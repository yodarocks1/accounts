import type { Account } from './account.js';
import type { JournalEntry } from './journal.js';
import { computeTrialBalance } from './trial-balance.js';
import {
  dueDateOf,
  revisionGrandTotal,
  type DocumentRecord,
} from './documents.js';
import { ageLabelFor, daysBetween, DEFAULT_AGING_RULES, type AgingRule } from './statement.js';
import { appliedToInvoice, settle, type ApplicationSourceKind, type CreditApplication, type Payment } from './payments.js';

/**
 * Financial reports (ADR 0017): pure reads over existing facts, never
 * stored — like every other derived value in the system.
 */

export interface ReportAccountRow {
  readonly accountId: string;
  readonly code: string | null;
  readonly name: string;
  readonly currency: string;
  /** Sign-normalized for display: always the natural balance, positive. */
  readonly amount: bigint;
}

export interface ProfitAndLoss {
  readonly from: string;
  readonly to: string;
  readonly income: readonly ReportAccountRow[];
  readonly expense: readonly ReportAccountRow[];
  readonly totalIncome: bigint;
  readonly totalExpense: bigint;
  readonly netProfit: bigint;
}

/** Income credit-positive, expense debit-positive, over entries in [from, to]. */
export function computeProfitAndLoss(
  entries: Iterable<JournalEntry>,
  accountsById: ReadonlyMap<string, Account>,
  from: string,
  to: string,
): ProfitAndLoss {
  const inRange = [...entries].filter((entry) => entry.date >= from && entry.date <= to);
  const balance = computeTrialBalance(inRange, accountsById);
  const income: ReportAccountRow[] = [];
  const expense: ReportAccountRow[] = [];
  for (const row of balance.rows) {
    const account = accountsById.get(row.accountId);
    if (!account || row.net === 0n) continue;
    const base = { accountId: row.accountId, code: account.code, name: account.name, currency: row.currency };
    if (account.type === 'income') income.push({ ...base, amount: -row.net });
    else if (account.type === 'expense') expense.push({ ...base, amount: row.net });
  }
  const totalIncome = income.reduce((sum, row) => sum + row.amount, 0n);
  const totalExpense = expense.reduce((sum, row) => sum + row.amount, 0n);
  return { from, to, income, expense, totalIncome, totalExpense, netProfit: totalIncome - totalExpense };
}

export interface BalanceSheet {
  readonly asOf: string;
  readonly assets: readonly ReportAccountRow[];
  readonly liabilities: readonly ReportAccountRow[];
  /** Includes the derived retained-earnings row. */
  readonly equity: readonly ReportAccountRow[];
  readonly totalAssets: bigint;
  readonly totalLiabilities: bigint;
  readonly totalEquity: bigint;
  /** Tripwire; true by construction of a balanced trial balance. */
  readonly balanced: boolean;
}

