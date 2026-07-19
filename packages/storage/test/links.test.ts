import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-links-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('document links in storage (ADR 0021)', () => {
  it('mirrors the core graph: conversion chain + cross-linked PO, void visible', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const supplier = file.createParty({ name: 'Widgets Wholesale' });
    const acme = file.createParty({ name: 'Acme LLC' });
    expect(file.listParties().map((party) => party.name)).toEqual(['Acme LLC', 'Widgets Wholesale']);

    const estimate = file.createDocument({
      type: 'estimate', number: 'EST-1', date: '2026-07-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, lineId: 'E1' }],
    });
    file.sendDocument(estimate.id);
    const order = file.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', date: '2026-07-02' });
    file.sendDocument(order.id);
    const soLine = file.viewDocument(order.id).current.lines[0]!;

    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-03', partyId: supplier.id,
      lines: [{
        itemId: widget.id, description: 'Widget', quantityMilli: 6_000n, unitPrice: 900n,
        sourceDocumentId: order.id, sourceLineId: soLine.lineId,
      }],
    });
    const invoice = file.convertDocument(order.id, {
      type: 'invoice', number: 'INV-1', date: '2026-07-04',
      lines: [{ sourceLineId: soLine.lineId, quantityMilli: 4_000n }],
    });
    file.sendDocument(invoice.id);
    const dead = file.convertDocument(order.id, {
      type: 'invoice', number: 'INV-2', date: '2026-07-05',
      lines: [{ sourceLineId: soLine.lineId, quantityMilli: 1_000n }],
    });
    file.voidDocument(dead.id);

    const links = file.documentLinks(order.id);
    const line = links.lines[0]!;
    expect(line.upstream).toMatchObject({ number: 'EST-1', lineId: 'E1', kind: 'conversion' });
    expect(line.downstream).toHaveLength(3);
    expect(line.downstream).toContainEqual(expect.objectContaining({ number: 'PO-1', kind: 'cross', quantityMilli: 6_000n }));
    expect(line.downstream).toContainEqual(expect.objectContaining({ number: 'INV-2', status: 'void' }));
    expect(links.family.nodes.map((node) => node.number)).toEqual(['EST-1', 'SO-1', 'PO-1', 'INV-1', 'INV-2']);
    // Fulfillment agrees with the graph: 4 converted (void ignored), 6 open.
    const state = file.fulfillment(order.id)[0]!;
    expect(state).toMatchObject({ convertedMilli: 4_000n, openMilli: 6_000n, status: 'partial' });
    // And the graph is reachable from the far leaf too.
    expect(file.documentLinks(po.id).family.nodes).toHaveLength(5);
  });
});
