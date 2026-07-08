import { describe, expect, it } from 'vitest';
import { DocumentBook, purchaseDepositFloor } from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n, kind: 'inventory' });
  const custom = book.createItem({ name: 'Custom part', currency: 'USD', unitPrice: 50_000n, cost: 30_000n, depositPolicy: 'special_order' });
  const supplier = book.createParty({ name: 'Supplier Inc', accountNumber: 'S-1' });
  return { book, widget, custom, supplier };
}

describe('purchase deposits (ADR 0016)', () => {
  it('special-order items force full prepayment before a PO can be sent', () => {
    const { book, custom, supplier } = setUp();
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: custom.id, description: 'Custom part', quantityMilli: 1000n, unitPrice: 30_000n }],
    });
    // No deposit committed: the special-order line's gross must be covered.
    expect(() => book.sendDocument(po.id)).toThrowError(/must cover at least 30000/);

    const covered = book.createDocument({
      type: 'purchase_order', number: 'PO-2', date: '2026-07-01', partyId: supplier.id,
      deposit: { amountMinor: 30_000n },
      lines: [{ itemId: custom.id, description: 'Custom part', quantityMilli: 1000n, unitPrice: 30_000n }],
    });
    book.sendDocument(covered.id);
    expect(covered).toBeDefined();

    // The override escape is approvable, like the sales side.
    book.setApprovalPolicy(['deposit_override']);
    expect(() => book.sendDocument(po.id, { overrideDeposit: true })).toThrowError(/requires an approver/);
    book.sendDocument(po.id, { overrideDeposit: true, approvedBy: 'owner' });
  });

  it('supplier prepayment percent gates ordinary orders', () => {
    const { book, widget, supplier } = setUp();
    book.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      prepaymentPercentMilli: 50_000n, // 50% down
      items: [{ itemId: widget.id, unitCost: 1000n }],
    });
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-3', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }], // 100.00
    });
    expect(() => book.sendDocument(po.id)).toThrowError(/must cover at least 5000/); // 50% of 100.00

    const ok = book.createDocument({
      type: 'purchase_order', number: 'PO-4', date: '2026-07-01', partyId: supplier.id,
      deposit: { percentMilli: 50_000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }],
    });
    book.sendDocument(ok.id);
  });

  it('purchaseDepositFloor takes the greater of item and supplier requirements', () => {
    const { book, widget, custom } = setUp();
    const getItem = (id: string) => book.getItem(id);
    const lines = [
      { lineId: 'a', itemId: widget.id, description: 'W', quantityMilli: 10_000n, unitPrice: 1000n, currency: 'USD', adjustment: 0n, free: false, substituted: false, sourceDocumentId: null, sourceLineId: null, returnCondition: null, taxCode: null, taxPercentMilli: 0n },
      { lineId: 'b', itemId: custom.id, description: 'C', quantityMilli: 1000n, unitPrice: 30_000n, currency: 'USD', adjustment: 0n, free: false, substituted: false, sourceDocumentId: null, sourceLineId: null, returnCondition: null, taxCode: null, taxPercentMilli: 0n },
    ];
    // Special-order gross = 300.00; total = 400.00, supplier 50% = 200.00 → max 300.00.
    expect(purchaseDepositFloor(lines, getItem, 50_000n)).toBe(30_000n);
    // Supplier 90% of 400.00 = 360.00 wins.
    expect(purchaseDepositFloor(lines, getItem, 90_000n)).toBe(36_000n);
    // No requirements → zero.
    expect(purchaseDepositFloor([lines[0]!], getItem, null)).toBe(0n);
  });

  it('outbound payments deposit against a sent PO and transfer to the bill', () => {
    const { book, widget, supplier } = setUp();
    book.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      prepaymentPercentMilli: 50_000n,
      items: [{ itemId: widget.id, unitCost: 1000n }],
    });
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-5', date: '2026-07-01', partyId: supplier.id,
      deposit: { percentMilli: 50_000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n, lineId: 'L1' }], // 100.00
    });
    book.sendDocument(po.id);

    // Pay the 50.00 deposit — an outbound payment applied to the PO.
    book.recordPayment({
      number: 'PMT-1', direction: 'out', date: '2026-07-02', partyId: supplier.id, amount: 5000n,
      applications: [{ invoiceId: po.id, amount: 5000n }],
    });
    expect(book.depositHeld(po.id)).toBe(5000n);

    // An inbound payment cannot deposit against a PO (direction guard).
    const inbound = book.recordPayment({ number: 'PMT-2', date: '2026-07-02', partyId: supplier.id, amount: 100n });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: inbound.id, invoiceId: po.id, amount: 100n }),
    ).toThrowError(/settled by outbound payments/);

    // Bill it: the deposit transfers, leaving 50.00 open.
    const bill = book.convertDocument(po.id, { type: 'bill', number: 'BILL-1', date: '2026-07-10' });
    book.sendDocument(bill.id);
    expect(book.depositHeld(po.id)).toBe(0n);
    expect(book.invoiceSettlement(bill.id)).toMatchObject({ paid: 5000n, open: 5000n, status: 'partial' });
  });

  it('deposits transfer through a receipt in the three-way flow', () => {
    const { book, widget, supplier } = setUp();
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-6', date: '2026-07-01', partyId: supplier.id,
      deposit: { amountMinor: 3000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }],
    });
    book.sendDocument(po.id);
    book.recordPayment({
      number: 'PMT-3', direction: 'out', date: '2026-07-02', partyId: supplier.id, amount: 3000n,
      applications: [{ invoiceId: po.id, amount: 3000n }],
    });
    // PO → receipt → bill; deposit is held on the PO, bill converts from the receipt.
    const receipt = book.convertDocument(po.id, { type: 'receipt', number: 'RCT-1', date: '2026-07-05' });
    book.sendDocument(receipt.id);
    const bill = book.convertDocument(receipt.id, { type: 'bill', number: 'BILL-2', date: '2026-07-10' });
    book.sendDocument(bill.id);
    expect(book.depositHeld(po.id)).toBe(0n);
    expect(book.invoiceSettlement(bill.id)).toMatchObject({ paid: 3000n, open: 7000n });
  });
});
