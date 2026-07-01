import { describe, expect, it } from 'vitest';
import {
  Ledger,
  LedgerError,
  validateNewEntry,
  type Account,
  type NewJournalEntry,
} from '../src/index.js';

function sampleLedger() {
  const ledger = new Ledger();
  const cash = ledger.createAccount({ name: 'Cash', type: 'asset', currency: 'USD', code: '1000' });
  const sales = ledger.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
  const rent = ledger.createAccount({ name: 'Rent', type: 'expense', currency: 'USD', code: '6000' });
  return { ledger, cash, sales, rent };
}

describe('Ledger.post', () => {
  it('posts a balanced entry and assigns a sequence', () => {
    const { ledger, cash, sales } = sampleLedger();
    const entry = ledger.post({
      date: '2026-07-01',
      memo: 'Sale',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 12345n, currency: 'USD' },
        { accountId: sales.id, side: 'credit', amount: 12345n, currency: 'USD' },
      ],
    });
    expect(entry.seq).toBe(1);
    expect(ledger.getEntry(entry.id)).toBe(entry);
  });

  it('rejects unbalanced entries', () => {
    const { ledger, cash, sales } = sampleLedger();
    expect(() =>
      ledger.post({
        date: '2026-07-01',
        lines: [
          { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
          { accountId: sales.id, side: 'credit', amount: 99n, currency: 'USD' },
        ],
      }),
    ).toThrowError(/differ by 1 minor units/);
  });

  it('rejects single-line, empty, and nonpositive entries', () => {
    const { ledger, cash } = sampleLedger();
    const single: NewJournalEntry = {
      date: '2026-07-01',
      lines: [{ accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' }],
    };
    expect(() => ledger.post(single)).toThrowError(/at least two lines/);
    expect(() => ledger.post({ date: '2026-07-01', lines: [] })).toThrow(LedgerError);
    expect(() =>
      ledger.post({
        date: '2026-07-01',
        lines: [
          { accountId: cash.id, side: 'debit', amount: 0n, currency: 'USD' },
          { accountId: cash.id, side: 'credit', amount: 0n, currency: 'USD' },
        ],
      }),
    ).toThrowError(/positive/);
  });

  it('rejects unknown accounts and currency mismatches', () => {
    const { ledger, cash, sales } = sampleLedger();
    expect(() =>
      ledger.post({
        date: '2026-07-01',
        lines: [
          { accountId: 'nope', side: 'debit', amount: 100n, currency: 'USD' },
          { accountId: sales.id, side: 'credit', amount: 100n, currency: 'USD' },
        ],
      }),
    ).toThrowError(/No such account/);
    expect(() =>
      ledger.post({
        date: '2026-07-01',
        lines: [
          { accountId: cash.id, side: 'debit', amount: 100n, currency: 'EUR' },
          { accountId: sales.id, side: 'credit', amount: 100n, currency: 'EUR' },
        ],
      }),
    ).toThrowError(/CURRENCY|is USD/);
  });

  it('rejects malformed dates', () => {
    const { ledger, cash, sales } = sampleLedger();
    expect(() =>
      ledger.post({
        date: 'July 1',
        lines: [
          { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
          { accountId: sales.id, side: 'credit', amount: 100n, currency: 'USD' },
        ],
      }),
    ).toThrowError(/YYYY-MM-DD/);
  });

  it('an entry that balances only across currencies is rejected', () => {
    // Balance must hold per currency, not in aggregate.
    const accounts = new Map<string, Account>([
      ['usd', { id: 'usd', code: null, name: 'Cash USD', type: 'asset', currency: 'USD', parentId: null, archived: false }],
      ['eur', { id: 'eur', code: null, name: 'Cash EUR', type: 'asset', currency: 'EUR', parentId: null, archived: false }],
    ]);
    expect(() =>
      validateNewEntry(
        {
          date: '2026-07-01',
          lines: [
            { accountId: 'usd', side: 'debit', amount: 100n, currency: 'USD' },
            { accountId: 'eur', side: 'credit', amount: 100n, currency: 'EUR' },
          ],
        },
        accounts,
      ),
    ).toThrowError(/UNBALANCED|differ/);
  });

  it('rejects posting to archived accounts', () => {
    const accounts = new Map<string, Account>([
      ['a', { id: 'a', code: null, name: 'Old', type: 'asset', currency: 'USD', parentId: null, archived: true }],
      ['b', { id: 'b', code: null, name: 'Sales', type: 'income', currency: 'USD', parentId: null, archived: false }],
    ]);
    expect(() =>
      validateNewEntry(
        {
          date: '2026-07-01',
          lines: [
            { accountId: 'a', side: 'debit', amount: 100n, currency: 'USD' },
            { accountId: 'b', side: 'credit', amount: 100n, currency: 'USD' },
          ],
        },
        accounts,
      ),
    ).toThrowError(/archived/);
  });
});

describe('Ledger.reverse', () => {
  it('reversal restores every account balance and links to the original', () => {
    const { ledger, cash, rent } = sampleLedger();
    const entry = ledger.post({
      date: '2026-07-01',
      lines: [
        { accountId: rent.id, side: 'debit', amount: 5000n, currency: 'USD' },
        { accountId: cash.id, side: 'credit', amount: 5000n, currency: 'USD' },
      ],
    });
    const reversal = ledger.reverse(entry.id, '2026-07-02');
    expect(reversal.reversesEntryId).toBe(entry.id);
    for (const row of ledger.trialBalance().rows) {
      expect(row.net).toBe(0n);
    }
  });

  it('an entry can only be reversed once', () => {
    const { ledger, cash, rent } = sampleLedger();
    const entry = ledger.post({
      date: '2026-07-01',
      lines: [
        { accountId: rent.id, side: 'debit', amount: 5000n, currency: 'USD' },
        { accountId: cash.id, side: 'credit', amount: 5000n, currency: 'USD' },
      ],
    });
    ledger.reverse(entry.id, '2026-07-02');
    expect(() => ledger.reverse(entry.id, '2026-07-03')).toThrowError(/already reversed/i);
  });
});

describe('Ledger.createAccount', () => {
  it('enforces unique codes and existing parents', () => {
    const { ledger } = sampleLedger();
    expect(() =>
      ledger.createAccount({ name: 'Other', type: 'asset', currency: 'USD', code: '1000' }),
    ).toThrowError(/already in use/);
    expect(() =>
      ledger.createAccount({ name: 'Child', type: 'asset', currency: 'USD', parentId: 'missing' }),
    ).toThrowError(/parent/);
  });
});

describe('trial balance as-of filtering', () => {
  it('excludes entries after the as-of date', () => {
    const { ledger, cash, sales } = sampleLedger();
    ledger.post({
      date: '2026-01-15',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 100n, currency: 'USD' },
        { accountId: sales.id, side: 'credit', amount: 100n, currency: 'USD' },
      ],
    });
    ledger.post({
      date: '2026-06-15',
      lines: [
        { accountId: cash.id, side: 'debit', amount: 900n, currency: 'USD' },
        { accountId: sales.id, side: 'credit', amount: 900n, currency: 'USD' },
      ],
    });
    const early = ledger.trialBalance('2026-03-31');
    const cashRow = early.rows.find((row) => row.accountId === cash.id);
    expect(cashRow?.net).toBe(100n);
    const full = ledger.trialBalance();
    expect(full.rows.find((row) => row.accountId === cash.id)?.net).toBe(1000n);
  });
});
