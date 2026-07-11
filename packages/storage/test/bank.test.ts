import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

const CSV = `date,amount,description,reference
2026-07-01,150.00,ACH ACME LLC,ref-1
2026-07-03,-90.00,CHECK 77 WIDGETS WHOLESALE,ref-2
2026-07-05,42.50,COUNTER DEPOSIT,`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-bank-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bank import & reconciliation (ADR 0019)', () => {
  it('imports idempotently per source and freezes rows at the DB level', () => {
    expect(file.importBankTransactions('chase-checking', CSV)).toEqual({ imported: 3, skipped: 0 });
    // Re-importing an overlapping export skips what's already there.
    expect(file.importBankTransactions('chase-checking', CSV)).toEqual({ imported: 0, skipped: 3 });
    // The same lines from a DIFFERENT source are distinct facts.
    expect(file.importBankTransactions('savings', CSV).imported).toBe(3);
    const rows = file.listBankTransactions('chase-checking');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ amountMinor: -9000n, description: 'CHECK 77 WIDGETS WHOLESALE', reference: 'ref-2' });

    file.close();
    const raw = new Database(books);
    expect(() => raw.prepare(`UPDATE bank_transactions SET amount = 1`).run()).toThrowError(/immutable/);
    expect(() => raw.prepare(`DELETE FROM bank_transactions`).run()).toThrowError(/immutable/);
    raw.close();
    file = CompanyFile.open(books);
  });

  it('suggests matches by direction, amount, and date window; confirm and reverse', () => {
    file.importBankTransactions('chase-checking', CSV);
    const inbound = file.recordPayment({
      number: 'PMT-1', date: '2026-07-01', customerName: 'Acme LLC', amount: 15_000n,
    });
    const outbound = file.recordPayment({
      number: 'PMT-2', direction: 'out', date: '2026-07-02', customerName: 'Widgets Wholesale Inc', amount: 9000n,
    });
    // Same amount as PMT-1 but far outside the window: not suggested.
    file.recordPayment({ number: 'PMT-9', date: '2026-08-15', customerName: 'Acme LLC', amount: 15_000n });

    const suggestions = file.bankMatchSuggestions('chase-checking');
    expect(suggestions).toEqual([
      { bankSeq: 1, paymentId: inbound.id, paymentNumber: 'PMT-1', dayOffset: 0 },
      { bankSeq: 2, paymentId: outbound.id, paymentNumber: 'PMT-2', dayOffset: 1 },
    ]);

    // Confirm the first; both sides drop out of future suggestions.
    const mark = file.reconcileBankTransaction(1, inbound.id);
    expect(file.bankMatchSuggestions('chase-checking')).toHaveLength(1);
    expect(() => file.reconcileBankTransaction(1, outbound.id)).toThrowError(/already reconciled/);
    // Amount/direction re-validated at write time, not just suggestion time.
    expect(() => file.reconcileBankTransaction(3, outbound.id)).toThrowError(/does not match/);

    // Undo is a reversal record; the pair becomes matchable again.
    file.unreconcileBankTransaction(mark.reconSeq);
    expect(file.bankMatchSuggestions('chase-checking')).toHaveLength(2);
    expect(() => file.unreconcileBankTransaction(mark.reconSeq)).toThrowError(/already reversed/);
  });

  it('rejects malformed CSV loudly', () => {
    expect(() => file.importBankTransactions('x', 'nope,nope\n1,2')).toThrowError(/must start with header/);
    expect(() => file.importBankTransactions('x', 'date,amount,description\n2026-13-99,abc,')).toThrowError(/malformed|Invalid/);
  });
});
