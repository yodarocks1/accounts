import { randomUUID } from './ids.js';
import type { Account, NewAccount } from './account.js';
import { ACCOUNT_TYPES } from './account.js';
import { LedgerError } from './errors.js';
import type { JournalEntry, NewJournalEntry } from './journal.js';
import { validateNewEntry } from './journal.js';
import { computeTrialBalance, type TrialBalance } from './trial-balance.js';
import { currencyExponent } from './money.js';

/**
 * In-memory reference ledger. Storage engines implement the same semantics
 * with persistence; the property-based test suite runs against this class and
 * doubles as their conformance oracle.
 */
export class Ledger {
  private readonly accounts = new Map<string, Account>();
  private readonly codes = new Map<string, string>();
  private readonly entries: JournalEntry[] = [];
  private readonly entryIds = new Map<string, JournalEntry>();
  private readonly reversedBy = new Map<string, string>();
  private nextSeq = 1;

  createAccount(input: NewAccount, id: string = randomUUID()): Account {
    if (!ACCOUNT_TYPES.includes(input.type)) {
      throw new LedgerError('UNKNOWN_ACCOUNT', `Invalid account type: ${String(input.type)}`);
    }
    if (!input.name.trim()) {
      throw new LedgerError('UNKNOWN_ACCOUNT', 'Account name must not be empty');
    }
    currencyExponent(input.currency);
    if (input.code !== undefined && this.codes.has(input.code)) {
      throw new LedgerError('DUPLICATE_ACCOUNT_CODE', `Account code already in use: ${input.code}`);
    }
    if (input.parentId !== undefined && !this.accounts.has(input.parentId)) {
      throw new LedgerError('UNKNOWN_ACCOUNT', `No such parent account: ${input.parentId}`);
    }
    const account: Account = {
      id,
      code: input.code ?? null,
      name: input.name.trim(),
      type: input.type,
      currency: input.currency,
      parentId: input.parentId ?? null,
      archived: false,
    };
    this.accounts.set(account.id, account);
    if (account.code !== null) this.codes.set(account.code, account.id);
    return account;
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  get accountsById(): ReadonlyMap<string, Account> {
    return this.accounts;
  }

  /** Validate and append an entry. Posted entries are immutable (ADR 0003). */
  post(input: NewJournalEntry, id: string = randomUUID()): JournalEntry {
    if (input.reversesEntryId !== undefined) {
      if (!this.entryIds.has(input.reversesEntryId)) {
        throw new LedgerError('UNKNOWN_ENTRY', `No such entry: ${input.reversesEntryId}`);
      }
      if (this.reversedBy.has(input.reversesEntryId)) {
        throw new LedgerError('ALREADY_REVERSED', `Entry already reversed: ${input.reversesEntryId}`);
      }
    }
    validateNewEntry(input, this.accounts);
    const entry: JournalEntry = {
      id,
      seq: this.nextSeq++,
      date: input.date,
      memo: input.memo ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      lines: input.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount: line.amount,
        currency: line.currency,
        memo: line.memo ?? null,
      })),
    };
    this.entries.push(entry);
    this.entryIds.set(entry.id, entry);
    if (entry.reversesEntryId !== null) this.reversedBy.set(entry.reversesEntryId, entry.id);
    return entry;
  }

  /** Post the mirror image of an existing entry, linked to it. */
  reverse(entryId: string, date: string, memo?: string): JournalEntry {
    const original = this.entryIds.get(entryId);
    if (!original) {
      throw new LedgerError('UNKNOWN_ENTRY', `No such entry: ${entryId}`);
    }
    return this.post({
      date,
      memo: memo ?? `Reversal of ${entryId}`,
      reversesEntryId: entryId,
      lines: original.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side === 'debit' ? 'credit' : 'debit',
        amount: line.amount,
        currency: line.currency,
      })),
    });
  }

  getEntry(id: string): JournalEntry | undefined {
    return this.entryIds.get(id);
  }

  listEntries(): readonly JournalEntry[] {
    return this.entries;
  }

  trialBalance(asOf?: string): TrialBalance {
    return computeTrialBalance(this.entries, this.accounts, asOf);
  }
}
