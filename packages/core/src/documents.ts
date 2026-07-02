import { randomUUID } from 'node:crypto';
import { allocateProportional } from './allocation.js';
import { LedgerError } from './errors.js';
import { currencyExponent } from './money.js';
import { divRoundHalf, QUANTITY_SCALE } from './quantity.js';
import { computeStatement, type AgingRule, type Statement } from './statement.js';
import {
  computeRateSuggestions,
  defaultAllowBelowCost,
  rateMatchesCustomer,
  resolveRatePrice,
  type CustomerRate,
  type NewCustomerRate,
  type SpecialRateSuggestion,
} from './customer-rates.js';
import type { NewParty, Party, PartyName } from './parties.js';
import {
  appliedFromSource,
  appliedToInvoice,
  settle,
  validateApplication,
  type CreditApplication,
  type InvoiceSettlement,
  type NewApplication,
  type NewPayment,
  type Payment,
} from './payments.js';

export const DOCUMENT_TYPES = ['estimate', 'sales_order', 'invoice', 'credit_memo'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type DocumentStatus = 'draft' | 'sent' | 'void';

export type RevisionKind = 'initial' | 'edit' | 'correction' | 'substitution';

export type DocumentTag = 'with corrections' | 'with substitutions';

/** How a credit memo settles (ADR 0006): account credit or money paid back. */
export type SettlementMode = 'account' | 'refund';

/** Allowed conversion targets per source type (ADR 0005). */
export const CONVERSION_TARGETS: Record<DocumentType, readonly DocumentType[]> = {
  estimate: ['sales_order', 'invoice'],
  sales_order: ['invoice'],
  invoice: [],
  credit_memo: [],
};

export interface DocumentLine {
  /** Stable identity across revisions of this document. */
  readonly lineId: string;
  readonly itemId: string | null;
  readonly description: string;
  /** Quantity in thousandths (scale 3). */
  readonly quantityMilli: bigint;
  /** Unit price in minor units, snapshotted when the line was written (ADR 0004). */
  readonly unitPrice: bigint;
  readonly currency: string;
  /**
   * Customer-visible reduction in minor units (≤ 0), allocated by charge
   * corrections (ADR 0005). Customer line amount = face total + adjustment.
   */
  readonly adjustment: bigint;
  /** Free to the customer; recorded at min(cost, sales price) (ADR 0005). */
  readonly free: boolean;
  /** This line substitutes for what its source line promised. */
  readonly substituted: boolean;
  /** Line-level provenance: which document the linked line lives in (ADR 0006). */
  readonly sourceDocumentId: string | null;
  /** Line-level provenance to the source document's line (ADR 0005). */
  readonly sourceLineId: string | null;
}

export interface NewDocumentLine {
  itemId?: string;
  description: string;
  quantityMilli: bigint;
  /** Omit to resolve from the item's price history on the document date. */
  unitPrice?: bigint;
  currency?: string;
  lineId?: string;
  adjustment?: bigint;
  free?: boolean;
  substituted?: boolean;
  sourceDocumentId?: string;
  sourceLineId?: string;
}

export interface DocumentRevision {
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  /** ISO 8601 timestamp the revision was recorded. */
  readonly at: string;
  /** Why the correction/substitution was made; free text. */
  readonly reason: string | null;
  /** Document date (issue date), YYYY-MM-DD. */
  readonly date: string;
  /** Every transaction must carry a customer name (ADR 0006). */
  readonly customerName: string;
  /** Optional customer account number (ADR 0006). */
  readonly accountNumber: string | null;
  /** Optional purchase-order number (ADR 0006). */
  readonly poNumber: string | null;
  /** Payment terms in days (Net N); due date = date + termsDays (ADR 0008). */
  readonly termsDays: number | null;
  readonly memo: string | null;
  readonly lines: readonly DocumentLine[];
}

export interface DocumentRecord {
  readonly id: string;
  readonly type: DocumentType;
  readonly number: string;
  readonly status: DocumentStatus;
  readonly sourceDocumentId: string | null;
  /** Durable customer identity when known (ADR 0008 part 4). */
  readonly partyId: string | null;
  /** Only for credit memos: how the credit settles (ADR 0006). */
  readonly settlement: SettlementMode | null;
  /** Source document's tags snapshotted at creation (ADR 0004). */
  readonly inheritedTags: readonly DocumentTag[];
  readonly revisions: readonly DocumentRevision[];
}

/** Current state of a document: latest revision plus derived tags. */
export interface DocumentView {
  readonly id: string;
  readonly type: DocumentType;
  readonly number: string;
  readonly status: DocumentStatus;
  readonly sourceDocumentId: string | null;
  readonly partyId: string | null;
  readonly current: DocumentRevision;
  readonly tags: readonly DocumentTag[];
  /** e.g. "INV-0001 (with corrections)" */
  readonly label: string;
  /** What the customer owes/paid: free lines at zero, others at face + adjustment. */
  readonly total: bigint;
  /**
   * Per-line amounts as booked: free lines at min(cost, sales price) with all
   * lines scaled so these sum exactly to `total` (ADR 0005). Aligned with
   * `current.lines`.
   */
  readonly recordedLineTotals: readonly bigint[];
  readonly currency: string;
  readonly revisionCount: number;
}

/** Records that a quantity of a line will never be fulfilled (ADR 0005). */
export interface LineClosure {
  readonly closureSeq: number;
  readonly lineId: string;
  readonly kind: 'unfulfilled' | 'substituted';
  readonly quantityMilli: bigint;
  readonly reason: string | null;
  readonly at: string;
}

export interface NewLineClosure {
  lineId: string;
  kind: 'unfulfilled' | 'substituted';
  /** Defaults to the line's full open quantity. */
  quantityMilli?: bigint;
  reason?: string;
}

export interface LineFulfillment {
  readonly lineId: string;
  readonly description: string;
  readonly quantityMilli: bigint;
  readonly convertedMilli: bigint;
  readonly closedMilli: bigint;
  readonly openMilli: bigint;
  readonly status: 'open' | 'partial' | 'fulfilled' | 'closed';
}

/** One line of a conversion request (ADR 0005). */
export interface ConversionLine {
  sourceLineId: string;
  /** Defaults to the source line's full open quantity. */
  quantityMilli?: bigint;
  free?: boolean;
  /** Deliver something else against this source line; price may change or stay. */
  substitution?: {
    itemId?: string;
    description?: string;
    unitPrice?: bigint;
  };
}

export interface ConversionSpec {
  type: DocumentType;
  number: string;
  date: string;
  /** Customer fields inherit from the source document unless overridden. */
  customerName?: string;
  accountNumber?: string;
  poNumber?: string;
  termsDays?: number;
  memo?: string;
  /** Omit to convert every open line in full. */
  lines?: ConversionLine[];
}

export type PriceKind = 'sale' | 'cost';

export interface Item {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

export interface ItemPrice {
  readonly itemId: string;
  readonly kind: PriceKind;
  /** First date (YYYY-MM-DD) this price applies to. */
  readonly effectiveFrom: string;
  readonly unitPrice: bigint;
  /** Monotonic per item; later records win ties on effectiveFrom. */
  readonly priceSeq: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Pure policy & derivation (shared by every storage engine) ─────────────

/**
 * Which revision kind a change to this document must use (ADR 0004).
 * Callers pass the kind they intend (if any); this resolves or rejects it.
 */
export function resolveRevisionKind(
  type: DocumentType,
  status: DocumentStatus,
  requested?: RevisionKind,
): RevisionKind {
  if (status === 'void') {
    throw new LedgerError('DOCUMENT_LOCKED', 'Void documents cannot be changed');
  }
  if (requested === 'initial') {
    throw new LedgerError('INVALID_REVISION_KIND', '"initial" is reserved for document creation');
  }
  if (status === 'draft') {
    if (requested !== undefined && requested !== 'edit') {
      throw new LedgerError('INVALID_REVISION_KIND', `Draft changes are plain edits, not ${requested}s`);
    }
    return 'edit';
  }
  // status === 'sent'
  switch (type) {
    case 'estimate':
      if (requested !== undefined && requested !== 'edit') {
        throw new LedgerError('INVALID_REVISION_KIND', 'Estimates only take plain edits');
      }
      return 'edit';
    case 'invoice':
    case 'credit_memo':
      if (requested !== undefined && requested !== 'correction') {
        throw new LedgerError(
          'INVALID_REVISION_KIND',
          `A sent ${type === 'invoice' ? 'invoice' : 'credit memo'} can only be changed by a correction`,
        );
      }
      return 'correction';
    case 'sales_order':
      if (requested !== 'correction' && requested !== 'substitution') {
        throw new LedgerError(
          'INVALID_REVISION_KIND',
          'Changing a sent sales order requires kind "correction" or "substitution"',
        );
      }
      return requested;
  }
}

/**
 * Tags derive from revision kinds, substituted lines anywhere in history,
 * substitution closures, and inherited tags — never stored as editable state.
 */
export function deriveTags(
  document: Pick<DocumentRecord, 'revisions' | 'inheritedTags'>,
  closures: readonly LineClosure[] = [],
): DocumentTag[] {
  const tags = new Set<DocumentTag>(document.inheritedTags);
  for (const revision of document.revisions) {
    if (revision.kind === 'correction') tags.add('with corrections');
    if (revision.kind === 'substitution') tags.add('with substitutions');
    for (const line of revision.lines) {
      if (line.substituted) tags.add('with substitutions');
    }
  }
  for (const closure of closures) {
    if (closure.kind === 'substituted') tags.add('with substitutions');
  }
  // Stable order: corrections first.
  return (['with corrections', 'with substitutions'] as const).filter((tag) => tags.has(tag));
}

export function documentLabel(number: string, tags: readonly DocumentTag[]): string {
  return tags.length === 0 ? number : `${number} (${tags.join(', ')})`;
}

/** Terms must be a whole, non-negative day count when given. */
export function validateTermsDays(termsDays: number | undefined): number | undefined {
  if (termsDays === undefined) return undefined;
  if (!Number.isInteger(termsDays) || termsDays < 0) {
    throw new LedgerError('INVALID_DOCUMENT', `termsDays must be a non-negative integer; got ${termsDays}`);
  }
  return termsDays;
}

/** date + termsDays, or null when the revision has no terms (ADR 0008). */
export function dueDateOf(revision: Pick<DocumentRevision, 'date' | 'termsDays'>): string | null {
  if (revision.termsDays === null) return null;
  const [year, month, day] = revision.date.split('-').map(Number);
  const due = new Date(Date.UTC(year!, month! - 1, day! + revision.termsDays));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())}`;
}

/** Face amount: quantity × unit price, before adjustments and free handling. */
export function lineTotal(line: Pick<DocumentLine, 'quantityMilli' | 'unitPrice'>): bigint {
  return divRoundHalf(line.quantityMilli * line.unitPrice, QUANTITY_SCALE);
}

/** What the customer sees for this line: zero when free, else face + adjustment. */
export function customerLineTotal(
  line: Pick<DocumentLine, 'quantityMilli' | 'unitPrice' | 'adjustment' | 'free'>,
): bigint {
  return line.free ? 0n : lineTotal(line) + line.adjustment;
}

/** What the customer owes for the revision. */
export function revisionTotal(revision: Pick<DocumentRevision, 'lines'>): bigint {
  let total = 0n;
  for (const line of revision.lines) total += customerLineTotal(line);
  return total;
}

/**
 * Booked per-line amounts (ADR 0005): without free lines these are the
 * customer amounts; with free lines, the free line's face value participates
 * and every line scales down so the sum still equals the customer total.
 * Derived on demand — never stored, so it can't drift.
 */
export function recordedLineTotals(lines: readonly DocumentLine[]): bigint[] {
  const customer = lines.map(customerLineTotal);
  if (!lines.some((line) => line.free)) return customer;
  const face = lines.map((line) => (line.free ? lineTotal(line) : customerLineTotal(line)));
  const target = customer.reduce((sum, amount) => sum + amount, 0n);
  return allocateProportional(face, target);
}

export interface RevisionContent {
  date: string;
  lines: DocumentLine[];
  customerName: string;
  memo?: string;
}

/** Validate revision content; returns the document's single currency. */
export function validateRevisionContent(content: RevisionContent): string {
  if (!ISO_DATE.test(content.date)) {
    throw new LedgerError('INVALID_DOCUMENT', `Document date must be YYYY-MM-DD; got ${JSON.stringify(content.date)}`);
  }
  if (!content.customerName.trim()) {
    throw new LedgerError('INVALID_DOCUMENT', 'Every transaction must carry a customer name (ADR 0006)');
  }
  if (content.lines.length === 0) {
    throw new LedgerError('INVALID_DOCUMENT', 'A document needs at least one line');
  }
  let currency: string | undefined;
  const lineIds = new Set<string>();
  for (const line of content.lines) {
    if (lineIds.has(line.lineId)) {
      throw new LedgerError('INVALID_DOCUMENT', `Duplicate line id: ${line.lineId}`);
    }
    lineIds.add(line.lineId);
    if (!line.description.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Line description must not be empty');
    }
    if (line.quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Line quantities must be positive');
    }
    if (line.unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Unit prices must not be negative');
    }
    if (line.adjustment > 0n) {
      throw new LedgerError('CHARGE_INCREASE', 'Adjustments may only reduce a line, never increase it');
    }
    if (line.free && line.adjustment !== 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Free lines cannot carry adjustments');
    }
    if (!line.free && lineTotal(line) + line.adjustment < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Adjustment cannot push a line below zero');
    }
    currencyExponent(line.currency);
    if (currency === undefined) currency = line.currency;
    else if (currency !== line.currency) {
      throw new LedgerError('CURRENCY_MISMATCH', 'All lines of a document must share one currency');
    }
  }
  return currency!;
}

/** Item lookup used to resolve document lines; DocumentBook and storage engines both implement it. */
export interface ItemCatalog {
  getItem(id: string): Item | undefined;
  /** Latest sales price effective on `date`; later records win ties. Throws if none. */
  priceAt(itemId: string, date: string): bigint;
  /** Latest cost effective on `date`, or undefined if the item has no cost history. */
  costAt(itemId: string, date: string): bigint | undefined;
  /**
   * The customer's standing special rate for the item resolved to a unit
   * price on `date` (below-cost guard applied), or undefined when the
   * customer has no rate for it (ADR 0007).
   */
  customerPriceAt(itemId: string, customer: CustomerQuery, date: string): bigint | undefined;
}

/** Recorded value of a free item line: at cost, or sales price if lower (ADR 0005). */
function freeRecordedUnitPrice(itemId: string, date: string, catalog: ItemCatalog): bigint {
  const sale = catalog.priceAt(itemId, date);
  const cost = catalog.costAt(itemId, date);
  if (cost === undefined) return sale;
  return cost < sale ? cost : sale;
}

/**
 * Resolve incoming lines into full snapshots: prices default to the catalog
 * price effective on the document date and are copied into the line, so later
 * price changes can never reach back into this document (ADR 0004). Line ids
 * default to the same-index line of `previousLines` (carrying identity across
 * revisions) or a fresh id.
 */
export function resolveDocumentLines(
  lines: NewDocumentLine[],
  date: string,
  catalog: ItemCatalog,
  previousLines?: readonly DocumentLine[],
  customer?: CustomerQuery,
): DocumentLine[] {
  return lines.map((line, index) => {
    const previous = previousLines?.[index];
    const item = line.itemId !== undefined ? catalog.getItem(line.itemId) : undefined;
    if (line.itemId !== undefined && !item) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${line.itemId}`);
    }
    const free = line.free ?? previous?.free ?? false;
    let unitPrice: bigint | undefined;
    if (free && item) {
      unitPrice = freeRecordedUnitPrice(item.id, date, catalog);
    } else {
      // Pricing order (ADR 0007): explicit price → customer rate → catalog.
      unitPrice =
        line.unitPrice ??
        (item && customer ? catalog.customerPriceAt(item.id, customer, date) : undefined) ??
        (item ? catalog.priceAt(item.id, date) : undefined);
    }
    if (unitPrice === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'Lines without an item need an explicit unitPrice');
    }
    const currency = line.currency ?? item?.currency;
    if (currency === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'Lines without an item need an explicit currency');
    }
    if (item && currency !== item.currency) {
      throw new LedgerError('CURRENCY_MISMATCH', `Item ${item.name} is priced in ${item.currency}`);
    }
    return {
      lineId: line.lineId ?? previous?.lineId ?? randomUUID(),
      itemId: item?.id ?? null,
      description: line.description,
      quantityMilli: line.quantityMilli,
      unitPrice,
      currency,
      adjustment: line.adjustment ?? 0n,
      free,
      substituted: line.substituted ?? previous?.substituted ?? false,
      sourceDocumentId: line.sourceDocumentId ?? previous?.sourceDocumentId ?? null,
      sourceLineId: line.sourceLineId ?? previous?.sourceLineId ?? null,
    };
  });
}

