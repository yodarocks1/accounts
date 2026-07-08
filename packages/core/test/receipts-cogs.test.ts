import { describe, expect, it } from 'vitest';
import { DocumentBook, planDocumentPosting } from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
  const supplier = book.createParty({ name: 'Supplier Inc' });
  return { book, widget, supplier };
}

function billIn(book: DocumentBook, supplierId: string, itemId: string, qty: bigint, unitPrice: bigint, number: string, date: string) {
  const bill = book.createDocument({
    type: 'bill', number, date, partyId: supplierId,
    lines: [{ itemId, description: 'Widget', quantityMilli: qty, unitPrice }],
  });
  book.sendDocument(bill.id);
  return bill;
}

describe('receipts (ADR 0015)', () => {
  it('PO → receipt → bill: stock lands once, at the receipt', () => {
    const { book, widget, supplier } = setUp();
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n, unitPrice: 900n, lineId: 'P1' }],
    });
    book.sendDocument(po.id);

    // Goods arrive: receipt converts from the PO and moves stock.
    const receipt = book.convertDocument(po.id, { type: 'receipt', number: 'RCT-1', date: '2026-07-05' });
    expect(book.stockOnHand(widget.id).goodMilli).toBe(0n); // draft
    book.sendDocument(receipt.id);
    expect(book.stockOnHand(widget.id).goodMilli).toBe(12_000n);
    expect(book.fulfillment(po.id)[0]!.status).toBe('fulfilled'); // received = fulfilled

    // The bill arrives later; billing received lines moves NO stock again.
    const bill = book.convertDocument(receipt.id, { type: 'bill', number: 'BILL-1', date: '2026-07-10' });
    book.sendDocument(bill.id);
    expect(book.stockOnHand(widget.id).goodMilli).toBe(12_000n);

    // The receipt's layer carries the PO price into valuation.
    const valuation = book.itemValuation(widget.id);
    expect(valuation.valueMinor).toBe(10_800n);
    expect(valuation.layers[0]).toMatchObject({ quantityMilli: 12_000n, valueMinor: 10_800n });
  });

  it('receipts take no payments and direct billing still moves stock', () => {
    const { book, widget, supplier } = setUp();
    const receipt = book.createDocument({
      type: 'receipt', number: 'RCT-2', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 900n }],
    });
    book.sendDocument(receipt.id);
    const payment = book.recordPayment({
      number: 'PMT-1', direction: 'out', date: '2026-07-02', partyId: supplier.id, amount: 900n,
    });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: receipt.id, amount: 900n }),
    ).toThrowError(/invoices, sales orders \(deposits\), or bills/);
    // Direct-billed lines (no receipt source) still move stock at approval.
    billIn(book, supplier.id, widget.id, 2000n, 950n, 'BILL-2', '2026-07-03');
    expect(book.stockOnHand(widget.id).goodMilli).toBe(3000n);
  });
});

describe('FIFO valuation (ADR 0015)', () => {
  it('consumes layers front-first; invoices cost at FIFO; voids re-enter at issue cost', () => {
    const { book, widget, supplier } = setUp();
    billIn(book, supplier.id, widget.id, 10_000n, 900n, 'BILL-1', '2026-07-01'); // 10 @ 9.00
    billIn(book, supplier.id, widget.id, 10_000n, 1100n, 'BILL-2', '2026-07-02'); // 10 @ 11.00

    // Sell 12: consumes all of layer 1 (90.00) + 2 of layer 2 (22.00).
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-03', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n }],
    });
    book.sendDocument(invoice.id);
    let valuation = book.itemValuation(widget.id);
    expect(valuation.costBySource.get(invoice.id)).toBe(-11_200n); // COGS 112.00
    expect(valuation.quantityMilli).toBe(8000n);
    expect(valuation.valueMinor).toBe(8800n); // 8 @ 11.00 remain

    // Voiding brings the stock back at the SAME cost it left with.
    book.voidDocument(invoice.id);
    valuation = book.itemValuation(widget.id);
    expect(valuation.quantityMilli).toBe(20_000n);
    expect(valuation.valueMinor).toBe(20_000n); // 90 + 110 restored exactly
  });

  it('corrected-down bills remove exactly the value they added', () => {
    const { book, widget, supplier } = setUp();
    const bill = book.createDocument({
      type: 'bill', number: 'BILL-3', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 900n, lineId: 'L1' }],
    });
    book.sendDocument(bill.id);
    billIn(book, supplier.id, widget.id, 5000n, 1200n, 'BILL-4', '2026-07-02');
    // Correct the first bill down to 6: its own layer shrinks by 4 × 9.00.
    book.changeDocument(bill.id, {
      kind: 'correction', reason: 'short shipped',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 6000n, unitPrice: 900n, lineId: 'L1' }],
    });
    const valuation = book.itemValuation(widget.id);
    expect(valuation.quantityMilli).toBe(11_000n);
    expect(valuation.valueMinor).toBe(11_400n); // 6×9.00 + 5×12.00
    expect(valuation.costBySource.get(bill.id)).toBe(5400n);
  });

  it('negative stock falls back to costAt; damage transfers keep value', () => {
    const { book, widget, supplier } = setUp();
    book.setCost(widget.id, 1000n, '0000-01-01');
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3000n }],
    });
    book.sendDocument(invoice.id); // nothing on hand: costAt fallback 3 × 10.00
    expect(book.itemValuation(widget.id).costBySource.get(invoice.id)).toBe(-3000n);

    billIn(book, supplier.id, widget.id, 10_000n, 900n, 'BILL-5', '2026-07-02');
    book.markDamaged(widget.id, 2000n, { reason: 'forklift' });
    let valuation = book.itemValuation(widget.id);
    expect(valuation.valueMinor).toBe(9000n); // damage is a transfer, not a value event
    book.disposeStock(widget.id, 2000n, 'trash');
    valuation = book.itemValuation(widget.id);
    expect(valuation.valueMinor).toBe(7200n); // trash consumed 2 × 9.00
  });
});

