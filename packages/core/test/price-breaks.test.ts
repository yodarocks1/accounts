import { describe, expect, it } from 'vitest';
import { DocumentBook, LedgerError, marginPercentMilli } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  // Widget: sale 25.00, cost 10.00. A "box" is 12 units, a "pallet" 480.
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const invoice = (number: string, quantityMilli: bigint, date = '2026-07-01') => {
    return book.createDocument({
      type: 'invoice', number, date, ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli }],
    });
  };
  return { book, widget, invoice };
}

describe('quantity price breaks (Tier 2)', () => {
  it('threshold tiers and exact-multiple (box/pallet) tiers price correctly', () => {
    const { book, widget, invoice } = setUp();
    book.setCustomerRate({
      itemId: widget.id, ...acme,
      rate: { kind: 'constant', unitPrice: 2400n }, // base special
      tiers: [
        { minQuantityMilli: 50_000n, rate: { kind: 'constant', unitPrice: 2200n } },  // 50+
        { multipleQuantityMilli: 12_000n, rate: { kind: 'constant', unitPrice: 2000n } },  // full boxes
        { multipleQuantityMilli: 480_000n, rate: { kind: 'constant', unitPrice: 1800n } }, // full pallets
      ],
    });

    expect(invoice('INV-1', 5_000n).current.lines[0]!.unitPrice).toBe(2400n);   // 5 loose
    expect(invoice('INV-2', 24_000n).current.lines[0]!.unitPrice).toBe(2000n);  // 2 boxes
    expect(invoice('INV-3', 25_000n).current.lines[0]!.unitPrice).toBe(2400n);  // 2 boxes + 1 loose → no multiple
    expect(invoice('INV-4', 60_000n).current.lines[0]!.unitPrice).toBe(2000n);  // 5 boxes: box (20.00) beats 50+ (22.00)
    expect(invoice('INV-5', 50_000n).current.lines[0]!.unitPrice).toBe(2200n);  // 50 loose: threshold only
    expect(invoice('INV-6', 480_000n).current.lines[0]!.unitPrice).toBe(1800n); // full pallet beats box
  });

  it('formula tiers and below-cost clamping apply per candidate', () => {
    const { book, widget, invoice } = setUp();
    book.setCustomerRate({
      itemId: widget.id, ...acme,
      rate: { kind: 'formula', base: 'sale', percentMilli: -10_000n }, // 10% off = 22.50
      tiers: [
        { minQuantityMilli: 10_000n, rate: { kind: 'formula', base: 'cost', percentMilli: 20_000n } }, // cost+20% = 12.00
        { minQuantityMilli: 100_000n, rate: { kind: 'constant', unitPrice: 100n } }, // absurd; clamps at cost
      ],
      allowBelowCost: false,
    });
    expect(invoice('INV-7', 5_000n).current.lines[0]!.unitPrice).toBe(2250n);
    expect(invoice('INV-8', 10_000n).current.lines[0]!.unitPrice).toBe(1200n);
    expect(invoice('INV-9', 100_000n).current.lines[0]!.unitPrice).toBe(1000n); // clamped at cost
  });

  it('tiers need a condition and positive quantities', () => {
    const { book, widget } = setUp();
    expect(() =>
      book.setCustomerRate({
        itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 2400n },
        tiers: [{ rate: { kind: 'constant', unitPrice: 2000n } }],
      }),
    ).toThrowError(/minimum quantity and\/or an exact multiple/);
    expect(() =>
      book.setCustomerRate({
        itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 2400n },
        tiers: [{ minQuantityMilli: 0n, rate: { kind: 'constant', unitPrice: 2000n } }],
      }),
    ).toThrow(LedgerError);
  });
});

describe('rate hygiene (Tier 2)', () => {
  it('expiry ends special pricing; revocation ends it explicitly', () => {
    const { book, widget, invoice } = setUp();
    book.setCustomerRate({
      itemId: widget.id, ...acme,
      rate: { kind: 'constant', unitPrice: 2000n },
      effectiveTo: '2026-06-30', // through June
    });
    expect(invoice('INV-10', 1000n, '2026-06-15').current.lines[0]!.unitPrice).toBe(2000n);
    expect(invoice('INV-11', 1000n, '2026-07-15').current.lines[0]!.unitPrice).toBe(2500n); // expired → catalog

    book.setCustomerRate({ itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 1900n }, effectiveFrom: '2026-08-01' });
    expect(invoice('INV-12', 1000n, '2026-08-05').current.lines[0]!.unitPrice).toBe(1900n);
    book.setCustomerRate({ itemId: widget.id, ...acme, rate: { kind: 'revoked' }, effectiveFrom: '2026-09-01' });
    expect(invoice('INV-13', 1000n, '2026-09-05').current.lines[0]!.unitPrice).toBe(2500n); // revoked → catalog
  });

  it('suggestions carry margins; rateReview reports the standing rates', () => {
    const { book, widget, invoice } = setUp();
    expect(marginPercentMilli(2000n, 1000n)).toBe(50_000n); // 50%
    expect(marginPercentMilli(2000n, undefined)).toBeNull();

    const view = invoice('INV-14', 1000n);
    book.changeDocument(view.id, {
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 1100n }],
    });
    book.sendDocument(view.id);
    const [suggestion] = book.suggestSpecialRates(view.id);
    expect(suggestion!.marginPercentMilli).toBe(9_091n); // (11−10)/11 ≈ 9.091%

    book.setCustomerRate({ itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 2000n } });
    book.setCustomerRate({
      itemId: widget.id, customerName: 'Someone Else',
      rate: { kind: 'constant', unitPrice: 2300n }, effectiveTo: '2026-01-31',
    });
    const review = book.rateReview('2026-07-01');
    expect(review).toHaveLength(2);
    const active = review.find((entry) => entry.rate.customerName === 'Acme LLC')!;
    expect(active.active).toBe(true);
    expect(active.resolvedPrice).toBe(2000n);
    expect(active.marginPercentMilli).toBe(50_000n);
    const expired = review.find((entry) => entry.rate.customerName === 'Someone Else')!;
    expect(expired.active).toBe(false);
    expect(expired.resolvedPrice).toBeUndefined();
  });
});