/**
 * ADR 0006 consumption guard: a revision may not remove a line whose quantity
 * has been consumed downstream (converted or closed), nor shrink it below the
 * consumed amount. Enforced by every storage engine on every change.
 */
export function validateLineConsumption(
  newLines: readonly Pick<DocumentLine, 'lineId' | 'quantityMilli'>[],
  fulfillment: readonly LineFulfillment[],
): void {
  const byId = new Map(newLines.map((line) => [line.lineId, line]));
  for (const state of fulfillment) {
    const consumed = state.convertedMilli + state.closedMilli;
    if (consumed === 0n) continue;
    const line = byId.get(state.lineId);
    if (!line) {
      throw new LedgerError(
        'LINE_LINKED',
        `Line ${state.lineId} (${state.description}) has ${consumed} (milli) converted/closed and cannot be removed; void or close the downstream documents first`,
      );
    }
    if (line.quantityMilli < consumed) {
      throw new LedgerError(
        'LINE_LINKED',
        `Line ${state.lineId} (${state.description}) cannot shrink below its consumed quantity ${consumed} (milli)`,
      );
    }
  }
}

export function viewDocument(
  document: DocumentRecord,
  closures: readonly LineClosure[] = [],
): DocumentView {
  const current = document.revisions[document.revisions.length - 1];
  if (!current) {
    throw new LedgerError('INVALID_DOCUMENT', `Document ${document.id} has no revisions`);
  }
  const tags = deriveTags(document, closures);
  return {
    id: document.id,
    type: document.type,
    number: document.number,
    status: document.status,
    sourceDocumentId: document.sourceDocumentId,
    partyId: document.partyId,
    current,
    tags,
    label: documentLabel(document.number, tags),
    total: revisionTotal(current),
    recordedLineTotals: recordedLineTotals(current.lines),
    currency: current.lines[0]!.currency,
    revisionCount: document.revisions.length,
  };
}