/** Assets debit-positive vs liabilities/equity credit-positive, with derived retained earnings. */
export function computeBalanceSheet(
  entries: Iterable<JournalEntry>,
  accountsById: ReadonlyMap<string, Account>,
  asOf: string,
): BalanceSheet {
  const balance = computeTrialBalance(entries, accountsById, asOf);
  const assets: ReportAccountRow[] = [];
  const liabilities: ReportAccountRow[] = [];
  const equity: ReportAccountRow[] = [];
  let retained = 0n;
  let currency = 'USD';
  for (const row of balance.rows) {
    const account = accountsById.get(row.accountId);
    if (!account) continue;
    currency = row.currency;
    if (account.type === 'income' || account.type === 'expense') {
      retained -= row.net; // accumulated profit is a credit balance
      continue;
    }
    if (row.net === 0n) continue;
    const base = { accountId: row.accountId, code: account.code, name: account.name, currency: row.currency };
    if (account.type === 'asset') assets.push({ ...base, amount: row.net });
    else if (account.type === 'liability') liabilities.push({ ...base, amount: -row.net });
    else equity.push({ ...base, amount: -row.net });
  }
  if (retained !== 0n) {
    equity.push({ accountId: 'retained-earnings', code: null, name: 'Retained earnings', currency, amount: retained });
  }
  const totalAssets = assets.reduce((sum, row) => sum + row.amount, 0n);
  const totalLiabilities = liabilities.reduce((sum, row) => sum + row.amount, 0n);
  const totalEquity = equity.reduce((sum, row) => sum + row.amount, 0n);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

// ── Aging summaries (ADR 0017 part 3) ──────────────────────────────────────

export interface AgingBucket {
  readonly label: string;
  readonly amount: bigint;
}

export interface AgingRow {
  readonly partyId: string | null;
  readonly name: string;
  readonly accountNumber: string | null;
  readonly buckets: readonly AgingBucket[];
  readonly total: bigint;
}

export interface AgingSummary {
  readonly asOf: string;
  readonly side: 'customer' | 'supplier';
  /** Bucket labels in display order; every row's buckets align to these. */
  readonly labels: readonly string[];
  readonly rows: readonly AgingRow[];
  readonly totals: readonly AgingBucket[];
  readonly grandTotal: bigint;
}

/**
 * Open invoices (customer side) or bills (supplier side), bucketed by the
 * aging rules from their due dates and grouped per counterparty — the
 * statement's aging semantics applied across the whole book (ADR 0017).
 */
export function computeAgingSummary(
  documents: readonly DocumentRecord[],
  payments: readonly Payment[],
  applications: readonly CreditApplication[],
  asOf: string,
  side: 'customer' | 'supplier' = 'customer',
  rules: readonly AgingRule[] = DEFAULT_AGING_RULES,
): AgingSummary {
  const invoiceType = side === 'supplier' ? 'bill' : 'invoice';
  const creditType = side === 'supplier' ? 'vendor_credit' : 'credit_memo';
  const recordsById = new Map(documents.map((record) => [record.id, record]));
  const paymentsById = new Map(payments.map((payment) => [payment.id, payment]));
  const isSourceActive = (kind: ApplicationSourceKind, id: string): boolean => {
    if (kind === 'payment') return paymentsById.get(id)?.status === 'received';
    const record = recordsById.get(id);
    return record?.type === creditType && record.status === 'sent' && record.settlement === 'account';
  };

  const labels = ['not due', ...rules.map((rule) => rule.label), 'unaged'];
  interface RowAccumulator {
    partyId: string | null;
    name: string;
    accountNumber: string | null;
    byLabel: Map<string, bigint>;
    total: bigint;
  }
  const rowsByIdentity = new Map<string, RowAccumulator>();

  for (const record of documents) {
    if (record.type !== invoiceType || record.status !== 'sent') continue;
    const current = record.revisions[record.revisions.length - 1]!;
    if (current.date > asOf) continue;
    const settlement = settle(
      revisionGrandTotal(current),
      appliedToInvoice(applications, record.id, isSourceActive, asOf),
    );
    if (settlement.open === 0n) continue;
    const ageDays = daysBetween(dueDateOf(current) ?? current.date, asOf);
    const label = ageLabelFor(ageDays, rules);
    const identity = record.partyId ?? `${current.customerName}|${current.accountNumber ?? ''}`;
    const row = rowsByIdentity.get(identity) ?? {
      partyId: record.partyId,
      name: current.customerName,
      accountNumber: current.accountNumber,
      byLabel: new Map<string, bigint>(),
      total: 0n,
    };
    row.byLabel.set(label, (row.byLabel.get(label) ?? 0n) + settlement.open);
    row.total += settlement.open;
    rowsByIdentity.set(identity, row);
  }

  const rows: AgingRow[] = [...rowsByIdentity.values()]
    .sort((a, b) => (a.total === b.total ? (a.name < b.name ? -1 : 1) : a.total > b.total ? -1 : 1))
    .map((row) => ({
      partyId: row.partyId,
      name: row.name,
      accountNumber: row.accountNumber,
      buckets: labels.map((label) => ({ label, amount: row.byLabel.get(label) ?? 0n })),
      total: row.total,
    }));
  const totals: AgingBucket[] = labels.map((label) => ({
    label,
    amount: rows.reduce((sum, row) => sum + (row.buckets.find((bucket) => bucket.label === label)?.amount ?? 0n), 0n),
  }));
  return {
    asOf,
    side,
    labels,
    rows,
    totals,
    grandTotal: rows.reduce((sum, row) => sum + row.total, 0n),
  };
}

// ── Inventory summary (ADR 0017 part 4) ────────────────────────────────────

export interface InventorySummaryRow {
  readonly itemId: string;
  readonly name: string;
  readonly quantityMilli: bigint;
  readonly valueMinor: bigint;
}

export interface InventorySummary {
  readonly asOf: string | null;
  readonly rows: readonly InventorySummaryRow[];
  readonly totalValueMinor: bigint;
}
