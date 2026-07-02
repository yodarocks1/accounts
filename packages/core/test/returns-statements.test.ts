import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGING_RULES,
  DocumentBook,
  LedgerError,
  ageLabelFor,
} from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const gadget = book.createItem({ name: 'Gadget', currency: 'USD', unitPrice: 4000n, cost: 3000n });
  return { book, widget, gadget };
}

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function sellTo(
  book: DocumentBook,
  itemId: string,
  number: string,
  date: string,
  quantityMilli: bigint,
  unitPrice?: bigint,
  customer = acme,
) {
  const invoice = book.createDocument({
    type: 'invoice',
    number,
    date,
    customerName: customer.customerName,
    accountNumber: customer.accountNumber,
    lines: [
      {
        itemId,
        description: 'Sale',
        quantityMilli,
        ...(unitPrice !== undefined ? { unitPrice } : {}),
      },
    ],
  });
  book.sendDocument(invoice.id);
  return invoice;
}

describe('customer identity on every transaction (ADR 0006)', () => {
  it('requires a customer name and accepts PO/account numbers', () => {
    const { book, widget } = setUp();
    expect(() =>
      book.createDocument({
        type: 'invoice',
        number: 'INV-X',
        date: '2026-07-01',
        customerName: '   ',
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
      }),
    ).toThrowError(/customer name/);

    const invoice = book.createDocument({
      type: 'invoice',
      number: 'INV-Y',
      date: '2026-07-01',
      customerName: 'Acme LLC',
      accountNumber: 'A-100',
      poNumber: 'PO-778',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(invoice.current.customerName).toBe('Acme LLC');
    expect(invoice.current.accountNumber).toBe('A-100');
    expect(invoice.current.poNumber).toBe('PO-778');
  });

  it('conversions inherit customer fields including the PO number', () => {
    const { book, widget } = setUp();
    const estimate = book.createDocument({
      type: 'estimate', number: 'EST-1', date: '2026-07-01',
      customerName: 'Acme LLC', accountNumber: 'A-100', poNumber: 'PO-9',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(estimate.id);
    const order = book.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', date: '2026-07-02' });
    expect(order.current.customerName).toBe('Acme LLC');
    expect(order.current.accountNumber).toBe('A-100');
    expect(order.current.poNumber).toBe('PO-9');
  });
});

describe('link-integrity consumption guard (ADR 0006 part 1)', () => {
  it('a correction cannot shrink a line below its converted quantity', () => {
    const { book, widget } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-G1', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);
    book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-G1', date: '2026-07-02',
      lines: [{ sourceLineId: 'L1', quantityMilli: 4000n }],
    });

    // Shrinking to 3 would strand the 4 already invoiced.
    expect(() =>
      book.changeDocument(order.id, {
        kind: 'correction',
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3000n, lineId: 'L1' }],
      }),
    ).toThrowError(/cannot shrink below its consumed quantity/);

    // Removing the line entirely is also rejected.
    expect(() =>
      book.changeDocument(order.id, {
        kind: 'correction',
        lines: [{ itemId: widget.id, description: 'Other line', quantityMilli: 1000n, lineId: 'L2' }],
      }),
    ).toThrowError(/cannot be removed/);

    // Shrinking to exactly the consumed quantity is fine.
    const corrected = book.changeDocument(order.id, {
      kind: 'correction',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n, lineId: 'L1' }],
    });
    expect(corrected.current.lines[0]!.quantityMilli).toBe(4000n);
    expect(book.fulfillment(order.id)[0]!.openMilli).toBe(0n);
  });

  it('links survive a source correction: the invoice still resolves to the corrected line', () => {
    const { book, widget } = setUp();
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-G2', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10000n, lineId: 'L1' }],
    });
    book.sendDocument(order.id);
    const invoice = book.convertDocument(order.id, {
      type: 'invoice', number: 'INV-G2', date: '2026-07-02',
      lines: [{ sourceLineId: 'L1', quantityMilli: 4000n }],
    });
    // Substitution revision on the source keeps the lineId — link stays valid.
    book.changeDocument(order.id, {
      kind: 'substitution',
      reason: 'blue widgets shipped',
      lines: [{ itemId: widget.id, description: 'Widget (blue)', quantityMilli: 10000n, lineId: 'L1' }],
    });
    const sourceLineId = invoice.current.lines[0]!.sourceLineId!;
    const sourceCurrent = book.getDocument(order.id)!.revisions.at(-1)!;
    const resolved = sourceCurrent.lines.find((line) => line.lineId === sourceLineId);
    expect(resolved).toBeDefined();
    expect(resolved!.description).toBe('Widget (blue)');
    expect(book.fulfillment(order.id)[0]!.convertedMilli).toBe(4000n);
  });
});

