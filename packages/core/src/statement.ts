import { LedgerError } from './errors.js';
import {
  deriveTags,
  documentLabel,
  dueDateOf,
  matchesCustomer,
  matchesCustomerOrParty,
  revisionGrandTotal,
  type CustomerQuery,
  type DocumentRecord,
  type DocumentTag,
  type LineClosure,
  type SettlementMode,
} from './documents.js';
import {
  appliedFromSource,
  appliedToInvoice,
  settle,
  type ApplicationSourceKind,
  type CreditApplication,
  type InvoiceSettlement,
  type Payment,
} from './payments.js';

/** Age bucket: minDays..maxDays inclusive; omit maxDays for open-ended. Negative minDays = before due. */
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
  /** date + terms; aging measures from this when present (ADR 0008). */
  readonly dueDate: string | null;
  readonly poNumber: string | null;
  /** The original amount due — shown first (ADR 0006). */
  readonly originalTotal: bigint;
  readonly currentTotal: bigint;
  /** Placed directly below the invoice entry, in order. */
  readonly corrections: readonly StatementCorrection[];
  readonly paidAmount: bigint;
  readonly openAmount: bigint;
  readonly settlementStatus: InvoiceSettlement['status'];
  readonly ageDays: number;
  /** 'paid' for settled invoices; otherwise from the aging rules. */
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
  /** Portion applied to invoices (account credits only). */
  readonly appliedAmount: bigint;
  readonly unappliedAmount: bigint;
}

export interface StatementPayment {
  readonly paymentId: string;
  readonly number: string;
  readonly date: string;
  readonly method: string | null;
  readonly amount: bigint;
  readonly appliedAmount: bigint;
  readonly unappliedAmount: bigint;
}

export interface Statement {
  readonly query: CustomerQuery;
  readonly asOf: string;
  readonly invoices: readonly StatementInvoice[];
  readonly credits: readonly StatementCredit[];
  readonly payments: readonly StatementPayment[];
  readonly invoiceTotal: bigint;
  readonly openInvoiceTotal: bigint;
  /** All credits listed; only account-settled ones participate in the balance. */
  readonly creditTotal: bigint;
  readonly accountCreditTotal: bigint;
  /** Unapplied account credit + unapplied payments — money on account. */
  readonly unappliedCreditTotal: bigint;
  /** Open invoices minus money on account. */
  readonly balance: bigint;
}

export function daysBetween(from: string, to: string): number {
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
  if (rule) return rule.label;
  return ageDays < 0 ? 'not due' : 'unaged';
}

/**
 * Customer statement (ADR 0006, extended by Tier 1): all sent invoices with
 * original amounts first and corrections directly below, aged per the rules
 * (only open balances age — settled invoices read "paid"), plus all credits
 * and payments with their applied/unapplied splits. A pure computation —
 * statements are never stored.
 */
