import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DocumentBook,
  LedgerError,
  allocateProportional,
  customerLineTotal,
  lineTotal,
  recordedLineTotals,
} from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const gadget = book.createItem({ name: 'Gadget', currency: 'USD', unitPrice: 4000n, cost: 3000n });
  return { book, widget, gadget };
}

describe('allocateProportional', () => {
  it('splits pro rata and lands exactly on the target', () => {
    expect(allocateProportional([1000n, 3000n], 2000n)).toEqual([500n, 1500n]);
    expect(allocateProportional([100n, 100n, 100n], 200n)).toEqual([67n, 67n, 66n]);
  });

  it('respects floors and redistributes the shortfall', () => {
    // Proportional would be [500, 1500], but the first line floors at 800.
    expect(allocateProportional([1000n, 3000n], 2000n, [800n, 0n])).toEqual([800n, 1200n]);
  });

  it('throws PRICE_FLOOR when floors make the target unreachable', () => {
    expect(() => allocateProportional([1000n, 3000n], 2000n, [900n, 1200n])).toThrowError(
      /floors already total/,
    );
  });

  it('rejects increases', () => {
    expect(() => allocateProportional([100n], 200n)).toThrow(LedgerError);
  });

  it('property: sums exactly, stays within [floor, face]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            face: fc.bigInt({ min: 0n, max: 1_000_000n }),
            floorPct: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 100 }),
        (specs, targetPct) => {
          const face = specs.map((spec) => spec.face);
          const floors = specs.map((spec) => (spec.face * BigInt(spec.floorPct)) / 100n);
          const faceTotal = face.reduce((a, b) => a + b, 0n);
          const floorTotal = floors.reduce((a, b) => a + b, 0n);
          // Pick a reachable target between floorTotal and faceTotal.
          const target = floorTotal + ((faceTotal - floorTotal) * BigInt(targetPct)) / 100n;
          const result = allocateProportional(face, target, floors);
          expect(result.reduce((a, b) => a + b, 0n)).toBe(target);
          result.forEach((amount, index) => {
            expect(amount >= floors[index]!).toBe(true);
            expect(amount <= face[index]!).toBe(true);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('conversions with line-level links', () => {
  it('estimate → sales order → invoice, fully linked line to line', () => {
    const { book, widget } = setUp();
    const estimate = book.createDocument({
      type: 'estimate',
      number: 'EST-1', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10000n, lineId: 'E1' }],
    });
    book.sendDocument(estimate.id);

    const order = book.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', customerName: 'Acme LLC', date: '2026-07-02' });
    expect(order.current.lines[0]!.sourceLineId).toBe('E1');
    expect(order.current.lines[0]!.quantityMilli).toBe(10000n);
    expect(order.current.lines[0]!.unitPrice).toBe(2500n); // snapshot carried from estimate
    book.sendDocument(order.id);

    const invoice = book.convertDocument(order.id, { type: 'invoice', number: 'INV-1', customerName: 'Acme LLC', date: '2026-07-03' });
    expect(invoice.current.lines[0]!.sourceLineId).toBe(order.current.lines[0]!.lineId);
    expect(invoice.sourceDocumentId).toBe(order.id);

    expect(book.fulfillment(estimate.id)[0]!.status).toBe('fulfilled');
    expect(book.fulfillment(order.id)[0]!.status).toBe('fulfilled');
  });

  it('partial conversions leave the remainder open, and multiple can stack', () => {
    const { book, widget } = setUp();
    const order = book.createDocument({
      type: 'sales_order',
      number: 'SO-2', customerName: 'Acme LLC',
      date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);

    book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-2a', customerName: 'Acme LLC', date: '2026-07-02',
      lines: [{ sourceLineId: 'L1', quantityMilli: 4000n }],
    });
    let state = book.fulfillment(order.id)[0]!;
    expect(state.status).toBe('partial');
    expect(state.openMilli).toBe(6000n);

    book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-2b', customerName: 'Acme LLC', date: '2026-07-03',
      lines: [{ sourceLineId: 'L1', quantityMilli: 6000n }],
    });
    state = book.fulfillment(order.id)[0]!;
    expect(state.status).toBe('fulfilled');
    expect(state.openMilli).toBe(0n);

    expect(() =>
      book.convertDocument(order.id, {
        type: 'invoice', number: 'INV-2c', customerName: 'Acme LLC', date: '2026-07-04',
        lines: [{ sourceLineId: 'L1', quantityMilli: 1n }],
      }),
    ).toThrowError(/open .* but conversion takes/);
  });

  it('voiding a conversion returns its quantity to the source', () => {
    const { book, widget } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-3', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 5000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);
    const invoice = book.convertDocument(order.id, { type: 'invoice', number: 'INV-3', customerName: 'Acme LLC', date: '2026-07-02' });
    expect(book.fulfillment(order.id)[0]!.openMilli).toBe(0n);
    book.voidDocument(invoice.id);
    expect(book.fulfillment(order.id)[0]!.openMilli).toBe(5000n);
  });

  it('rejects disallowed direction, unsent sources, and unknown lines', () => {
    const { book, widget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-4', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(invoice.id);
    expect(() =>
      book.convertDocument(invoice.id, { type: 'sales_order', number: 'SO-4', customerName: 'Acme LLC', date: '2026-07-02' }),
    ).toThrowError(/cannot be converted/);

    const draft = book.createDocument({
      type: 'estimate', number: 'EST-4', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, lineId: 'L1' }],
    });
    expect(() =>
      book.convertDocument(draft.id, { type: 'invoice', number: 'INV-4b', customerName: 'Acme LLC', date: '2026-07-02' }),
    ).toThrowError(/Only sent documents/);
    book.sendDocument(draft.id);
    expect(() =>
      book.convertDocument(draft.id, {
        type: 'invoice', number: 'INV-4c', customerName: 'Acme LLC', date: '2026-07-02',
        lines: [{ sourceLineId: 'NOPE' }],
      }),
    ).toThrowError(/no line NOPE/);
  });
});

