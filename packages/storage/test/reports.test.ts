import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-reports-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('financial reports (ADR 0017)', () => {
  it('P&L and balance sheet derive from the journal and always balance', () => {
    // Full inventory-accounting book so COGS shows on the P&L.
    const cash = file.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
    const ar = file.createAccount({ name: 'A/R', type: 'asset', currency: 'USD', code: '1100' });
    const inv = file.createAccount({ name: 'Inventory', type: 'asset', currency: 'USD', code: '1200' });
    const ap = file.createAccount({ name: 'A/P', type: 'liability', currency: 'USD', code: '2000' });
    const income = file.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
    const cogs = file.createAccount({ name: 'COGS', type: 'expense', currency: 'USD', code: '5000' });
    const pur = file.createAccount({ name: 'Purchases', type: 'expense', currency: 'USD', code: '5100' });
    file.setPostingAccount('cash', cash.id);
    file.setPostingAccount('accounts_receivable', ar.id);
    file.setPostingAccount('inventory_asset', inv.id);
    file.setPostingAccount('accounts_payable', ap.id);
    file.setPostingAccount('sales_income', income.id);
    file.setPostingAccount('cogs', cogs.id);
    file.setPostingAccount('purchases_expense', pur.id);

    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const bill = file.createDocument({
      type: 'bill', number: 'BILL-1', date: '2026-06-15', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 900n }],
    });
    file.sendDocument(bill.id); // DR inventory 90 / CR AP 90 — no P&L effect
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-10', customerName: 'Acme LLC', termsDays: 30,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }], // 100.00 revenue, 36.00 COGS
    });
    file.sendDocument(invoice.id);

    // July P&L: 100 income, 36 COGS, 64 profit. June purchase is NOT expense.
    const pnl = file.profitAndLoss('2026-07-01', '2026-07-31');
    expect(pnl.totalIncome).toBe(10_000n);
    expect(pnl.totalExpense).toBe(3600n);
    expect(pnl.netProfit).toBe(6400n);
    expect(file.profitAndLoss('2026-06-01', '2026-06-30').netProfit).toBe(0n);

    // Balance sheet: AR 100 + inventory 54 = AP 90 + retained 64.
    const sheet = file.balanceSheet('2026-07-31');
    expect(sheet.balanced).toBe(true);
    expect(sheet.totalAssets).toBe(15_400n);
    expect(sheet.totalLiabilities).toBe(9000n);
    expect(sheet.equity.find((row) => row.name === 'Retained earnings')!.amount).toBe(6400n);
    // Inventory account reconciles to the FIFO summary.
    expect(file.inventorySummary().totalValueMinor).toBe(5400n);

    // A mid-period as-of excludes later activity.
    expect(file.balanceSheet('2026-06-30').totalAssets).toBe(9000n);
  });

  it('A/R and A/P aging bucket open documents per counterparty', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const supplier = file.createParty({ name: 'Supplier Inc', accountNumber: 'S-1' });

    // Two customers: one past due, one current; one partially paid.
    const overdue = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-05-01', customerName: 'Slowpay LLC', termsDays: 30,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }], // 100.00
    });
    file.sendDocument(overdue.id);
    const current = file.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-07-25', customerName: 'Acme LLC', termsDays: 30,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }], // 50.00
    });
    file.sendDocument(current.id);
    file.recordPayment({
      number: 'PMT-1', date: '2026-07-26', customerName: 'Acme LLC', amount: 2000n,
      applications: [{ invoiceId: current.id, amount: 2000n }],
    });
    // A paid invoice must not appear at all.
    const paid = file.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-07-01', customerName: 'Paidup Inc',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    file.sendDocument(paid.id);
    file.recordPayment({
      number: 'PMT-2', date: '2026-07-02', customerName: 'Paidup Inc', amount: 2500n,
      applications: [{ invoiceId: paid.id, amount: 2500n }],
    });

    const ar = file.arAging('2026-07-31');
    expect(ar.rows.map((row) => row.name)).toEqual(['Slowpay LLC', 'Acme LLC']);
    const slowpay = ar.rows[0]!;
    expect(slowpay.buckets.find((bucket) => bucket.label === 'past due')!.amount).toBe(10_000n);
    const acme = ar.rows[1]!;
    expect(acme.buckets.find((bucket) => bucket.label === 'not due')!.amount).toBe(3000n);
    expect(ar.grandTotal).toBe(13_000n);

    // A/P side: one open bill.
    const bill = file.createDocument({
      type: 'bill', number: 'BILL-1', date: '2026-06-01', partyId: supplier.id, termsDays: 30,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n, unitPrice: 900n }],
    });
    file.sendDocument(bill.id);
    const ap = file.apAging('2026-07-31');
    expect(ap.rows).toHaveLength(1);
    expect(ap.rows[0]!.name).toBe('Supplier Inc');
    // Due 07-01, aged exactly 30 days at 07-31: the 'due soon' (23–30) bucket.
    expect(ap.rows[0]!.buckets.find((bucket) => bucket.label === 'due soon')!.amount).toBe(3600n);
    expect(ap.grandTotal).toBe(3600n);
  });
});