describe('returns and credits (ADR 0006 part 2)', () => {
  it('credits a return at the price the customer last paid, linked to that purchase', () => {
    const { book, widget } = setUp();
    sellTo(book, widget.id, 'INV-R1', '2026-05-01', 2000n); // at 25.00
    book.setPrice(widget.id, 3000n, '2026-06-01'); // price rises
    const lastSale = sellTo(book, widget.id, 'INV-R2', '2026-06-15', 1000n); // at 30.00
    book.setPrice(widget.id, 3500n, '2026-07-01'); // rises again — must NOT affect the credit

    const credit = book.createReturn({
      number: 'CR-1', date: '2026-07-10', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    expect(credit.total).toBe(3000n); // last purchase price, not current catalog
    expect(credit.current.lines[0]!.sourceDocumentId).toBe(lastSale.id);
    expect(credit.current.lines[0]!.sourceLineId).toBe(lastSale.current.lines[0]!.lineId);
    expect(credit.current.lines[0]!.description).toBe('Widget (return, unopened)');
    expect(book.getDocument(credit.id)!.settlement).toBe('account');
  });

  it('a corrected purchase price flows into the credit (customer price, not face)', () => {
    const { book, widget } = setUp();
    const sale = sellTo(book, widget.id, 'INV-R3', '2026-06-01', 4000n); // 4 × 25.00 = 100.00
    book.chargeCorrection(sale.id, 8000n, 'charged $80'); // per-unit now 20.00
    const credit = book.createReturn({
      number: 'CR-2', date: '2026-06-20', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 2000n }],
    });
    expect(credit.total).toBe(4000n); // 2 × 20.00
  });

  it('refund settlement is recorded; no purchase history is rejected without an override', () => {
    const { book, widget, gadget } = setUp();
    sellTo(book, widget.id, 'INV-R4', '2026-06-01', 1000n);
    expect(() =>
      book.createReturn({
        number: 'CR-3', date: '2026-06-20', ...acme,
        items: [{ itemId: gadget.id, quantityMilli: 1000n }],
      }),
    ).toThrowError(/No purchase of Gadget/);

    const refunded = book.createReturn({
      number: 'CR-4', date: '2026-06-20', ...acme, settlement: 'refund',
      items: [{ itemId: gadget.id, quantityMilli: 1000n, unitPrice: 3800n }],
    });
    expect(book.getDocument(refunded.id)!.settlement).toBe('refund');
    expect(refunded.total).toBe(3800n);
  });

  it('lookup respects the customer: another customer’s purchases don’t count', () => {
    const { book, widget } = setUp();
    sellTo(book, widget.id, 'INV-R5', '2026-06-01', 1000n, 9999n, {
      customerName: 'Someone Else', accountNumber: 'B-200',
    });
    expect(() =>
      book.createReturn({
        number: 'CR-5', date: '2026-06-20', ...acme,
        items: [{ itemId: widget.id, quantityMilli: 1000n }],
      }),
    ).toThrowError(/No purchase/);
  });

  it('free items credit at zero — the customer paid nothing for them', () => {
    const { book, widget, gadget } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-R6', date: '2026-06-01',
      customerName: acme.customerName, accountNumber: acme.accountNumber,
      lines: [
        { itemId: gadget.id, description: 'Gadget', quantityMilli: 1000n },
        { itemId: widget.id, description: 'Widget (free)', quantityMilli: 1000n, free: true },
      ],
    });
    book.sendDocument(invoice.id);
    const credit = book.createReturn({
      number: 'CR-6', date: '2026-06-20', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    expect(credit.total).toBe(0n);
  });
});

