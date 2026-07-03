import { describe, expect, it } from 'vitest';
import { computePurchaseReadiness, DocumentBook } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const gizmo = book.createItem({ name: 'Gizmo', currency: 'USD', unitPrice: 8000n }); // no cost history
  const supplier = book.createParty({ name: 'Widgets Wholesale Inc' });
  return { book, widget, gizmo, supplier };
}

describe('supplier info (ADR 0011)', () => {
  it('records append-only, source-tagged snapshots; newest as-of wins', () => {
    const { book, widget, supplier } = setUp();
    book.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      minimumOrderMinor: 50_000n,
      items: [{ itemId: widget.id, unitCost: 900n, leadDays: 14 }],
    });
    const fresh = book.recordSupplierInfo({
      partyId: supplier.id, source: 'edi-plugin', asOf: '2026-06-01', currency: 'USD',
      minimumOrderMinor: 60_000n,
      shipping: [{ method: 'freight', costMinor: 12_000n, freeAboveMinor: 100_000n, minDays: 3, maxDays: 7 }],
      items: [{ itemId: widget.id, unitCost: 950n, inStock: true, multipleQuantityMilli: 12_000n }],
    });
    expect(fresh.infoSeq).toBe(2);
    expect(fresh.source).toBe('edi-plugin');

    // Effective-dated lookup: what did we know when?
    expect(book.supplierInfoAt(supplier.id, '2026-03-01')!.minimumOrderMinor).toBe(50_000n);
    expect(book.supplierInfoAt(supplier.id, '2026-07-01')!.minimumOrderMinor).toBe(60_000n);
    expect(book.supplierInfo(supplier.id)!.infoSeq).toBe(2);
    expect(book.supplierInfoHistory(supplier.id)).toHaveLength(2);
    expect(book.supplierCostAt(supplier.id, widget.id, '2026-03-01')).toBe(900n);
    expect(book.supplierCostAt(supplier.id, widget.id, '2026-07-01')).toBe(950n);
  });

  it('validates parties, items, and terms', () => {
    const { book, widget, supplier } = setUp();
    expect(() =>
      book.recordSupplierInfo({ partyId: 'nope', asOf: '2026-01-01', currency: 'USD' }),
    ).toThrowError(/No such party/);
    expect(() =>
      book.recordSupplierInfo({
        partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
        items: [{ itemId: 'nope', unitCost: 1n }],
      }),
    ).toThrowError(/No such item/);
    expect(() =>
      book.recordSupplierInfo({
        partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
        items: [{ itemId: widget.id, unitCost: -1n }],
      }),
    ).toThrowError(/not be negative/);
    expect(() =>
      book.recordSupplierInfo({
        partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
        shipping: [{ method: 'ground', minDays: 5, maxDays: 2 }],
      }),
    ).toThrowError(/maxDays 2 is below minDays 5/);
  });
});

