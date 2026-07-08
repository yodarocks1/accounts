import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-cogs-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function mapInventoryRoles() {
  const cash = file.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
  const ar = file.createAccount({ name: 'A/R', type: 'asset', currency: 'USD', code: '1100' });
  const inv = file.createAccount({ name: 'Inventory', type: 'asset', currency: 'USD', code: '1200' });
  const ap = file.createAccount({ name: 'A/P', type: 'liability', currency: 'USD', code: '2000' });
  const grni = file.createAccount({ name: 'GRNI', type: 'liability', currency: 'USD', code: '2100' });
  const income = file.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
  const cogs = file.createAccount({ name: 'COGS', type: 'expense', currency: 'USD', code: '5000' });
  const pur = file.createAccount({ name: 'Purchases', type: 'expense', currency: 'USD', code: '5100' });
  file.setPostingAccount('cash', cash.id);
  file.setPostingAccount('accounts_receivable', ar.id);
  file.setPostingAccount('inventory_asset', inv.id);
  file.setPostingAccount('accounts_payable', ap.id);
  file.setPostingAccount('goods_received_not_invoiced', grni.id);
  file.setPostingAccount('sales_income', income.id);
  file.setPostingAccount('cogs', cogs.id);
  file.setPostingAccount('purchases_expense', pur.id);
  return { cash, ar, inv, ap, grni, income, cogs, pur };
}

describe('receipts and COGS persist (ADR 0015)', () => {
  it('drives the three-way flow: PO → receipt → bill → invoice with GRNI and COGS', () => {
    const roles = mapInventoryRoles();
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const net = (id: string) => file.trialBalance().rows.find((row) => row.accountId === id)?.net ?? 0n;

    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 900n, lineId: 'P1' }],
    });
    file.sendDocument(po.id);

    // Receipt: goods arrive. DR inventory 90 / CR GRNI 90.
    const receipt = file.convertDocument(po.id, { type: 'receipt', number: 'RCT-1', date: '2026-07-05' });
    file.sendDocument(receipt.id);
    expect(file.stockOnHand(widget.id).goodMilli).toBe(10_000n);
    expect(net(roles.inv.id)).toBe(9000n);
    expect(net(roles.grni.id)).toBe(-9000n);

    // Bill: clears GRNI. DR GRNI 90 / CR AP 90. No re-stocking, no new inventory.
    const bill = file.convertDocument(receipt.id, { type: 'bill', number: 'BILL-1', date: '2026-07-10' });
    file.sendDocument(bill.id);
    expect(file.stockOnHand(widget.id).goodMilli).toBe(10_000n);
    expect(net(roles.grni.id)).toBe(0n);
    expect(net(roles.inv.id)).toBe(9000n);
    expect(net(roles.ap.id)).toBe(-9000n);

    // Invoice: revenue + COGS at FIFO (9.00/unit).
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-15', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }], // 4 × 25.00 = 100.00
    });
    file.sendDocument(invoice.id);
    expect(net(roles.ar.id)).toBe(10_000n);
    expect(net(roles.income.id)).toBe(-10_000n);
    expect(net(roles.cogs.id)).toBe(3600n); // 4 × 9.00
    expect(net(roles.inv.id)).toBe(5400n); // 6 × 9.00 left

    // Books balance and inventory account reconciles to the FIFO valuation.
    const tb = file.trialBalance().totals.get('USD')!;
    expect(tb.debits).toBe(tb.credits);
    expect(file.itemValuation(widget.id).valueMinor).toBe(net(roles.inv.id));

    file.close();
    file = CompanyFile.open(books);
    expect(file.itemValuation(widget.id).valueMinor).toBe(5400n);
  });

  it('direct bill (no receipt) posts DR inventory / CR AP and FIFO survives correction', () => {
    const roles = mapInventoryRoles();
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const net = (id: string) => file.trialBalance().rows.find((row) => row.accountId === id)?.net ?? 0n;

    const bill = file.createDocument({
      type: 'bill', number: 'BILL-2', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 900n, lineId: 'L1' }],
    });
    file.sendDocument(bill.id);
    expect(net(roles.inv.id)).toBe(9000n);
    expect(net(roles.grni.id)).toBe(0n); // nothing received in advance

    // Correct the bill down: inventory value and posting both follow.
    file.changeDocument(bill.id, {
      kind: 'correction', reason: 'short shipped',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 6000n, unitPrice: 900n, lineId: 'L1' }],
    });
    expect(file.stockOnHand(widget.id).goodMilli).toBe(6000n);
    expect(net(roles.inv.id)).toBe(5400n);
    expect(net(roles.ap.id)).toBe(-5400n);
    const tb = file.trialBalance().totals.get('USD')!;
    expect(tb.debits).toBe(tb.credits);
  });

  it('degrades gracefully: without inventory roles, bills expense and invoices post revenue only', () => {
    // Only the classic roles mapped.
    const cash = file.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
    const ar = file.createAccount({ name: 'A/R', type: 'asset', currency: 'USD', code: '1100' });
    const ap = file.createAccount({ name: 'A/P', type: 'liability', currency: 'USD', code: '2000' });
    const income = file.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
    const pur = file.createAccount({ name: 'Purchases', type: 'expense', currency: 'USD', code: '5100' });
    file.setPostingAccount('cash', cash.id);
    file.setPostingAccount('accounts_receivable', ar.id);
    file.setPostingAccount('accounts_payable', ap.id);
    file.setPostingAccount('sales_income', income.id);
    file.setPostingAccount('purchases_expense', pur.id);
    const net = (id: string) => file.trialBalance().rows.find((row) => row.accountId === id)?.net ?? 0n;

    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const bill = file.createDocument({
      type: 'bill', number: 'BILL-3', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 900n }],
    });
    file.sendDocument(bill.id);
    expect(net(pur.id)).toBe(9000n); // expensed, not capitalized
    expect(net(ap.id)).toBe(-9000n);

    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-07-02', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    file.sendDocument(invoice.id);
    expect(net(ar.id)).toBe(10_000n);
    expect(net(income.id)).toBe(-10_000n);
    // No COGS/inventory postings exist — but stock is still tracked.
    expect(file.stockOnHand(widget.id).goodMilli).toBe(6000n);
  });
});
