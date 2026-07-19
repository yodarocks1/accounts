#!/usr/bin/env node
/**
 * Seed a demo company file (demo.sqlite at the repo root) with one small
 * business's July: stocked purchases through PO → receipt → bill, a sales
 * family EST → SO → partial invoice, a cash sale, an assembly build,
 * damaged stock, and a bank export left deliberately unreconciled — so
 * every screen of the web UI has something real to show and something
 * left for you to do.
 *
 * Run from the repo root after `pnpm build`:  node examples/demo/seed.mjs
 */
import { existsSync } from 'node:fs';
import { CompanyFile } from '../../packages/storage/dist/index.js';

const PATH = 'demo.sqlite';
if (existsSync(PATH)) {
  console.error(`${PATH} already exists — delete it first to reseed.`);
  process.exit(1);
}

const file = CompanyFile.create(PATH, { name: 'Demo Books Inc', baseCurrency: 'USD' });

// ── Chart of accounts + posting roles: full accounting switched on ──────────
const account = (name, type, code) => file.createAccount({ name, type, code, currency: 'USD' });
const cash = account('Cash', 'asset', '1000');
const ar = account('Accounts Receivable', 'asset', '1100');
const inventory = account('Inventory', 'asset', '1200');
const ap = account('Accounts Payable', 'liability', '2000');
const grni = account('Goods Received Not Invoiced', 'liability', '2100');
const taxPayable = account('Sales Tax Payable', 'liability', '2200');
const sales = account('Sales', 'income', '4000');
const cogs = account('Cost of Goods Sold', 'expense', '5000');
const purchases = account('Purchases', 'expense', '5100');
for (const [role, acct] of [
  ['cash', cash], ['accounts_receivable', ar], ['inventory_asset', inventory],
  ['accounts_payable', ap], ['goods_received_not_invoiced', grni],
  ['sales_tax_payable', taxPayable], ['sales_income', sales],
  ['cogs', cogs], ['purchases_expense', purchases],
]) {
  file.setPostingAccount(role, acct.id);
}

// ── Numbering, tax, items, parties ──────────────────────────────────────────
for (const [kind, prefix] of [
  ['estimate', 'EST-'], ['sales_order', 'SO-'], ['invoice', 'INV-'],
  ['purchase_order', 'PO-'], ['receipt', 'RCT-'], ['bill', 'BILL-'], ['payment', 'PMT-'],
]) {
  file.setNumberSequence(kind, { prefix });
}
file.setTaxRate({ code: 'TX', name: 'State sales tax', percentMilli: 8_250n });

const widget = file.createItem({
  name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 900n, taxCode: 'TX', kind: 'inventory',
});
const caseOf12 = file.createItem({
  name: 'Widget Case (12)', currency: 'USD', unitPrice: 27_000n, taxCode: 'TX', kind: 'inventory',
});
const install = file.createItem({
  name: 'Installation', currency: 'USD', unitPrice: 4000n, kind: 'service',
});
file.setBom({ itemId: caseOf12.id, components: [{ componentItemId: widget.id, quantityMilli: 12_000n }], assemblyCostMinor: 150n });

const acme = file.createParty({ name: 'Acme LLC', accountNumber: 'A-100', termsDays: 30 });
const bluebird = file.createParty({ name: 'Bluebird Cafe', accountNumber: 'B-200' });
const supplier = file.createParty({ name: 'Widgets Wholesale' });
file.recordSupplierInfo({
  partyId: supplier.id, asOf: '2026-06-01', currency: 'USD',
  minimumOrderMinor: 5000n,
  items: [{ itemId: widget.id, unitCost: 900n, leadDays: 5 }],
});

// ── Stock in: PO → receipt → bill (three-way, GRNI), then pay the bill ──────
const po1 = file.createDocument({
  type: 'purchase_order', date: '2026-06-10', partyId: supplier.id,
  lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 40_000n }],
});
file.sendDocument(po1.id);
const receipt = file.convertDocument(po1.id, { type: 'receipt', date: '2026-06-12' });
file.sendDocument(receipt.id);
const bill = file.convertDocument(receipt.id, { type: 'bill', date: '2026-06-15' });
file.sendDocument(bill.id);
file.recordPayment({
  date: '2026-06-20', partyId: supplier.id, direction: 'out', amount: 36_000n, method: 'check 501',
  applications: [{ invoiceId: bill.id, amount: 36_000n }],
});