describe('document posting plans with inventory (ADR 0015)', () => {
  const accounts = {
    accounts_receivable: 'AR', sales_income: 'INC', cash: 'CASH', sales_tax_payable: 'TAX',
    accounts_payable: 'AP', purchases_expense: 'PUR',
    inventory_asset: 'INV', cogs: 'COGS', goods_received_not_invoiced: 'GRNI',
  };

  it('invoice: revenue plus COGS in one balanced entry', () => {
    const plan = planDocumentPosting('invoice', { net: 10_000n, tax: 800n, inventory: 4000n }, 'USD', '2026-07-01', accounts)!;
    expect(plan.lines).toEqual([
      { accountId: 'AR', side: 'debit', amount: 10_800n, currency: 'USD' },
      { accountId: 'INC', side: 'credit', amount: 10_000n, currency: 'USD' },
      { accountId: 'TAX', side: 'credit', amount: 800n, currency: 'USD' },
      { accountId: 'COGS', side: 'debit', amount: 4000n, currency: 'USD' },
      { accountId: 'INV', side: 'credit', amount: 4000n, currency: 'USD' },
    ]);
  });

  it('bill: GRNI cleared, direct inventory in, remainder expensed', () => {
    const plan = planDocumentPosting('bill', { net: 10_000n, tax: 0n, inventory: 7000n, grni: 5000n }, 'USD', '2026-07-01', accounts)!;
    expect(plan.lines).toEqual([
      { accountId: 'GRNI', side: 'debit', amount: 5000n, currency: 'USD' },
      { accountId: 'INV', side: 'debit', amount: 2000n, currency: 'USD' },
      { accountId: 'PUR', side: 'debit', amount: 3000n, currency: 'USD' },
      { accountId: 'AP', side: 'credit', amount: 10_000n, currency: 'USD' },
    ]);
  });

  it('receipt posts the accrual; degradation preserves old behavior', () => {
    const plan = planDocumentPosting('receipt', { net: 9000n, tax: 0n, inventory: 9000n }, 'USD', '2026-07-01', accounts)!;
    expect(plan.lines).toEqual([
      { accountId: 'INV', side: 'debit', amount: 9000n, currency: 'USD' },
      { accountId: 'GRNI', side: 'credit', amount: 9000n, currency: 'USD' },
    ]);
    // Without the inventory roles: receipts post nothing, bills post as before.
    const bare = { accounts_payable: 'AP', purchases_expense: 'PUR' };
    expect(planDocumentPosting('receipt', { net: 9000n, tax: 0n, inventory: 9000n }, 'USD', '2026-07-01', bare)).toBeNull();
    expect(planDocumentPosting('bill', { net: 9000n, tax: 0n, inventory: 9000n, grni: 9000n }, 'USD', '2026-07-01', bare)!.lines).toEqual([
      { accountId: 'PUR', side: 'debit', amount: 9000n, currency: 'USD' },
      { accountId: 'AP', side: 'credit', amount: 9000n, currency: 'USD' },
    ]);
  });

  it('vendor credit: price variance lands on purchases', () => {
    // Credited 100.00 for goods whose FIFO value was 90.00.
    const plan = planDocumentPosting('vendor_credit_account', { net: 10_000n, tax: 0n, inventory: 9000n }, 'USD', '2026-07-01', accounts)!;
    expect(plan.lines).toEqual([
      { accountId: 'AP', side: 'debit', amount: 10_000n, currency: 'USD' },
      { accountId: 'INV', side: 'credit', amount: 9000n, currency: 'USD' },
      { accountId: 'PUR', side: 'credit', amount: 1000n, currency: 'USD' },
    ]);
  });
});
