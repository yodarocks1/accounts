import { describe, expect, it } from 'vitest';
import { DocumentBook, LedgerError } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  book.setTaxRate({ code: 'TX', name: 'State sales tax', percentMilli: 8_250n }); // 8.25%
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n, taxCode: 'TX' });
  const service = book.createItem({ name: 'Service hour', currency: 'USD', unitPrice: 10000n }); // untaxed
  return { book, widget, service };
}

describe('sales tax (Tier 3)', () => {
  it('applies the item default rate, grouped and rounded once per code', () => {
    const { book, widget, service } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-01', ...acme,
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 4000n },   // 100.00 taxable
        { itemId: service.id, description: 'Labor', quantityMilli: 1000n },   // 100.00 untaxed
      ],
    });
    expect(invoice.subtotal).toBe(20000n);
    expect(invoice.taxTotal).toBe(825n); // 8.25% of 100.00
    expect(invoice.total).toBe(20825n);
    expect(invoice.taxBreakdown).toEqual([
      { taxCode: 'TX', percentMilli: 8250n, taxableAmount: 10000n, tax: 825n },
    ]);
    expect(invoice.current.lines[0]!.taxCode).toBe('TX');
    expect(invoice.current.lines[0]!.taxPercentMilli).toBe(8250n);
    expect(invoice.current.lines[1]!.taxCode).toBeNull();
  });

  it('snapshots the rate: later changes never touch issued documents', () => {
    const { book, widget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-07-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    book.sendDocument(invoice.id);
    book.setTaxRate({ code: 'TX', percentMilli: 9_000n, effectiveFrom: '2026-01-01' }); // retroactive
    expect(book.view(invoice.id).taxTotal).toBe(825n); // unchanged
    // New documents pick up the rate effective on THEIR date.
    const later = book.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-07-02', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(later.taxTotal).toBe(900n);
  });

  it('exempt parties and per-document overrides suppress tax; unknown codes fail', () => {
    const { book, widget } = setUp();
    const school = book.createParty({ name: 'District School', accountNumber: 'GOV-1', taxExempt: true });
    const exempt = book.createDocument({
      type: 'invoice', number: 'INV-4', date: '2026-07-01', partyId: school.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(exempt.taxTotal).toBe(0n);
    expect(exempt.current.lines[0]!.taxCode).toBeNull();

    const override = book.createDocument({
      type: 'invoice', number: 'INV-5', date: '2026-07-01', ...acme, taxExempt: true,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(override.taxTotal).toBe(0n);

    expect(() =>
      book.createDocument({
        type: 'invoice', number: 'INV-6', date: '2026-07-01', ...acme,
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, taxCode: 'NOPE' }],
      }),
    ).toThrowError(/No tax rate for code NOPE/);
  });

  it('tax flows into settlement, statements, and returns refund the tax paid', () => {
    const { book, widget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-7', date: '2026-06-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }], // 100 + 8.25
    });
    book.sendDocument(invoice.id);
    expect(book.invoiceSettlement(invoice.id).open).toBe(10825n);

    book.recordPayment({
      number: 'PMT-1', date: '2026-06-05', ...acme, amount: 10825n,
      applications: [{ invoiceId: invoice.id, amount: 10825n }],
    });
    expect(book.invoiceSettlement(invoice.id).status).toBe('paid');

    // Rate rises, then the customer returns one widget: credit includes the 8.25% they paid.
    book.setTaxRate({ code: 'TX', percentMilli: 9_000n, effectiveFrom: '2026-06-10' });
    const credit = book.createReturn({
      number: 'CR-1', date: '2026-06-20', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    expect(credit.subtotal).toBe(2500n);
    expect(credit.taxTotal).toBe(206n); // 8.25% of 25.00, NOT 9%
    expect(credit.total).toBe(2706n);

    const statement = book.statement({ accountNumber: 'A-100' }, '2026-07-01');
    expect(statement.invoices[0]!.currentTotal).toBe(10825n);
    expect(statement.invoices[0]!.ageLabel).toBe('paid');
  });

  it('charge corrections target the pre-tax subtotal; tax follows', () => {
    const { book, widget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-8', date: '2026-06-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    book.sendDocument(invoice.id);
    const corrected = book.chargeCorrection(invoice.id, 9000n, 'charged less'); // subtotal → 90.00
    expect(corrected.subtotal).toBe(9000n);
    expect(corrected.taxTotal).toBe(743n); // 8.25% of 90.00 (742.5 → half-up)
    expect(corrected.total).toBe(9743n);
  });

  it('negative tax rates are rejected', () => {
    const { book } = setUp();
    expect(() => book.setTaxRate({ code: 'BAD', percentMilli: -1n })).toThrow(LedgerError);
  });
});