// ── Fulfillment & conversion (pure) ───────────────────────────────────────

/** open = quantity − converted − closed, computed over the current revision. */
export function computeFulfillment(
  record: DocumentRecord,
  convertedByLineId: ReadonlyMap<string, bigint>,
  closures: readonly LineClosure[],
): LineFulfillment[] {
  const closedByLine = new Map<string, bigint>();
  for (const closure of closures) {
    closedByLine.set(closure.lineId, (closedByLine.get(closure.lineId) ?? 0n) + closure.quantityMilli);
  }
  const current = record.revisions[record.revisions.length - 1]!;
  return current.lines.map((line) => {
    const convertedMilli = convertedByLineId.get(line.lineId) ?? 0n;
    const closedMilli = closedByLine.get(line.lineId) ?? 0n;
    let openMilli = line.quantityMilli - convertedMilli - closedMilli;
    if (openMilli < 0n) openMilli = 0n;
    const status: LineFulfillment['status'] =
      openMilli === 0n
        ? closedMilli > 0n
          ? 'closed'
          : 'fulfilled'
        : convertedMilli + closedMilli > 0n
          ? 'partial'
          : 'open';
    return {
      lineId: line.lineId,
      description: line.description,
      quantityMilli: line.quantityMilli,
      convertedMilli,
      closedMilli,
      openMilli,
      status,
    };
  });
}

/**
 * Validate a conversion: allowed type pair, sent source, every linked line
 * exists, and consumed quantities fit within each source line's open balance.
 */
export function validateConversion(
  source: DocumentRecord,
  targetType: DocumentType,
  targetLines: readonly Pick<DocumentLine, 'sourceLineId' | 'quantityMilli'>[],
  fulfillment: readonly LineFulfillment[],
): void {
  if (!CONVERSION_TARGETS[source.type].includes(targetType)) {
    throw new LedgerError(
      'INVALID_CONVERSION',
      `A ${source.type} cannot be converted to a ${targetType}`,
    );
  }
  if (source.status !== 'sent') {
    throw new LedgerError('INVALID_CONVERSION', 'Only sent documents can be converted');
  }
  const open = new Map(fulfillment.map((line) => [line.lineId, line.openMilli]));
  const consumed = new Map<string, bigint>();
  for (const line of targetLines) {
    if (line.sourceLineId === null) continue;
    if (!open.has(line.sourceLineId)) {
      throw new LedgerError('UNKNOWN_LINE', `Source document has no line ${line.sourceLineId}`);
    }
    consumed.set(line.sourceLineId, (consumed.get(line.sourceLineId) ?? 0n) + line.quantityMilli);
  }
  for (const [lineId, quantity] of consumed) {
    const available = open.get(lineId)!;
    if (quantity > available) {
      throw new LedgerError(
        'LINE_OVERDRAWN',
        `Line ${lineId} has ${available} open (milli) but conversion takes ${quantity}`,
      );
    }
  }
}

