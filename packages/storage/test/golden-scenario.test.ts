import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '@accounts/core';
import { demoSupplierPlugin } from '@accounts/plugin-demo-supplier';
import { CompanyFile } from '../src/index.js';

/**
 * The golden scenario (SPIKE.md WS4): one business's story, told once,
 * across every subsystem — sales, purchasing, inventory, plugins, money in
 * and out, a return, and the reports — asserting the books balance at every
 * chapter. This is the spike's demonstrable artifact.
 */

let dir: string;
let file: CompanyFile;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-golden-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Golden Widget Co', baseCurrency: 'USD' });
});

afterAll(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function assertBalanced() {
  const totals = file.trialBalance().totals.get('USD');
  if (totals) expect(totals.debits).toBe(totals.credits);
}

function net(accountId: string): bigint {
  return file.trialBalance().rows.find((row) => row.accountId === accountId)?.net ?? 0n;
}

describe('the golden scenario', () => {
  // Shared story state, built up chapter by chapter.
  const S = {} as {
    cash: string; ar: string; inv: string; ap: string; grni: string; tax: string;
    income: string; cogs: string; pur: string;
    piece: string; box: string; labor: string; custom: string;
    acme: string; supplier: string;
    soId: string; customLineId: string; poId: string; invoiceId: string;
  };

  it('ch.1 — a company with a full inventory-accounting chart', () => {
    const make = (name: string, type: 'asset' | 'liability' | 'equity' | 'income' | 'expense', code: string) =>
      file.createAccount({ name, type, currency: 'USD', code }).id;
    S.cash = make('Cash', 'asset', '1000');
    S.ar = make('Accounts Receivable', 'asset', '1100');
    S.inv = make('Inventory', 'asset', '1200');
    S.ap = make('Accounts Payable', 'liability', '2000');
    S.grni = make('Goods Received Not Invoiced', 'liability', '2100');
    S.tax = make('Sales Tax Payable', 'liability', '2200');
    S.income = make('Sales', 'income', '4000');
    S.cogs = make('Cost of Goods Sold', 'expense', '5000');
    S.pur = make('Purchases', 'expense', '5100');
    file.setPostingAccount('cash', S.cash);
    file.setPostingAccount('accounts_receivable', S.ar);
    file.setPostingAccount('inventory_asset', S.inv);
    file.setPostingAccount('accounts_payable', S.ap);
    file.setPostingAccount('goods_received_not_invoiced', S.grni);
    file.setPostingAccount('sales_tax_payable', S.tax);
    file.setPostingAccount('sales_income', S.income);
    file.setPostingAccount('cogs', S.cogs);
    file.setPostingAccount('purchases_expense', S.pur);
    file.setTaxRate({ code: 'TX', percentMilli: 10_000n }); // 10%
    file.setNumberSequence('payment', { prefix: 'PMT-' });
    assertBalanced();
  });

  it('ch.2 — a catalog with pieces, boxes (BOM), labor, and a special-order part', () => {
    S.piece = file.createItem({ name: 'Piece', currency: 'USD', unitPrice: 300n, cost: 100n, taxCode: 'TX', kind: 'inventory' }).id;
    S.box = file.createItem({ name: 'Box of 12', currency: 'USD', unitPrice: 3000n, taxCode: 'TX', kind: 'inventory' }).id;
    file.setBom({ itemId: S.box, components: [{ componentItemId: S.piece, quantityMilli: 12_000n }] });
    S.labor = file.createItem({ name: 'Install labor (hour)', currency: 'USD', unitPrice: 6000n, cost: 2000n, kind: 'service' }).id;
    S.custom = file.createItem({
      name: 'Custom part', currency: 'USD', unitPrice: 50_000n, cost: 30_000n, taxCode: 'TX', depositPolicy: 'special_order',
    }).id;
    // The box's cost derives through its BOM: 12 × 1.00.
    expect(file.costAt(S.box, '2026-06-01')).toBe(1200n);
    S.acme = file.createParty({ name: 'Acme LLC', accountNumber: 'A-100', termsDays: 30 }).id;
    S.supplier = file.createParty({ name: 'Widgets Wholesale Inc', accountNumber: 'S-1' }).id;
  });

  it('ch.3 — the supplier plugin quotes terms with provenance', async () => {
    const host = new PluginHost<CompanyFile>();
    host.register(demoSupplierPlugin({
      partyId: S.supplier,
      itemCosts: { [S.piece]: 100n, [S.custom]: 30_000n },
      minimumOrderMinor: 5000n,
      prepaymentPercentMilli: 50_000n,
      leadDays: 7,
    }));
    file.attachPlugins(host);
    const info = await file.refreshSupplierInfo(S.supplier);
    expect(info.source).toBe('demo-supplier');
    expect(info.prepaymentPercentMilli).toBe(50_000n);
  });

  it('ch.4 — estimate → sales order; the special-order part demands full prepayment', () => {
    const estimate = file.createDocument({
      type: 'estimate', number: 'EST-1', date: '2026-06-20', partyId: S.acme,
      lines: [
        { itemId: S.box, description: 'Box of 12', quantityMilli: 2000n, lineId: 'E1' },
        { itemId: S.custom, description: 'Custom part', quantityMilli: 1000n, lineId: 'E2' },
        { itemId: S.labor, description: 'Install labor', quantityMilli: 2000n, lineId: 'E3' },
      ],
    });
    // 2×30 + 500 + 2×60 = 680.00 net; boxes + part taxed at 10% → 56.00 tax.
    expect(estimate.total).toBe(73_600n);
    file.sendDocument(estimate.id);
    const so = file.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', date: '2026-06-21' });
    S.soId = so.id;
    S.customLineId = so.current.lines.find((line) => line.itemId === S.custom)!.lineId;

    // Sending is gated: the special-order line's 550.00 gross must be prepaid.
    expect(() => file.sendDocument(so.id)).toThrowError(/must cover at least 55000/);
    file.changeDocument(so.id, { deposit: { amountMinor: 55_000n } });
    file.sendDocument(so.id);

    // The customer prepays that specific line.
    file.recordPayment({
      date: '2026-06-22', partyId: S.acme, amount: 55_000n, method: 'check #101',
      applications: [{ invoiceId: so.id, amount: 55_000n, lineId: S.customLineId }],
    });
    expect(file.depositHeld(so.id)).toBe(55_000n);
    expect(net(S.cash)).toBe(55_000n);
    assertBalanced();
  });

  it('ch.5 — a purchase order linked to the sale; we must prepay the supplier too', async () => {
    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-06-23', partyId: S.supplier,
      lines: [
        { itemId: S.piece, description: 'Piece', quantityMilli: 24_000n }, // stock for 2 boxes, 24.00
        {
          itemId: S.custom, description: 'Custom part', quantityMilli: 1000n,
          sourceDocumentId: S.soId, sourceLineId: S.customLineId, // line-linked to the sale
        },
      ],
    });
    S.poId = po.id;
    expect(po.total).toBe(32_400n); // costs from the plugin's quote
    // Floor = max(special-order gross 300.00, 50% × 324.00): must be committed.
    await expect(file.submitPurchaseOrder(po.id)).rejects.toThrowError(/must cover at least 30000/);
    file.changeDocument(po.id, { deposit: { amountMinor: 30_000n } });
    const { reference } = await file.submitPurchaseOrder(po.id);
    expect(reference).toBe('DEMO-0001'); // delivered by the plugin

    // Wire the supplier their deposit.
    file.recordPayment({
      direction: 'out', date: '2026-06-24', partyId: S.supplier, amount: 30_000n,
      applications: [{ invoiceId: S.poId, amount: 30_000n }],
    });
    expect(file.depositHeld(S.poId)).toBe(30_000n);
    assertBalanced();
  });

  it('ch.6 — goods arrive (receipt), the bill follows, the deposit rides along', () => {
    const receipt = file.convertDocument(S.poId, { type: 'receipt', number: 'RCT-1', date: '2026-06-30' });
    file.sendDocument(receipt.id);
    expect(file.stockOnHand(S.piece).goodMilli).toBe(24_000n);
    // Receipt accrues only tracked stock: DR inventory 24.00 / CR GRNI 24.00.
    expect(net(S.inv)).toBe(2400n);
    expect(net(S.grni)).toBe(-2400n);

    const bill = file.convertDocument(receipt.id, { type: 'bill', number: 'BILL-1', date: '2026-07-02' });
    file.sendDocument(bill.id);
    expect(net(S.grni)).toBe(0n); // accrual cleared
    expect(net(S.pur)).toBe(30_000n); // the non-inventory custom part is expensed
    // Our 300.00 deposit transferred from the PO; only 24.00 remains.
    expect(file.depositHeld(S.poId)).toBe(0n);
    expect(file.invoiceSettlement(bill.id)).toMatchObject({ paid: 30_000n, open: 2400n });
    file.recordPayment({
      direction: 'out', date: '2026-07-03', partyId: S.supplier, amount: 2400n,
      applications: [{ invoiceId: bill.id, amount: 2400n }],
    });
    expect(file.invoiceSettlement(bill.id).status).toBe('paid');
    assertBalanced();
  });

  it('ch.7 — build the boxes from pieces', () => {
    file.buildAssembly(S.box, 2000n, { date: '2026-07-05' });
    expect(file.stockOnHand(S.piece).goodMilli).toBe(0n);
    expect(file.stockOnHand(S.box).goodMilli).toBe(2000n);
    // Value moved, not created: still 24.00 of inventory.
    expect(file.inventorySummary().totalValueMinor).toBe(2400n);
    expect(file.inventorySummary().totalValueMinor).toBe(net(S.inv));
  });

  it('ch.8 — invoice the order: revenue, COGS, and the customer deposit land together', () => {
    const invoice = file.convertDocument(S.soId, { type: 'invoice', number: 'INV-1', date: '2026-07-08' });
    S.invoiceId = invoice.id;
    file.sendDocument(invoice.id);
    expect(file.stockOnHand(S.box).goodMilli).toBe(0n);
    expect(net(S.income)).toBe(-68_000n);
    expect(net(S.cogs)).toBe(2400n); // 2 boxes at derived 12.00
    expect(net(S.inv)).toBe(0n);
    // The 550.00 line prepayment transferred; Acme owes the rest.
    const settlement = file.invoiceSettlement(invoice.id);
    expect(settlement).toMatchObject({ paid: 55_000n, open: 18_600n });
    file.recordPayment({
      date: '2026-07-15', partyId: S.acme, amount: 18_600n, method: 'ACH',
      applications: [{ invoiceId: invoice.id, amount: 18_600n }],
    });
    expect(file.invoiceSettlement(invoice.id).status).toBe('paid');
    assertBalanced();
  });

  it('ch.9 — a damaged return: credited at purchase price, refunded, written off', () => {
    const memo = file.createReturn({
      number: 'CM-1', date: '2026-07-20', partyId: S.acme,
      items: [{ itemId: S.box, quantityMilli: 1000n, condition: 'damaged' }],
    });
    expect(memo.total).toBe(3300n); // 30.00 + the 10% tax Acme actually paid
    file.sendDocument(memo.id);
    expect(file.stockOnHand(S.box).damagedMilli).toBe(1000n);

    // Nothing left to apply it to — pay the credit back out.
    file.refundCredit({ sourceKind: 'credit_memo', sourceId: memo.id, amount: 3300n, date: '2026-07-21' });
    expect(net(S.ar)).toBe(0n);

    // The damaged box is trash; write-offs are gated.
    file.setApprovalPolicy(['stock_write_off']);
    expect(() => file.disposeStock(S.box, 1000n, 'trash', { date: '2026-07-22' })).toThrowError(/requires an approver/);
    file.disposeStock(S.box, 1000n, 'trash', { date: '2026-07-22', approvedBy: 'dana' });
    expect(file.stockOnHand(S.box).damagedMilli).toBe(0n);
    // Honest gap, by design: shrinkage posting is deferred (ADR 0015 §4), so
    // the G/L keeps the returned box's 12.00 until the shrinkage ADR lands.
    expect(net(S.inv) - file.inventorySummary().totalValueMinor).toBe(1200n);
    assertBalanced();
  });

  it('ch.10 — the reports tell the same story the ledger does', () => {
    const pnl = file.profitAndLoss('2026-06-01', '2026-07-31');
    expect(pnl.totalIncome).toBe(65_000n); // 680.00 sold − 30.00 returned
    expect(pnl.totalExpense).toBe(31_200n); // 300.00 special part + 12.00 net COGS
    expect(pnl.netProfit).toBe(33_800n);

    const sheet = file.balanceSheet('2026-07-31');
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.find((row) => row.name === 'Retained earnings')!.amount).toBe(33_800n);
    // Cash: +550 +186 −300 −24 −33 = 379.00.
    expect(net(S.cash)).toBe(37_900n);

    // Nobody owes anybody: both aging reports are clean.
    expect(file.arAging('2026-07-31').grandTotal).toBe(0n);
    expect(file.apAging('2026-07-31').grandTotal).toBe(0n);
    expect(file.supplierStatementForParty(S.supplier, '2026-07-31').balance).toBe(0n);

    // And the plugin still sees its pipeline.
    expect(file.runPluginReport('demo.purchase-pipeline')).toMatchObject({ openOrders: 1, numbers: ['PO-1'] });
    assertBalanced();
  });
});
