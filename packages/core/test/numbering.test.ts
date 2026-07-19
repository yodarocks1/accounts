import { describe, expect, it } from 'vitest';
import { DocumentBook, LedgerError, formatSequenceNumber } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
  const lines = [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }];
  return { book, widget, lines };
}

describe('auto-numbering (Tier 3)', () => {
  it('draws formatted numbers per kind; explicit numbers still work', () => {
    const { book, lines } = setUp();
    book.setNumberSequence('invoice', { prefix: 'INV-', next: 7, width: 4 });
    book.setNumberSequence('payment', { prefix: 'PMT-', width: 3 });

    const first = book.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines });
    const second = book.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines });
    expect(first.number).toBe('INV-0007');
    expect(second.number).toBe('INV-0008');

    // Explicit numbers bypass the sequence without consuming it.
    const manual = book.createDocument({ type: 'invoice', number: 'INV-CUSTOM', date: '2026-07-01', ...acme, lines });
    expect(manual.number).toBe('INV-CUSTOM');
    expect(book.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines }).number).toBe('INV-0009');

    const payment = book.recordPayment({ date: '2026-07-02', ...acme, amount: 100n });
    expect(payment.number).toBe('PMT-001');

    expect(formatSequenceNumber({ prefix: 'X-', width: 6 }, 42)).toBe('X-000042');
  });

  it('no sequence and no number is an error; sequences number roots, families number members (ADR 0022)', () => {
    const { book, widget, lines } = setUp();
    expect(() =>
      book.createDocument({ type: 'estimate', date: '2026-07-01', ...acme, lines }),
    ).toThrowError(/no sequence configured for estimate/);

    book.setNumberSequence('estimate', { prefix: 'EST-' });
    book.setNumberSequence('sales_order', { prefix: 'SO-' });
    book.setNumberSequence('invoice', { prefix: 'INV-' });

    const estimate = book.createDocument({ type: 'estimate', date: '2026-07-01', ...acme, lines });
    expect(estimate.number).toBe('EST-0001');
    book.sendDocument(estimate.id);
    // Conversions continue the family, not the target type's sequence.
    const order = book.convertDocument(estimate.id, { type: 'sales_order', date: '2026-07-02' });
    expect(order.number).toBe('EST-0001b');

    // An unlinked document still draws from its own sequence…
    const invoice = book.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines });
    expect(invoice.number).toBe('INV-0001');
    book.sendDocument(invoice.id);
    // …and a return linked to that one invoice joins its family.
    const credit = book.createReturn({ date: '2026-07-05', ...acme, items: [{ itemId: widget.id, quantityMilli: 1000n }] });
    expect(credit.number).toBe('INV-0001b');
  });

  it('rejects bad sequence parameters', () => {
    const { book } = setUp();
    expect(() => book.setNumberSequence('invoice', { prefix: 'X-', next: 0 })).toThrow(LedgerError);
    expect(() => book.setNumberSequence('invoice', { prefix: 'X-', width: 0 })).toThrow(LedgerError);
  });
});
