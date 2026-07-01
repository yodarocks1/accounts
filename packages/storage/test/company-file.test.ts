import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { Ledger, LedgerError, type NewJournalEntry } from '@accounts/core';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-test-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedAccounts(target: CompanyFile) {
  const cash = target.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
  const sales = target.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
  const rent = target.createAccount({ name: 'Rent', type: 'expense', currency: 'USD', code: '6000' });
  return { cash, sales, rent };
}

describe('CompanyFile lifecycle', () => {
  it('persists company info and reopens', () => {
    const { cash } = seedAccounts(file);
    file.postEntry({
      date: '2026-07-01',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
        { accountId: file.findAccountByCode('4000')!.id, side: 'credit', amount: 100n, currency: 'USD' },
      ],
    });
    file.close();

    file = CompanyFile.open(join(dir, 'books.sqlite'));
    expect(file.info()).toEqual({ name: 'Test Co', baseCurrency: 'USD' });
    expect(file.listAccounts()).toHaveLength(3);
    expect(file.listEntries()).toHaveLength(1);
    expect(file.listEntries()[0]!.lines[0]!.amount).toBe(100n);
  });

  it('refuses to open a non-company file and to re-init a used one', () => {
    expect(() => CompanyFile.open(join(dir, 'missing.sqlite'))).toThrow();
    expect(() =>
      CompanyFile.create(join(dir, 'books.sqlite'), { name: 'Again', baseCurrency: 'USD' }),
    ).toThrowError(/non-empty/);
  });
});

describe('validation parity with core', () => {
  it('rejects unbalanced, unknown-account, and mismatched-currency entries', () => {
    const { cash, sales } = seedAccounts(file);
    const bad: NewJournalEntry[] = [
      {
        date: '2026-07-01',
        lines: [
          { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
          { accountId: sales.id, side: 'credit', amount: 99n, currency: 'USD' },
        ],
      },
      {
        date: '2026-07-01',
        lines: [
          { accountId: 'ghost', side: 'debit', amount: 100n, currency: 'USD' },
          { accountId: sales.id, side: 'credit', amount: 100n, currency: 'USD' },
        ],
      },
      {
        date: '2026-07-01',
        lines: [
          { accountId: cash.id, side: 'debit', amount: 100n, currency: 'EUR' },
          { accountId: sales.id, side: 'credit', amount: 100n, currency: 'EUR' },
        ],
      },
    ];
    for (const entry of bad) {
      expect(() => file.postEntry(entry)).toThrow(LedgerError);
    }
    expect(file.listEntries()).toHaveLength(0);
  });

  it('enforces unique account codes', () => {
    seedAccounts(file);
    expect(() =>
      file.createAccount({ name: 'Petty Cash', type: 'asset', currency: 'USD', code: '1000' }),
    ).toThrowError(/already in use/);
  });

  it('reverses once and only once', () => {
    const { cash, rent } = seedAccounts(file);
    const entry = file.postEntry({
      date: '2026-07-01',
      lines: [
        { accountId: rent.id, side: 'debit', amount: 5000n, currency: 'USD' },
        { accountId: cash.id, side: 'credit', amount: 5000n, currency: 'USD' },
      ],
    });
    const reversal = file.reverseEntry(entry.id, '2026-07-02');
    expect(reversal.reversesEntryId).toBe(entry.id);
    expect(() => file.reverseEntry(entry.id, '2026-07-03')).toThrowError(/already reversed/i);
    for (const row of file.trialBalance().rows) {
      expect(row.net).toBe(0n);
    }
  });
});

describe('immutability at the database level', () => {
  it('raw SQL cannot update or delete posted journal rows', async () => {
    const { cash, sales } = seedAccounts(file);
    const entry = file.postEntry({
      date: '2026-07-01',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
        { accountId: sales.id, side: 'credit', amount: 100n, currency: 'USD' },
      ],
    });
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(join(dir, 'books.sqlite'));
    try {
      expect(() => raw.prepare(`UPDATE journal_lines SET amount = 1 WHERE entry_id = ?`).run(entry.id)).toThrowError(/immutable/);
      expect(() => raw.prepare(`DELETE FROM journal_entries WHERE id = ?`).run(entry.id)).toThrowError(/immutable/);
      expect(() => raw.prepare(`UPDATE journal_entries SET date = '2020-01-01' WHERE id = ?`).run(entry.id)).toThrowError(/immutable/);
      expect(() => raw.prepare(`DELETE FROM audit_log`).run()).toThrowError(/immutable/);
    } finally {
      raw.close();
    }
  });

  it('audit log records every write', () => {
    const { cash, sales } = seedAccounts(file);
    file.postEntry({
      date: '2026-07-01',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
        { accountId: sales.id, side: 'credit', amount: 100n, currency: 'USD' },
      ],
    });
    const actions = file.auditLog().map((row) => row.action);
    expect(actions).toEqual([
      'company.created',
      'account.created',
      'account.created',
      'account.created',
      'journal.posted',
    ]);
  });
});

describe('conformance against the in-memory reference ledger', () => {
  it('produces identical trial balances for any generated activity', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            debitIdx: fc.nat({ max: 2 }),
            creditIdx: fc.nat({ max: 2 }),
            amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
            month: fc.integer({ min: 1, max: 12 }),
          }),
          { maxLength: 20 },
        ),
        (moves) => {
          const scratch = mkdtempSync(join(tmpdir(), 'accounts-prop-'));
          const sqlFile = CompanyFile.create(join(scratch, 'books.sqlite'), {
            name: 'Prop Co',
            baseCurrency: 'USD',
          });
          try {
            const reference = new Ledger();
            const sqlAccounts = seedAccounts(sqlFile);
            const pool = [sqlAccounts.cash, sqlAccounts.sales, sqlAccounts.rent];
            const referencePool = pool.map((account) =>
              reference.createAccount(
                { name: account.name, type: account.type, currency: account.currency, code: account.code ?? undefined },
                account.id,
              ),
            );
            void referencePool;

            for (const move of moves) {
              if (move.debitIdx === move.creditIdx) continue;
              const entry: NewJournalEntry = {
                date: `2026-${String(move.month).padStart(2, '0')}-15`,
                lines: [
                  { accountId: pool[move.debitIdx]!.id, side: 'debit', amount: move.amount, currency: 'USD' },
                  { accountId: pool[move.creditIdx]!.id, side: 'credit', amount: move.amount, currency: 'USD' },
                ],
              };
              sqlFile.postEntry(entry);
              reference.post(entry);
            }

            const fromSql = sqlFile.trialBalance();
            const fromReference = reference.trialBalance();
            expect(fromSql.rows).toEqual(fromReference.rows);

            // And the raw SQL aggregation agrees with both.
            const sqlRows = new Map(sqlFile.trialBalanceSql().map((row) => [row.accountId, row]));
            for (const row of fromReference.rows) {
              const sqlRow = sqlRows.get(row.accountId)!;
              expect(sqlRow.debits).toBe(row.debits);
              expect(sqlRow.credits).toBe(row.credits);
            }
          } finally {
            sqlFile.close();
            rmSync(scratch, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
