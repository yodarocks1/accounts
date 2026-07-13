import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost, type AccountsPlugin } from '@accounts/core';
import { demoSupplierPlugin } from '@accounts/plugin-demo-supplier';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-plugins-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('plugin host v1 (ADR 0018)', () => {
  it('the demo plugin drives the whole purchase flow through public seams', async () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Widgets Wholesale Inc' });

    const host = new PluginHost<CompanyFile>();
    host.register(
      demoSupplierPlugin({
        partyId: supplier.id,
        itemCosts: { [widget.id]: 900n },
        minimumOrderMinor: 5000n,
        prepaymentPercentMilli: 50_000n,
        leadDays: 7,
      }),
    );
    file.attachPlugins(host);
    expect(file.plugins().map((manifest) => manifest.id)).toEqual(['demo-supplier']);

    // 1. Connector quotes terms → recorded with plugin provenance.
    const info = await file.refreshSupplierInfo(supplier.id);
    expect(info.source).toBe('demo-supplier');
    expect(info.prepaymentPercentMilli).toBe(50_000n);
    expect(file.supplierCostAt(supplier.id, widget.id, info.asOf)).toBe(900n);

    // 2. The quoted terms gate the PO exactly as manual supplier info would.
    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: info.asOf, partyId: supplier.id,
      deposit: { percentMilli: 50_000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n }], // costs from the quote: 90.00
    });
    expect(po.current.lines[0]!.unitPrice).toBe(900n);

    // 3. Submission = ordinary send + connector delivery, audited.
    const { view, reference } = await file.submitPurchaseOrder(po.id);
    expect(view.status).toBe('sent');
    expect(reference).toBe('DEMO-0001');
    expect(file.auditLog().some((row) => row.action === 'po.submitted')).toBe(true);

    // 4. The lifecycle hook observed the send; the report contribution runs.
    expect(host.logEntries().some((entry) => entry.message.includes('PO-1 sent'))).toBe(true);
    const pipeline = file.runPluginReport('demo.purchase-pipeline') as {
      openOrders: number; committedMinor: bigint; numbers: string[];
    };
    expect(pipeline).toMatchObject({ openOrders: 1, committedMinor: 9000n, numbers: ['PO-1'] });
    expect(file.pluginReportNames()).toEqual(['demo.purchase-pipeline']);
  });

  it('hooks are isolated: a throwing plugin never breaks the write, and is audited', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const host = new PluginHost<CompanyFile>();
    const angry: AccountsPlugin<CompanyFile> = {
      manifest: { id: 'angry', name: 'Angry Plugin', version: '0.0.1' },
      activate(api) {
        api.onDocumentEvent('document.sent', () => {
          throw new Error('plugin exploded');
        });
      },
    };
    host.register(angry);
    file.attachPlugins(host);

    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    file.sendDocument(invoice.id); // must not throw
    expect(file.viewDocument(invoice.id).status).toBe('sent');
    const audit = file.auditLog().find((row) => row.action === 'plugin.error');
    expect(audit?.entityId).toBe('angry');
    expect(audit?.details).toContain('plugin exploded');
  });

  it('activation is transactional: a plugin that throws leaves nothing behind', () => {
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const host = new PluginHost<CompanyFile>();
    const halfway: AccountsPlugin<CompanyFile> = {
      manifest: { id: 'halfway', name: 'Halfway Plugin', version: '0.0.1' },
      activate(api) {
        api.registerSupplierConnector({ partyId: supplier.id });
        api.registerReport({ name: 'half.report', run: () => ({}) });
        throw new Error('activation exploded');
      },
    };
    expect(() => host.register(halfway)).toThrowError(/activation exploded/);
    // Nothing was kept: not the manifest, connector, or report.
    expect(host.list()).toHaveLength(0);
    expect(host.connectorFor(supplier.id)).toBeUndefined();
    expect(host.reportNames()).toHaveLength(0);
    // The party is still free for a well-behaved plugin.
    host.register({
      manifest: { id: 'ok', name: 'OK', version: '0.0.1' },
      activate(api) {
        api.registerSupplierConnector({ partyId: supplier.id });
      },
    });
    expect(host.connectorFor(supplier.id)?.pluginId).toBe('ok');
  });

  it('a failed connector delivery never strands the order: submit retries', async () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const host = new PluginHost<CompanyFile>();
    let attempts = 0;
    host.register({
      manifest: { id: 'flaky', name: 'Flaky Connector', version: '0.0.1' },
      activate(api) {
        api.registerSupplierConnector({
          partyId: supplier.id,
          submitPurchaseOrder() {
            attempts += 1;
            if (attempts === 1) throw new Error('supplier API timed out');
            return { reference: `FLAKY-${attempts}` };
          },
        });
      },
    });
    file.attachPlugins(host);

    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 900n }],
    });
    // First attempt: the send commits, delivery fails.
    await expect(file.submitPurchaseOrder(po.id)).rejects.toThrowError(/timed out/);
    expect(file.viewDocument(po.id).status).toBe('sent');
    // Retry skips the send and just delivers.
    const retry = await file.submitPurchaseOrder(po.id);
    expect(retry.reference).toBe('FLAKY-2');
    // Voided orders cannot be submitted at all.
    const dead = file.createDocument({
      type: 'purchase_order', number: 'PO-2', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 900n }],
    });
    file.voidDocument(dead.id);
    await expect(file.submitPurchaseOrder(dead.id)).rejects.toThrowError(/Void purchase orders/);
  });

  it('registration conflicts fail loudly; unknown reports 404-shaped', async () => {
    const host = new PluginHost<CompanyFile>();
    const supplier = file.createParty({ name: 'Supplier Inc' });
    const connectorPlugin = (id: string): AccountsPlugin<CompanyFile> => ({
      manifest: { id, name: id, version: '0.0.1' },
      activate(api) {
        api.registerSupplierConnector({ partyId: supplier.id });
      },
    });
    host.register(connectorPlugin('first'));
    expect(() => host.register(connectorPlugin('first'))).toThrowError(/already registered: first/);
    expect(() => host.register(connectorPlugin('second'))).toThrowError(/already has a connector from first/);

    file.attachPlugins(host);
    expect(() => file.runPluginReport('nope')).toThrowError(/No plugin report named/);
    // A connector with no fetch cannot quote.
    await expect(file.refreshSupplierInfo(supplier.id)).rejects.toThrowError(/cannot quote|can quote/);
  });
});
