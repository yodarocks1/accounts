import { LedgerError } from './errors.js';
import {
  deriveTags,
  documentLabel,
  matchesCustomer,
  revisionTotal,
  type CustomerQuery,
  type DocumentRecord,
  type DocumentTag,
  type LineClosure,
  type SettlementMode,
} from './documents.js';

/** Age bucket: minDays..maxDays inclusive; omit maxDays for open-ended. */
export interface AgingRule {
  label: string;
  minDays: number;
  maxDays?: number;
}

/** Default buckets (ADR 0006): ≤22 current, 23–30 due soon, >30 past due. */
export const DEFAULT_AGING_RULES: readonly AgingRule[] = [
  { label: 'current', minDays: 0, maxDays: 22 },
  { label: 'due soon', minDays: 23, maxDays: 30 },
  { label: 'past due', minDays: 31 },
];

export interface StatementCorrection {
  readonly revisionNo: number;
  readonly at: string;
  readonly reason: string | null;
  /** Amount due after this correction. */
  readonly total: bigint;
}

export interface StatementInvoice {
  readonly documentId: string;
  readonly number: string;
  readonly label: string;
  readonly date: string;
  readonly poNumber: string | null;
  /** The original amount due — shown first (ADR 0006). */
  readonly originalTotal: bigint;
  readonly currentTotal: bigint;
  /** Placed directly below the invoice entry, in order. */
  readonly corrections: readonly StatementCorrection[];
  readonly ageDays: number;
  readonly ageLabel: string;
  readonly tags: readonly DocumentTag[];
}

export interface StatementCredit {
  readonly documentId: string;
  readonly number: string;
  readonly label: string;
  readonly date: string;
  readonly total: bigint;
  readonly settlement: SettlementMode;
  /** 'return' when the credit's lines link back to purchases. */
  readonly kind: 'return' | 'credit';
}

export interface Statement {
  readonly query: CustomerQuery;
  readonly asOf: string;
  readonly invoices: readonly StatementInvoice[];
  readonly credits: readonly StatementCredit[];
  readonly invoiceTotal: bigint;
  /** All credits listed; only account-settled ones reduce the balance. */
  readonly creditTotal: bigint;
  readonly accountCreditTotal: bigint;
  readonly balance: bigint;
}

function daysBetween(from: string, to: string): number {
  const parse = (value: string): number => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year!, month! - 1, day!);
  };
  return Math.floor((parse(to) - parse(from)) / 86_400_000);
}

export function ageLabelFor(ageDays: number, rules: readonly AgingRule[]): string {
  const rule = rules.find(
    (candidate) => ageDays >= candidate.minDays && (candidate.maxDays === undefined || ageDays <= candidate.maxDays),
  );
  return rule?.label ?? 'unaged';
}

/**
 * Customer statement (ADR 0006): all sent invoices with original amounts
 * first and corrections directly below, aged per the rules, plus all credits
 * to the account. A pure computation — statements are never stored.
 */
export function computeStatement(
  documents: readonly { record: DocumentRecord; closures: readonly LineClosure[] }[],
  query: CustomerQuery,
  asOf: string,
  rules: readonly AgingRule[] = DEFAULT_AGING_RULES,
): Statement {
  if (query.customerName === undefined && query.accountNumber === undefined) {
    throw new LedgerError('INVALID_DOCUMENT', 'Statement query needs a customer name or an account number');
  }
  const invoices: StatementInvoice[] = [];
  const credits: StatementCredit[] = [];

  for (const { record, closures } of documents) {
    if (record.status !== 'sent') continue;
    const current = record.revisions[record.revisions.length - 1]!;
    if (current.date > asOf || !matchesCustomer(current, query)) continue;
    const tags = deriveTags(record, closures);

    if (record.type === 'invoice') {
      const ageDays = daysBetween(current.date, asOf);
      invoices.push({
        documentId: record.id,
        number: record.number,
        label: documentLabel(record.number, tags),
        date: current.date,
        poNumber: current.poNumber,
        originalTotal: revisionTotal(record.revisions[0]!),
        currentTotal: revisionTotal(current),
        corrections: record.revisions
          .filter((revision) => revision.kind === 'correction')
          .map((revision) => ({
            revisionNo: revision.revisionNo,
            at: revision.at,
            reason: revision.reason,
            total: revisionTotal(revision),
          })),
        ageDays,
        ageLabel: ageLabelFor(ageDays, rules),
        tags,
      });
    } else if (record.type === 'credit_memo') {
      credits.push({
        documentId: record.id,
        number: record.number,
        label: documentLabel(record.number, tags),
        date: current.date,
        total: revisionTotal(current),
        settlement: record.settlement ?? 'account',
        kind: current.lines.some((line) => line.sourceLineId !== null) ? 'return' : 'credit',
      });
    }
  }

  invoices.sort((a, b) => (a.date === b.date ? (a.number < b.number ? -1 : 1) : a.date < b.date ? -1 : 1));
  credits.sort((a, b) => (a.date === b.date ? (a.number < b.number ? -1 : 1) : a.date < b.date ? -1 : 1));

  const invoiceTotal = invoices.reduce((sum, entry) => sum + entry.currentTotal, 0n);
  const creditTotal = credits.reduce((sum, entry) => sum + entry.total, 0n);
  const accountCreditTotal = credits
    .filter((entry) => entry.settlement === 'account')
    .reduce((sum, entry) => sum + entry.total, 0n);

  return {
    query,
    asOf,
    invoices,
    credits,
    invoiceTotal,
    creditTotal,
    accountCreditTotal,
    balance: invoiceTotal - accountCreditTotal,
  };
}
