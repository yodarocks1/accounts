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
    type: 'purchase_order', number: 'PO-1', date: '2026-06-01', partyId: supplier.id,
    lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n, lineId: 'P1' }],
  });
  book.sendDocument(po.id);
  const bill = book.convertDocument(po.id, { type: 'bill', number: 'BILL-1', date: '2026-06-05' });
  book.sendDocument(bill.id); // 108.00
  return { book, widget, supplier, po, bill };
}

describe('vendor credits (ADR 0013)', () => {
  it('prices at cost, applies to bills, and never touches customer documents', () => {
    const { book, widget, supplier, bill } = setUp();
    const billLineId = book.view(bill.id).current.lines[0]!.lineId;
    // Return 4 widgets to the supplier, linked to the billed line.
    const credit = book.createDocument({
      type: 'vendor_credit', number: 'VC-1', date: '2026-06-10', partyId: supplier.id,
      lines: [{
        itemId: widget.id, description: 'Widget (returned to supplier)', quantityMilli: 4000n,
        unitPrice: 900n, sourceDocumentId: bill.id, sourceLineId: billLineId,
      }],
    });
    expect(credit.total).toBe(3600n);
    expect(credit.current.lines[0]!.taxCode).toBeNull();
    book.sendDocument(credit.id);

    book.applyCredit({ sourceKind: 'vendor_credit', sourceId: credit.id, invoiceId: bill.id, amount: 3600n });
    expect(book.invoiceSettlement(bill.id)).toMatchObject({ paid: 3600n, open: 7200n });

    // Direction guard: a vendor credit cannot pay a customer invoice.
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-06-11', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(invoice.id);
    const credit2 = book.createDocument({
      type: 'vendor_credit', number: 'VC-2', date: '2026-06-12', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Rebate', quantityMilli: 1000n, unitPrice: 100n }],
    });
    book.sendDocument(credit2.id);
    expect(() =>
      book.applyCredit({ sourceKind: 'vendor_credit', sourceId: credit2.id, invoiceId: invoice.id, amount: 100n }),
    ).toThrowError(/settle bills, not customer documents/);
  });

  it('cumulative vendor-credit returns cannot exceed the billed quantity', () => {
    const { book, widget, supplier, bill } = setUp();
    const billLineId = book.view(bill.id).current.lines[0]!.lineId;
    const link = { sourceDocumentId: bill.id, sourceLineId: billLineId };
    book.createDocument({
      type: 'vendor_credit', number: 'VC-3', date: '2026-06-10', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Return', quantityMilli: 10_000n, unitPrice: 900n, ...link }],
    });
    expect(() =>
      book.createDocument({
        type: 'vendor_credit', number: 'VC-4', date: '2026-06-11', partyId: supplier.id,
        lines: [{ itemId: widget.id, description: 'Return', quantityMilli: 3000n, unitPrice: 900n, ...link }],
      }),
    ).toThrowError(/exceeds the 12000 purchased/);
  });
});

describe('credit refunds (ADR 0013)', () => {
  it('pays out unapplied credit, capped, reversible, and approvable', () => {
    const { book, bill, supplier } = setUp();
    // Outbound payment overpays the bill by 20.00.
    const payment = book.recordPayment({
      number: 'PMT-1', direction: 'out', date: '2026-06-15', partyId: supplier.id, amount: 12_800n,
      applications: [{ invoiceId: bill.id, amount: 10_800n }],
    });
    expect(() =>
      book.refundCredit({ sourceKind: 'payment', sourceId: payment.id, amount: 2500n }),
    ).toThrowError(/exceeds the source's unapplied 2000/);

    book.setApprovalPolicy(['refund_credit']);
    expect(() =>
      book.refundCredit({ sourceKind: 'payment', sourceId: payment.id, amount: 2000n }),
    ).toThrowError(/requires an approver/);
    const refund = book.refundCredit({
      sourceKind: 'payment', sourceId: payment.id, amount: 2000n, date: '2026-06-16', approvedBy: 'owner',
    });
    expect(refund.refund).toBe(true);
    expect(refund.invoiceId).toBeNull();

    // Fully consumed now; nothing left to refund or apply.
    expect(() =>
      book.refundCredit({ sourceKind: 'payment', sourceId: payment.id, amount: 1n, approvedBy: 'owner' }),
    ).toThrowError(/unapplied 0/);
    // Reversal restores the balance.
    book.reverseApplication(refund.applicationSeq);
    book.refundCredit({ sourceKind: 'payment', sourceId: payment.id, amount: 2000n, approvedBy: 'owner' });
  });

  it('shows on statements as refunded, not on account', () => {
    const { book, widget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-06-10', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    book.sendDocument(invoice.id); // 50.00
    const payment = book.recordPayment({
      number: 'PMT-2', date: '2026-06-11', customerName: 'Acme LLC', amount: 8000n,
      applications: [{ invoiceId: invoice.id, amount: 5000n }],
    });
    book.refundCredit({ sourceKind: 'payment', sourceId: payment.id, amount: 3000n, date: '2026-06-12' });

    const statement = book.statement({ customerName: 'Acme LLC' }, '2026-06-30');
    expect(statement.payments[0]).toMatchObject({
      appliedAmount: 5000n, refundedAmount: 3000n, unappliedAmount: 0n,
    });
    expect(statement.balance).toBe(0n); // paid invoice, refunded overage
  });
});

describe('cash sales and expenses (ADR 0013)', () => {
  it('recordSalesReceipt: paid invoice plus its payment in one motion', () => {
    const { book, widget } = setUp();
    book.setTaxRate({ code: 'TX', percentMilli: 10_000n });
    const { document, payment } = book.recordSalesReceipt({
      number: 'INV-CASH', paymentNumber: 'PMT-CASH', date: '2026-06-20',
      customerName: 'Walk-in', method: 'cash',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n, taxCode: 'TX' }],
    });
    expect(document.type).toBe('invoice');
    expect(document.status).toBe('sent');
    expect(document.current.termsDays).toBe(0);
    expect(document.total).toBe(5500n); // 50.00 + 10% tax
    expect(payment!.amountMinor).toBe(5500n);
    expect(book.invoiceSettlement(document.id).status).toBe('paid');
  });

  it('recordExpense: approved bill paid by an outbound payment', () => {
    const { book, widget, supplier } = setUp();
    const { document, payment } = book.recordExpense({
      number: 'BILL-CASH', paymentNumber: 'PMT-3', date: '2026-06-21', partyId: supplier.id, method: 'card',
      lines: [{ itemId: widget.id, description: 'Shop supplies', quantityMilli: 1000n }],
    });
    expect(document.type).toBe('bill');
    expect(document.total).toBe(900n); // supplier quote
    expect(payment!.direction).toBe('out');
    expect(book.invoiceSettlement(document.id).status).toBe('paid');
  });
});

