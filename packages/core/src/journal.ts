import type { BalanceSide } from './account.js';
import { LedgerError } from './errors.js';
import type { Account } from './account.js';
import { currencyExponent } from './money.js';

export interface JournalLine {
  readonly accountId: string;
  readonly side: BalanceSide;
  /** Positive count of minor units in the line's currency. */
  readonly amount: bigint;
  readonly currency: string;
  readonly memo: string | null;
}

export interface NewJournalLine {
  accountId: string;
  side: BalanceSide;
  amount: bigint;
  currency: string;
  memo?: string;
}

export interface JournalEntry {
  readonly id: string;
  /** Monotonic posting sequence assigned by the ledger. */
  readonly seq: number;
  /** ISO 8601 calendar date the entry is effective (e.g. "2026-07-01"). */
  readonly date: string;
  readonly memo: string | null;
  readonly lines: readonly JournalLine[];
  /** Set when this entry reverses another. */
  readonly reversesEntryId: string | null;
}

export interface NewJournalEntry {
  date: string;
  lines: NewJournalLine[];
  memo?: string;
  reversesEntryId?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a candidate entry against the double-entry invariants:
 * at least two lines, positive amounts, known active accounts, line currency
 * matching the account's currency, and debits equal to credits per currency.
 *
 * Throws LedgerError; returns nothing. This is the single source of truth for
 * what may enter the journal — every storage engine must route through it.
 */
export function validateNewEntry(
  entry: NewJournalEntry,
  accountsById: ReadonlyMap<string, Account>,
): void {
  if (!ISO_DATE.test(entry.date)) {
    throw new LedgerError('EMPTY_ENTRY', `Entry date must be YYYY-MM-DD; got ${JSON.stringify(entry.date)}`);
  }
  if (entry.lines.length < 2) {
    throw new LedgerError('EMPTY_ENTRY', 'A journal entry needs at least two lines');
  }

  const balance = new Map<string, bigint>();
  for (const line of entry.lines) {
    if (line.amount <= 0n) {
      throw new LedgerError('NONPOSITIVE_AMOUNT', 'Line amounts must be positive minor units');
    }
    currencyExponent(line.currency);
    const account = accountsById.get(line.accountId);
    if (!account) {
      throw new LedgerError('UNKNOWN_ACCOUNT', `No such account: ${line.accountId}`);
    }
    if (account.archived) {
      throw new LedgerError('ARCHIVED_ACCOUNT', `Account is archived: ${account.name}`);
    }
    if (account.currency !== line.currency) {
      throw new LedgerError(
        'CURRENCY_MISMATCH',
        `Account ${account.name} is ${account.currency}; line is ${line.currency}`,
      );
    }
    const delta = line.side === 'debit' ? line.amount : -line.amount;
    balance.set(line.currency, (balance.get(line.currency) ?? 0n) + delta);
  }

  for (const [currency, net] of balance) {
    if (net !== 0n) {
      throw new LedgerError(
        'UNBALANCED_ENTRY',
        `Debits and credits differ by ${net} minor units of ${currency}`,
      );
    }
  }
}
