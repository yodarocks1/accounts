import { describe, expect, it } from 'vitest';
import { DocumentBook } from '../src/index.js';

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

function setUp() {
  const book = new DocumentBook();
  const widget = book.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
  const invoice = (number: string, date: string, quantityMilli: bigint, customer = acme) => {
    const view = book.createDocument({
      type: 'invoice', number, date,
      customerName: customer.customerName, accountNumber: customer.accountNumber,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli }],
    });
    book.sendDocument(view.id);
    return view;
  };
  return { book, widget, invoice };
}

describe('payment application (Tier 1)', () => {
  it('applies a payment across invoices, leaving the remainder on account', () => {
    const { book, invoice } = setUp();
    const inv1 = invoice('INV-1', '2026-06-01', 4000n); // 100.00
    const inv2 = invoice('INV-2', '2026-06-10', 2000n); //  50.00

    book.recordPayment({
      number: 'PMT-1', date: '2026-06-20', ...acme, amount: 12_000n, method: 'check #42',
      applications: [
        { invoiceId: inv1.id, amount: 10_000n },
        { invoiceId: inv2.id, amount: 1_500n },
      ],
    });

    expect(book.invoiceSettlement(inv1.id).status).toBe('paid');
    const partial = book.invoiceSettlement(inv2.id);
    expect(partial.status).toBe('partial');
    expect(partial.open).toBe(3500n);

    const statement = book.statement({ accountNumber: 'A-100' }, '2026-07-01');
    expect(statement.invoices.find((entry) => entry.number === 'INV-1')!.ageLabel).toBe('paid');
    expect(statement.invoices.find((entry) => entry.number === 'INV-2')!.openAmount).toBe(3500n);
    expect(statement.payments).toHaveLength(1);
    expect(statement.payments[0]!.unappliedAmount).toBe(500n); // 120 − 115 on account
    expect(statement.openInvoiceTotal).toBe(3500n);
    expect(statement.balance).toBe(3500n - 500n);
  });

  it('rejects over-application to source or invoice, wrong customer, and unsent invoices', () => {
    const { book, invoice } = setUp();
    const inv = invoice('INV-3', '2026-06-01', 1000n); // 25.00
    const payment = book.recordPayment({ number: 'PMT-2', date: '2026-06-05', ...acme, amount: 2000n });

    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: inv.id, amount: 2600n }),
    ).toThrowError(/exceeds the source's remaining/);
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: inv.id, amount: 2000n });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: inv.id, amount: 1n }),
    ).toThrowError(/remaining 0/);

    const other = invoice('INV-4', '2026-06-01', 4000n, { customerName: 'Someone Else', accountNumber: 'B-1' });
    const payment2 = book.recordPayment({ number: 'PMT-3', date: '2026-06-05', ...acme, amount: 1000n });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment2.id, invoiceId: other.id, amount: 1000n }),
    ).toThrowError(/different customers/);

    // Applying beyond the invoice's open balance is rejected too.
    const small = invoice('INV-5', '2026-06-01', 1000n); // 25.00
    const big = book.recordPayment({ number: 'PMT-4', date: '2026-06-05', ...acme, amount: 100_000n });
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: big.id, invoiceId: small.id, amount: 3000n }),
    ).toThrowError(/open balance/);
  });

  it('account credit memos can be applied; refunds cannot', () => {
    const { book, invoice } = setUp();
    const inv = invoice('INV-6', '2026-06-01', 4000n); // 100.00
    invoice('INV-7', '2026-05-01', 1000n); // purchase history for the return

    const credit = book.createReturn({
      number: 'CR-1', date: '2026-06-10', ...acme,
      items: [{ itemId: book.listDocuments('invoice')[0]!.current.lines[0]!.itemId!, quantityMilli: 1000n }],
    });
    book.sendDocument(credit.id);
    book.applyCredit({ sourceKind: 'credit_memo', sourceId: credit.id, invoiceId: inv.id, amount: 2500n });
    expect(book.invoiceSettlement(inv.id).paid).toBe(2500n);

    const refund = book.createReturn({
      number: 'CR-2', date: '2026-06-11', ...acme, settlement: 'refund',
      items: [{ itemId: credit.current.lines[0]!.itemId!, quantityMilli: 1000n, unitPrice: 100n }],
    });
    book.sendDocument(refund.id);
    expect(() =>
      book.applyCredit({ sourceKind: 'credit_memo', sourceId: refund.id, invoiceId: inv.id, amount: 100n }),
    ).toThrowError(/paid out/);
  });

  it('reversing an application and voiding a payment reopen the invoice', () => {
    const { book, invoice } = setUp();
    const inv = invoice('INV-8', '2026-06-01', 4000n); // 100.00
    const payment = book.recordPayment({
      number: 'PMT-5', date: '2026-06-05', ...acme, amount: 10_000n,
      applications: [{ invoiceId: inv.id, amount: 10_000n }],
    });
    expect(book.invoiceSettlement(inv.id).status).toBe('paid');

    const application = book.listApplications()[0]!;
    book.reverseApplication(application.applicationSeq);
    expect(book.invoiceSettlement(inv.id).status).toBe('open');
    expect(() => book.reverseApplication(application.applicationSeq)).toThrowError(/already reversed/i);

    // Re-apply, then void the whole payment.
    book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: inv.id, amount: 10_000n });
    expect(book.invoiceSettlement(inv.id).status).toBe('paid');
    book.voidPayment(payment.id);
    expect(book.invoiceSettlement(inv.id).status).toBe('open');
    expect(() =>
      book.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: inv.id, amount: 1n }),
    ).toThrowError(/Void payments/);
  });

  it('a charge correction below the paid amount surfaces as overpaid', () => {
    const { book, invoice } = setUp();
    const inv = invoice('INV-9', '2026-06-01', 4000n); // 100.00, floor 40.00
    book.recordPayment({
      number: 'PMT-6', date: '2026-06-05', ...acme, amount: 10_000n,
      applications: [{ invoiceId: inv.id, amount: 10_000n }],
    });
    book.chargeCorrection(inv.id, 9_000n, 'charged $90');
    const settlement = book.invoiceSettlement(inv.id);
    expect(settlement.status).toBe('overpaid');
    expect(settlement.overpaid).toBe(1000n);
    expect(settlement.open).toBe(0n);
  });

  it('payment numbers are unique and amounts must be positive', () => {
    const { book } = setUp();
    book.recordPayment({ number: 'PMT-7', date: '2026-06-01', ...acme, amount: 100n });
    expect(() =>
      book.recordPayment({ number: 'PMT-7', date: '2026-06-02', ...acme, amount: 100n }),
    ).toThrowError(/already in use/);
    expect(() =>
      book.recordPayment({ number: 'PMT-8', date: '2026-06-02', ...acme, amount: 0n }),
    ).toThrowError(/positive/);
  });
});