describe('purchase orders (ADR 0011)', () => {
  it('prices at cost: explicit → supplier quote → cost history; untaxed', () => {
    const { book, widget, gizmo, supplier } = setUp();
    book.setTaxRate({ code: 'TX', percentMilli: 8_250n });
    book.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      items: [{ itemId: widget.id, unitCost: 900n }],
    });
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 10_000n }, // supplier quote 9.00
        { itemId: widget.id, description: 'Widget (spot price)', quantityMilli: 1000n, unitPrice: 875n },
      ],
    });
    expect(po.current.lines[0]!.unitPrice).toBe(900n);
    expect(po.current.lines[1]!.unitPrice).toBe(875n);
    // Never taxed, even though the item may carry a tax code for sales.
    expect(po.current.lines.every((line) => line.taxCode === null)).toBe(true);
    expect(po.total).toBe(9875n);

    // Without a supplier quote, cost history is the fallback…
    const noQuote = book.createDocument({
      type: 'purchase_order', number: 'PO-2', date: '2026-07-01', customerName: 'Cash & Carry Co',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(noQuote.current.lines[0]!.unitPrice).toBe(1000n);

    // …and with neither, the line needs an explicit price.
    expect(() =>
      book.createDocument({
        type: 'purchase_order', number: 'PO-3', date: '2026-07-01', partyId: supplier.id,
        lines: [{ itemId: gizmo.id, description: 'Gizmo', quantityMilli: 1000n }],
      }),
    ).toThrowError(/supplier quote, or item cost history/);
  });

  it('draws numbers from its own sequence and edits freely as a draft', () => {
    const { book, widget, supplier } = setUp();
    book.setNumberSequence('purchase_order', { prefix: 'PO-' });
    const po = book.createDocument({
      type: 'purchase_order', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(po.number).toBe('PO-0001');
    // Accumulate: drafts take plain edits.
    const grown = book.changeDocument(po.id, {
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 1000n },
        { itemId: widget.id, description: 'Widget', quantityMilli: 5000n },
      ],
    });
    expect(grown.current.lines).toHaveLength(2);
    // Sent purchase orders require correction/substitution, like sales orders.
    book.sendDocument(po.id);
    expect(() => book.changeDocument(po.id, { memo: 'oops' })).toThrowError(/purchase order requires kind/);
    book.changeDocument(po.id, { kind: 'correction', reason: 'price fixed', memo: 'ok' });
  });

  it('links PO lines to sales-order lines, bounded by the promised quantity', () => {
    const { book, widget, supplier } = setUp();
    const so = book.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, lineId: 'L1' }],
    });
    // A draft PO accumulates lines from the sales order — no conversion involved.
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-02', partyId: supplier.id,
      lines: [{
        itemId: widget.id, description: 'Widget', quantityMilli: 6000n,
        sourceDocumentId: so.id, sourceLineId: 'L1',
      }],
    });
    // Coverage splits draft vs sent.
    let coverage = book.purchaseCoverage(so.id);
    expect(coverage[0]).toMatchObject({ draftOrderedMilli: 6000n, sentOrderedMilli: 0n, unorderedMilli: 4000n });
    book.sendDocument(po.id);
    coverage = book.purchaseCoverage(so.id);
    expect(coverage[0]).toMatchObject({ draftOrderedMilli: 0n, sentOrderedMilli: 6000n, unorderedMilli: 4000n });

    // Over-ordering against the link is rejected (order overage unlinked instead).
    expect(() =>
      book.createDocument({
        type: 'purchase_order', number: 'PO-2', date: '2026-07-03', partyId: supplier.id,
        lines: [{
          itemId: widget.id, description: 'Widget', quantityMilli: 5000n,
          sourceDocumentId: so.id, sourceLineId: 'L1',
        }],
      }),
    ).toThrowError(/exceeds the 10000 on the sales order/);

    // Links must point at real sales-order lines.
    expect(() =>
      book.createDocument({
        type: 'purchase_order', number: 'PO-3', date: '2026-07-03', partyId: supplier.id,
        lines: [{
          itemId: widget.id, description: 'Widget', quantityMilli: 1000n,
          sourceDocumentId: so.id, sourceLineId: 'nope',
        }],
      }),
    ).toThrowError(/has no line/);
    expect(() =>
      book.createDocument({
        type: 'purchase_order', number: 'PO-4', date: '2026-07-03', partyId: supplier.id,
        lines: [{
          itemId: widget.id, description: 'Widget', quantityMilli: 1000n,
          sourceDocumentId: po.id, sourceLineId: 'L1',
        }],
      }),
    ).toThrowError(/only link to sales-order lines/);

    // PO links don't consume sales-order fulfillment — invoicing does.
    expect(book.fulfillment(so.id)[0]!.openMilli).toBe(10_000n);

    // The sales order cannot shrink below what's on order with the supplier.
    expect(() =>
      book.changeDocument(so.id, {
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 5000n, lineId: 'L1' }],
      }),
    ).toThrowError(/cannot shrink below the 6000/);
  });

  it('gates sending on the supplier minimums, with an approvable override', () => {
    const { book, widget, supplier } = setUp();
    book.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      minimumOrderMinor: 10_000n, // 100.00
      items: [{ itemId: widget.id, unitCost: 900n, multipleQuantityMilli: 12_000n }],
    });
    const po = book.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 6000n }], // 54.00, half a case
    });
    const readiness = book.purchaseOrderReadiness(po.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.shortfalls.map((entry) => entry.kind)).toEqual(['order_minimum', 'item_multiple']);
    expect(() => book.sendDocument(po.id)).toThrowError(/MINIMUM|below the supplier minimum|pack size/);

    // The override is approvable.
    book.setApprovalPolicy(['minimum_order_override']);
    expect(() => book.sendDocument(po.id, { overrideMinimum: true })).toThrowError(/requires an approver/);

    // Accumulate to a full case: ready, sends without an override.
    book.changeDocument(po.id, {
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 12_000n }],
    });
    expect(book.purchaseOrderReadiness(po.id)).toMatchObject({ ready: true, shortfalls: [] });
    book.sendDocument(po.id);

    // No supplier info on file ⇒ trivially ready.
    const cash = book.createDocument({
      type: 'purchase_order', number: 'PO-9', date: '2026-07-01', customerName: 'Cash & Carry Co',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 999n }],
    });
    expect(book.purchaseOrderReadiness(cash.id).ready).toBe(true);
  });

  it('computePurchaseReadiness reports quantity minimums too', () => {
    const info = {
      infoSeq: 1, partyId: 'p', source: 'manual', asOf: '2026-01-01', at: 'now', currency: 'USD',
      minimumOrderMinor: null, minimumOrderQuantityMilli: 5000n,
      shipping: [], items: [], notes: null,
    };
    const line = {
      lineId: 'L1', itemId: 'i', description: 'x', quantityMilli: 2000n, unitPrice: 100n,
      currency: 'USD', adjustment: 0n, free: false, substituted: false,
      sourceDocumentId: null, sourceLineId: null, returnCondition: null,
      taxCode: null, taxPercentMilli: 0n,
    };
    const readiness = computePurchaseReadiness([line], info);
    expect(readiness.ready).toBe(false);
    expect(readiness.shortfalls[0]!.kind).toBe('order_quantity');
  });
});