export function computeStatement(
  documents: readonly { record: DocumentRecord; closures: readonly LineClosure[] }[],
  payments: readonly Payment[],
  applications: readonly CreditApplication[],
  query: CustomerQuery,
  asOf: string,
  rules: readonly AgingRule[] = DEFAULT_AGING_RULES,
): Statement {
  if (query.customerName === undefined && query.accountNumber === undefined && query.partyId === undefined) {
    throw new LedgerError('INVALID_DOCUMENT', 'Statement query needs a party, customer name, or account number');
  }
  const recordsById = new Map(documents.map((pair) => [pair.record.id, pair.record]));
  const paymentsById = new Map(payments.map((payment) => [payment.id, payment]));
  const isSourceActive = (kind: ApplicationSourceKind, id: string): boolean => {
    if (kind === 'payment') return paymentsById.get(id)?.status === 'received';
    const record = recordsById.get(id);
    return record?.type === 'credit_memo' && record.status === 'sent' && record.settlement === 'account';
  };

  const invoices: StatementInvoice[] = [];
  const credits: StatementCredit[] = [];

  for (const { record, closures } of documents) {
    if (record.status !== 'sent') continue;
    const current = record.revisions[record.revisions.length - 1]!;
    if (current.date > asOf || !matchesCustomerOrParty(record, current, query)) continue;
    const tags = deriveTags(record, closures);

    if (record.type === 'invoice') {
      const settlement = settle(
        revisionGrandTotal(current),
        appliedToInvoice(applications, record.id, isSourceActive, asOf),
      );
      const dueDate = dueDateOf(current);
      // With terms, "past due" means past the DUE date; ages can be negative.
      const ageDays = daysBetween(dueDate ?? current.date, asOf);
      invoices.push({
        documentId: record.id,
        number: record.number,
        label: documentLabel(record.number, tags),
        date: current.date,
        dueDate,
        poNumber: current.poNumber,
        originalTotal: revisionGrandTotal(record.revisions[0]!),
        currentTotal: settlement.total,
        corrections: record.revisions
          .filter((revision) => revision.kind === 'correction')
          .map((revision) => ({
            revisionNo: revision.revisionNo,
            at: revision.at,
            reason: revision.reason,
            total: revisionGrandTotal(revision),
          })),
        paidAmount: settlement.paid,
        openAmount: settlement.open,
        settlementStatus: settlement.status,
        ageDays,
        ageLabel: settlement.open === 0n ? 'paid' : ageLabelFor(ageDays, rules),
        tags,
      });
    } else if (record.type === 'credit_memo') {
      const total = revisionGrandTotal(current);
      const applied =
        record.settlement === 'account'
          ? appliedFromSource(applications, 'credit_memo', record.id, asOf)
          : 0n;
      credits.push({
        documentId: record.id,
        number: record.number,
        label: documentLabel(record.number, tags),
        date: current.date,
        total,
        settlement: record.settlement ?? 'account',
        kind: current.lines.some((line) => line.sourceLineId !== null) ? 'return' : 'credit',
        appliedAmount: applied,
        unappliedAmount: record.settlement === 'account' ? total - applied : 0n,
      });
    }
  }

  const statementPayments: StatementPayment[] = payments
    .filter(
      (payment) =>
        payment.status === 'received' &&
        payment.date <= asOf &&
        ((query.partyId !== undefined && payment.partyId === query.partyId) ||
          matchesCustomer({ customerName: payment.customerName, accountNumber: payment.accountNumber }, query)),
    )
    .map((payment) => {
      const applied = appliedFromSource(applications, 'payment', payment.id, asOf);
      return {
        paymentId: payment.id,
        number: payment.number,
        date: payment.date,
        method: payment.method,
        amount: payment.amountMinor,
        appliedAmount: applied,
        unappliedAmount: payment.amountMinor - applied,
      };
    });

  const byDate = <T extends { date: string; number: string }>(a: T, b: T): number =>
    a.date === b.date ? (a.number < b.number ? -1 : 1) : a.date < b.date ? -1 : 1;
  invoices.sort(byDate);
  credits.sort(byDate);
  statementPayments.sort(byDate);

  const invoiceTotal = invoices.reduce((sum, entry) => sum + entry.currentTotal, 0n);
  const openInvoiceTotal = invoices.reduce((sum, entry) => sum + entry.openAmount, 0n);
  const creditTotal = credits.reduce((sum, entry) => sum + entry.total, 0n);
  const accountCreditTotal = credits
    .filter((entry) => entry.settlement === 'account')
    .reduce((sum, entry) => sum + entry.total, 0n);
  const unappliedCreditTotal =
    credits.reduce((sum, entry) => sum + entry.unappliedAmount, 0n) +
    statementPayments.reduce((sum, entry) => sum + entry.unappliedAmount, 0n);

  return {
    query,
    asOf,
    invoices,
    credits,
    payments: statementPayments,
    invoiceTotal,
    openInvoiceTotal,
    creditTotal,
    accountCreditTotal,
    unappliedCreditTotal,
    balance: openInvoiceTotal - unappliedCreditTotal,
  };
}