/** Build target-document lines for a conversion; defaults to all open lines in full. */
export function buildConversionLines(
  source: DocumentRecord,
  fulfillment: readonly LineFulfillment[],
  specs?: readonly ConversionLine[],
): NewDocumentLine[] {
  const current = source.revisions[source.revisions.length - 1]!;
  const linesById = new Map(current.lines.map((line) => [line.lineId, line]));
  const openById = new Map(fulfillment.map((line) => [line.lineId, line.openMilli]));
  const effective =
    specs ??
    fulfillment
      .filter((line) => line.openMilli > 0n)
      .map((line) => ({ sourceLineId: line.lineId }) as ConversionLine);
  if (effective.length === 0) {
    throw new LedgerError('INVALID_CONVERSION', 'Nothing left to convert');
  }
  return effective.map((spec) => {
    const sourceLine = linesById.get(spec.sourceLineId);
    if (!sourceLine) {
      throw new LedgerError('UNKNOWN_LINE', `Source document has no line ${spec.sourceLineId}`);
    }
    const quantityMilli = spec.quantityMilli ?? openById.get(spec.sourceLineId) ?? 0n;
    const substitution = spec.substitution;
    const base: NewDocumentLine = substitution
      ? {
          ...(substitution.itemId !== undefined ? { itemId: substitution.itemId } : {}),
          description: substitution.description ?? sourceLine.description,
          quantityMilli,
          // Substitutions may change the price or keep it (ADR 0005).
          unitPrice: substitution.unitPrice ?? sourceLine.unitPrice,
          currency: sourceLine.currency,
          substituted: true,
        }
      : {
          ...(sourceLine.itemId !== null ? { itemId: sourceLine.itemId } : {}),
          description: sourceLine.description,
          quantityMilli,
          unitPrice: sourceLine.unitPrice,
          currency: sourceLine.currency,
        };
    return {
      ...base,
      sourceDocumentId: source.id,
      sourceLineId: spec.sourceLineId,
      ...(spec.free !== undefined ? { free: spec.free } : {}),
    };
  });
}

// ── Returns & last-purchase lookup (ADR 0006) ─────────────────────────────

export interface CustomerQuery {
  customerName?: string;
  accountNumber?: string;
  /** Durable identity; matches record-level partyId (ADR 0008 part 4). */
  partyId?: string;
}

/** Match a revision's customer: account number when given, else exact name. */
export function matchesCustomer(
  revision: Pick<DocumentRevision, 'customerName' | 'accountNumber'>,
  query: CustomerQuery,
): boolean {
  if (query.accountNumber !== undefined) {
    return revision.accountNumber === query.accountNumber;
  }
  if (query.customerName !== undefined) {
    return revision.customerName === query.customerName;
  }
  return false;
}

/**
 * Party identity wins; free-text matching remains as the fallback for
 * documents recorded before the party existed (ADR 0008 part 4).
 */
export function matchesCustomerOrParty(
  record: Pick<DocumentRecord, 'partyId'>,
  revision: Pick<DocumentRevision, 'customerName' | 'accountNumber'>,
  query: CustomerQuery,
): boolean {
  if (query.partyId !== undefined && record.partyId === query.partyId) return true;
  return matchesCustomer(revision, query);
}

/** The customer-facing per-unit price actually paid on a line (free ⇒ 0). */
export function perUnitCustomerPrice(line: DocumentLine): bigint {
  return divRoundHalf(customerLineTotal(line) * QUANTITY_SCALE, line.quantityMilli);
}

/**
 * Find the price at which this customer last purchased an item on or before
 * `asOf`: the newest sent invoice for the customer whose current revision
 * contains the item (ADR 0006).
 */
export function findLastPurchase(
  invoices: readonly DocumentRecord[],
  itemId: string,
  customer: CustomerQuery,
  asOf: string,
): { record: DocumentRecord; line: DocumentLine } | undefined {
  let best: { record: DocumentRecord; line: DocumentLine } | undefined;
  for (const record of invoices) {
    if (record.type !== 'invoice' || record.status !== 'sent') continue;
    const current = record.revisions[record.revisions.length - 1]!;
    if (current.date > asOf || !matchesCustomerOrParty(record, current, customer)) continue;
    const line = current.lines.find((candidate) => candidate.itemId === itemId);
    if (!line) continue;
    if (!best) {
      best = { record, line };
      continue;
    }
    const bestCurrent = best.record.revisions[best.record.revisions.length - 1]!;
    const bestKey = `${bestCurrent.date}|${best.record.revisions[0]!.at}`;
    const key = `${current.date}|${record.revisions[0]!.at}`;
    if (key > bestKey) best = { record, line };
  }
  return best;
}

export interface ReturnItem {
  itemId: string;
  quantityMilli: bigint;
  /** Override the looked-up price (out-of-band cases). */
  unitPrice?: bigint;
}

export interface NewReturn {
  number: string;
  date: string;
  customerName?: string;
  accountNumber?: string;
  partyId?: string;
  poNumber?: string;
  settlement?: SettlementMode;
  memo?: string;
  items: ReturnItem[];
}

/**
 * Build one credit-memo line for a returned item: priced at the customer's
 * last purchase (or explicit override), linked to that purchase line
 * (ADR 0006). Shared by DocumentBook and storage engines.
 */
export function buildReturnLine(
  item: ReturnItem,
  customer: CustomerQuery,
  asOf: string,
  records: readonly DocumentRecord[],
  catalog: ItemCatalog,
): NewDocumentLine {
  const catalogItem = catalog.getItem(item.itemId);
  if (!catalogItem) {
    throw new LedgerError('UNKNOWN_ITEM', `No such item: ${item.itemId}`);
  }
  if (item.quantityMilli <= 0n) {
    throw new LedgerError('INVALID_QUANTITY', 'Return quantities must be positive');
  }
  const purchase = findLastPurchase(records, item.itemId, customer, asOf);
  if (!purchase && item.unitPrice === undefined) {
    throw new LedgerError(
      'NO_PURCHASE_HISTORY',
      `No purchase of ${catalogItem.name} found for this customer on or before ${asOf}; pass an explicit unitPrice to credit anyway`,
    );
  }
  return {
    itemId: item.itemId,
    description: `${catalogItem.name} (return)`,
    quantityMilli: item.quantityMilli,
    unitPrice: item.unitPrice ?? perUnitCustomerPrice(purchase!.line),
    currency: catalogItem.currency,
    ...(purchase
      ? { sourceDocumentId: purchase.record.id, sourceLineId: purchase.line.lineId }
      : {}),
  };
}

// ── Charge corrections (pure planner) ─────────────────────────────────────

/** Per-line reduction floor: quantity × min(cost, sales price) (ADR 0005). */
function lineReductionFloor(line: DocumentLine, date: string, catalog: ItemCatalog): bigint {
  if (line.itemId === null) return 0n;
  const sale = catalog.priceAt(line.itemId, date);
  const cost = catalog.costAt(line.itemId, date) ?? 0n;
  const floorUnit = cost < sale ? cost : sale;
  return divRoundHalf(line.quantityMilli * floorUnit, QUANTITY_SCALE);
}

