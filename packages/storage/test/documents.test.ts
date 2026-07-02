import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DocumentBook, LedgerError } from '@accounts/core';
import { CompanyFile, SCHEMA_VERSION } from '../src/index.js';
import { MIGRATIONS } from '../src/schema.js';

let dir: string;
let file: CompanyFile;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-docs-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('invoice corrections persist', () => {
  it('stores immutable revisions and derives tags after reopening', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const invoice = file.createDocument({
      type: 'invoice',
      number: 'INV-0001',
      date: '2026-07-01',
      counterparty: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    file.sendDocument(invoice.id);
    expect(() => file.changeDocument(invoice.id, { kind: 'edit', memo: 'nope' })).toThrow(LedgerError);
    file.changeDocument(invoice.id, {
      reason: 'Quantity was wrong',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3000n }],
    });

    file.close();
    file = CompanyFile.open(books);

    const view = file.viewDocument(invoice.id);
    expect(view.label).toBe('INV-0001 (with corrections)');
    expect(view.current.lines[0]!.quantityMilli).toBe(3000n);
    expect(view.total).toBe(7500n);
    const history = file.documentHistory(invoice.id);
    expect(history.map((revision) => revision.kind)).toEqual(['initial', 'correction']);
    expect(history[0]!.lines[0]!.quantityMilli).toBe(2000n);
  });

  it('sales order substitutions flow into invoices created from them', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const order = file.createDocument({
      type: 'sales_order',
      number: 'SO-0001',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 5000n }],
    });
    file.sendDocument(order.id);
    file.changeDocument(order.id, {
      kind: 'substitution',
      reason: 'out of stock',
      lines: [{ itemId: widget.id, description: 'Widget (blue)', quantityMilli: 5000n }],
    });
    const invoice = file.createDocument({
      type: 'invoice',
      number: 'INV-0002',
      date: '2026-07-03',
      sourceDocumentId: order.id,
      lines: [{ itemId: widget.id, description: 'Widget (blue)', quantityMilli: 5000n }],
    });
    expect(invoice.tags).toEqual(['with substitutions']);
    expect(file.viewDocument(order.id).label).toBe('SO-0001 (with substitutions)');
  });
});