describe('special_order deposit policy (ADR 0011 part 6)', () => {
  it('special-order lines must be prepaid in full via the deposit request', () => {
    const { book } = setUp();
    book.setTaxRate({ code: 'TX', percentMilli: 10_000n }); // 10%
    const special = book.createItem({
      name: 'Special-order part', currency: 'USD', unitPrice: 20_000n, cost: 12_000n,
      depositPolicy: 'special_order', taxCode: 'TX',
    });
    const so = book.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 5000n }, // not enough: line gross is 220.00
      lines: [{ itemId: special.id, description: 'Part', quantityMilli: 1000n, lineId: 'L1' }],
    });
    expect(() => book.sendDocument(so.id)).toThrowError(/must cover at least 22000, not 5000/);

    // A deposit covering the special-order lines in full sends.
    const covered = book.createDocument({
      type: 'sales_order', number: 'SO-2', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 22_000n },
      lines: [{ itemId: special.id, description: 'Part', quantityMilli: 1000n, lineId: 'L1' }],
    });
    book.sendDocument(covered.id);

    // The override escape still applies, gated by deposit_override.
    book.setApprovalPolicy(['deposit_override']);
    expect(() => book.sendDocument(so.id, { overrideDeposit: true })).toThrowError(/requires an approver/);
    book.sendDocument(so.id, { overrideDeposit: true, approvedBy: 'owner' });
  });

  it('mixed orders only floor the special-order lines', () => {
    const { book, widget } = setUp();
    const special = book.createItem({
      name: 'Special-order part', currency: 'USD', unitPrice: 10_000n, depositPolicy: 'special_order',
    });
    const so = book.createDocument({
      type: 'sales_order', number: 'SO-3', date: '2026-07-01', ...acme,
      deposit: { amountMinor: 10_000n }, // covers the special line; widget line needs nothing
      lines: [
        { itemId: special.id, description: 'Part', quantityMilli: 1000n },
        { itemId: widget.id, description: 'Widget', quantityMilli: 4000n },
      ],
    });
    book.sendDocument(so.id);
  });
});