/**
 * Plan a "we charged the wrong amount" correction (ADR 0005): reduce every
 * non-free line pro rata so the customer total becomes exactly `actualTotal`,
 * flooring each line at quantity × min(item cost, sales price). Only ever
 * reduces; throws CHARGE_INCREASE otherwise and PRICE_FLOOR if unreachable.
 */
export function planChargeCorrection(
  record: DocumentRecord,
  actualTotal: bigint,
  catalog: ItemCatalog,
): DocumentLine[] {
  if (record.type !== 'invoice') {
    throw new LedgerError('INVALID_DOCUMENT', 'Charge corrections apply to invoices');
  }
  const current = record.revisions[record.revisions.length - 1]!;
  const customerTotals = current.lines.map(customerLineTotal);
  const total = customerTotals.reduce((sum, amount) => sum + amount, 0n);
  if (actualTotal >= total) {
    throw new LedgerError(
      'CHARGE_INCREASE',
      `Charge corrections only reduce: actual ${actualTotal} must be below current total ${total}`,
    );
  }
  if (actualTotal < 0n) {
    throw new LedgerError('INVALID_ALLOCATION', 'Actual total must not be negative');
  }
  const billableIndices = current.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.free);
  const faces = billableIndices.map(({ index }) => customerTotals[index]!);
  const floors = billableIndices.map(({ line }) => lineReductionFloor(line, current.date, catalog));
  const allocated = allocateProportional(faces, actualTotal, floors);
  const newLines = current.lines.map((line) => ({ ...line }));
  billableIndices.forEach(({ line, index }, position) => {
    newLines[index] = { ...line, adjustment: allocated[position]! - lineTotal(line) };
  });
  return newLines;
}

// ── In-memory reference implementation ────────────────────────────────────

export interface NewDocument {
  type: DocumentType;
  number: string;
  date: string;
  lines: NewDocumentLine[];
  /** Required unless partyId supplies it. */
  customerName?: string;
  accountNumber?: string;
  poNumber?: string;
  /** Payment terms in days (Net N); defaults from the party when linked. */
  termsDays?: number;
  /** Link to the durable customer record; supplies name/account/terms defaults. */
  partyId?: string;
  memo?: string;
  sourceDocumentId?: string;
  /** Credit memos only: defaults to 'account'. */
  settlement?: SettlementMode;
}

export interface DocumentChanges {
  kind?: RevisionKind;
  reason?: string;
  date?: string;
  lines?: NewDocumentLine[];
  customerName?: string;
  accountNumber?: string;
  poNumber?: string;
  termsDays?: number;
  memo?: string;
}

export interface NewItem {
  name: string;
  currency: string;
  unitPrice: bigint;
  cost?: bigint;
  /** Defaults to the beginning of time. */
  effectiveFrom?: string;
}

/**
 * In-memory reference for items, price/cost history, and revisioned
 * documents — the conformance oracle for storage engines.
 */
export class DocumentBook implements ItemCatalog {
  private readonly items = new Map<string, Item>();
  private readonly prices = new Map<string, ItemPrice[]>();
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly closures = new Map<string, LineClosure[]>();
  private readonly numbers = new Set<string>();
  private readonly rates: CustomerRate[] = [];
  private readonly payments = new Map<string, Payment>();
  private readonly applications: CreditApplication[] = [];
  private readonly parties = new Map<string, Party>();
  private readonly partyNames = new Map<string, PartyName[]>();

  // ── Parties (ADR 0008 part 4) ─────────────────────────────────────────

