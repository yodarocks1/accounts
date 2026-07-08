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
  /** 'in' = received from a customer; 'out' = paid to a supplier (ADR 0012). */
  readonly direction: 'in' | 'out';
  readonly date: string;
  readonly partyId: string | null;
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
  /** Omit to draw from the payment number sequence (ADR 0010 part 2). */
  number?: string;
  /** Defaults to 'in' (money received); 'out' pays supplier bills (ADR 0012). */
  direction?: 'in' | 'out';
  date: string;
  /** Required unless partyId supplies it. */
  customerName?: string;
  accountNumber?: string;
  partyId?: string;
  poNumber?: string;
  memo?: string;
  method?: string;
  amount: bigint;
  /** Optional immediate applications; the rest stays on account. */
  applications?: NewApplication[];
}

/** A credit source: a payment or an account-settled credit memo / vendor credit. */
export type ApplicationSourceKind = 'payment' | 'credit_memo' | 'vendor_credit';

export interface CreditApplication {
  readonly applicationSeq: number;
  readonly sourceKind: ApplicationSourceKind;
  readonly sourceId: string;
  /** Target: an invoice, sent sales order (deposit), or bill; null for refunds. */
  readonly invoiceId: string | null;
  /** Sales orders only: the specific line this prepays (ADR 0010 part 3). */
  readonly lineId: string | null;
  /** True when this record pays out unapplied credit instead (ADR 0013). */
  readonly refund: boolean;
  readonly amountMinor: bigint;
  readonly date: string;
  readonly at: string;
  /** Set when this record undoes an earlier application. */
  readonly reversesApplicationSeq: number | null;
}

export interface NewApplication {
  invoiceId: string;
  amount: bigint;
  /** Sales orders only: mark this specific line as prepaid (ADR 0010 part 3). */
  lineId?: string;
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

/** Everything drawn from a source: applications plus refunds (ADR 0013). */
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

/** Just the refunded portion of a source (ADR 0013). */
export function refundedFromSource(
  applications: readonly CreditApplication[],
  sourceKind: ApplicationSourceKind,
  sourceId: string,
  asOf?: string,
): bigint {
  let total = 0n;
  for (const application of activeApplications(applications)) {
    if (!application.refund) continue;
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
  source: { customerName: string; accountNumber: string | null; direction: 'in' | 'out' },
): void {
  if (amount <= 0n) {
    throw new LedgerError('INVALID_ALLOCATION', 'Application amounts must be positive');
  }
  // Direction check (ADR 0012): bills are settled by outbound payments;
  // customer documents by inbound credit only.
  if (invoice.type === 'bill' || invoice.type === 'purchase_order') {
    if (source.direction !== 'out') {
      throw new LedgerError('INVALID_DOCUMENT', 'Bills and purchase-order deposits are settled by outbound payments');
    }
  } else if (invoice.type === 'invoice' || invoice.type === 'sales_order') {
    if (source.direction !== 'in') {
      throw new LedgerError('INVALID_DOCUMENT', 'Outbound payments settle bills, not customer documents');
    }
  } else {
    throw new LedgerError('INVALID_DOCUMENT', 'Credit can only be applied to invoices, orders (deposits), or bills');
  }
  if (invoice.status !== 'sent') {
    throw new LedgerError('INVALID_STATUS', 'Credit can only be applied to sent documents');
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

/**
 * Net amount applied to one sales-order line (line-level prepayments,
 * ADR 0010 part 3).
 */
export function appliedToLine(
  applications: readonly CreditApplication[],
  targetId: string,
  lineId: string,
  isSourceActive: (kind: ApplicationSourceKind, id: string) => boolean,
): bigint {
  let total = 0n;
  for (const application of activeApplications(applications)) {
    if (application.invoiceId !== targetId || application.lineId !== lineId) continue;
    if (!isSourceActive(application.sourceKind, application.sourceId)) continue;
    total += application.amountMinor;
  }
  return total;
}
