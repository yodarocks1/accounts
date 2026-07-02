import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DocumentBook,
  LedgerError,
  formatQuantity,
  lineTotal,
  parseQuantity,
  resolveRevisionKind,
} from '../src/index.js';

function bookWithItem() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
  const hours = book.createItem({ name: 'Consulting hour', currency: 'USD', unitPrice: 15000n });
  return { book, widget, hours };
}

describe('quantities', () => {
  it('parses and formats scale-3 quantities exactly', () => {
    expect(parseQuantity('2.5')).toBe(2500n);
    expect(parseQuantity('0.125')).toBe(125n);
    expect(formatQuantity(2500n)).toBe('2.5');
    expect(formatQuantity(3000n)).toBe('3');
    expect(() => parseQuantity('1.0001')).toThrow(LedgerError);
  });

  it('line totals round half away from zero at the last step', () => {
    // 0.333 × $0.01 = $0.00333 → 0 minor units; 0.5 × $0.01 → 1 minor unit (half up)
    expect(lineTotal({ quantityMilli: 333n, unitPrice: 1n })).toBe(0n);
    expect(lineTotal({ quantityMilli: 500n, unitPrice: 1n })).toBe(1n);
    expect(lineTotal({ quantityMilli: 2500n, unitPrice: 15000n })).toBe(37500n);
  });
});

describe('invoice correction semantics', () => {
  it('draft invoices are freely editable without gaining tags', () => {
    const { book, widget } = bookWithItem();
    const invoice = book.createDocument({
      type: 'invoice',
      number: 'INV-0001', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    const edited = book.changeDocument(invoice.id, {
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3000n }],
    });
    expect(edited.tags).toEqual([]);
    expect(edited.label).toBe('INV-0001');
    expect(edited.revisionCount).toBe(2);
  });

  it('sent invoices reject plain edits and record corrections', () => {
    const { book, widget } = bookWithItem();
    const invoice = book.createDocument({
      type: 'invoice',
      number: 'INV-0002', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    book.sendDocument(invoice.id);

    expect(() => book.changeDocument(invoice.id, { kind: 'edit', memo: 'sneaky' })).toThrowError(
      /only be changed by a correction/,
    );

    const corrected = book.changeDocument(invoice.id, {
      reason: 'Customer was billed for 2, received 3',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3000n }],
    });
    expect(corrected.tags).toEqual(['with corrections']);
    expect(corrected.label).toBe('INV-0002 (with corrections)');
    // Lookup shows the most up-to-date information…
    expect(corrected.current.lines[0]!.quantityMilli).toBe(3000n);
    expect(corrected.total).toBe(7500n);
    // …while history preserves exactly what was sent.
    const history = book.history(invoice.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.lines[0]!.quantityMilli).toBe(2000n);
    expect(history[1]!.kind).toBe('correction');
    expect(history[1]!.reason).toMatch(/billed for 2/);
  });
});

describe('sales order corrections and substitutions', () => {
  it('sent sales orders require an explicit correction or substitution kind', () => {
    const { book, widget } = bookWithItem();
    const order = book.createDocument({
      type: 'sales_order',
      number: 'SO-0001', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 5000n }],
    });
    book.sendDocument(order.id);
    expect(() => book.changeDocument(order.id, { memo: 'tweak' })).toThrowError(
      /requires kind "correction" or "substitution"/,
    );

    const substituted = book.changeDocument(order.id, {
      kind: 'substitution',
      reason: 'Widget out of stock; blue widget shipped',
      lines: [{ itemId: widget.id, description: 'Widget (blue)', quantityMilli: 5000n }],
    });
    expect(substituted.tags).toEqual(['with substitutions']);

    const corrected = book.changeDocument(order.id, { kind: 'correction', date: '2026-07-02' });
    expect(corrected.tags).toEqual(['with corrections', 'with substitutions']);
    expect(corrected.label).toBe('SO-0001 (with corrections, with substitutions)');
  });

  it('an invoice created from a marked sales order inherits its tags', () => {
    const { book, widget } = bookWithItem();
    const order = book.createDocument({
      type: 'sales_order',
      number: 'SO-0002', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(order.id);
    book.changeDocument(order.id, { kind: 'substitution', reason: 'stock' });

    const invoice = book.createDocument({
      type: 'invoice',
      number: 'INV-0003', customerName: 'Acme LLC',
      date: '2026-07-05',
      sourceDocumentId: order.id,
      lines: [{ itemId: widget.id, description: 'Widget (blue)', quantityMilli: 1000n }],
    });
    expect(invoice.tags).toEqual(['with substitutions']);
    expect(invoice.label).toBe('INV-0003 (with substitutions)');

    // Tags snapshot at creation: correcting the SO later doesn't retag the invoice.
    book.changeDocument(order.id, { kind: 'correction', reason: 'price fix' });
    expect(book.view(invoice.id).tags).toEqual(['with substitutions']);
  });
});

