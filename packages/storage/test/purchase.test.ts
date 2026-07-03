import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-purchase-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('supplier info persists (ADR 0011)', () => {
  it('round-trips snapshots with shipping and item terms; effective-dated lookups', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const supplier = file.createParty({ name: 'Widgets Wholesale Inc' });
    file.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      minimumOrderMinor: 50_000n,
      items: [{ itemId: widget.id, unitCost: 900n, leadDays: 14 }],
    });
    const fresh = file.recordSupplierInfo({
      partyId: supplier.id, source: 'edi-plugin', asOf: '2026-06-01', currency: 'USD',
      minimumOrderMinor: 60_000n, minimumOrderQuantityMilli: 24_000n,
      shipping: [{ method: 'freight', costMinor: 12_000n, freeAboveMinor: 100_000n, minDays: 3, maxDays: 7 }],
      items: [{ itemId: widget.id, unitCost: 950n, supplierSku: 'WW-42', inStock: true, multipleQuantityMilli: 12_000n }],
      notes: 'quoted by phone',
    });
    expect(fresh.infoSeq).toBe(2);

    file.close();
    file = CompanyFile.open(books);
    const reloaded = file.supplierInfo(supplier.id)!;
    expect(reloaded.source).toBe('edi-plugin');
    expect(reloaded.minimumOrderQuantityMilli).toBe(24_000n);
    expect(reloaded.shipping[0]).toEqual({
      method: 'freight', costMinor: 12_000n, freeAboveMinor: 100_000n, minDays: 3, maxDays: 7,
    });
    expect(reloaded.items[0]).toMatchObject({ unitCost: 950n, supplierSku: 'WW-42', inStock: true });
    expect(file.supplierInfoAt(supplier.id, '2026-03-01')!.minimumOrderMinor).toBe(50_000n);
    expect(file.supplierCostAt(supplier.id, widget.id, '2026-07-01')).toBe(950n);
    expect(file.supplierInfoHistory(supplier.id)).toHaveLength(2);
  });

  it('is immutable at the database level', () => {
    const supplier = file.createParty({ name: 'Widgets Wholesale Inc' });
    file.recordSupplierInfo({ partyId: supplier.id, asOf: '2026-01-01', currency: 'USD' });
    file.close();
    const raw = new Database(books);
    expect(() => raw.prepare(`UPDATE supplier_info SET currency = 'EUR'`).run()).toThrowError(/immutable/);
    expect(() => raw.prepare(`DELETE FROM supplier_info`).run()).toThrowError(/immutable/);
    raw.close();
    file = CompanyFile.open(books);
  });
});

describe('purchase orders persist (ADR 0011)', () => {
  function setUpSupplier() {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const supplier = file.createParty({ name: 'Widgets Wholesale Inc' });
    file.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      minimumOrderMinor: 10_000n,
      items: [{ itemId: widget.id, unitCost: 900n, multipleQuantityMilli: 12_000n }],
    });
    return { widget, supplier };
  }

  it('prices at supplier cost, gates sending on minimums, and survives reopen', () => {
    const { widget, supplier } = setUpSupplier();
    file.setNumberSequence('purchase_order', { prefix: 'PO-' });
    const po = file.createDocument({
      type: 'purchase_order', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 6000n }],
    });
    expect(po.number).toBe('PO-0001');
    expect(po.current.lines[0]!.unitPrice).toBe(900n);
    expect(po.current.lines[0]!.taxCode).toBeNull();

    const readiness = file.purchaseOrderReadiness(po.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.shortfalls.map((entry) => entry.kind)).toEqual(['order_minimum', 'item_multiple']);
    expect(() => file.sendDocument(po.id)).toThrowError(/does not meet the supplier's terms/);

    // Accumulate to a full case, reopen mid-flight, then send.
    file.changeDocument(po.id, { lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n }] });
    file.close();
    file = CompanyFile.open(books);
    expect(file.purchaseOrderReadiness(po.id).ready).toBe(true);
    file.sendDocument(po.id);
    expect(file.viewDocument(po.id).status).toBe('sent');
    // Purchase orders never post to the ledger.
    expect(file.listPostings('document', po.id)).toHaveLength(0);
  });

  it('links to sales-order lines with coverage and shrink guards', () => {
    const { widget, supplier } = setUpSupplier();
    const so = file.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, lineId: 'L1' }],
    });
    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-02', partyId: supplier.id,
      lines: [{
        itemId: widget.id, description: 'Widget', quantityMilli: 6000n,
        sourceDocumentId: so.id, sourceLineId: 'L1',
      }],
    });
    expect(file.purchaseCoverage(so.id)[0]).toMatchObject({
      draftOrderedMilli: 6000n, sentOrderedMilli: 0n, unorderedMilli: 4000n,
    });
    // Cumulative link guard across purchase orders.
    expect(() =>
      file.createDocument({
        type: 'purchase_order', number: 'PO-2', date: '2026-07-03', partyId: supplier.id,
        lines: [{
          itemId: widget.id, description: 'Widget', quantityMilli: 5000n,
          sourceDocumentId: so.id, sourceLineId: 'L1',
        }],
      }),
    ).toThrowError(/exceeds the 10000 on the sales order/);
    // Sales-order lines with linked purchases cannot shrink below them.
    expect(() =>
      file.changeDocument(so.id, {
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 5000n, lineId: 'L1' }],
      }),
    ).toThrowError(/cannot shrink below the 6000/);
    // PO links never consume sales-order fulfillment.
    expect(file.fulfillment(so.id)[0]!.openMilli).toBe(10_000n);
    void po;
  });

  it('special_order items require a covering deposit before the SO sends', () => {
    const special = file.createItem({
      name: 'Special-order part', currency: 'USD', unitPrice: 20_000n, depositPolicy: 'special_order',
    });
    const so = file.createDocument({
      type: 'sales_order', number: 'SO-9', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 5000n },
      lines: [{ itemId: special.id, description: 'Part', quantityMilli: 1000n }],
    });
    expect(() => file.sendDocument(so.id)).toThrowError(/must cover at least 20000, not 5000/);
    file.setApprovalPolicy(['deposit_override']);
    expect(() => file.sendDocument(so.id, { overrideDeposit: true })).toThrowError(/requires an approver/);
    file.sendDocument(so.id, { overrideDeposit: true, approvedBy: 'owner' });
  });
});