describe('price snapshots persist', () => {
  it('price changes, even retroactive, never alter stored documents', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const invoice = file.createDocument({
      type: 'invoice',
      number: 'INV-0003',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    file.sendDocument(invoice.id);
    file.setPrice(widget.id, 100n, '2026-01-01'); // retroactive
    file.setPrice(widget.id, 9900n, '2026-08-01'); // future
    expect(file.viewDocument(invoice.id).total).toBe(10000n);
    expect(file.priceAt(widget.id, '2026-07-01')).toBe(100n); // catalog moved…
    expect(file.viewDocument(invoice.id).current.lines[0]!.unitPrice).toBe(2500n); // …document didn't
    expect(file.priceHistory(widget.id)).toHaveLength(3);
  });
});

describe('database-level immutability', () => {
  it('raw SQL cannot rewrite revisions, price history, or document identity', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const invoice = file.createDocument({
      type: 'invoice',
      number: 'INV-0004',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    const raw = new Database(books);
    try {
      expect(() =>
        raw.prepare(`UPDATE document_revision_lines SET unit_price = 1 WHERE document_id = ?`).run(invoice.id),
      ).toThrowError(/immutable/);
      expect(() =>
        raw.prepare(`DELETE FROM document_revisions WHERE document_id = ?`).run(invoice.id),
      ).toThrowError(/immutable/);
      expect(() => raw.prepare(`UPDATE item_prices SET unit_price = 1`).run()).toThrowError(/immutable/);
      expect(() =>
        raw.prepare(`UPDATE documents SET number = 'INV-9999' WHERE id = ?`).run(invoice.id),
      ).toThrowError(/only document status/);
      expect(() => raw.prepare(`DELETE FROM documents WHERE id = ?`).run(invoice.id)).toThrowError(/void them/);
      // Status transitions remain possible (that's the one mutable column).
      raw.prepare(`UPDATE documents SET status = 'sent' WHERE id = ?`).run(invoice.id);
    } finally {
      raw.close();
    }
  });
});

describe('schema migrations', () => {
  it('opening a v1 file upgrades it in place', () => {
    // Build a v1-only file by hand (mirrors a file created by the previous release).
    const oldPath = join(dir, 'old.sqlite');
    const old = new Database(oldPath);
    old.exec(MIGRATIONS[0]!);
    old.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run();
    old.prepare(`INSERT INTO meta (key, value) VALUES ('company_name', 'Legacy Co')`).run();
    old.prepare(`INSERT INTO meta (key, value) VALUES ('base_currency', 'USD')`).run();
    old.close();

    const upgraded = CompanyFile.open(oldPath);
    try {
      // v2 tables exist and work.
      const item = upgraded.createItem({ name: 'Widget', currency: 'USD', unitPrice: 100n });
      expect(upgraded.priceAt(item.id, '2026-01-01')).toBe(100n);
      const check = new Database(oldPath, { readonly: true });
      expect((check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string }).value).toBe(String(SCHEMA_VERSION));
      check.close();
    } finally {
      upgraded.close();
    }
  });
});

describe('conversions, closures, and adjustments persist (ADR 0005)', () => {
  it('partial conversion chain with line links and fulfillment survives reopening', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const estimate = file.createDocument({
      type: 'estimate', number: 'EST-1', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10000n, lineId: 'E1' }],
    });
    file.sendDocument(estimate.id);
    const order = file.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', date: '2026-07-02' });
    expect(order.current.lines[0]!.sourceLineId).toBe('E1');
    file.sendDocument(order.id);

    const orderLineId = order.current.lines[0]!.lineId;
    file.convertDocument(order.id, {
      type: 'invoice', number: 'INV-1', date: '2026-07-03',
      lines: [{ sourceLineId: orderLineId, quantityMilli: 4000n }],
    });
    file.closeLine(order.id, { lineId: orderLineId, kind: 'unfulfilled', quantityMilli: 1000n, reason: 'reduced' });

    file.close();
    file = CompanyFile.open(books);

    const state = file.fulfillment(order.id)[0]!;
    expect(state.convertedMilli).toBe(4000n);
    expect(state.closedMilli).toBe(1000n);
    expect(state.openMilli).toBe(5000n);
    expect(state.status).toBe('partial');
    expect(file.fulfillment(estimate.id)[0]!.status).toBe('fulfilled');
    expect(file.lineClosures(order.id)[0]!.reason).toBe('reduced');
  });

  it('substitution conversions tag target and consume the source line', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const gadget = file.createItem({ name: 'Gadget', currency: 'USD', unitPrice: 4000n });
    const order = file.createDocument({
      type: 'sales_order', number: 'SO-2', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n, lineId: 'L1' }],
    });
    file.sendDocument(order.id);
    const invoice = file.convertDocument(order.id, {
      type: 'invoice', number: 'INV-2', date: '2026-07-02',
      lines: [{ sourceLineId: 'L1', substitution: { itemId: gadget.id, description: 'Gadget instead', unitPrice: 3000n } }],
    });
    expect(invoice.tags).toEqual(['with substitutions']);
    expect(invoice.current.lines[0]!.substituted).toBe(true);
    expect(invoice.current.lines[0]!.unitPrice).toBe(3000n);
    expect(file.fulfillment(order.id)[0]!.status).toBe('fulfilled');
  });

  it('charge corrections persist with floors honored', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const gadget = file.createItem({ name: 'Gadget', currency: 'USD', unitPrice: 4000n, cost: 3000n });
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-07-01',
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 4000n, lineId: 'L1' }, // 100.00, floor 40.00
        { itemId: gadget.id, description: 'Gadget', quantityMilli: 2500n, lineId: 'L2' }, // 100.00, floor 75.00
      ],
    });
    file.sendDocument(invoice.id);
    const corrected = file.chargeCorrection(invoice.id, 12000n, 'charged $120');
    expect(corrected.total).toBe(12000n);
    expect(corrected.tags).toEqual(['with corrections']);

    file.close();
    file = CompanyFile.open(books);
    const reloaded = file.viewDocument(invoice.id);
    expect(reloaded.total).toBe(12000n);
    expect(reloaded.current.lines.map((line) => line.adjustment)).toEqual([-5500n, -2500n]);
    expect(() => file.chargeCorrection(invoice.id, 11000n)).toThrowError(/floors already total/);
    expect(() => file.chargeCorrection(invoice.id, 20000n)).toThrowError(/only reduce/);
  });

  it('free items persist: customer sees free, books scale to the actual total', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const gadget = file.createItem({ name: 'Gadget', currency: 'USD', unitPrice: 4000n });
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-4', date: '2026-07-01',
      lines: [
        { itemId: gadget.id, description: 'Gadget', quantityMilli: 3000n, lineId: 'L1' },
        { itemId: widget.id, description: 'Widget (free)', quantityMilli: 1000n, free: true, lineId: 'L2' },
      ],
    });
    expect(invoice.total).toBe(12000n);
    expect(invoice.current.lines[1]!.unitPrice).toBe(1000n); // recorded at cost

    file.close();
    file = CompanyFile.open(books);
    const reloaded = file.viewDocument(invoice.id);
    expect(reloaded.current.lines[1]!.free).toBe(true);
    expect(reloaded.recordedLineTotals.reduce((a, b) => a + b, 0n)).toBe(12000n);
    expect(reloaded.recordedLineTotals[1]!).toBe(923n);
  });

  it('closures are immutable at the database level', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const order = file.createDocument({
      type: 'sales_order', number: 'SO-3', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, lineId: 'L1' }],
    });
    file.sendDocument(order.id);
    file.closeLine(order.id, { lineId: 'L1', kind: 'unfulfilled' });
    const raw = new Database(books);
    try {
      expect(() => raw.prepare(`UPDATE document_line_closures SET quantity_milli = 1`).run()).toThrowError(/immutable/);
      expect(() => raw.prepare(`DELETE FROM document_line_closures`).run()).toThrowError(/immutable/);
    } finally {
      raw.close();
    }
  });
});