describe('closures and substitutions', () => {
  it('closing a line unfulfilled removes it from the open balance', () => {
    const { book, widget } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-5', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);
    book.closeLine(order.id, { lineId: 'L1', kind: 'unfulfilled', quantityMilli: 4000n, reason: 'Customer reduced order' });
    const state = book.fulfillment(order.id)[0]!;
    expect(state.closedMilli).toBe(4000n);
    expect(state.openMilli).toBe(6000n);
    expect(book.view(order.id).tags).toEqual([]); // unfulfilled closure ≠ substitution

    // Cannot close more than is open.
    expect(() =>
      book.closeLine(order.id, { lineId: 'L1', kind: 'unfulfilled', quantityMilli: 7000n }),
    ).toThrowError(/has 6000 open/);
  });

  it('substitution closures tag the source; substitute conversion lines tag the target', () => {
    const { book, widget, gadget } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-6', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);

    // Deliver gadgets instead of widgets, at a changed price.
    const invoice = book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-6', customerName: 'Acme LLC', date: '2026-07-02',
      lines: [{ sourceLineId: 'L1', substitution: { itemId: gadget.id, description: 'Gadget (substitute)', unitPrice: 3500n } }],
    });
    expect(invoice.current.lines[0]!.substituted).toBe(true);
    expect(invoice.current.lines[0]!.unitPrice).toBe(3500n);
    expect(invoice.tags).toEqual(['with substitutions']);

    // A substitution may also keep the source price.
    const order2 = book.createDocument({
      type: 'sales_order', number: 'SO-6b', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n, lineId: 'L1' }],
    });
    book.sendDocument(order2.id);
    const invoice2 = book.convertDocument(order2.id, {
      type: 'invoice', number: 'INV-6b', customerName: 'Acme LLC', date: '2026-07-02',
      lines: [{ sourceLineId: 'L1', substitution: { description: 'Widget v2' } }],
    });
    expect(invoice2.current.lines[0]!.unitPrice).toBe(2500n);

    // Closing with a substitution marks the source document.
    const order3 = book.createDocument({
      type: 'sales_order', number: 'SO-6c', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n, lineId: 'L1' }],
    });
    book.sendDocument(order3.id);
    book.closeLine(order3.id, { lineId: 'L1', kind: 'substituted', reason: 'covered by gadget delivery' });
    expect(book.view(order3.id).tags).toEqual(['with substitutions']);
    expect(book.fulfillment(order3.id)[0]!.status).toBe('closed');
  });
});

describe('charge corrections (amount paid)', () => {
  function invoiceWithTwoLines() {
    const { book, widget, gadget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-7', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [
        { itemId: widget.id, description: 'Widget', quantityMilli: 4000n, lineId: 'L1' }, // 4 × 25.00 = 100.00
        { itemId: gadget.id, description: 'Gadget', quantityMilli: 2500n, lineId: 'L2' }, // 2.5 × 40.00 = 100.00
      ],
    });
    book.sendDocument(invoice.id);
    return { book, invoice, widget, gadget };
  }

  it('reduces every line by the percentage difference, exactly', () => {
    const { book, invoice } = invoiceWithTwoLines();
    // 200.00 documented, 180.00 actually charged → 10% off each line.
    const corrected = book.chargeCorrection(invoice.id, 18000n, 'Charged $180, not $200');
    expect(corrected.total).toBe(18000n);
    expect(corrected.tags).toEqual(['with corrections']);
    const amounts = corrected.current.lines.map((line) => customerLineTotal(line));
    expect(amounts).toEqual([9000n, 9000n]);
    // History intact: the original amounts survive in revision 1.
    expect(book.history(invoice.id)[0]!.lines.map((line) => lineTotal(line))).toEqual([10000n, 10000n]);
  });

  it('never increases', () => {
    const { book, invoice } = invoiceWithTwoLines();
    expect(() => book.chargeCorrection(invoice.id, 20000n)).toThrowError(/only reduce/);
    expect(() => book.chargeCorrection(invoice.id, 25000n)).toThrowError(/only reduce/);
  });

  it('floors each line at quantity × min(cost, sales price) and redistributes', () => {
    const { book, invoice } = invoiceWithTwoLines();
    // Floors: widget 4 × min(10.00, 25.00) = 40.00; gadget 2.5 × min(30.00, 40.00) = 75.00.
    // Ask for 120.00: proportional would be 60/60, but gadget floors at 75 → widget absorbs 45.
    const corrected = book.chargeCorrection(invoice.id, 12000n);
    const amounts = corrected.current.lines.map((line) => customerLineTotal(line));
    expect(amounts).toEqual([4500n, 7500n]);
    expect(corrected.total).toBe(12000n);
  });

  it('rejects a target below the combined floors', () => {
    const { book, invoice } = invoiceWithTwoLines();
    // Combined floors 40.00 + 75.00 = 115.00.
    expect(() => book.chargeCorrection(invoice.id, 11000n)).toThrowError(/floors already total/);
  });

  it('applies only to sent invoices', () => {
    const { book, widget } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-8', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(order.id);
    expect(() => book.chargeCorrection(order.id, 100n)).toThrowError(/apply to invoices/);
  });
});