describe('supplier statements (ADR 0013)', () => {
  it('ages what we owe, mirrors credits and outbound payments', () => {
    const { book, widget, supplier, bill } = setUp();
    // Vendor credit applied to the bill; partial outbound payment.
    const credit = book.createDocument({
      type: 'vendor_credit', number: 'VC-9', date: '2026-06-10', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Rebate', quantityMilli: 1000n, unitPrice: 800n }],
    });
    book.sendDocument(credit.id);
    book.applyCredit({ sourceKind: 'vendor_credit', sourceId: credit.id, invoiceId: bill.id, amount: 800n });
    book.recordPayment({
      number: 'PMT-4', direction: 'out', date: '2026-06-15', partyId: supplier.id, amount: 5000n,
      applications: [{ invoiceId: bill.id, amount: 5000n }],
    });
    // Noise that must NOT appear: a customer invoice and inbound payment for the same party.
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-06-16', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(invoice.id);
    book.recordPayment({ number: 'PMT-5', date: '2026-06-17', partyId: supplier.id, amount: 100n });

    const statement = book.supplierStatementForParty(supplier.id, '2026-08-01');
    expect(statement.invoices.map((entry) => entry.number)).toEqual(['BILL-1']);
    expect(statement.invoices[0]!.openAmount).toBe(5000n); // 108 − 0.8 credit − 50 paid
    expect(statement.invoices[0]!.ageLabel).toBe('past due'); // June bill, August as-of
    expect(statement.credits.map((entry) => entry.number)).toEqual(['VC-9']);
    expect(statement.payments.map((entry) => entry.number)).toEqual(['PMT-4']);
    expect(statement.balance).toBe(5000n);

    // And the customer statement stays purely customer-side.
    const customer = book.statementForParty(supplier.id, '2026-08-01');
    expect(customer.invoices.map((entry) => entry.number)).toEqual(['INV-3']);
    expect(customer.payments.map((entry) => entry.number)).toEqual(['PMT-5']);
  });
});

describe('new posting plans (ADR 0013)', () => {
  const accounts = {
    accounts_receivable: 'AR', sales_income: 'INC', cash: 'CASH',
    accounts_payable: 'AP', purchases_expense: 'PUR',
  };
  it('vendor credits and refunds post to the right sides', () => {
    expect(planPosting('vendor_credit_account', 3600n, 'USD', '2026-06-10', accounts)!.lines).toEqual([
      { accountId: 'AP', side: 'debit', amount: 3600n, currency: 'USD' },
      { accountId: 'PUR', side: 'credit', amount: 3600n, currency: 'USD' },
    ]);
    expect(planPosting('vendor_credit_refund', 3600n, 'USD', '2026-06-10', accounts)!.lines).toEqual([
      { accountId: 'CASH', side: 'debit', amount: 3600n, currency: 'USD' },
      { accountId: 'PUR', side: 'credit', amount: 3600n, currency: 'USD' },
    ]);
    expect(planPosting('refund_out', 2000n, 'USD', '2026-06-16', accounts)!.lines).toEqual([
      { accountId: 'AR', side: 'debit', amount: 2000n, currency: 'USD' },
      { accountId: 'CASH', side: 'credit', amount: 2000n, currency: 'USD' },
    ]);
    expect(planPosting('refund_in', 2000n, 'USD', '2026-06-16', accounts)!.lines).toEqual([
      { accountId: 'CASH', side: 'debit', amount: 2000n, currency: 'USD' },
      { accountId: 'AP', side: 'credit', amount: 2000n, currency: 'USD' },
    ]);
  });
});
