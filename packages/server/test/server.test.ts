import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PluginHost } from '@accounts/core';
import { CompanyFile } from '@accounts/storage';
import { demoSupplierPlugin } from '@accounts/plugin-demo-supplier';
import { createApiServer } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-api-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'API Co', baseCurrency: 'USD' });
  server = createApiServer(file);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: never }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as never };
}

describe('document API (Tier 3)', () => {
  it('drives the full sales flow over HTTP with string bigints', async () => {
    expect((await get('/company')).json).toEqual({ name: 'API Co', baseCurrency: 'USD' });

    await post('/tax-rates', { code: 'TX', percentMilli: '8250' });
    const widget = (await post('/items', {
      name: 'Widget', currency: 'USD', unitPrice: '2500', cost: '1000', taxCode: 'TX', depositPolicy: 'always',
    })).json as { id: string };
    const party = (await post('/parties', { name: 'Acme LLC', accountNumber: 'A-100', termsDays: 30 })).json as { id: string };
    await post('/sequences/sales_order', { prefix: 'SO-' });
    await post('/sequences/invoice', { prefix: 'INV-' });
    await post('/sequences/payment', { prefix: 'PMT-' });

    // Sales order with a 25% deposit request (required by the item policy).
    const order = (await post('/documents', {
      type: 'sales_order', date: '2026-07-01', partyId: party.id,
      deposit: { percentMilli: '25000' },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '4000', lineId: 'L1' }],
    })).json as { id: string; number: string; total: string; subtotal: string; taxTotal: string };
    expect(order.number).toBe('SO-0001');
    expect(order.subtotal).toBe('10000');
    expect(order.taxTotal).toBe('825');
    expect(order.total).toBe('10825');

    await post(`/documents/${order.id}/send`, {});

    // Line-level prepayment via a payment.
    const payment = (await post('/payments', {
      date: '2026-07-02', partyId: party.id, amount: '5000', method: 'check #9',
      applications: [{ invoiceId: order.id, amount: '5000', lineId: 'L1' }],
    })).json as { id: string; number: string };
    expect(payment.number).toBe('PMT-0001');
    const prepayments = (await get(`/documents/${order.id}/prepayments`)).json as { prepaid: string }[];
    expect(prepayments[0]!.prepaid).toBe('5000');

    // Convert to invoice; deposit transfers on send.
    const invoice = (await post(`/documents/${order.id}/convert`, { type: 'invoice', date: '2026-07-03' })).json as {
      id: string; number: string;
    };
    expect(invoice.number).toBe('INV-0001');
    await post(`/documents/${invoice.id}/send`, {});
    const settlement = (await get(`/documents/${invoice.id}/settlement`)).json as { paid: string; open: string };
    expect(settlement.paid).toBe('5000');
    expect(settlement.open).toBe('5825');

    // Statement through the party.
    const statement = (await get(`/statements?partyId=${party.id}&asOf=2026-07-10`)).json as {
      invoices: { number: string; openAmount: string; dueDate: string }[];
      balance: string;
    };
    expect(statement.invoices[0]!.number).toBe('INV-0001');
    expect(statement.invoices[0]!.dueDate).toBe('2026-08-02');
    expect(statement.balance).toBe('5825');
  });

  it('maps LedgerError codes to HTTP statuses', async () => {
    const missing = await get('/documents/nope');
    expect(missing.status).toBe(404);

    await post('/items', { name: 'W', currency: 'USD', unitPrice: '100' });
    const bad = await post('/documents', {
      type: 'invoice', date: '2026-07-01', customerName: '',
      lines: [{ description: 'x', quantityMilli: '1000', unitPrice: '100', currency: 'USD' }],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe('INVALID_DOCUMENT');

    const unknownRoute = await get('/frobnicate');
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.json.error).toBe('NOT_FOUND');
  });

  it('drives the purchase flow: supplier info, PO links, readiness gating', async () => {
    const widget = (await post('/items', { name: 'Widget', currency: 'USD', unitPrice: '2500', cost: '1000' })).json as { id: string };
    const supplier = (await post('/parties', { name: 'Widgets Wholesale Inc' })).json as { id: string };

    // Record a supplier snapshot and read it back.
    const info = await post(`/parties/${supplier.id}/supplier-info`, {
      source: 'edi-plugin', asOf: '2026-01-01', currency: 'USD',
      minimumOrderMinor: '10000',
      shipping: [{ method: 'freight', costMinor: '1200', minDays: 3, maxDays: 7 }],
      items: [{ itemId: widget.id, unitCost: '900', multipleQuantityMilli: '12000' }],
    });
    expect(info.status).toBe(201);
    const latest = (await get(`/parties/${supplier.id}/supplier-info`)).json as {
      source: string; minimumOrderMinor: string; items: { unitCost: string }[];
    };
    expect(latest.source).toBe('edi-plugin');
    expect(latest.items[0]!.unitCost).toBe('900');

    // Sales order to link against.
    const so = (await post('/documents', {
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '10000', lineId: 'L1' }],
    })).json as { id: string };

    // PO priced from the supplier quote, linked to the SO line.
    const po = (await post('/documents', {
      type: 'purchase_order', number: 'PO-1', date: '2026-07-02', partyId: supplier.id,
      lines: [{
        itemId: widget.id, description: 'Widget', quantityMilli: '6000',
        sourceDocumentId: so.id, sourceLineId: 'L1',
      }],
    })).json as { id: string; total: string; current: { lines: { unitPrice: string }[] } };
    expect(po.current.lines[0]!.unitPrice).toBe('900');
    expect(po.total).toBe('5400');

    const coverage = (await get(`/documents/${so.id}/purchase-coverage`)).json as {
      draftOrderedMilli: string; unorderedMilli: string;
    }[];
    expect(coverage[0]!.draftOrderedMilli).toBe('6000');
    expect(coverage[0]!.unorderedMilli).toBe('4000');

    // Not ready: below the order minimum and half a case.
    const readiness = (await get(`/documents/${po.id}/readiness`)).json as { ready: boolean; shortfalls: unknown[] };
    expect(readiness.ready).toBe(false);
    const denied = await post(`/documents/${po.id}/send`, {});
    expect(denied.status).toBe(409);
    expect(denied.json.error).toBe('MINIMUM_NOT_MET');

    // Accumulate to a full case (link stays within the SO quantity), then send.
    await post(`/documents/${po.id}/change`, {
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: '10000', sourceDocumentId: so.id, sourceLineId: 'L1' },
        { itemId: widget.id, description: 'Widget (stock)', quantityMilli: '2000' },
      ],
    });
    expect(((await get(`/documents/${po.id}/readiness`)).json as { ready: boolean }).ready).toBe(true);
    const sent = await post(`/documents/${po.id}/send`, {});
    expect(sent.status).toBe(201);

    // Bill the PO and settle it with an outbound payment (ADR 0012).
    const bill = (await post(`/documents/${po.id}/convert`, {
      type: 'bill', number: 'BILL-1', date: '2026-07-10',
    })).json as { id: string; total: string };
    expect(bill.total).toBe('10800'); // 12 × 9.00 quoted
    await post(`/documents/${bill.id}/send`, {});
    await post('/payments', {
      direction: 'out', number: 'PMT-OUT', date: '2026-07-12', partyId: supplier.id, amount: '10800',
      applications: [{ invoiceId: bill.id, amount: '10800' }],
    });
    const settled = (await get(`/documents/${bill.id}/settlement`)).json as { status: string };
    expect(settled.status).toBe('paid');

    // Supplier statement over HTTP (ADR 0013).
    const supplierStatement = (await get(`/supplier-statements?partyId=${supplier.id}&asOf=2026-08-01`)).json as {
      invoices: { number: string }[]; balance: string;
    };
    expect(supplierStatement.invoices[0]!.number).toBe('BILL-1');
    expect(supplierStatement.balance).toBe('0');
  });

  it('cash sales and refunds round-trip over HTTP (ADR 0013)', async () => {
    const widget = (await post('/items', { name: 'Widget', currency: 'USD', unitPrice: '2500' })).json as { id: string };
    await post('/sequences/payment', { prefix: 'PMT-' });

    const sale = (await post('/sales-receipts', {
      number: 'INV-CASH', date: '2026-07-01', customerName: 'Walk-in', method: 'cash',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '2000' }],
    })).json as { document: { id: string; status: string }; payment: { id: string; amountMinor: string } };
    expect(sale.document.status).toBe('sent');
    expect(sale.payment.amountMinor).toBe('5000');

    // Overpay a second invoice's payment, then refund the overage.
    const payment = (await post('/payments', {
      date: '2026-07-02', customerName: 'Walk-in', amount: '3000',
    })).json as { id: string };
    const refund = await post('/refunds', { sourceKind: 'payment', sourceId: payment.id, amount: '3000' });
    expect(refund.status).toBe(201);
    expect(refund.json.refund).toBe(true);
    const denied = await post('/refunds', { sourceKind: 'payment', sourceId: payment.id, amount: '1' });
    expect(denied.status).toBe(422);
  });

  it('inventory: stock ledger, damage, and BOMs over HTTP (ADR 0014)', async () => {
    const piece = (await post('/items', {
      name: 'Piece', currency: 'USD', unitPrice: '300', cost: '100', kind: 'inventory',
    })).json as { id: string };
    const box = (await post('/items', {
      name: 'Box', currency: 'USD', unitPrice: '3000', kind: 'inventory', dispositions: ['recycle', 'trash'],
    })).json as { id: string };

    await post(`/items/${box.id}/bom`, {
      assemblyCostMinor: '30',
      components: [{ componentItemId: piece.id, quantityMilli: '12000' }],
    });
    const bom = (await get(`/items/${box.id}/bom`)).json as { assemblyCostMinor: string };
    expect(bom.assemblyCostMinor).toBe('30');

    await post(`/items/${piece.id}/stock-adjustments`, { quantityMilli: '30000', reason: 'initial count' });
    await post(`/items/${box.id}/build`, { quantityMilli: '2000' });
    expect((await get(`/items/${box.id}/stock`)).json).toEqual({ goodMilli: '2000', damagedMilli: '0' });
    expect((await get(`/items/${piece.id}/stock`)).json).toEqual({ goodMilli: '6000', damagedMilli: '0' });

    await post(`/items/${box.id}/damage`, { quantityMilli: '1000', reason: 'dropped' });
    const restock = await post(`/items/${box.id}/dispose`, { quantityMilli: '1000', disposition: 'restock' });
    expect(restock.status).toBe(422); // policy forbids restock for this item
    await post(`/items/${box.id}/dispose`, { quantityMilli: '1000', disposition: 'trash' });
    expect((await get(`/items/${box.id}/stock`)).json).toEqual({ goodMilli: '1000', damagedMilli: '0' });

    const overbuild = await post(`/items/${box.id}/build`, { quantityMilli: '9000' });
    expect(overbuild.status).toBe(409);
    expect(overbuild.json.error).toBe('INSUFFICIENT_STOCK');
  });

  it('receipts and FIFO valuation over HTTP (ADR 0015)', async () => {
    const widget = (await post('/items', { name: 'Widget', currency: 'USD', unitPrice: '2500', kind: 'inventory' })).json as { id: string };
    const supplier = (await post('/parties', { name: 'Supplier Inc' })).json as { id: string };

    const po = (await post('/documents', {
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '10000', unitPrice: '900', lineId: 'P1' }],
    })).json as { id: string };
    await post(`/documents/${po.id}/send`, {});

    // Receipt lands stock; bill clears it without re-stocking.
    const receipt = (await post(`/documents/${po.id}/convert`, { type: 'receipt', number: 'RCT-1', date: '2026-07-05' })).json as { id: string };
    await post(`/documents/${receipt.id}/send`, {});
    expect((await get(`/items/${widget.id}/stock`)).json).toEqual({ goodMilli: '10000', damagedMilli: '0' });
    const bill = (await post(`/documents/${receipt.id}/convert`, { type: 'bill', number: 'BILL-1', date: '2026-07-10' })).json as { id: string };
    await post(`/documents/${bill.id}/send`, {});
    expect((await get(`/items/${widget.id}/stock`)).json).toEqual({ goodMilli: '10000', damagedMilli: '0' });

    // FIFO valuation carries the PO price.
    const valuation = (await get(`/items/${widget.id}/valuation`)).json as { quantityMilli: string; valueMinor: string };
    expect(valuation.quantityMilli).toBe('10000');
    expect(valuation.valueMinor).toBe('9000');
  });

  it('purchase prepayments: supplier deposit over HTTP (ADR 0016)', async () => {
    const widget = (await post('/items', { name: 'Widget', currency: 'USD', unitPrice: '2500', kind: 'inventory' })).json as { id: string };
    const supplier = (await post('/parties', { name: 'Supplier Inc' })).json as { id: string };
    await post(`/parties/${supplier.id}/supplier-info`, {
      asOf: '2026-01-01', currency: 'USD', prepaymentPercentMilli: '50000', // 50% down
      items: [{ itemId: widget.id, unitCost: '1000' }],
    });

    // Without a deposit request, the PO cannot be sent.
    const bare = (await post('/documents', {
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '10000', unitPrice: '1000' }],
    })).json as { id: string };
    const denied = await post(`/documents/${bare.id}/send`, {});
    expect(denied.status).toBe(409);
    expect(denied.json.error).toBe('DEPOSIT_REQUIRED');

    // With the deposit committed, it sends; the outbound payment holds against it.
    const po = (await post('/documents', {
      type: 'purchase_order', number: 'PO-2', date: '2026-07-01', partyId: supplier.id,
      deposit: { percentMilli: '50000' },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '10000', unitPrice: '1000' }],
    })).json as { id: string };
    await post(`/documents/${po.id}/send`, {});
    await post('/payments', {
      number: 'PMT-OUT-1', direction: 'out', date: '2026-07-02', partyId: supplier.id, amount: '5000',
      applications: [{ invoiceId: po.id, amount: '5000' }],
    });
    expect((await get(`/documents/${po.id}/deposit`)).json).toEqual({ held: '5000' });

    // Billing transfers the deposit, leaving half open.
    const bill = (await post(`/documents/${po.id}/convert`, { type: 'bill', number: 'BILL-1', date: '2026-07-10' })).json as { id: string };
    await post(`/documents/${bill.id}/send`, {});
    const settled = (await get(`/documents/${bill.id}/settlement`)).json as { paid: string; open: string };
    expect(settled.paid).toBe('5000');
    expect(settled.open).toBe('5000');
  });

  it('plugins, reports, and banking round-trip over HTTP (ADR 0017–0019)', async () => {
    const widget = (await post('/items', { name: 'Widget', currency: 'USD', unitPrice: '2500', kind: 'inventory' })).json as { id: string };
    const supplier = (await post('/parties', { name: 'Supplier Inc' })).json as { id: string };

    // Attach the bundled plugin to the served file (v1 wiring, ADR 0018).
    const host = new PluginHost<CompanyFile>();
    host.register(demoSupplierPlugin({ partyId: supplier.id, itemCosts: { [widget.id]: 900n } }));
    file.attachPlugins(host);

    expect((await get('/plugins')).json).toEqual({
      plugins: [{ id: 'demo-supplier', name: 'Demo Supplier Connector', version: '0.0.1' }],
      reports: ['demo.purchase-pipeline'],
    });
    const quoted = (await post(`/parties/${supplier.id}/refresh-supplier-info`, {})).json as { source: string; asOf: string };
    expect(quoted.source).toBe('demo-supplier');

    // Priced from the quote, so dated on/after the quote's asOf.
    const po = (await post('/documents', {
      type: 'purchase_order', number: 'PO-1', date: quoted.asOf, partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '10000' }],
    })).json as { id: string };
    const submitted = (await post(`/documents/${po.id}/submit`, {})).json as { reference: string; view: { status: string } };
    expect(submitted).toMatchObject({ reference: 'DEMO-0001', view: { status: 'sent' } });
    // Plugin report contributions share the /reports namespace.
    expect((await get('/reports/demo.purchase-pipeline')).json).toMatchObject({ openOrders: 1 });
    expect((await get('/reports/nope')).status).toBe(404);

    // Built-in reports over HTTP.
    const sheet = (await get('/reports/balance-sheet?asOf=2026-07-31')).json as { balanced: boolean };
    expect(sheet.balanced).toBe(true);
    expect((await get('/reports/pnl?from=2026-07-01&to=2026-07-31')).status).toBe(200);
    expect((await get('/reports/pnl')).status).toBe(422); // needs from/to

    // Banking: import, suggest, reconcile, reverse.
    await post('/sequences/payment', { prefix: 'PMT-' });
    const payment = (await post('/payments', {
      date: '2026-07-02', customerName: 'Acme LLC', amount: '15000',
    })).json as { id: string };
    const imported = (await post('/bank/import', {
      source: 'chase', csv: 'date,amount,description\n2026-07-02,150.00,ACH ACME',
    })).json as { imported: number };
    expect(imported.imported).toBe(1);
    const suggestions = (await get('/bank/suggestions?source=chase')).json as { bankSeq: number; paymentId: string }[];
    expect(suggestions).toHaveLength(1);
    const mark = (await post('/bank/reconcile', { bankSeq: suggestions[0]!.bankSeq, paymentId: payment.id })).json as { reconSeq: number };
    expect((await get('/bank/suggestions?source=chase')).json).toHaveLength(0);
    // Active marks are readable — added for the web UI (ADR 0020).
    expect((await get('/bank/reconciliations')).json).toEqual([
      { bankSeq: suggestions[0]!.bankSeq, reconSeq: mark.reconSeq, paymentId: payment.id },
    ]);
    const again = await post('/bank/reconcile', { bankSeq: suggestions[0]!.bankSeq, paymentId: payment.id });
    expect(again.status).toBe(409);
    await post(`/bank/reconcile/${mark.reconSeq}/reverse`, {});
    expect((await get('/bank/suggestions?source=chase')).json).toHaveLength(1);
  });

  it('gated actions surface 403 APPROVAL_REQUIRED', async () => {
    await post('/policies/approval', { actions: ['void_document'] });
    await post('/policies/approval', { actions: ['void_document'] });
    const item = (await post('/items', { name: 'W', currency: 'USD', unitPrice: '100' })).json as { id: string };
    const doc = (await post('/documents', {
      type: 'invoice', number: 'INV-X', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: item.id, description: 'W', quantityMilli: '1000' }],
    })).json as { id: string };
    const denied = await post(`/documents/${doc.id}/void`, {});
    expect(denied.status).toBe(403);
    const allowed = await post(`/documents/${doc.id}/void`, { approvedBy: 'owner' });
    expect(allowed.status).toBe(201);
  });

  it('GET / serves the read-only HTML dashboard; JSON stays everywhere else', async () => {
    const item = (await post('/items', { name: 'Widget <em>Pro</em>', currency: 'USD', unitPrice: '2500', kind: 'inventory' })).json as { id: string };
    const doc = (await post('/documents', {
      type: 'invoice', number: 'INV-1', date: '2026-07-01', customerName: 'Acme & Sons',
      lines: [{ itemId: item.id, description: 'Widget', quantityMilli: '2000' }],
    })).json as { id: string };
    await post(`/documents/${doc.id}/send`, {});

    for (const path of ['/', '/dashboard', '/?asOf=2026-07-15']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('API Co');
      expect(html).toContain('BALANCED');
      // Interpolated names are escaped, never raw.
      expect(html).toContain('Acme &amp; Sons');
      expect(html).toContain('Widget &lt;em&gt;Pro&lt;/em&gt;');
      expect(html).not.toContain('<em>Pro</em>');
    }
    // The JSON 404 contract is untouched for unknown paths.
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
  });

  it('the same API answers under /api — one prefix for dev proxies (ADR 0020)', async () => {
    expect((await get('/api/company')).json).toEqual({ name: 'API Co', baseCurrency: 'USD' });
    const item = (await post('/api/items', { name: 'W', currency: 'USD', unitPrice: '100' })).json as { id: string };
    expect((await get(`/items`)).json).toMatchObject([{ id: item.id }]);
    // Without a webRoot, /app is just another unknown path.
    expect((await fetch(`${base}/app`)).status).toBe(404);
  });

  it('serves the built web app under /app when webRoot is configured (ADR 0020)', async () => {
    const webRoot = join(dir, 'web');
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Accounts app shell</title>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app")');
    const webServer = createApiServer(file, { webRoot });
    await new Promise<void>((resolve) => webServer.listen(0, resolve));
    const webBase = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
    try {
      const index = await fetch(`${webBase}/app`);
      expect(index.headers.get('content-type')).toContain('text/html');
      expect(await index.text()).toContain('Accounts app shell');
      const asset = await fetch(`${webBase}/app/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain('text/javascript');
      // Extensionless deep links fall back to the SPA shell; missing assets 404.
      expect(await (await fetch(`${webBase}/app/documents/abc`)).text()).toContain('Accounts app shell');
      expect((await fetch(`${webBase}/app/assets/missing.js`)).status).toBe(404);
      // The API and dashboard still answer on the same server.
      const company = (await (await fetch(`${webBase}/api/company`)).json()) as { name: string };
      expect(company.name).toBe('API Co');
    } finally {
      await new Promise<void>((resolve, reject) => webServer.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
