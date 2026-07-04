import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-bills-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function setUpPurchase() {
  const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const supplier = file.createParty({ name: 'Widgets Wholesale Inc', accountNumber: 'S-7' });
  file.recordSupplierInfo({
    partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
    items: [{ itemId: widget.id, unitCost: 900n }],
  });
  const po = file.createDocument({
    type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
    lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n, lineId: 'P1' }],
  });
  file.sendDocument(po.id);
  return { widget, supplier, po };
}

describe('vendor bills persist (ADR 0012)', () => {
  it('converts PO→bill, posts to A/P, and settles with an outbound payment', () => {
    const { supplier, po } = setUpPurchase();
    // Map the A/P roles; posting activates.
    const cash = file.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
    const ap = file.createAccount({ name: 'Accounts Payable', type: 'liability', currency: 'USD', code: '2000' });
    const purchases = file.createAccount({ name: 'Purchases', type: 'expense', currency: 'USD', code: '5000' });
    file.setPostingAccount('cash', cash.id);
    file.setPostingAccount('accounts_payable', ap.id);
    file.setPostingAccount('purchases_expense', purchases.id);

    const bill = file.convertDocument(po.id, { type: 'bill', number: 'BILL-1', date: '2026-07-10' });
    expect(bill.total).toBe(10_800n); // 12 × 9.00 at the PO price
    expect(file.fulfillment(po.id)[0]!.convertedMilli).toBe(12_000n);

    file.sendDocument(bill.id); // approve: DR purchases / CR AP
    let balance = file.trialBalance();
    const net = (id: string) => balance.rows.find((row) => row.accountId === id)?.net ?? 0n;
    expect(net(purchases.id)).toBe(10_800n);
    expect(net(ap.id)).toBe(-10_800n);

    // Outbound payment: DR AP / CR cash, applied to the bill.
    file.recordPayment({
      direction: 'out', number: 'PMT-1', date: '2026-07-12', partyId: supplier.id, amount: 10_800n,
      applications: [{ invoiceId: bill.id, amount: 10_800n }],
    });
    expect(file.invoiceSettlement(bill.id).status).toBe('paid');
    balance = file.trialBalance();
    expect(net(ap.id)).toBe(0n);
    expect(net(cash.id)).toBe(-10_800n);
    expect(balance.totals.get('USD')!.debits).toBe(balance.totals.get('USD')!.credits);
  });

  it('direction round-trips, is frozen by triggers, and never crosses', () => {
    const { widget, po } = setUpPurchase();
    const bill = file.convertDocument(po.id, { type: 'bill', number: 'BILL-2', date: '2026-07-10' });
    file.sendDocument(bill.id);

    // Inbound money cannot settle a bill.
    const inbound = file.recordPayment({
      number: 'PMT-IN', date: '2026-07-11', customerName: 'Widgets Wholesale Inc', accountNumber: 'S-7', amount: 500n,
    });
    expect(inbound.direction).toBe('in');
    expect(() =>
      file.applyCredit({ sourceKind: 'payment', sourceId: inbound.id, invoiceId: bill.id, amount: 500n }),
    ).toThrowError(/settled by outbound payments/);

    const outbound = file.recordPayment({
      direction: 'out', number: 'PMT-OUT', date: '2026-07-12',
      customerName: 'Widgets Wholesale Inc', accountNumber: 'S-7', amount: 500n,
    });
    file.close();
    file = CompanyFile.open(books);
    expect(file.getPayment(outbound.id)!.direction).toBe('out');

    // Outbound payments stay off customer statements.
    const statement = file.statement({ accountNumber: 'S-7' }, '2026-07-31');
    expect(statement.payments.map((payment) => payment.number)).toEqual(['PMT-IN']);

    file.close();
    const raw = new Database(books);
    expect(() => raw.prepare(`UPDATE payments SET direction = 'in' WHERE number = 'PMT-OUT'`).run()).toThrowError(
      /only payment status may change/,
    );
    raw.close();
    file = CompanyFile.open(books);
    void widget;
  });

  it('bills draw from their own number sequence', () => {
    const { po } = setUpPurchase();
    file.setNumberSequence('bill', { prefix: 'BILL-', width: 3 });
    const bill = file.convertDocument(po.id, { type: 'bill', date: '2026-07-10' });
    expect(bill.number).toBe('BILL-001');
  });
});