describe('free items', () => {
  it('shows free to the customer, records at min(cost, sale), scales the books to match', () => {
    const { book, widget, gadget } = setUp();
    // Widget: sale 25.00 / cost 10.00 → free line records at 10.00 each.
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-9', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [
        { itemId: gadget.id, description: 'Gadget', quantityMilli: 3000n, lineId: 'L1' }, // 3 × 40.00 = 120.00
        { itemId: widget.id, description: 'Widget (free to close the sale)', quantityMilli: 1000n, free: true, lineId: 'L2' },
      ],
    });
    // Customer pays only the gadgets.
    expect(invoice.total).toBe(12000n);
    expect(customerLineTotal(invoice.current.lines[1]!)).toBe(0n);
    // Free line records at cost (10.00 < 25.00), and everything scales so books = 120.00.
    expect(invoice.current.lines[1]!.unitPrice).toBe(1000n);
    const recorded = invoice.recordedLineTotals;
    expect(recorded.reduce((a, b) => a + b, 0n)).toBe(12000n);
    // 120 and 10 face → gadget ≈ 110.77, widget ≈ 9.23; both reduced, exact sum.
    expect(recorded[0]!).toBe(11077n);
    expect(recorded[1]!).toBe(923n);
  });

  it('uses sales price when it is lower than cost', () => {
    const book = new DocumentBook();
    const lossLeader = book.createItem({ name: 'Loss leader', currency: 'USD', unitPrice: 500n, cost: 900n });
    const anchor = book.createItem({ name: 'Anchor', currency: 'USD', unitPrice: 10000n, cost: 1n });
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-10', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [
        { itemId: anchor.id, description: 'Anchor', quantityMilli: 1000n },
        { itemId: lossLeader.id, description: 'Freebie', quantityMilli: 1000n, free: true },
      ],
    });
    expect(invoice.current.lines[1]!.unitPrice).toBe(500n); // sale < cost
    expect(invoice.total).toBe(10000n);
    expect(invoice.recordedLineTotals.reduce((a, b) => a + b, 0n)).toBe(10000n);
  });

  it('property: recorded totals always equal the customer total exactly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            quantityMilli: fc.bigInt({ min: 1n, max: 50_000n }),
            unitPrice: fc.bigInt({ min: 0n, max: 100_000n }),
            free: fc.boolean(),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (specs) => {
          // At least one paid line so the total isn't degenerate.
          const lines = specs.map((spec, index) => ({
            lineId: `L${index}`,
            itemId: null,
            description: `Line ${index}`,
            quantityMilli: spec.quantityMilli,
            unitPrice: spec.unitPrice,
            currency: 'USD',
            adjustment: 0n,
            free: spec.free,
            substituted: false,
            sourceLineId: null,
          }));
          const customerTotal = lines.reduce((sum, line) => sum + customerLineTotal(line), 0n);
          const recorded = recordedLineTotals(lines);
          expect(recorded.reduce((a, b) => a + b, 0n)).toBe(customerTotal);
          recorded.forEach((amount) => expect(amount >= 0n).toBe(true));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('charge corrections leave free lines free and still hit the target', () => {
    const { book, widget, gadget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-11', customerName: 'Acme LLC', date: '2026-07-01',
      lines: [
        { itemId: gadget.id, description: 'Gadget', quantityMilli: 3000n, lineId: 'L1' }, // 120.00, floor 90.00
        { itemId: widget.id, description: 'Freebie', quantityMilli: 1000n, free: true, lineId: 'L2' },
      ],
    });
    book.sendDocument(invoice.id);
    const corrected = book.chargeCorrection(invoice.id, 10000n, 'charged $100');
    expect(corrected.total).toBe(10000n);
    expect(corrected.current.lines[1]!.free).toBe(true);
    expect(customerLineTotal(corrected.current.lines[1]!)).toBe(0n);
    expect(corrected.recordedLineTotals.reduce((a, b) => a + b, 0n)).toBe(10000n);
    expect(corrected.tags).toEqual(['with corrections']);
  });
});