describe('statements (ADR 0006 part 3)', () => {
  it('ages invoices with the default rules', () => {
    expect(ageLabelFor(0, DEFAULT_AGING_RULES)).toBe('current');
    expect(ageLabelFor(22, DEFAULT_AGING_RULES)).toBe('current');
    expect(ageLabelFor(23, DEFAULT_AGING_RULES)).toBe('due soon');
    expect(ageLabelFor(30, DEFAULT_AGING_RULES)).toBe('due soon');
    expect(ageLabelFor(31, DEFAULT_AGING_RULES)).toBe('past due');
    expect(ageLabelFor(365, DEFAULT_AGING_RULES)).toBe('past due');
  });

  it('lists invoices with originals first, corrections directly below, and all credits', () => {
    const { book, widget } = setUp();
    // Old invoice, will be past due.
    sellTo(book, widget.id, 'INV-S1', '2026-05-15', 4000n); // 100.00
    // Corrected invoice.
    const corrected = sellTo(book, widget.id, 'INV-S2', '2026-06-05', 2000n); // 50.00
    book.chargeCorrection(corrected.id, 4500n, 'charged $45'); // → 45.00
    // Fresh invoice.
    sellTo(book, widget.id, 'INV-S3', '2026-06-25', 1000n); // 25.00
    // A return credited to the account.
    const credit = book.createReturn({
      number: 'CR-S1', date: '2026-06-28', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    book.sendDocument(credit.id);
    // Drafts and other customers stay off the statement.
    book.createDocument({
      type: 'invoice', number: 'INV-S4', date: '2026-06-30', customerName: 'Acme LLC', accountNumber: 'A-100',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 9000n }],
    });
    sellTo(book, widget.id, 'INV-S5', '2026-06-30', 9000n, undefined, {
      customerName: 'Someone Else', accountNumber: 'B-200',
    });

    const statement = book.statement({ accountNumber: 'A-100' }, '2026-07-02');

    expect(statement.invoices.map((entry) => entry.number)).toEqual(['INV-S1', 'INV-S2', 'INV-S3']);
    const [s1, s2, s3] = statement.invoices;
    expect(s1!.ageDays).toBe(48);
    expect(s1!.ageLabel).toBe('past due');
    expect(s2!.ageDays).toBe(27);
    expect(s2!.ageLabel).toBe('due soon');
    expect(s3!.ageLabel).toBe('current');

    // Original amount shows first; the correction sits directly below it.
    expect(s2!.originalTotal).toBe(5000n);
    expect(s2!.currentTotal).toBe(4500n);
    expect(s2!.corrections).toHaveLength(1);
    expect(s2!.corrections[0]!.total).toBe(4500n);
    expect(s2!.corrections[0]!.reason).toBe('charged $45');
    expect(s2!.label).toBe('INV-S2 (with corrections)');

    // Credits listed; account-settled ones reduce the balance.
    expect(statement.credits).toHaveLength(1);
    expect(statement.credits[0]!.kind).toBe('return');
    expect(statement.credits[0]!.total).toBe(2500n);
    expect(statement.invoiceTotal).toBe(100_00n + 45_00n + 25_00n);
    expect(statement.balance).toBe(17000n - 2500n);
  });

  it('refund credits are listed but do not reduce the balance', () => {
    const { book, widget } = setUp();
    sellTo(book, widget.id, 'INV-S6', '2026-06-20', 1000n); // 25.00
    const refund = book.createReturn({
      number: 'CR-S2', date: '2026-06-25', ...acme, settlement: 'refund',
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    book.sendDocument(refund.id);
    const statement = book.statement({ customerName: 'Acme LLC' }, '2026-07-01');
    expect(statement.credits).toHaveLength(1);
    expect(statement.creditTotal).toBe(2500n);
    expect(statement.accountCreditTotal).toBe(0n);
    expect(statement.balance).toBe(2500n);
  });

  it('rejects a query with neither name nor account number', () => {
    const { book } = setUp();
    expect(() => book.statement({}, '2026-07-01')).toThrow(LedgerError);
  });
});
