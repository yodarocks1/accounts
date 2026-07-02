import { describe, expect, it } from 'vitest';
import { DocumentBook, LedgerError, dueDateOf } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
  return { book, widget };
}

describe('payment terms and due dates (Tier 1)', () => {
  it('derives due dates from terms, including month rollover', () => {
    expect(dueDateOf({ date: '2026-06-01', termsDays: 30 })).toBe('2026-07-01');
    expect(dueDateOf({ date: '2026-12-15', termsDays: 30 })).toBe('2027-01-14');
    expect(dueDateOf({ date: '2026-06-01', termsDays: 0 })).toBe('2026-06-01');
    expect(dueDateOf({ date: '2026-06-01', termsDays: null })).toBeNull();
  });

  it('rejects negative or fractional terms', () => {
    const { book, widget } = setUp();
    for (const bad of [-1, 2.5]) {
      expect(() =>
        book.createDocument({
          type: 'invoice', number: `INV-${bad}`, date: '2026-06-01', ...acme, termsDays: bad,
          lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
        }),
      ).toThrow(LedgerError);
    }
  });

  it('ages from the due date when terms exist; unmatured invoices read "not due"', () => {
    const { book, widget } = setUp();
    const invoice = (number: string, date: string, termsDays?: number) => {
      const view = book.createDocument({
        type: 'invoice', number, date, ...acme,
        ...(termsDays !== undefined ? { termsDays } : {}),
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
      });
      book.sendDocument(view.id);
      return view;
    };

    invoice('INV-A', '2026-05-01', 30); // due 05-31 → 32 days past due at 07-02
    invoice('INV-B', '2026-06-20', 30); // due 07-20 → not due yet
    invoice('INV-C', '2026-06-01');     // no terms → aged from invoice date (31 days)

    const statement = book.statement({ accountNumber: 'A-100' }, '2026-07-02');
    const byNumber = new Map(statement.invoices.map((entry) => [entry.number, entry]));

    expect(byNumber.get('INV-A')!.dueDate).toBe('2026-05-31');
    expect(byNumber.get('INV-A')!.ageDays).toBe(32);
    expect(byNumber.get('INV-A')!.ageLabel).toBe('past due');

    expect(byNumber.get('INV-B')!.ageDays).toBe(-18);
    expect(byNumber.get('INV-B')!.ageLabel).toBe('not due');

    expect(byNumber.get('INV-C')!.dueDate).toBeNull();
    expect(byNumber.get('INV-C')!.ageLabel).toBe('past due');
  });

  it('supports negative-minDays rules like "due within a week"', () => {
    const { book, widget } = setUp();
    const view = book.createDocument({
      type: 'invoice', number: 'INV-D', date: '2026-06-25', ...acme, termsDays: 10, // due 07-05
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(view.id);
    const rules = [
      { label: 'due this week', minDays: -7, maxDays: -1 },
      { label: 'overdue', minDays: 0 },
    ];
    const statement = book.statement({ accountNumber: 'A-100' }, '2026-07-02', rules);
    expect(statement.invoices[0]!.ageDays).toBe(-3);
    expect(statement.invoices[0]!.ageLabel).toBe('due this week');
  });

  it('terms carry through corrections and inherit through conversions', () => {
    const { book, widget } = setUp();
    const estimate = book.createDocument({
      type: 'estimate', number: 'EST-1', date: '2026-06-01', ...acme, termsDays: 45,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(estimate.id);
    const invoice = book.convertDocument(estimate.id, { type: 'invoice', number: 'INV-E', date: '2026-06-10' });
    expect(invoice.current.termsDays).toBe(45);

    book.sendDocument(invoice.id);
    const corrected = book.chargeCorrection(invoice.id, 2000n, 'charged $20');
    expect(corrected.current.termsDays).toBe(45);
  });
});