describe('estimate semantics', () => {
  it('estimates stay editable after sending and keep full history, untagged', () => {
    const { book, hours } = bookWithItem();
    const estimate = book.createDocument({
      type: 'estimate',
      number: 'EST-0001', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: hours.id, description: 'Discovery', quantityMilli: 10000n }],
    });
    book.sendDocument(estimate.id);
    book.changeDocument(estimate.id, {
      lines: [{ itemId: hours.id, description: 'Discovery + build', quantityMilli: 25000n }],
    });
    const view = book.changeDocument(estimate.id, { memo: 'Revised after call' });
    expect(view.tags).toEqual([]);
    expect(view.revisionCount).toBe(3);
    expect(book.history(estimate.id).map((revision) => revision.kind)).toEqual([
      'initial',
      'edit',
      'edit',
    ]);
  });
});

describe('void and lifecycle guards', () => {
  it('void documents accept no further changes', () => {
    const { book, widget } = bookWithItem();
    const invoice = book.createDocument({
      type: 'invoice',
      number: 'INV-0004', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.voidDocument(invoice.id);
    expect(() => book.changeDocument(invoice.id, { memo: 'no' })).toThrowError(/Void documents/);
    expect(() => book.sendDocument(invoice.id)).toThrowError(/Only draft/);
  });

  it('document numbers are unique per type', () => {
    const { book, widget } = bookWithItem();
    const lines = [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }];
    book.createDocument({ type: 'invoice', number: 'DOC-1', customerName: 'Acme LLC', date: '2026-07-01', lines });
    expect(() =>
      book.createDocument({ type: 'invoice', number: 'DOC-1', customerName: 'Acme LLC', date: '2026-07-01', lines }),
    ).toThrowError(/already in use/);
    // Same number on a different type is fine.
    book.createDocument({ type: 'estimate', number: 'DOC-1', customerName: 'Acme LLC', date: '2026-07-01', lines });
  });

  it('resolveRevisionKind rejects reserved and mismatched kinds', () => {
    expect(() => resolveRevisionKind('invoice', 'draft', 'initial')).toThrow(LedgerError);
    expect(() => resolveRevisionKind('invoice', 'draft', 'correction')).toThrow(LedgerError);
    expect(() => resolveRevisionKind('estimate', 'sent', 'correction')).toThrow(LedgerError);
    expect(resolveRevisionKind('sales_order', 'sent', 'substitution')).toBe('substitution');
  });
});

describe('price changes never change past transactions', () => {
  it('documents keep the price effective on their date; catalog changes do not leak', () => {
    const book = new DocumentBook();
    const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const invoice = book.createDocument({
      type: 'invoice',
      number: 'INV-0005', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(invoice.total).toBe(10000n);
    book.sendDocument(invoice.id);

    // Future price change: no effect on the sent invoice.
    book.setPrice(widget.id, 9900n, '2026-08-01');
    expect(book.view(invoice.id).total).toBe(10000n);

    // Even a RETROACTIVE price change leaves the snapshot untouched.
    book.setPrice(widget.id, 100n, '2026-01-01');
    expect(book.view(invoice.id).total).toBe(10000n);
    expect(book.view(invoice.id).current.lines[0]!.unitPrice).toBe(2500n);

    // New documents pick up the price effective on THEIR date.
    const later = book.createDocument({
      type: 'invoice',
      number: 'INV-0006', customerName: 'Acme LLC',
      date: '2026-08-02',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(later.current.lines[0]!.unitPrice).toBe(9900n);
  });

  it('property: no sequence of price changes ever mutates an existing document', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            unitPrice: fc.bigInt({ min: 0n, max: 1_000_000n }),
            month: fc.integer({ min: 1, max: 12 }),
            day: fc.integer({ min: 1, max: 28 }),
          }),
          { maxLength: 30 },
        ),
        (priceChanges) => {
          const book = new DocumentBook();
          const item = book.createItem({ name: 'Thing', currency: 'USD', unitPrice: 777n });
          const created = book.createDocument({
            type: 'invoice',
            number: 'INV-P', customerName: 'Acme LLC',
            date: '2026-06-15',
            lines: [{ itemId: item.id, description: 'Thing', quantityMilli: 3210n }],
          });
          book.sendDocument(created.id);
          const snapshot = JSON.stringify(book.history(created.id), (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          );

          for (const change of priceChanges) {
            const pad = (value: number) => String(value).padStart(2, '0');
            book.setPrice(item.id, change.unitPrice, `2026-${pad(change.month)}-${pad(change.day)}`);
          }

          const after = JSON.stringify(book.history(created.id), (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          );
          expect(after).toBe(snapshot);
          expect(book.view(created.id).current.lines[0]!.unitPrice).toBe(777n);
        },
      ),
      { numRuns: 50 },
    );
  });
});
