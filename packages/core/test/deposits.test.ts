import { describe, expect, it } from 'vitest';
import { DocumentBook } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  const stocked = book.createItem({ name: 'Stocked widget', currency: 'USD', unitPrice: 2500n });
  const custom = book.createItem({ name: 'Custom fabrication', currency: 'USD', unitPrice: 50_000n, depositPolicy: 'always' });
  const seasonal = book.createItem({ name: 'Seasonal gadget', currency: 'USD', unitPrice: 4000n, depositPolicy: 'when_out_of_stock', inStock: true });
  return { book, stocked, custom, seasonal };
}

describe('deposit requests on sales orders (Tier 3)', () => {
  it('flat and percent requests resolve against the grand total; SO-only', () => {
    const { book, stocked } = setUp();
    const flat = book.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 2000n },
      lines: [{ itemId: stocked.id, description: 'Widget', quantityMilli: 4000n }], // 100.00
    });
    expect(flat.current.depositRequiredMinor).toBe(2000n);

    const percent = book.createDocument({
      type: 'sales_order', number: 'SO-2', date: '2026-07-01', ...acme,
      deposit: { percentMilli: 25_000n }, // 25%
      lines: [{ itemId: stocked.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(percent.current.depositRequiredMinor).toBe(2500n);

    expect(() =>
      book.createDocument({
        type: 'invoice', number: 'INV-1', date: '2026-07-01', ...acme,
        deposit: { amountMinor: 100n },
        lines: [{ itemId: stocked.id, description: 'Widget', quantityMilli: 1000n }],
      }),
    ).toThrowError(/only be requested on sales orders/);
  });

  it('item policies gate sending: always, when_out_of_stock, and the override', () => {
    const { book, custom, seasonal } = setUp();
    // 'always' item without a deposit request: cannot send.
    const noDeposit = book.createDocument({
      type: 'sales_order', number: 'SO-3', date: '2026-07-01', ...acme,
      lines: [{ itemId: custom.id, description: 'Custom job', quantityMilli: 1000n }],
    });
    expect(() => book.sendDocument(noDeposit.id)).toThrowError(/require a deposit before sending/);

    // Override works, and is approvable.
    book.setApprovalPolicy(['deposit_override']);
    expect(() => book.sendDocument(noDeposit.id, { overrideDeposit: true })).toThrowError(/requires an approver/);
    book.sendDocument(noDeposit.id, { overrideDeposit: true, approvedBy: 'owner' });

    // In-stock seasonal item sends freely…
    const inStock = book.createDocument({
      type: 'sales_order', number: 'SO-4', date: '2026-07-01', ...acme,
      lines: [{ itemId: seasonal.id, description: 'Gadget', quantityMilli: 1000n }],
    });
    book.sendDocument(inStock.id);

    // …but once out of stock, a deposit is required.
    book.setItemStock(seasonal.id, false);
    const backordered = book.createDocument({
      type: 'sales_order', number: 'SO-5', date: '2026-07-01', ...acme,
      lines: [{ itemId: seasonal.id, description: 'Gadget', quantityMilli: 1000n }],
    });
    expect(() => book.sendDocument(backordered.id)).toThrowError(/DEPOSIT|require a deposit/);

    // With a deposit request it sends fine.
    const withDeposit = book.createDocument({
      type: 'sales_order', number: 'SO-6', date: '2026-07-01', ...acme,
      deposit: { percentMilli: 50_000n },
      lines: [{ itemId: seasonal.id, description: 'Gadget', quantityMilli: 1000n }],
    });
    book.sendDocument(withDeposit.id);
  });
});

describe('prepayments held on sales orders (Tier 3)', () => {
  it('payments apply to sent sales orders, document-level and line-level', () => {
    const { book, stocked, custom } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-7', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 10_000n },
      lines: [
        { itemId: custom.id, description: 'Custom job', quantityMilli: 1000n, lineId: 'L1' },  // 500.00
        { itemId: stocked.id, description: 'Widget', quantityMilli: 4000n, lineId: 'L2' },     // 100.00
      ],
    });
    book.sendDocument(order.id);

    const payment = book.recordPayment({ number: 'PMT-1', date: '2026-07-02', ...acme, amount: 100_000n });
    // Line-level prepayment on the custom job.
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 25_000n, lineId: 'L1' });
    // Document-level deposit.
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 5_000n });

    expect(book.depositHeld(order.id)).toBe(30_000n);
    const prepayments = book.linePrepayments(order.id);
    expect(prepayments.find((entry) => entry.lineId === 'L1')!.prepaid).toBe(25_000n);
    expect(prepayments.find((entry) => entry.lineId === 'L2')!.prepaid).toBe(0n);

    // Line-level caps at the line's gross amount.
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 26_000n, lineId: 'L1' }),
    ).toThrowError(/exceeds the line's remaining/);
    // Unknown lines and non-SO targets are rejected.
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 1n, lineId: 'NOPE' }),
    ).toThrowError(/No such line/);

    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-07-03', ...acme,
      lines: [{ itemId: stocked.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(invoice.id);
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: invoice.id, amount: 1n, lineId: 'X' }),
    ).toThrowError(/only to sales orders/);
  });

  it('prepaid lines cannot be removed or shrunk below their prepayment', () => {
    const { book, custom } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-8', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 10_000n },
      lines: [{ itemId: custom.id, description: 'Custom job', quantityMilli: 1000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);
    const payment = book.recordPayment({ number: 'PMT-2', date: '2026-07-02', ...acme, amount: 30_000n });
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 30_000n, lineId: 'L1' });

    expect(() =>
      book.changeDocument(order.id, {
        kind: 'correction',
        lines: [{ itemId: custom.id, description: 'Custom job', quantityMilli: 500n, lineId: 'L1' }], // 250.00 < 300.00 prepaid
      }),
    ).toThrowError(/cannot shrink below its 30000 prepayment/);
  });

  it('deposits transfer to the invoice when it is sent; unrelated line prepayments stay', () => {
    const { book, stocked, custom } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-9', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 20_000n },
      lines: [
        { itemId: custom.id, description: 'Custom job', quantityMilli: 1000n, lineId: 'L1' },  // 500.00
        { itemId: stocked.id, description: 'Widget', quantityMilli: 4000n, lineId: 'L2' },     // 100.00
      ],
    });
    book.sendDocument(order.id);
    const payment = book.recordPayment({ number: 'PMT-3', date: '2026-07-02', ...acme, amount: 60_000n });
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 30_000n, lineId: 'L1' });
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 10_000n }); // doc-level

    // Invoice only the custom job line.
    const invoice = book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-3', date: '2026-07-05',
      lines: [{ sourceLineId: 'L1' }],
    });
    book.sendDocument(invoice.id);

    // L1's 300.00 prepayment and the 100.00 doc-level deposit both moved (invoice total 500.00).
    const settlement = book.invoiceSettlement(invoice.id);
    expect(settlement.paid).toBe(40_000n);
    expect(settlement.open).toBe(10_000n);
    expect(book.depositHeld(order.id)).toBe(0n);

    // Now the reverse case: line prepayment for a line NOT on the invoice stays held.
    const order2 = book.createDocument({
      type: 'sales_order', number: 'SO-10', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 5_000n },
      lines: [
        { itemId: custom.id, description: 'Custom job', quantityMilli: 1000n, lineId: 'L1' },
        { itemId: stocked.id, description: 'Widget', quantityMilli: 4000n, lineId: 'L2' },
      ],
    });
    book.sendDocument(order2.id);
    const payment2 = book.recordPayment({ number: 'PMT-4', date: '2026-07-02', ...acme, amount: 20_000n });
    book.applyCredit({ sourceKind: 'payment', sourceId: payment2.id, invoiceId: order2.id, amount: 20_000n, lineId: 'L1' });

    // Invoice only the WIDGET line: L1's prepayment must stay on the order.
    const invoice2 = book.convertDocument(order2.id, {
      type: 'invoice', number: 'INV-4', date: '2026-07-05',
      lines: [{ sourceLineId: 'L2' }],
    });
    book.sendDocument(invoice2.id);
    expect(book.invoiceSettlement(invoice2.id).paid).toBe(0n);
    expect(book.depositHeld(order2.id)).toBe(20_000n);
  });

  it('oversized deposits transfer partially; the remainder stays held', () => {
    const { book, stocked } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-11', date: '2026-07-01', ...acme,
      lines: [{ itemId: stocked.id, description: 'Widget', quantityMilli: 8000n, lineId: 'L1' }], // 200.00
    });
    book.sendDocument(order.id);
    const payment = book.recordPayment({ number: 'PMT-5', date: '2026-07-02', ...acme, amount: 15_000n });
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 15_000n });

    // Partial conversion: invoice half the order (100.00); deposit 150.00.
    const invoice = book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-5', date: '2026-07-05',
      lines: [{ sourceLineId: 'L1', quantityMilli: 4000n }],
    });
    book.sendDocument(invoice.id);
    expect(book.invoiceSettlement(invoice.id).status).toBe('paid'); // 100.00 covered
    expect(book.depositHeld(order.id)).toBe(5_000n); // 50.00 stays for the rest
  });
});
