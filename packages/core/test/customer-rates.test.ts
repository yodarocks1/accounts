import { describe, expect, it } from 'vitest';
import { DocumentBook, LedgerError, resolveRatePrice } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  // Widget: sale 25.00, cost 10.00.
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  return { book, widget };
}

function invoiceFor(book: DocumentBook, itemId: string, number: string, date: string, unitPrice?: bigint) {
  const invoice = book.createDocument({
    type: 'invoice', number, date,
    customerName: acme.customerName, accountNumber: acme.accountNumber,
    lines: [{ itemId, description: 'Sale', quantityMilli: 1000n, ...(unitPrice !== undefined ? { unitPrice } : {}) }],
  });
  book.sendDocument(invoice.id);
  return invoice;
}

describe('rate math (resolveRatePrice)', () => {
  const base = { unitPrice: null, percentMilli: 0n, amountMinor: 0n, allowBelowCost: true };

  it('covers every requested form', () => {
    // Constant value (most common).
    expect(resolveRatePrice({ ...base, kind: 'constant', unitPrice: 2000n, base: null }, 2500n, 1000n)).toBe(2000n);
    // % discount off sales price: 10% off 25.00 = 22.50.
    expect(resolveRatePrice({ ...base, kind: 'formula', base: 'sale', percentMilli: -10_000n }, 2500n, 1000n)).toBe(2250n);
    // % markup above cost: cost 10.00 + 20% = 12.00.
    expect(resolveRatePrice({ ...base, kind: 'formula', base: 'cost', percentMilli: 20_000n }, 2500n, 1000n)).toBe(1200n);
    // $ amount off sales price: 25.00 − 3.00 = 22.00.
    expect(resolveRatePrice({ ...base, kind: 'formula', base: 'sale', amountMinor: -300n }, 2500n, 1000n)).toBe(2200n);
    // $ markup above cost: 10.00 + 2.50 = 12.50.
    expect(resolveRatePrice({ ...base, kind: 'formula', base: 'cost', amountMinor: 250n }, 2500n, 1000n)).toBe(1250n);
    // Combination: 10% off sale, then another 1.00 off: 22.50 − 1.00 = 21.50.
    expect(
      resolveRatePrice({ ...base, kind: 'formula', base: 'sale', percentMilli: -10_000n, amountMinor: -100n }, 2500n, 1000n),
    ).toBe(2150n);
  });

  it('floors at cost unless allowBelowCost, and at zero always', () => {
    const cheap = { ...base, kind: 'formula' as const, base: 'sale' as const, percentMilli: -80_000n };
    // 80% off 25.00 = 5.00, below cost 10.00.
    expect(resolveRatePrice({ ...cheap, allowBelowCost: false }, 2500n, 1000n)).toBe(1000n);
    expect(resolveRatePrice({ ...cheap, allowBelowCost: true }, 2500n, 1000n)).toBe(500n);
    // No cost history → no floor to apply.
    expect(resolveRatePrice({ ...cheap, allowBelowCost: false }, 2500n, undefined)).toBe(500n);
    // Never negative.
    expect(
      resolveRatePrice({ ...base, kind: 'formula', base: 'sale', amountMinor: -99999n, allowBelowCost: true }, 2500n, undefined),
    ).toBe(0n);
  });

  it('cost-based rate without cost history throws at resolution', () => {
    expect(() =>
      resolveRatePrice({ ...base, kind: 'formula', base: 'cost', percentMilli: 10_000n }, 2500n, undefined),
    ).toThrow(LedgerError);
  });
});

