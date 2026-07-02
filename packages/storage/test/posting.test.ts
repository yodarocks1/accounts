import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function net(accountId: string): bigint {
  const row = file.trialBalance().rows.find((entry) => entry.accountId === accountId);
  return row?.net ?? 0n;
}

let ar: string;
let income: string;
let cash: string;
let widget: { id: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-post-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Test Co', baseCurrency: 'USD' });
  ar = file.createAccount({ name: 'Accounts Receivable', type: 'asset', currency: 'USD', code: '1100' }).id;
  income = file.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' }).id;
  cash = file.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' }).id;
  widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function configureRoles() {
  file.setPostingAccount('accounts_receivable', ar);
  file.setPostingAccount('sales_income', income);
  file.setPostingAccount('cash', cash);
}

function sendInvoice(number: string, quantityMilli: bigint) {
  const invoice = file.createDocument({
    type: 'invoice', number, date: '2026-07-01', ...acme,
    lines: [{ itemId: widget.id, description: 'Widget', quantityMilli }],
  });
  file.sendDocument(invoice.id);
  return invoice;
}

describe('ledger posting (Tier 1)', () => {
  it('does nothing until roles are configured', () => {
    sendInvoice('INV-0', 4000n);
    expect(file.listPostings()).toHaveLength(0);
    expect(file.trialBalance().rows).toHaveLength(0);
  });

  it('posts invoices, payments, and credits; trial balance stays balanced', () => {
    configureRoles();
    const invoice = sendInvoice('INV-1', 4000n); // 100.00
    expect(net(ar)).toBe(10000n);
    expect(net(income)).toBe(-10000n);

    const payment = file.recordPayment({
      number: 'PMT-1', date: '2026-07-05', ...acme, amount: 10000n,
      applications: [{ invoiceId: invoice.id, amount: 10000n }],
    });
    expect(net(cash)).toBe(10000n);
    expect(net(ar)).toBe(0n);

    // Refund credit memo: DR income / CR cash.
    const refund = file.createReturn({
      number: 'CR-1', date: '2026-07-06', ...acme, settlement: 'refund',
      items: [{ itemId: widget.id, quantityMilli: 1000n }], // last paid 25.00
    });
    file.sendDocument(refund.id);
    expect(net(income)).toBe(-10000n + 2500n);
    expect(net(cash)).toBe(10000n - 2500n);

    // Books always balance.
    for (const [, totals] of file.trialBalance().totals) {
      expect(totals.debits).toBe(totals.credits);
    }
    expect(file.listPostings('payment', payment.id)).toHaveLength(1);
  });

  it('a charge correction reverses and reposts in one transaction', () => {
    configureRoles();
    const invoice = sendInvoice('INV-2', 4000n); // 100.00
    file.chargeCorrection(invoice.id, 9000n, 'charged $90');
    expect(net(ar)).toBe(9000n);
    expect(net(income)).toBe(-9000n);
    const postings = file.listPostings('document', invoice.id);
    expect(postings.map((entry) => entry.kind)).toEqual(['post', 'reversal', 'post']);
    // The journal has full history: original, reversal, corrected.
    expect(file.listEntries()).toHaveLength(3);
  });

  it('voiding reverses the posting', () => {
    configureRoles();
    const invoice = sendInvoice('INV-3', 4000n);
    file.voidDocument(invoice.id);
    expect(net(ar)).toBe(0n);
    expect(net(income)).toBe(0n);

    const payment = file.recordPayment({ number: 'PMT-2', date: '2026-07-05', ...acme, amount: 5000n });
    expect(net(cash)).toBe(5000n);
    file.voidPayment(payment.id);
    expect(net(cash)).toBe(0n);
  });

  it('account credit memos post DR income / CR AR', () => {
    configureRoles();
    sendInvoice('INV-4', 4000n); // history for the return
    const credit = file.createReturn({
      number: 'CR-2', date: '2026-07-06', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    file.sendDocument(credit.id);
    expect(net(ar)).toBe(10000n - 2500n);
    expect(net(income)).toBe(-(10000n - 2500n));
  });
});
