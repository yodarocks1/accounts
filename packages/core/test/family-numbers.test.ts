import { describe, expect, it } from 'vitest';
import { DocumentBook, familyBaseOf, nextFamilyNumber } from '../src/index.js';

describe('family number helpers (ADR 0022)', () => {
  it('derives the base by stripping letter suffixes after a digit', () => {
    expect(familyBaseOf('412')).toBe('412');
    expect(familyBaseOf('412b')).toBe('412');
    expect(familyBaseOf('412aa')).toBe('412');
    expect(familyBaseOf('EST-0412')).toBe('EST-0412');
    expect(familyBaseOf('DRAFT')).toBe('DRAFT'); // no digit — nothing stripped
  });

  it('assigns letters monotonically, spreadsheet-style past z', () => {
    expect(nextFamilyNumber('412', ['412'])).toBe('412b');
    expect(nextFamilyNumber('412', ['412', '412b'])).toBe('412c');
    expect(nextFamilyNumber('412b', ['412', '412b', '412c'])).toBe('412d'); // chains extend the root
    expect(nextFamilyNumber('412', ['412', '412z'])).toBe('412aa');
    expect(nextFamilyNumber('412', ['412', '4120', '412-1'])).toBe('412b'); // lookalikes are not family
  });
});

describe('family numbers in the book (ADR 0022)', () => {
  function setUp() {
    const book = new DocumentBook();
    const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 900n });
    const supplier = book.createParty({ name: 'Widgets Wholesale' });
    return { book, widget, supplier };
  }

  it('EST 412 → SO 412b → invoices 412c and 412d', () => {
    const { book, widget } = setUp();
    const estimate = book.createDocument({
      type: 'estimate', number: '412', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, lineId: 'E1' }],
    });
    book.sendDocument(estimate.id);
    const order = book.convertDocument(estimate.id, { type: 'sales_order', date: '2026-07-02' });
    expect(order.number).toBe('412b');
    book.sendDocument(order.id);
    const soLine = book.view(order.id).current.lines[0]!;
    const first = book.convertDocument(order.id, {
      type: 'invoice', date: '2026-07-03', lines: [{ sourceLineId: soLine.lineId, quantityMilli: 4_000n }],
    });
    const second = book.convertDocument(order.id, {
      type: 'invoice', date: '2026-07-04', lines: [{ sourceLineId: soLine.lineId, quantityMilli: 6_000n }],
    });
    expect(first.number).toBe('412c');
    expect(second.number).toBe('412d');
  });

  it('cross-linked documents join the family; explicit numbers still win', () => {
    const { book, widget, supplier } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-77', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, lineId: 'S1' }],
    });
    book.sendDocument(order.id);
    // A PO ordering for this SO inherits the family number.
    const po = book.createDocument({
      type: 'purchase_order', date: '2026-07-02', partyId: supplier.id,
      lines: [{
        itemId: widget.id, description: 'Widget', quantityMilli: 6_000n, unitPrice: 900n,
        sourceDocumentId: order.id, sourceLineId: 'S1',
      }],
    });
    expect(po.number).toBe('SO-77b');
    // An explicit number opts out without consuming a letter for itself.
    const named = book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-CUSTOM', date: '2026-07-03',
      lines: [{ sourceLineId: 'S1', quantityMilli: 1_000n }],
    });
    expect(named.number).toBe('INV-CUSTOM');
    // The next automatic member continues from the highest letter in use.
    const next = book.convertDocument(order.id, {
      type: 'invoice', date: '2026-07-04', lines: [{ sourceLineId: 'S1', quantityMilli: 1_000n }],
    });
    expect(next.number).toBe('SO-77c');
  });

  it('multiple sources start a new transaction: fresh sequence number', () => {
    const { book, widget } = setUp();
    book.setNumberSequence('credit_memo', { prefix: 'CM-' });
    const a = book.createDocument({
      type: 'invoice', number: '100', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2_000n, lineId: 'A1' }],
    });
    book.sendDocument(a.id);
    const b = book.createDocument({
      type: 'invoice', number: '200', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3_000n, lineId: 'B1' }],
    });
    book.sendDocument(b.id);
    // A credit memo drawing on BOTH invoices is a new transaction.
    const memo = book.createDocument({
      type: 'credit_memo', date: '2026-07-05', customerName: 'Acme',
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 1_000n, sourceDocumentId: a.id, sourceLineId: 'A1' },
        { itemId: widget.id, description: 'Widget', quantityMilli: 1_000n, sourceDocumentId: b.id, sourceLineId: 'B1' },
      ],
    });
    expect(memo.number).toBe('CM-0001'); // its own type sequence, not 100b or 200b
    // …and conversions off the multi-source document suffix ITS number.
    // (single-source memo joins the family of its one source)
    const single = book.createDocument({
      type: 'credit_memo', date: '2026-07-06', customerName: 'Acme',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 500n, sourceDocumentId: a.id, sourceLineId: 'A1' }],
    });
    expect(single.number).toBe('100b');
  });

  it('void members keep their letters; the family never reuses them', () => {
    const { book, widget } = setUp();
    const estimate = book.createDocument({
      type: 'estimate', number: '900', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 5_000n, lineId: 'E1' }],
    });
    book.sendDocument(estimate.id);
    const order = book.convertDocument(estimate.id, { type: 'sales_order', date: '2026-07-02' });
    expect(order.number).toBe('900b');
    book.voidDocument(order.id);
    const retry = book.convertDocument(estimate.id, { type: 'sales_order', date: '2026-07-03' });
    expect(retry.number).toBe('900c'); // b stays with the void, honestly
  });
});
