import { LedgerError } from './errors.js';
import type { DocumentRecord, DocumentRevision } from './documents.js';

/**
 * Payment application (ADR 0008 / Tier 1): money received from a customer,
 * applied against specific invoices. What isn't applied stays on account.
 * Payments are immutable once recorded; mistakes are voided or their
 * applications reversed — never edited.
 */
export interface Payment {
  readonly id: string;
  readonly number: string;
  readonly date: string;
  readonly customerName: string;
  readonly accountNumber: string | null;
  readonly poNumber: string | null;
  readonly memo: string | null;
  /** Free text: "check #1042", "VISA …9921", … */
  readonly method: string | null;
  readonly amountMinor: bigint;
  readonly status: 'received' | 'void';
}

export interface NewPayment {
  number: string;
  date: string;
  customerName: string;
  accountNumber?: string;
  poNumber?: string;
  memo?: string;
  method?: string;
  amount: bigint;
  /** Optional immediate applications; the rest stays on account. */
  applications?: NewApplication[];
}

/** A credit source: a received payment or an account-settled credit memo. */
export type ApplicationSourceKind = 'payment' | 'credit_memo';

export interface CreditApplication {
  readonly applicationSeq: number;
  readonly sourceKind: ApplicationSourceKind;
  readonly sourceId: string;
  readonly invoiceId: string;
  readonly amountMinor: bigint;
  readonly date: string;
  readonly at: string;
  /** Set when this record undoes an earlier application. */
  readonly reversesApplicationSeq: number | null;
}

export interface NewApplication {
  invoiceId: string;
  amount: bigint;
}

/** Active (non-reversed) applications only. */
export function activeApplications(applications: readonly CreditApplication[]): CreditApplication[] {
  const reversed = new Set(
    applications
      .map((application) => application.reversesApplicationSeq)
      .filter((seq): seq is number => seq !== null),
  );
  return applications.filter(
    (application) => application.reversesApplicationSeq === null && !reversed.has(application.applicationSeq),
  );
}

export function appliedFromSource(
  applications: readonly CreditApplication[],
  sourceKind: ApplicationSourceKind,
  sourceId: string,
  asOf?: string,
): bigint {
  let total = 0n;
  for (const application of activeApplications(applications)) {
    if (application.sourceKind !== sourceKind || application.sourceId !== sourceId) continue;
    if (asOf !== undefined && application.date > asOf) continue;
    total += application.amountMinor;
  }
  return total;
}

export function appliedToInvoice(
  applications: readonly CreditApplication[],
  invoiceId: string,
  isSourceActive: (kind: ApplicationSourceKind, id: string) => boolean,
  asOf?: string,
): bigint {
  let total = 0n;
  for (const application of activeApplications(applications)) {
    if (application.invoiceId !== invoiceId) continue;
    if (asOf !== undefined && application.date > asOf) continue;
    if (!isSourceActive(application.sourceKind, application.sourceId)) continue;
    total += application.amountMinor;
  }
  return total;
}

export interface InvoiceSettlement {
  readonly total: bigint;
  readonly paid: bigint;
  /** max(0, total − paid). */
  readonly open: bigint;
  /** max(0, paid − total) — e.g. after a charge correction reduced the total. */
  readonly overpaid: bigint;
  readonly status: 'open' | 'partial' | 'paid' | 'overpaid';
}

export function settle(total: bigint, paid: bigint): InvoiceSettlement {
  const open = total > paid ? total - paid : 0n;
  const overpaid = paid > total ? paid - total : 0n;
  const status: InvoiceSettlement['status'] =
    overpaid > 0n ? 'overpaid' : open === 0n ? 'paid' : paid > 0n ? 'partial' : 'open';
  return { total, paid, open, overpaid, status };
}

/** Do a credit source and an invoice belong to the same customer? */
export function sameCustomer(
  a: { customerName: string; accountNumber: string | null },
  b: Pick<DocumentRevision, 'customerName' | 'accountNumber'>,
): boolean {
  if (a.accountNumber !== null && b.accountNumber !== null) {
    return a.accountNumber === b.accountNumber;
  }
  return a.customerName === b.customerName;
}

/**
 * Validate one application against source and invoice state. `sourceRemaining`
 * is the source's amount minus what it has already applied.
 */
export function validateApplication(
  amount: bigint,
  sourceRemaining: bigint,
  invoice: DocumentRecord,
  invoiceOpen: bigint,
  source: { customerName: string; accountNumber: string | null },
): void {
  if (amount <= 0n) {
    throw new LedgerError('INVALID_ALLOCATION', 'Application amounts must be positive');
  }
  if (invoice.type !== 'invoice') {
    throw new LedgerError('INVALID_DOCUMENT', 'Credit can only be applied to invoices');
  }
  if (invoice.status !== 'sent') {
    throw new LedgerError('INVALID_STATUS', 'Credit can only be applied to sent invoices');
  }
  const current = invoice.revisions[invoice.revisions.length - 1]!;
  if (!sameCustomer(source, current)) {
    throw new LedgerError('INVALID_DOCUMENT', 'Credit and invoice belong to different customers');
  }
  if (amount > sourceRemaining) {
    throw new LedgerError(
      'INVALID_ALLOCATION',
      `Application of ${amount} exceeds the source's remaining ${sourceRemaining}`,
    );
  }
  if (amount > invoiceOpen) {
    throw new LedgerError(
      'INVALID_ALLOCATION',
      `Application of ${amount} exceeds the invoice's open balance ${invoiceOpen}; the remainder stays on account`,
    );
  }
}