describe('conformance against the in-memory DocumentBook', () => {
  it('replays the same operations and reaches the same views', () => {
    const reference = new DocumentBook();
    const sqlWidget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    reference.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n }, sqlWidget.id);

    const sqlInvoice = file.createDocument({
      type: 'invoice',
      number: 'INV-C1',
      date: '2026-07-01',
      lines: [{ itemId: sqlWidget.id, description: 'Widget', quantityMilli: 2500n, lineId: 'L1' }],
    });
    reference.createDocument(
      {
        type: 'invoice',
        number: 'INV-C1',
        date: '2026-07-01',
        lines: [{ itemId: sqlWidget.id, description: 'Widget', quantityMilli: 2500n, lineId: 'L1' }],
      },
      sqlInvoice.id,
    );

    file.sendDocument(sqlInvoice.id);
    reference.sendDocument(sqlInvoice.id);
    file.changeDocument(sqlInvoice.id, { reason: 'price fix', lines: [{ itemId: sqlWidget.id, description: 'Widget', quantityMilli: 2500n, unitPrice: 2400n, lineId: 'L1' }] });
    reference.changeDocument(sqlInvoice.id, { reason: 'price fix', lines: [{ itemId: sqlWidget.id, description: 'Widget', quantityMilli: 2500n, unitPrice: 2400n, lineId: 'L1' }] });

    const sqlView = file.viewDocument(sqlInvoice.id);
    const referenceView = reference.view(sqlInvoice.id);
    expect(sqlView.tags).toEqual(referenceView.tags);
    expect(sqlView.label).toEqual(referenceView.label);
    expect(sqlView.total).toEqual(referenceView.total);
    expect(sqlView.status).toEqual(referenceView.status);
    expect(sqlView.current.lines).toEqual(referenceView.current.lines);
    expect(file.documentHistory(sqlInvoice.id).map((r) => [r.revisionNo, r.kind])).toEqual(
      reference.history(sqlInvoice.id).map((r) => [r.revisionNo, r.kind]),
    );
  });
});
