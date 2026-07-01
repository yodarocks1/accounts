import type { Account } from './account.js';
import type { JournalEntry } from './journal.js';

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly currency: string;
  /** Total of debit lines, minor units. */
  readonly debits: bigint;
  /** Total of credit lines, minor units. */
  readonly credits: bigint;
  /** debits - credits; positive means a net debit balance. */
  readonly net: bigint;
}

export interface TrialBalance {
  readonly asOf: string | null;
  readonly rows: readonly TrialBalanceRow[];
  /** Per-currency totals; a sound ledger has totalDebits === totalCredits. */
  readonly totals: ReadonlyMap<string, { debits: bigint; credits: bigint }>;
}

/**
 * Reference trial-balance computation over posted entries. Storage engines may
 * compute the same thing in SQL; tests cross-check them against this.
 */
export function computeTrialBalance(
  entries: Iterable<JournalEntry>,
  accountsById: ReadonlyMap<string, Account>,
  asOf?: string,
): TrialBalance {
  const rows = new Map<string, { accountId: string; currency: string; debits: bigint; credits: bigint }>();
  const totals = new Map<string, { debits: bigint; credits: bigint }>();

  for (const entry of entries) {
    if (asOf !== undefined && entry.date > asOf) continue;
    for (const line of entry.lines) {
      let row = rows.get(line.accountId);
      if (!row) {
        row = { accountId: line.accountId, currency: line.currency, debits: 0n, credits: 0n };
        rows.set(line.accountId, row);
      }
      let total = totals.get(line.currency);
      if (!total) {
        total = { debits: 0n, credits: 0n };
        totals.set(line.currency, total);
      }
      if (line.side === 'debit') {
        row.debits += line.amount;
        total.debits += line.amount;
      } else {
        row.credits += line.amount;
        total.credits += line.amount;
      }
    }
  }

  const ordered = [...rows.values()]
    .map((row) => ({ ...row, net: row.debits - row.credits }))
    .sort((a, b) => {
      const codeA = accountsById.get(a.accountId)?.code ?? '';
      const codeB = accountsById.get(b.accountId)?.code ?? '';
      if (codeA !== codeB) return codeA < codeB ? -1 : 1;
      const nameA = accountsById.get(a.accountId)?.name ?? a.accountId;
      const nameB = accountsById.get(b.accountId)?.name ?? b.accountId;
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });

  return { asOf: asOf ?? null, rows: ordered, totals };
}
