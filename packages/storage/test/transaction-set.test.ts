import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-txset-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function setUpBilled() {
  const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const supplier = file.createParty({ name: 'Widgets Wholesale Inc', accountNumber: 'S-7' });
  const po = file.createDocument({
    type: 'purchase_order', number: 'PO-1', date: '2026-06-01', partyId: supplier.id,
    lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n }],
  });
  file.sendDocument(po.id);
  const bill = file.convertDocument(po.id, { type: 'bill', number: 'BILL-1', date: '2026-06-05' });
  file.sendDocument(bill.id); // 12 × 10.00 cost history = 120.00
  return { widget, supplier, po, bill };
}

function mapRoles() {
  const cash = file.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
  const ar = file.createAccount({ name: 'A/R', type: 'asset', currency: 'USD', code: '1100' });
  const ap = file.createAccount({ name: 'A/P', type: 'liability', currency: 'USD', code: '2000' });
  const income = file.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
  const purchases = file.createAccount({ name: 'Purchases', type: 'expense', currency: 'USD', code: '5000' });
  file.setPostingAccount('cash', cash.id);
  file.setPostingAccount('accounts_receivable', ar.id);
  file.setPostingAccount('accounts_payable', ap.id);
  file.setPostingAccount('sales_income', income.id);
  file.setPostingAccount('purchases_expense', purchases.id);
  return { cash, ar, ap, income, purchases };
}

describe('vendor credits persist (ADR 0013)', () => {
  it('applies to bills, posts to A/P, and survives reopen', () => {
    const { ap, purchases } = mapRoles(); // before the bill is sent, so it posts
    const { widget, supplier, bill } = setUpBilled();
    const credit = file.createDocument({
      type: 'vendor_credit', number: 'VC-1', date: '2026-06-10', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Returned to supplier', quantityMilli: 4000n, unitPrice: 1000n }],
    });
    file.sendDocument(credit.id); // DR AP 40 / CR purchases 40
    file.applyCredit({ sourceKind: 'vendor_credit', sourceId: credit.id, invoiceId: bill.id, amount: 4000n });

    file.close();
    file = CompanyFile.open(books);
    expect(file.invoiceSettlement(bill.id)).toMatchObject({ paid: 4000n, open: 8000n });
    const balance = file.trialBalance();
    const net = (id: string) => balance.rows.find((row) => row.accountId === id)?.net ?? 0n;
    expect(net(ap.id)).toBe(-8000n); // 120 bill − 40 credit
    expect(net(purchases.id)).toBe(8000n);
  });
});

describe('credit refunds persist (ADR 0013)', () => {
  it('posts by direction and reversal unwinds the entry', () => {
    const { widget } = setUpBilled();
    const { cash, ar } = mapRoles();
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-06-10', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    file.sendDocument(invoice.id); // 50.00
    const payment = file.recordPayment({
      number: 'PMT-1', date: '2026-06-11', customerName: 'Acme LLC', amount: 8000n,
      applications: [{ invoiceId: invoice.id, amount: 5000n }],
    });

    const refund = file.refundCredit({ sourceKind: 'payment', sourceId: payment.id, amount: 3000n, date: '2026-06-12' });
    expect(refund.refund).toBe(true);
    let balance = file.trialBalance();
    const net = (id: string) => balance.rows.find((row) => row.accountId === id)?.net ?? 0n;
    // Cash: +80 payment − 30 refund; AR: +50 invoice − 80 payment + 30 refund.
    expect(net(cash.id)).toBe(5000n);
    expect(net(ar.id)).toBe(0n);
    expect(file.listPostings('refund', String(refund.applicationSeq))).toHaveLength(1);

    // Reversing the refund reverses its journal entry too.
    file.reverseApplication(refund.applicationSeq);
    balance = file.trialBalance();
    expect(net(cash.id)).toBe(8000n);
    expect(net(ar.id)).toBe(-3000n); // 30 back on account
    expect(file.listPostings('refund', String(refund.applicationSeq))).toHaveLength(2);

    // Statement shows the on-account money again.
    const statement = file.statement({ customerName: 'Acme LLC' }, '2026-06-30');
    expect(statement.payments[0]).toMatchObject({ appliedAmount: 5000n, refundedAmount: 0n, unappliedAmount: 3000n });
  });
});

describe('cash transactions persist (ADR 0013)', () => {
  it('recordSalesReceipt and recordExpense are atomic and settle in full', () => {
    const { widget, supplier } = setUpBilled();
    file.setNumberSequence('invoice', { prefix: 'INV-' });
    file.setNumberSequence('bill', { prefix: 'BILL-9' });
    file.setNumberSequence('payment', { prefix: 'PMT-' });

    const sale = file.recordSalesReceipt({
      date: '2026-06-20', customerName: 'Walk-in', method: 'cash',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(sale.document.status).toBe('sent');
    expect(sale.payment!.amountMinor).toBe(2500n);
    expect(file.invoiceSettlement(sale.document.id).status).toBe('paid');

    const expense = file.recordExpense({
      date: '2026-06-21', partyId: supplier.id, method: 'card',
      lines: [{ itemId: widget.id, description: 'Supplies', quantityMilli: 1000n }],
    });
    expect(expense.payment!.direction).toBe('out');
    expect(file.invoiceSettlement(expense.document.id).status).toBe('paid');
  });
});

describe('supplier statements persist (ADR 0013)', () => {
  it('mirrors the customer statement for the payable side', () => {
    const { supplier, bill } = setUpBilled();
    file.recordPayment({
      number: 'PMT-7', direction: 'out', date: '2026-06-15', partyId: supplier.id, amount: 7000n,
      applications: [{ invoiceId: bill.id, amount: 7000n }],
    });
    const statement = file.supplierStatementForParty(supplier.id, '2026-08-01');
    expect(statement.invoices.map((entry) => entry.number)).toEqual(['BILL-1']);
    expect(statement.invoices[0]!.openAmount).toBe(5000n);
    expect(statement.payments.map((entry) => entry.number)).toEqual(['PMT-7']);
    expect(statement.balance).toBe(5000n);
  });
});
