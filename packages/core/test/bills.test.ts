import { describe, expect, it } from 'vitest';
import { DocumentBook, planPosting } from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const supplier = book.createParty({ name: 'Widgets Wholesale Inc', accountNumber: 'S-7' });
  book.recordSupplierInfo({
    partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
    items: [{ itemId: widget.id, unitCost: 900n }],
  });
  const po = book.createDocument({
    type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
    lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n, lineId: 'P1' }],
  });
  book.sendDocument(po.id);
  return { book, widget, supplier, po };
}

describe('vendor bills (ADR 0012)', () => {
  it('converts a sent PO to a bill, partially, at the PO price; untaxed', () => {
    const { book, po } = setUp();
    const bill = book.convertDocument(po.id, {
      type: 'bill', number: 'BILL-1', date: '2026-07-10',
      lines: [{ sourceLineId: 'P1', quantityMilli: 5000n }],
    });
    expect(bill.type).toBe('bill');
    expect(bill.current.lines[0]!.unitPrice).toBe(900n);
    expect(bill.current.lines[0]!.taxCode).toBeNull();
    expect(bill.total).toBe(4500n);
    // Billing consumes the PO's fulfillment; the rest stays open.
    expect(book.fulfillment(po.id)[0]).toMatchObject({ convertedMilli: 5000n, openMilli: 7000n });
    // Only sent POs can be billed; only bills come from POs.
    expect(() =>
      book.convertDocument(bill.id, { type: 'invoice', date: '2026-07-11' }),
    ).toThrowError(/cannot be converted/);
  });

  it('sent bills change only by correction', () => {
    const { book, po } = setUp();
    const bill = book.convertDocument(po.id, { type: 'bill', number: 'BILL-2', date: '2026-07-10' });
    book.sendDocument(bill.id);
    expect(() => book.changeDocument(bill.id, { kind: 'edit', memo: 'oops' })).toThrowError(/bill can only be changed by a correction/);
    // Like invoices, an unspecified kind resolves to a correction.
    const corrected = book.changeDocument(bill.id, { reason: 'supplier rebilled', memo: 'ok' });
    expect(corrected.tags).toContain('with corrections');
  });

  it('outbound payments settle bills; directions never cross', () => {
    const { book, widget, po } = setUp();
    const bill = book.convertDocument(po.id, { type: 'bill', number: 'BILL-3', date: '2026-07-10' });
    book.sendDocument(bill.id); // 12 × 9.00 = 108.00

    // An inbound payment cannot touch a bill.
    const inbound = book.recordPayment({
      number: 'PMT-1', date: '2026-07-11', customerName: 'Widgets Wholesale Inc', accountNumber: 'S-7', amount: 10_800n,
    });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: inbound.id, invoiceId: bill.id, amount: 10_800n }),
    ).toThrowError(/settled by outbound payments/);

    // An outbound payment settles it (partially, then fully).
    const outbound = book.recordPayment({
      number: 'PMT-2', direction: 'out', date: '2026-07-12', partyId: bill.partyId!,
      amount: 10_800n, method: 'check #77',
      applications: [{ invoiceId: bill.id, amount: 4000n }],
    });
    expect(book.invoiceSettlement(bill.id)).toMatchObject({ paid: 4000n, open: 6800n, status: 'partial' });
    book.applyCredit({ sourceKind: 'payment', sourceId: outbound.id, invoiceId: bill.id, amount: 6800n });
    expect(book.invoiceSettlement(bill.id).status).toBe('paid');

    // And an outbound payment cannot touch customer documents.
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-12', customerName: 'Widgets Wholesale Inc', accountNumber: 'S-7',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(invoice.id);
    const stray = book.recordPayment({
      number: 'PMT-3', direction: 'out', date: '2026-07-13', customerName: 'Widgets Wholesale Inc', accountNumber: 'S-7', amount: 100n,
    });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: stray.id, invoiceId: invoice.id, amount: 100n }),
    ).toThrowError(/settle bills, not customer documents/);
  });

  it('bills and outbound payments never reach customer statements', () => {
    const { book, widget, supplier, po } = setUp();
    // The supplier is also a customer.
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-9', date: '2026-07-05', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    book.sendDocument(invoice.id);
    const bill = book.convertDocument(po.id, { type: 'bill', number: 'BILL-9', date: '2026-07-10' });
    book.sendDocument(bill.id);
    book.recordPayment({
      number: 'PMT-9', direction: 'out', date: '2026-07-12', partyId: supplier.id, amount: 10_800n,
      applications: [{ invoiceId: bill.id, amount: 10_800n }],
    });

    const statement = book.statementForParty(supplier.id, '2026-07-31');
    expect(statement.invoices.map((entry) => entry.number)).toEqual(['INV-9']);
    expect(statement.payments).toHaveLength(0);
    expect(statement.balance).toBe(5000n); // just the customer invoice
  });
});

describe('A/P posting plans (ADR 0012)', () => {
  const accounts = {
    accounts_payable: 'AP', purchases_expense: 'PUR', cash: 'CASH',
    accounts_receivable: 'AR', sales_income: 'INC',
  };

  it('bill: DR purchases / CR accounts payable', () => {
    const plan = planPosting('bill', 10_800n, 'USD', '2026-07-10', accounts, 'BILL-1')!;
    expect(plan.lines).toEqual([
      { accountId: 'PUR', side: 'debit', amount: 10_800n, currency: 'USD' },
      { accountId: 'AP', side: 'credit', amount: 10_800n, currency: 'USD' },
    ]);
  });

  it('disbursement: DR accounts payable / CR cash; skipped when roles are unmapped', () => {
    const plan = planPosting('disbursement', 4000n, 'USD', '2026-07-12', accounts)!;
    expect(plan.lines).toEqual([
      { accountId: 'AP', side: 'debit', amount: 4000n, currency: 'USD' },
      { accountId: 'CASH', side: 'credit', amount: 4000n, currency: 'USD' },
    ]);
    expect(planPosting('bill', 100n, 'USD', '2026-07-12', { cash: 'CASH' })).toBeNull();
  });
});
