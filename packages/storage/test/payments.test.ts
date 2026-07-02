import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-pay-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function sendInvoice(itemId: string, number: string, date: string, quantityMilli: bigint) {
  const invoice = file.createDocument({
    type: 'invoice', number, date, ...acme,
    lines: [{ itemId, description: 'Widget', quantityMilli }],
  });
  file.sendDocument(invoice.id);
  return invoice;
}

describe('payments persist (Tier 1)', () => {
  it('records, applies, reverses, and survives reopening', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const inv1 = sendInvoice(widget.id, 'INV-1', '2026-06-01', 4000n); // 100.00
    const inv2 = sendInvoice(widget.id, 'INV-2', '2026-06-10', 2000n); //  50.00

    const payment = file.recordPayment({
      number: 'PMT-1', date: '2026-06-20', ...acme, amount: 12_000n, method: 'check #42',
      applications: [
        { invoiceId: inv1.id, amount: 10_000n },
        { invoiceId: inv2.id, amount: 1_500n },
      ],
    });

    file.close();
    file = CompanyFile.open(books);

    expect(file.invoiceSettlement(inv1.id).status).toBe('paid');
    expect(file.invoiceSettlement(inv2.id).open).toBe(3500n);

    const statement = file.statement({ accountNumber: 'A-100' }, '2026-07-01');
    expect(statement.invoices.find((entry) => entry.number === 'INV-1')!.ageLabel).toBe('paid');
    expect(statement.payments[0]!.unappliedAmount).toBe(500n);
    expect(statement.balance).toBe(3500n - 500n);

    // Reverse one application; the invoice reopens.
    const application = file.listApplications().find((entry) => entry.invoiceId === inv1.id)!;
    file.reverseApplication(application.applicationSeq);
    expect(file.invoiceSettlement(inv1.id).status).toBe('open');

    // Void the payment; everything it funded reopens.
    file.voidPayment(payment.id);
    expect(file.invoiceSettlement(inv2.id).status).toBe('open');
  });

  it('applies account credit memos and enforces application guards', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    sendInvoice(widget.id, 'INV-3', '2026-05-01', 1000n); // purchase history
    const inv = sendInvoice(widget.id, 'INV-4', '2026-06-01', 4000n); // 100.00
    const credit = file.createReturn({
      number: 'CR-1', date: '2026-06-10', ...acme,
      items: [{ itemId: widget.id, quantityMilli: 1000n }],
    });
    file.sendDocument(credit.id);

    file.applyCredit({ sourceKind: 'credit_memo', sourceId: credit.id, invoiceId: inv.id, amount: 2500n });
    expect(file.invoiceSettlement(inv.id).paid).toBe(2500n);
    expect(() =>
      file.applyCredit({ sourceKind: 'credit_memo', sourceId: credit.id, invoiceId: inv.id, amount: 1n }),
    ).toThrowError(/remaining 0/);

    const statement = file.statement({ accountNumber: 'A-100' }, '2026-07-01');
    const creditEntry = statement.credits.find((entry) => entry.number === 'CR-1')!;
    expect(creditEntry.appliedAmount).toBe(2500n);
    expect(creditEntry.unappliedAmount).toBe(0n);
  });

  it('payments and applications are immutable at the database level', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const inv = sendInvoice(widget.id, 'INV-5', '2026-06-01', 1000n);
    const payment = file.recordPayment({
      number: 'PMT-2', date: '2026-06-05', ...acme, amount: 2500n,
      applications: [{ invoiceId: inv.id, amount: 2500n }],
    });
    const raw = new Database(books);
    try {
      expect(() => raw.prepare(`UPDATE payments SET amount = 1 WHERE id = ?`).run(payment.id)).toThrowError(/only payment status/);
      expect(() => raw.prepare(`DELETE FROM payments WHERE id = ?`).run(payment.id)).toThrowError(/void them/);
      expect(() => raw.prepare(`UPDATE credit_applications SET amount = 1`).run()).toThrowError(/reverse them/);
      expect(() => raw.prepare(`DELETE FROM credit_applications`).run()).toThrowError(/reverse them/);
    } finally {
      raw.close();
    }
  });
});