describe('allowBelowCost default (the checkbox)', () => {
  it('defaults to false normally, true for loss leaders', () => {
    const book = new DocumentBook();
    const normal = book.createItem({ name: 'Normal', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    const lossLeader = book.createItem({ name: 'Leader', currency: 'USD', unitPrice: 500n, cost: 900n });
    const noCost = book.createItem({ name: 'NoCost', currency: 'USD', unitPrice: 2500n });

    const normalRate = book.setCustomerRate({ itemId: normal.id, ...acme, rate: { kind: 'constant', unitPrice: 2000n } });
    expect(normalRate.allowBelowCost).toBe(false);

    const leaderRate = book.setCustomerRate({ itemId: lossLeader.id, ...acme, rate: { kind: 'constant', unitPrice: 400n } });
    expect(leaderRate.allowBelowCost).toBe(true); // typical sales price < cost

    const noCostRate = book.setCustomerRate({ itemId: noCost.id, ...acme, rate: { kind: 'constant', unitPrice: 2000n } });
    expect(noCostRate.allowBelowCost).toBe(false);

    // Explicit choice always wins.
    const explicit = book.setCustomerRate({
      itemId: normal.id, ...acme, rate: { kind: 'constant', unitPrice: 500n }, allowBelowCost: true,
    });
    expect(explicit.allowBelowCost).toBe(true);
  });
});

describe('the ask: suggestSpecialRates', () => {
  it('suggests persisting a one-off special price, prefilled as a constant', () => {
    const { book, widget } = setUp();
    const invoice = invoiceFor(book, widget.id, 'INV-1', '2026-07-01', 2000n); // list is 25.00
    const suggestions = book.suggestSpecialRates(invoice.id);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0]!;
    expect(s.itemName).toBe('Widget');
    expect(s.givenPrice).toBe(2000n);
    expect(s.expectedPrice).toBe(2500n);
    expect(s.defaultAllowBelowCost).toBe(false);
    expect(s.belowCost).toBe(false);
    expect(s.proposedRate.rate).toEqual({ kind: 'constant', unitPrice: 2000n });
    expect(s.proposedRate.effectiveFrom).toBe('2026-07-01');
  });

  it('stays quiet for list prices, free lines, credit memos, and once a rate exists', () => {
    const { book, widget } = setUp();
    const listPriced = invoiceFor(book, widget.id, 'INV-2', '2026-07-01');
    expect(book.suggestSpecialRates(listPriced.id)).toHaveLength(0);

    const withFree = book.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-07-01', ...acme,
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 1000n },
        { itemId: widget.id, description: 'Widget (free)', quantityMilli: 1000n, free: true, lineId: 'F' },
      ],
    });
    book.sendDocument(withFree.id);
    expect(book.suggestSpecialRates(withFree.id)).toHaveLength(0);

    // Accept the suggestion once…
    const special = invoiceFor(book, widget.id, 'INV-4', '2026-07-02', 2000n);
    const [suggestion] = book.suggestSpecialRates(special.id);
    book.setCustomerRate(suggestion!.proposedRate);
    // …and the same price stops being special.
    const repeat = invoiceFor(book, widget.id, 'INV-5', '2026-07-03', 2000n);
    expect(book.suggestSpecialRates(repeat.id)).toHaveLength(0);

    // A return never asks.
    const credit = book.createReturn({ number: 'CR-1', date: '2026-07-04', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }] });
    expect(book.suggestSpecialRates(credit.id)).toHaveLength(0);
  });

  it('flags below-cost prices for the UI', () => {
    const { book, widget } = setUp();
    const invoice = invoiceFor(book, widget.id, 'INV-6', '2026-07-01', 800n); // under cost 10.00
    const [s] = book.suggestSpecialRates(invoice.id);
    expect(s!.belowCost).toBe(true);
    expect(s!.defaultAllowBelowCost).toBe(false); // spec: default follows sale-vs-cost, not the given price
  });
});

describe('rates apply going forward', () => {
  it('new documents price from the customer rate; other customers are unaffected', () => {
    const { book, widget } = setUp();
    book.setCustomerRate({ itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 2000n } });

    const forAcme = invoiceFor(book, widget.id, 'INV-7', '2026-07-01');
    expect(forAcme.current.lines[0]!.unitPrice).toBe(2000n);

    const other = book.createDocument({
      type: 'invoice', number: 'INV-8', date: '2026-07-01',
      customerName: 'Someone Else',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(other.current.lines[0]!.unitPrice).toBe(2500n);
  });

  it('formula rates follow the base price; constants do not; history stays put', () => {
    const { book, widget } = setUp();
    book.setCustomerRate({
      itemId: widget.id, ...acme,
      rate: { kind: 'formula', base: 'sale', percentMilli: -10_000n }, // always 10% off list
    });
    const before = invoiceFor(book, widget.id, 'INV-9', '2026-07-01');
    expect(before.current.lines[0]!.unitPrice).toBe(2250n);

    book.setPrice(widget.id, 3000n, '2026-08-01'); // list rises
    const after = invoiceFor(book, widget.id, 'INV-10', '2026-08-02');
    expect(after.current.lines[0]!.unitPrice).toBe(2700n); // 10% off the new list

    // The earlier invoice is untouched (ADR 0004 snapshots).
    expect(book.view(before.id).current.lines[0]!.unitPrice).toBe(2250n);
  });

  it('a newer rate supersedes an older one from its effective date', () => {
    const { book, widget } = setUp();
    book.setCustomerRate({ itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 2000n } });
    book.setCustomerRate({
      itemId: widget.id, ...acme, rate: { kind: 'constant', unitPrice: 1800n }, effectiveFrom: '2026-08-01',
    });
    expect(invoiceFor(book, widget.id, 'INV-11', '2026-07-15').current.lines[0]!.unitPrice).toBe(2000n);
    expect(invoiceFor(book, widget.id, 'INV-12', '2026-08-15').current.lines[0]!.unitPrice).toBe(1800n);
  });

  it('the below-cost checkbox clamps applied rates', () => {
    const { book, widget } = setUp();
    book.setCustomerRate({
      itemId: widget.id, ...acme,
      rate: { kind: 'constant', unitPrice: 500n }, // under cost 10.00
      allowBelowCost: false,
    });
    expect(invoiceFor(book, widget.id, 'INV-13', '2026-07-01').current.lines[0]!.unitPrice).toBe(1000n);
  });

  it('rejects cost-based rates for items without cost history', () => {
    const book = new DocumentBook();
    const noCost = book.createItem({ name: 'NoCost', currency: 'USD', unitPrice: 2500n });
    expect(() =>
      book.setCustomerRate({ itemId: noCost.id, ...acme, rate: { kind: 'formula', base: 'cost', percentMilli: 20_000n } }),
    ).toThrowError(/cost history/);
  });
});