// ── The sales family: estimate → sales order → partial invoice ──────────────
const estimate = file.createDocument({
  type: 'estimate', date: '2026-07-01', partyId: acme.id,
  lines: [
    { itemId: widget.id, description: 'Widget', quantityMilli: 10_000n },
    { itemId: install.id, description: 'Installation', quantityMilli: 2_000n },
  ],
});
file.sendDocument(estimate.id);
const so = file.convertDocument(estimate.id, { type: 'sales_order', date: '2026-07-02' });
file.sendDocument(so.id);
const soLines = file.viewDocument(so.id).current.lines;
const soWidget = soLines.find((line) => line.itemId === widget.id);
const soInstall = soLines.find((line) => line.itemId === install.id);
const invoice = file.convertDocument(so.id, {
  type: 'invoice', date: '2026-07-06',
  lines: [
    { sourceLineId: soWidget.lineId, quantityMilli: 6_000n },
    { sourceLineId: soInstall.lineId },
  ],
});
file.sendDocument(invoice.id);
const acmePayment = file.recordPayment({
  date: '2026-07-10', partyId: acme.id, amount: 15_000n, method: 'ACH',
  applications: [{ invoiceId: invoice.id, amount: 15_000n }],
});

// A draft PO cross-linked to the SO's open widgets — Send it from the UI.
file.createDocument({
  type: 'purchase_order', date: '2026-07-12', partyId: supplier.id,
  lines: [{
    itemId: widget.id, description: 'Widget', quantityMilli: 2_000n,
    sourceDocumentId: so.id, sourceLineId: soWidget.lineId,
  }],
});

// ── A cash sale, an assembly build, and some bad luck ───────────────────────
const sale = file.recordSalesReceipt({
  date: '2026-07-08', partyId: bluebird.id, method: 'card',
  lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2_000n }],
});
file.buildAssembly(caseOf12.id, 1_000n, { date: '2026-07-05', reason: 'shelf stock' });
file.markDamaged(widget.id, 2_000n, { reason: 'forklift incident', date: '2026-07-09' });
file.disposeStock(widget.id, 1_000n, 'trash', { reason: 'beyond repair', date: '2026-07-09' });

// ── The bank's July: three matches waiting, one mystery fee ─────────────────
file.importBankTransactions('first-national', [
  'date,amount,description',
  '2026-06-20,-360.00,CHECK 501 WIDGETS WHOLESALE',
  `2026-07-08,${sale.payment.amountMinor / 100n}.${(sale.payment.amountMinor % 100n).toString().padStart(2, '0')},CARD BATCH 4412`,
  '2026-07-10,150.00,ACH ACME LLC',
  '2026-07-15,-12.00,SERVICE FEE',
].join('\n'));

const balance = file.trialBalance();
const balanced = balance.totals.debit === balance.totals.credit;
file.close();

console.log(`Seeded ${PATH} — trial balance ${balanced ? 'BALANCED' : 'OUT OF BALANCE (bug!)'}`);
console.log(`
The story inside (one transaction = one number, ADR 0022):
  EST-0001 → EST-0001b (sales order) → EST-0001c (invoice: 6 of 10 widgets, ${acmePayment.number} applied)
  EST-0001d — draft purchase order cross-linked to the order's open widgets; try sending it
  PO-0001 → PO-0001b (receipt) → PO-0001c (bill, paid) — 40 widgets in
  INV-0001 — a cash sale, unlinked, so it draws its own sequence
  One assembly built, two widgets damaged (one trashed)
  Bank: 4 lines imported, 3 matches waiting for you, 1 fee that never matches

Serve it:  node packages/cli/dist/main.js serve demo.sqlite --port 3000 --web packages/web/dist`);