  createParty(input: NewParty, id: string = randomUUID(), at?: string): Party {
    if (!input.name.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Party name must not be empty');
    }
    if (
      input.accountNumber !== undefined &&
      [...this.parties.values()].some((party) => party.accountNumber === input.accountNumber)
    ) {
      throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Account number already in use: ${input.accountNumber}`);
    }
    const party: Party = {
      id,
      name: input.name.trim(),
      accountNumber: input.accountNumber ?? null,
      termsDays: validateTermsDays(input.termsDays) ?? null,
      createdAt: at ?? new Date().toISOString(),
    };
    this.parties.set(id, party);
    this.partyNames.set(id, [{ nameSeq: 1, name: party.name, at: party.createdAt }]);
    return party;
  }

  /** Renames are events: history is kept, documents keep their snapshots. */
  renameParty(id: string, name: string, at?: string): Party {
    const party = this.requireParty(id);
    if (!name.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Party name must not be empty');
    }
    const history = this.partyNames.get(id)!;
    history.push({ nameSeq: history.length + 1, name: name.trim(), at: at ?? new Date().toISOString() });
    const renamed: Party = { ...party, name: name.trim() };
    this.parties.set(id, renamed);
    return renamed;
  }

  getParty(id: string): Party | undefined {
    return this.parties.get(id);
  }

  partyNameHistory(id: string): readonly PartyName[] {
    return this.partyNames.get(id) ?? [];
  }

  findPartyByAccountNumber(accountNumber: string): Party | undefined {
    return [...this.parties.values()].find((party) => party.accountNumber === accountNumber);
  }

  private requireParty(id: string): Party {
    const party = this.parties.get(id);
    if (!party) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such party: ${id}`);
    }
    return party;
  }

  /** Effective customer fields: explicit values win, party supplies defaults. */
  private resolveCustomer(input: {
    partyId?: string;
    customerName?: string;
    accountNumber?: string;
    termsDays?: number;
  }): { partyId: string | null; customerName: string; accountNumber?: string; termsDays?: number } {
    const party = input.partyId !== undefined ? this.requireParty(input.partyId) : undefined;
    const customerName = input.customerName ?? party?.name;
    if (customerName === undefined || !customerName.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Every transaction must carry a customer name (ADR 0006)');
    }
    const accountNumber = input.accountNumber ?? party?.accountNumber ?? undefined;
    const termsDays = validateTermsDays(input.termsDays) ?? party?.termsDays ?? undefined;
    return {
      partyId: party?.id ?? null,
      customerName: customerName.trim(),
      ...(accountNumber !== undefined ? { accountNumber } : {}),
      ...(termsDays !== undefined ? { termsDays } : {}),
    };
  }

  // ── Items & price history ─────────────────────────────────────────────

  createItem(input: NewItem, id: string = randomUUID()): Item {
    if (!input.name.trim()) {
      throw new LedgerError('UNKNOWN_ITEM', 'Item name must not be empty');
    }
    currencyExponent(input.currency);
    const item: Item = { id, name: input.name.trim(), currency: input.currency };
    this.items.set(id, item);
    this.prices.set(id, []);
    this.setPrice(id, input.unitPrice, input.effectiveFrom ?? '0000-01-01');
    if (input.cost !== undefined) {
      this.setCost(id, input.cost, input.effectiveFrom ?? '0000-01-01');
    }
    return item;
  }

  getItem(id: string): Item | undefined {
    return this.items.get(id);
  }

  /**
   * Append a price record. Never touches existing documents: prices are
   * snapshotted into lines when lines are written (ADR 0004).
   */
  setPrice(itemId: string, unitPrice: bigint, effectiveFrom: string): ItemPrice {
    return this.appendPrice(itemId, 'sale', unitPrice, effectiveFrom);
  }

  /** Append a cost record (same append-only rules as sales prices). */
  setCost(itemId: string, unitCost: bigint, effectiveFrom: string): ItemPrice {
    return this.appendPrice(itemId, 'cost', unitCost, effectiveFrom);
  }

  private appendPrice(
    itemId: string,
    kind: PriceKind,
    unitPrice: bigint,
    effectiveFrom: string,
  ): ItemPrice {
    const history = this.prices.get(itemId);
    if (!history) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (!ISO_DATE.test(effectiveFrom) && effectiveFrom !== '0000-01-01') {
      throw new LedgerError('INVALID_DOCUMENT', `effectiveFrom must be YYYY-MM-DD; got ${JSON.stringify(effectiveFrom)}`);
    }
    if (unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Prices must not be negative');
    }
    const price: ItemPrice = { itemId, kind, effectiveFrom, unitPrice, priceSeq: history.length + 1 };
    history.push(price);
    return price;
  }

  /** Latest sales price effective on `date`; later records win ties. */
  priceAt(itemId: string, date: string): bigint {
    const price = this.lookupPrice(itemId, 'sale', date);
    if (price === undefined) {
      throw new LedgerError('UNKNOWN_ITEM', `Item ${itemId} has no price effective on ${date}`);
    }
    return price;
  }

  costAt(itemId: string, date: string): bigint | undefined {
    return this.lookupPrice(itemId, 'cost', date);
  }

  private lookupPrice(itemId: string, kind: PriceKind, date: string): bigint | undefined {
    const history = this.prices.get(itemId);
    if (!history) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    let best: ItemPrice | undefined;
    for (const price of history) {
      if (price.kind !== kind || price.effectiveFrom > date) continue;
      if (
        !best ||
        price.effectiveFrom > best.effectiveFrom ||
        (price.effectiveFrom === best.effectiveFrom && price.priceSeq > best.priceSeq)
      ) {
        best = price;
      }
    }
    return best?.unitPrice;
  }

  priceHistory(itemId: string): readonly ItemPrice[] {
    return this.prices.get(itemId) ?? [];
  }

  // ── Customer special rates (ADR 0007) ─────────────────────────────────

  /** Persist a standing special rate — the "yes" answer to a suggestion. */
  setCustomerRate(input: NewCustomerRate, at?: string): CustomerRate {
    if (!this.items.has(input.itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${input.itemId}`);
    }
    if (input.customerName === undefined && input.accountNumber === undefined && input.partyId === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'A rate needs a party, customer name, or account number');
    }
    if (input.partyId !== undefined) this.requireParty(input.partyId);
    const effectiveFrom = input.effectiveFrom ?? '0000-01-01';
    // The below-cost default judges the item as of the rate's effective date;
    // for an open-ended rate, judge it by the latest known price and cost.
    const evalDate = input.effectiveFrom ?? '9999-12-31';
    const salePrice = this.priceAt(input.itemId, evalDate);
    const cost = this.costAt(input.itemId, evalDate);
    if (input.rate.kind === 'formula' && input.rate.base === 'cost' && cost === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'Cost-based rate requires cost history for the item');
    }
    if (input.rate.kind === 'constant' && input.rate.unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Rates must not be negative');
    }
    const rate: CustomerRate = {
      rateSeq: this.rates.length + 1,
      itemId: input.itemId,
      partyId: input.partyId ?? null,
      customerName: input.customerName ?? null,
      accountNumber: input.accountNumber ?? null,
      kind: input.rate.kind,
      unitPrice: input.rate.kind === 'constant' ? input.rate.unitPrice : null,
      base: input.rate.kind === 'formula' ? input.rate.base : null,
      percentMilli: input.rate.kind === 'formula' ? (input.rate.percentMilli ?? 0n) : 0n,
      amountMinor: input.rate.kind === 'formula' ? (input.rate.amountMinor ?? 0n) : 0n,
      allowBelowCost: input.allowBelowCost ?? defaultAllowBelowCost(salePrice, cost),
      effectiveFrom,
      at: at ?? new Date().toISOString(),
    };
    this.rates.push(rate);
    return rate;
  }

  /** Latest rate for (item, customer) effective on `date`; later records win. */
  customerRateAt(itemId: string, customer: CustomerQuery, date: string): CustomerRate | undefined {
    let best: CustomerRate | undefined;
    for (const rate of this.rates) {
      if (rate.itemId !== itemId || rate.effectiveFrom > date) continue;
      if (!rateMatchesCustomer(rate, customer)) continue;
      if (
        !best ||
        rate.effectiveFrom > best.effectiveFrom ||
        (rate.effectiveFrom === best.effectiveFrom && rate.rateSeq > best.rateSeq)
      ) {
        best = rate;
      }
    }
    return best;
  }

  customerPriceAt(itemId: string, customer: CustomerQuery, date: string): bigint | undefined {
    const rate = this.customerRateAt(itemId, customer, date);
    if (!rate) return undefined;
    return resolveRatePrice(rate, this.priceAt(itemId, date), this.costAt(itemId, date));
  }

  /** "Should this special rate persist?" questions for a document (call after send). */
  suggestSpecialRates(documentId: string): SpecialRateSuggestion[] {
    return computeRateSuggestions(this.requireDocument(documentId), this);
  }

  // ── Documents ─────────────────────────────────────────────────────────

  private resolveLines(
    lines: NewDocumentLine[],
    date: string,
    previousLines?: readonly DocumentLine[],
    customer?: CustomerQuery,
  ): DocumentLine[] {
    return resolveDocumentLines(lines, date, this, previousLines, customer);
  }

  createDocument(input: NewDocument, id: string = randomUUID(), at?: string): DocumentView {
    if (!DOCUMENT_TYPES.includes(input.type)) {
      throw new LedgerError('INVALID_DOCUMENT', `Invalid document type: ${String(input.type)}`);
    }
    const numberKey = `${input.type}:${input.number}`;
    if (!input.number.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Document number must not be empty');
    }
    if (this.numbers.has(numberKey)) {
      throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Number already in use: ${input.number}`);
    }
    if (input.settlement !== undefined && input.type !== 'credit_memo') {
      throw new LedgerError('INVALID_DOCUMENT', 'Only credit memos take a settlement mode');
    }
    const customer = this.resolveCustomer(input);
    const lines = this.resolveLines(input.lines, input.date, undefined, {
      customerName: customer.customerName,
      ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
      ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
    });
    let inheritedTags: readonly DocumentTag[] = [];
    if (input.sourceDocumentId !== undefined) {
      const source = this.documents.get(input.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${input.sourceDocumentId}`);
      }
      validateConversion(source, input.type, lines, this.fulfillment(source.id));
      inheritedTags = deriveTags(source, this.closures.get(source.id) ?? []);
    }
    validateRevisionContent({ date: input.date, lines, customerName: customer.customerName });
    const document: DocumentRecord = {
      id,
      type: input.type,
      number: input.number.trim(),
      status: 'draft',
      sourceDocumentId: input.sourceDocumentId ?? null,
      partyId: customer.partyId,
      settlement: input.type === 'credit_memo' ? (input.settlement ?? 'account') : null,
      inheritedTags,
      revisions: [
        {
          revisionNo: 1,
          kind: 'initial',
          at: at ?? new Date().toISOString(),
          reason: null,
          date: input.date,
          customerName: customer.customerName,
          accountNumber: customer.accountNumber ?? null,
          poNumber: input.poNumber ?? null,
          termsDays: customer.termsDays ?? null,
          memo: input.memo ?? null,
          lines,
        },
      ],
    };
    this.documents.set(id, document);
    this.numbers.add(numberKey);
    return this.view(id);
  }

  /**
   * Change a document. Sent invoices only accept corrections; sent sales
   * orders require an explicit correction/substitution; estimates are always
   * editable. Every change is a new immutable revision (ADR 0004).
   */
  changeDocument(id: string, changes: DocumentChanges, at?: string): DocumentView {
    const document = this.requireDocument(id);
    const kind = resolveRevisionKind(document.type, document.status, changes.kind);
    const previous = document.revisions[document.revisions.length - 1]!;
    const date = changes.date ?? previous.date;
    const customerName = changes.customerName ?? previous.customerName;
    const accountNumber = changes.accountNumber ?? previous.accountNumber;
    const lines =
      changes.lines !== undefined
        ? this.resolveLines(changes.lines, date, previous.lines, {
            customerName,
            ...(accountNumber !== null ? { accountNumber } : {}),
            ...(document.partyId !== null ? { partyId: document.partyId } : {}),
          })
        : [...previous.lines];
    validateRevisionContent({ date, lines, customerName });
    // ADR 0006: never orphan downstream links or over-consume a shrunk line.
    validateLineConsumption(lines, this.fulfillment(id));
    this.appendRevision(document, {
      revisionNo: previous.revisionNo + 1,
      kind,
      at: at ?? new Date().toISOString(),
      reason: changes.reason ?? null,
      date,
      customerName,
      accountNumber: changes.accountNumber ?? previous.accountNumber,
      poNumber: changes.poNumber ?? previous.poNumber,
      termsDays: validateTermsDays(changes.termsDays) ?? previous.termsDays,
      memo: changes.memo ?? previous.memo,
      lines,
    });
    return this.view(id);
  }

  /**
   * "We accidentally charged the wrong amount": reduce the customer total of
   * a sent invoice to `actualTotal`, pro rata with cost floors (ADR 0005).
   */
  chargeCorrection(id: string, actualTotal: bigint, reason?: string, at?: string): DocumentView {
    const document = this.requireDocument(id);
    const kind = resolveRevisionKind(document.type, document.status, 'correction');
    const lines = planChargeCorrection(document, actualTotal, this);
    const previous = document.revisions[document.revisions.length - 1]!;
    this.appendRevision(document, {
      revisionNo: previous.revisionNo + 1,
      kind,
      at: at ?? new Date().toISOString(),
      reason: reason ?? `Charged amount corrected to ${actualTotal}`,
      date: previous.date,
      customerName: previous.customerName,
      accountNumber: previous.accountNumber,
      poNumber: previous.poNumber,
      termsDays: previous.termsDays,
      memo: previous.memo,
      lines,
    });
    return this.view(id);
  }

  /** Convert a sent document (partially) into a new linked document (ADR 0005). */
  convertDocument(sourceId: string, spec: ConversionSpec, id?: string, at?: string): DocumentView {
    const source = this.requireDocument(sourceId);
    const lines = buildConversionLines(source, this.fulfillment(sourceId), spec.lines);
    const previous = source.revisions[source.revisions.length - 1]!;
    return this.createDocument(
      {
        type: spec.type,
        number: spec.number,
        date: spec.date,
        lines,
        sourceDocumentId: sourceId,
        ...(source.partyId !== null ? { partyId: source.partyId } : {}),
        customerName: spec.customerName ?? previous.customerName,
        ...((spec.accountNumber ?? previous.accountNumber) !== null
          ? { accountNumber: (spec.accountNumber ?? previous.accountNumber)! }
          : {}),
        ...((spec.poNumber ?? previous.poNumber) !== null
          ? { poNumber: (spec.poNumber ?? previous.poNumber)! }
          : {}),
        ...((spec.termsDays ?? previous.termsDays) !== null
          ? { termsDays: (spec.termsDays ?? previous.termsDays)! }
          : {}),
        ...(spec.memo !== undefined ? { memo: spec.memo } : {}),
      },
      id,
      at,
    );
  }

  /**
   * Record a return: each item is credited at the price this customer last
   * paid for it, with line-level links back to that purchase (ADR 0006).
   */
  createReturn(input: NewReturn, id?: string, at?: string): DocumentView {
    const customer = this.resolveCustomer(input);
    const query: CustomerQuery = {
      customerName: customer.customerName,
      ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
      ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
    };
    const invoices = [...this.documents.values()];
    const lines = input.items.map((item) =>
      buildReturnLine(item, query, input.date, invoices, this),
    );
    return this.createDocument(
      {
        type: 'credit_memo',
        number: input.number,
        date: input.date,
        lines,
        customerName: customer.customerName,
        ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
        ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
        ...(input.poNumber !== undefined ? { poNumber: input.poNumber } : {}),
        ...(input.settlement !== undefined ? { settlement: input.settlement } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
      },
      id,
      at,
    );
  }

  /** Statement resolved through the party's identity, with free-text fallback. */
  statementForParty(partyId: string, asOf: string, rules?: readonly AgingRule[]): Statement {
    const party = this.requireParty(partyId);
    return this.statement(
      {
        partyId,
        customerName: party.name,
        ...(party.accountNumber !== null ? { accountNumber: party.accountNumber } : {}),
      },
      asOf,
      rules,
    );
  }

  /** Compute a customer statement as of a date (ADR 0006). */
  statement(query: CustomerQuery, asOf: string, rules?: readonly AgingRule[]): Statement {
    const pairs = [...this.documents.values()].map((record) => ({
      record,
      closures: this.closures.get(record.id) ?? [],
    }));
    return computeStatement(
      pairs,
      [...this.payments.values()],
      this.applications,
      query,
      asOf,
      rules,
    );
  }

  // ── Payments & credit application (Tier 1, ADR 0008) ──────────────────

  /** Record money received; optionally apply it to invoices immediately. */
  recordPayment(input: NewPayment, id: string = randomUUID()): Payment {
    if (input.amount <= 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Payment amounts must be positive');
    }
    const customer = this.resolveCustomer(input);
    if ([...this.payments.values()].some((payment) => payment.number === input.number)) {
      throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Payment number already in use: ${input.number}`);
    }
    const payment: Payment = {
      id,
      number: input.number,
      date: input.date,
      partyId: customer.partyId,
      customerName: customer.customerName,
      accountNumber: customer.accountNumber ?? null,
      poNumber: input.poNumber ?? null,
      memo: input.memo ?? null,
      method: input.method ?? null,
      amountMinor: input.amount,
      status: 'received',
    };
    this.payments.set(id, payment);
    for (const application of input.applications ?? []) {
      this.applyCredit({ sourceKind: 'payment', sourceId: id, ...application }, input.date);
    }
    return payment;
  }

  getPayment(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  voidPayment(id: string): Payment {
    const payment = this.payments.get(id);
    if (!payment) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such payment: ${id}`);
    }
    if (payment.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Payment is already void');
    }
    const voided: Payment = { ...payment, status: 'void' };
    this.payments.set(id, voided);
    return voided;
  }

  private isSourceActive(kind: CreditApplication['sourceKind'], id: string): boolean {
    if (kind === 'payment') {
      return this.payments.get(id)?.status === 'received';
    }
    const record = this.documents.get(id);
    return record?.type === 'credit_memo' && record.status === 'sent' && record.settlement === 'account';
  }

  private sourceState(kind: CreditApplication['sourceKind'], id: string): {
    customerName: string;
    accountNumber: string | null;
    total: bigint;
  } {
    if (kind === 'payment') {
      const payment = this.payments.get(id);
      if (!payment) throw new LedgerError('UNKNOWN_DOCUMENT', `No such payment: ${id}`);
      if (payment.status !== 'received') {
        throw new LedgerError('INVALID_STATUS', 'Void payments cannot be applied');
      }
      return { customerName: payment.customerName, accountNumber: payment.accountNumber, total: payment.amountMinor };
    }
    const record = this.documents.get(id);
    if (!record || record.type !== 'credit_memo') {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such credit memo: ${id}`);
    }
    if (record.status !== 'sent') {
      throw new LedgerError('INVALID_STATUS', 'Only sent credit memos can be applied');
    }
    if (record.settlement !== 'account') {
      throw new LedgerError('INVALID_DOCUMENT', 'Refund credit memos were paid out and cannot be applied');
    }
    const current = record.revisions[record.revisions.length - 1]!;
    return {
      customerName: current.customerName,
      accountNumber: current.accountNumber,
      total: revisionTotal(current),
    };
  }

  /** Apply credit from a payment or account credit memo against an invoice. */
  applyCredit(
    input: { sourceKind: CreditApplication['sourceKind']; sourceId: string } & NewApplication,
    date?: string,
    at?: string,
  ): CreditApplication {
    const source = this.sourceState(input.sourceKind, input.sourceId);
    const invoice = this.requireDocument(input.invoiceId);
    const remaining =
      source.total - appliedFromSource(this.applications, input.sourceKind, input.sourceId);
    const settlement = this.invoiceSettlement(input.invoiceId);
    validateApplication(input.amount, remaining, invoice, settlement.open, source);
    const application: CreditApplication = {
      applicationSeq: this.applications.length + 1,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      invoiceId: input.invoiceId,
      amountMinor: input.amount,
      date: date ?? invoice.revisions[invoice.revisions.length - 1]!.date,
      at: at ?? new Date().toISOString(),
      reversesApplicationSeq: null,
    };
    this.applications.push(application);
    return application;
  }

  /** Undo an application (appends a reversal record; nothing is edited). */
  reverseApplication(applicationSeq: number, at?: string): CreditApplication {
    const target = this.applications.find((application) => application.applicationSeq === applicationSeq);
    if (!target || target.reversesApplicationSeq !== null) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such application: ${applicationSeq}`);
    }
    if (this.applications.some((application) => application.reversesApplicationSeq === applicationSeq)) {
      throw new LedgerError('ALREADY_REVERSED', `Application already reversed: ${applicationSeq}`);
    }
    const reversal: CreditApplication = {
      applicationSeq: this.applications.length + 1,
      sourceKind: target.sourceKind,
      sourceId: target.sourceId,
      invoiceId: target.invoiceId,
      amountMinor: target.amountMinor,
      date: target.date,
      at: at ?? new Date().toISOString(),
      reversesApplicationSeq: applicationSeq,
    };
    this.applications.push(reversal);
    return reversal;
  }

  /** Derived paid/open state of an invoice — never stored (Tier 1). */
  invoiceSettlement(invoiceId: string, asOf?: string): InvoiceSettlement {
    const invoice = this.requireDocument(invoiceId);
    const current = invoice.revisions[invoice.revisions.length - 1]!;
    const paid = appliedToInvoice(
      this.applications,
      invoiceId,
      (kind, id) => this.isSourceActive(kind, id),
      asOf,
    );
    return settle(revisionTotal(current), paid);
  }

  listApplications(): readonly CreditApplication[] {
    return this.applications;
  }

  /** Explicitly close (part of) a line without fulfilling it (ADR 0005). */
  closeLine(documentId: string, input: NewLineClosure, at?: string): LineClosure {
    const document = this.requireDocument(documentId);
    if (document.status !== 'sent') {
      throw new LedgerError('INVALID_STATUS', 'Only lines of sent documents can be closed');
    }
    const fulfillment = this.fulfillment(documentId);
    const line = fulfillment.find((entry) => entry.lineId === input.lineId);
    if (!line) {
      throw new LedgerError('UNKNOWN_LINE', `No such line: ${input.lineId}`);
    }
    const quantityMilli = input.quantityMilli ?? line.openMilli;
    if (quantityMilli <= 0n || quantityMilli > line.openMilli) {
      throw new LedgerError(
        'LINE_OVERDRAWN',
        `Cannot close ${quantityMilli} (milli); line has ${line.openMilli} open`,
      );
    }
    const existing = this.closures.get(documentId) ?? [];
    const closure: LineClosure = {
      closureSeq: existing.length + 1,
      lineId: input.lineId,
      kind: input.kind,
      quantityMilli,
      reason: input.reason ?? null,
      at: at ?? new Date().toISOString(),
    };
    this.closures.set(documentId, [...existing, closure]);
    return closure;
  }

  /** Per-line open/converted/closed state, derived from links and closures. */
  fulfillment(documentId: string): LineFulfillment[] {
    const document = this.requireDocument(documentId);
    const converted = new Map<string, bigint>();
    for (const other of this.documents.values()) {
      if (other.sourceDocumentId !== documentId || other.status === 'void') continue;
      const current = other.revisions[other.revisions.length - 1]!;
      for (const line of current.lines) {
        if (line.sourceLineId === null) continue;
        converted.set(line.sourceLineId, (converted.get(line.sourceLineId) ?? 0n) + line.quantityMilli);
      }
    }
    return computeFulfillment(document, converted, this.closures.get(documentId) ?? []);
  }

  lineClosures(documentId: string): readonly LineClosure[] {
    return this.closures.get(documentId) ?? [];
  }

  sendDocument(id: string): DocumentView {
    const document = this.requireDocument(id);
    if (document.status !== 'draft') {
      throw new LedgerError('INVALID_STATUS', `Only draft documents can be sent (is ${document.status})`);
    }
    this.documents.set(id, { ...document, status: 'sent' });
    return this.view(id);
  }

  voidDocument(id: string): DocumentView {
    const document = this.requireDocument(id);
    if (document.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Document is already void');
    }
    this.documents.set(id, { ...document, status: 'void' });
    return this.view(id);
  }

  getDocument(id: string): DocumentRecord | undefined {
    return this.documents.get(id);
  }

  view(id: string): DocumentView {
    return viewDocument(this.requireDocument(id), this.closures.get(id) ?? []);
  }

  history(id: string): readonly DocumentRevision[] {
    return this.requireDocument(id).revisions;
  }

  listDocuments(type?: DocumentType): DocumentView[] {
    return [...this.documents.values()]
      .filter((document) => type === undefined || document.type === type)
      .map((document) => this.view(document.id));
  }

  private appendRevision(document: DocumentRecord, revision: DocumentRevision): void {
    this.documents.set(document.id, {
      ...document,
      revisions: [...document.revisions, revision],
    });
  }

  private requireDocument(id: string): DocumentRecord {
    const document = this.documents.get(id);
    if (!document) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such document: ${id}`);
    }
    return document;
  }
}
