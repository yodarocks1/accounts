import { describe, expect, it } from 'vitest';
import { DocumentBook } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const sale = (number: string, date: string, quantityMilli: bigint) => {
    const view = book.createDocument({
      type: 'invoice', number, date, ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli }],
    });
    book.sendDocument(view.id);
    return view;
  };
  return { book, widget, sale };
}

describe('return quantity guard (Tier 2)', () => {
  it('cumulative returns cannot exceed the quantity purchased', () => {
    const { book, widget, sale } = setUp();
    sale('INV-1', '2026-06-01', 3000n); // bought 3

    book.createReturn({ number: 'CR-1', date: '2026-06-10', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 2000n }] });
    // 2 returned, 1 left — returning 2 more must fail.
    expect(() =>
      book.createReturn({ number: 'CR-2', date: '2026-06-11', ...acme,
        items: [{ itemId: widget.id, quantityMilli: 2000n }] }),
    ).toThrowError(/exceeds the 3000 purchased/);
    // Returning the last one is fine.
    book.createReturn({ number: 'CR-3', date: '2026-06-12', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }] });
  });

  it('voided credit memos give their quantity back', () => {
    const { book, widget, sale } = setUp();
    sale('INV-2', '2026-06-01', 1000n);
    const credit = book.createReturn({ number: 'CR-4', date: '2026-06-10', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }] });
    expect(() =>
      book.createReturn({ number: 'CR-5', date: '2026-06-11', ...acme,
        items: [{ itemId: widget.id, quantityMilli: 1000n }] }),
    ).toThrowError(/exceeds/);
    book.voidDocument(credit.id);
    book.createReturn({ number: 'CR-6', date: '2026-06-12', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }] });
  });
});

describe('return conditions and restocking fees (Tier 2)', () => {
  it('applies per-condition fees, with unopened cheapest', () => {
    const { book, widget, sale } = setUp();
    book.setReturnPolicy({
      fees: {
        unopened: { percentMilli: 5_000n },            // 5%
        opened: { percentMilli: 15_000n },             // 15%
        damaged: { percentMilli: 25_000n, amountMinor: 500n }, // 25% + $5
      },
    });
    sale('INV-3', '2026-06-01', 6000n); // 6 × 25.00

    const credit = book.createReturn({
      number: 'CR-7', date: '2026-06-10', ...acme,
      items: [
        { itemId: widget.id, quantityMilli: 1000n },                       // unopened (default)
        { itemId: widget.id, quantityMilli: 1000n, condition: 'opened' },
        { itemId: widget.id, quantityMilli: 1000n, condition: 'damaged' },
      ],
    });
    const lines = credit.current.lines;
    expect(lines[0]!.returnCondition).toBe('unopened');
    expect(lines[0]!.adjustment).toBe(-125n);  // 5% of 25.00
    expect(lines[1]!.adjustment).toBe(-375n);  // 15% of 25.00
    expect(lines[2]!.adjustment).toBe(-1125n); // 25% of 25.00 + 5.00
    // Credit total nets the fees.
    expect(credit.total).toBe(7500n - 125n - 375n - 1125n);
  });

  it('per-item fee overrides win; fees clamp to the credit amount', () => {
    const { book, widget, sale } = setUp();
    book.setReturnPolicy({ fees: { unopened: { percentMilli: 5_000n } } });
    sale('INV-4', '2026-06-01', 2000n);
    const credit = book.createReturn({
      number: 'CR-8', date: '2026-06-10', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n, restockingFee: { amountMinor: 99_999n } }],
    });
    // Fee clamps at the full 25.00 credit — never negative credit.
    expect(credit.current.lines[0]!.adjustment).toBe(-2500n);
    expect(credit.total).toBe(0n);
  });

  it('no policy, no fee', () => {
    const { book, widget, sale } = setUp();
    sale('INV-5', '2026-06-01', 1000n);
    const credit = book.createReturn({ number: 'CR-9', date: '2026-06-10', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n, condition: 'damaged' }] });
    expect(credit.current.lines[0]!.adjustment).toBe(0n);
    expect(credit.current.lines[0]!.returnCondition).toBe('damaged');
  });
});

describe('return window (Tier 2)', () => {
  it('rejects returns past the window unless overridden', () => {
    const { book, widget, sale } = setUp();
    book.setReturnPolicy({ windowDays: 30 });
    sale('INV-6', '2026-05-01', 2000n);

    expect(() =>
      book.createReturn({ number: 'CR-10', date: '2026-06-15', ...acme,
        items: [{ itemId: widget.id, quantityMilli: 1000n }] }),
    ).toThrowError(/return window is 30 days/);

    const credit = book.createReturn({ number: 'CR-11', date: '2026-06-15', ...acme,
      overrideWindow: true,
      items: [{ itemId: widget.id, quantityMilli: 1000n }] });
    expect(credit.total).toBe(2500n);
  });
});

describe('approval policy (Tier 2)', () => {
  it('gates charge corrections, voids, closures, and window overrides', () => {
    const { book, widget, sale } = setUp();
    book.setApprovalPolicy(['charge_correction', 'void_document', 'close_line', 'return_window_override']);
    const invoice = sale('INV-7', '2026-06-01', 4000n);

    expect(() => book.chargeCorrection(invoice.id, 9000n, 'oops')).toThrowError(/requires an approver/);
    book.chargeCorrection(invoice.id, 9000n, 'oops', undefined, 'manager@acme');

    expect(() => book.voidDocument(invoice.id)).toThrowError(/requires an approver/);

    const order = book.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-06-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);
    expect(() => book.closeLine(order.id, { lineId: 'L1', kind: 'unfulfilled' })).toThrowError(/requires an approver/);
    book.closeLine(order.id, { lineId: 'L1', kind: 'unfulfilled', approvedBy: 'manager@acme' });

    book.setReturnPolicy({ windowDays: 1 });
    expect(() =>
      book.createReturn({ number: 'CR-12', date: '2026-07-01', ...acme, overrideWindow: true,
        items: [{ itemId: widget.id, quantityMilli: 1000n }] }),
    ).toThrowError(/requires an approver/);
  });

  it('gates below-cost sales', () => {
    const { book, widget } = setUp();
    book.setApprovalPolicy(['below_cost_sale']);
    expect(() =>
      book.createDocument({
        type: 'invoice', number: 'INV-8', date: '2026-06-01', ...acme,
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 500n }], // under cost 10.00
      }),
    ).toThrowError(/requires an approver/);
    const approved = book.createDocument({
      type: 'invoice', number: 'INV-9', date: '2026-06-01', ...acme, approvedBy: 'owner',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 500n }],
    });
    expect(approved.current.lines[0]!.unitPrice).toBe(500n);
    // At-or-above cost needs no approval.
    book.createDocument({
      type: 'invoice', number: 'INV-10', date: '2026-06-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 1000n }],
    });
  });
});
