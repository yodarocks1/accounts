import { describe, expect, it } from 'vitest';
import { DocumentBook, LedgerError } from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const acme = book.createParty({ name: 'Acme LLC', accountNumber: 'A-100', termsDays: 30 });
  return { book, widget, acme };
}

describe('parties (Tier 1)', () => {
  it('supplies name, account number, and default terms to documents', () => {
    const { book, widget, acme } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-06-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(invoice.partyId).toBe(acme.id);
    expect(invoice.current.customerName).toBe('Acme LLC');
    expect(invoice.current.accountNumber).toBe('A-100');
    expect(invoice.current.termsDays).toBe(30);

    // Explicit values still win over party defaults.
    const custom = book.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-06-01', partyId: acme.id, termsDays: 10,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(custom.current.termsDays).toBe(10);

    expect(() =>
      book.createDocument({
        type: 'invoice', number: 'INV-3', date: '2026-06-01',
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
      }),
    ).toThrowError(/customer name/); // no party, no name
  });

  it('renames keep history and never rewrite documents', () => {
    const { book, widget, acme } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-4', date: '2026-06-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(invoice.id);

    book.renameParty(acme.id, 'Acme Industries Inc');
    expect(book.getParty(acme.id)!.name).toBe('Acme Industries Inc');
    expect(book.partyNameHistory(acme.id).map((entry) => entry.name)).toEqual([
      'Acme LLC',
      'Acme Industries Inc',
    ]);
    // The sent invoice keeps the name the customer had at the time.
    expect(book.view(invoice.id).current.customerName).toBe('Acme LLC');
  });

  it('statements resolve through the party across renames and legacy documents', () => {
    const { book, widget, acme } = setUp();
    // Legacy document: created before the party link, matching by account number.
    const legacy = book.createDocument({
      type: 'invoice', number: 'INV-5', date: '2026-05-01',
      customerName: 'Acme LLC', accountNumber: 'A-100',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(legacy.id);

    const linked = book.createDocument({
      type: 'invoice', number: 'INV-6', date: '2026-06-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 2000n }],
    });
    book.sendDocument(linked.id);

    book.renameParty(acme.id, 'Acme Industries Inc');
    // After the rename, linked documents still match via partyId; the legacy
    // one still matches via account number.
    const statement = book.statementForParty(acme.id, '2026-07-01');
    expect(statement.invoices.map((entry) => entry.number)).toEqual(['INV-5', 'INV-6']);

    const payment = book.recordPayment({
      number: 'PMT-1', date: '2026-06-15', partyId: acme.id, amount: 1000n,
    });
    expect(payment.customerName).toBe('Acme Industries Inc');
    expect(book.statementForParty(acme.id, '2026-07-01').payments).toHaveLength(1);
  });

  it('rates bound to a party follow it through renames', () => {
    const { book, widget, acme } = setUp();
    book.setCustomerRate({ itemId: widget.id, partyId: acme.id, rate: { kind: 'constant', unitPrice: 2000n } });
    book.renameParty(acme.id, 'Acme Industries Inc');

    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-7', date: '2026-06-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(invoice.current.lines[0]!.unitPrice).toBe(2000n);

    // A different customer with the same NAME does not get the rate.
    const impostor = book.createDocument({
      type: 'invoice', number: 'INV-8', date: '2026-06-01', customerName: 'Acme Industries Inc',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    expect(impostor.current.lines[0]!.unitPrice).toBe(2500n);
  });

  it('returns look up purchases through the party', () => {
    const { book, widget, acme } = setUp();
    const sale = book.createDocument({
      type: 'invoice', number: 'INV-9', date: '2026-06-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 2200n }],
    });
    book.sendDocument(sale.id);
    book.renameParty(acme.id, 'Acme Industries Inc');

    const credit = book.createReturn({
      number: 'CR-1', date: '2026-06-20', partyId: acme.id,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    expect(credit.total).toBe(2200n);
    expect(credit.partyId).toBe(acme.id);
  });

  it('conversions carry the party; account numbers stay unique', () => {
    const { book, widget, acme } = setUp();
    const estimate = book.createDocument({
      type: 'estimate', number: 'EST-1', date: '2026-06-01', partyId: acme.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    book.sendDocument(estimate.id);
    const order = book.convertDocument(estimate.id, { type: 'sales_order', number: 'SO-1', date: '2026-06-02' });
    expect(order.partyId).toBe(acme.id);

    expect(() => book.createParty({ name: 'Other Co', accountNumber: 'A-100' })).toThrowError(/already in use/);
    expect(() => book.createParty({ name: '  ' })).toThrow(LedgerError);
  });
});
