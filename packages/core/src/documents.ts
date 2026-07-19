import { randomUUID } from './ids.js';
import { allocateProportional } from './allocation.js';
import { computeDocumentLinks, type DocumentLinks } from './links.js';
import { LedgerError } from './errors.js';
import { currencyExponent } from './money.js';
import { divRoundHalf, PERCENT_SCALE, QUANTITY_SCALE } from './quantity.js';
import { computeStatement, daysBetween, type AgingRule, type Statement } from './statement.js';
import { computeAgingSummary, type AgingSummary, type InventorySummary } from './reports.js';
import {
  computeRateReview,
  computeRateSuggestions,
  defaultAllowBelowCost,
  rateMatchesCustomer,
  resolveRateForQuantity,
  type CustomerRate,
  type NewCustomerRate,
  type RateReviewEntry,
  type RateTier,
  type SpecialRateSuggestion,
} from './customer-rates.js';
import type { NewParty, Party, PartyName } from './parties.js';
import {
  componentNeed,
  diffStockEffects,
  DISPOSITIONS,
  ITEM_KINDS,
  stockEffects,
  sumStock,
  valueInventory,
  type Disposition,
  type ItemBom,
  type ItemValuation,
  type ItemKind,
  type NewItemBom,
  type StockCondition,
  type StockEffect,
  type StockLevel,
  type StockMovement,
  type StockMovementKind,
} from './inventory.js';
import {
  buildSupplierInfo,
  computePurchaseCoverage,
  computePurchaseReadiness,
  purchaseDepositFloor,
  specialOrderDepositFloor,
  type NewSupplierInfo,
  type PurchaseCoverageLine,
  type PurchaseReadiness,
  type SupplierInfo,
} from './suppliers.js';
import {
  appliedFromSource,
  appliedToInvoice,
  appliedToLine,
  settle,
  validateApplication,
  type CreditApplication,
  type InvoiceSettlement,
  type NewApplication,
  type NewPayment,
  type Payment,
} from './payments.js';

export const DOCUMENT_TYPES = [
  'estimate',
  'sales_order',
  'invoice',
  'credit_memo',
  'purchase_order',
  'bill',
  'vendor_credit',
  'receipt',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Purchase-side documents share cost pricing and untaxed lines (ADR 0011/0012). */
export function isPurchaseType(type: DocumentType): boolean {
  return type === 'purchase_order' || type === 'bill' || type === 'vendor_credit' || type === 'receipt';
}

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
  // A billed purchase order mirrors an invoiced sales order (ADR 0012);
  // goods arriving before the bill go PO → receipt → bill (ADR 0015).
  purchase_order: ['bill', 'receipt'],
  bill: [],
  vendor_credit: [],
  receipt: ['bill'],
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
  /** Condition of a returned item on credit-memo lines (ADR 0009). */
  readonly returnCondition: ReturnCondition | null;
  /** Tax code applied to this line, or null when untaxed (ADR 0010). */
  readonly taxCode: string | null;
  /** Snapshot of the rate effective on the document date (scale-3 %). */
  readonly taxPercentMilli: bigint;
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
  returnCondition?: ReturnCondition;
  /** undefined = item default; null = force untaxed (ADR 0010). */
  taxCode?: string | null;
  /** Explicit snapshot override (used when copying purchase tax on returns). */
  taxPercentMilli?: bigint;
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
  /** Sales orders only: the deposit requested, resolved to minor units. */
  readonly depositRequiredMinor: bigint | null;
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
  /** Credit memos and vendor credits: how the credit settles (ADR 0006/0013). */
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
  /** What the customer owes/paid: subtotal + tax (ADR 0010). */
  readonly total: bigint;
  /** Pre-tax customer amount. */
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly taxBreakdown: readonly TaxBreakdownEntry[];
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
  /** Required when the approval policy gates close_line (ADR 0009). */
  approvedBy?: string;
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
  /** Omit to draw from the type's number sequence (ADR 0010 part 2). */
  number?: string;
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

/** An effective-dated tax rate, append-only like item prices (ADR 0010). */
export interface TaxRate {
  readonly taxSeq: number;
  readonly code: string;
  readonly name: string;
  /** Scale-3 percent: 8.25% = 8_250n. */
  readonly percentMilli: bigint;
  readonly effectiveFrom: string;
  readonly at: string;
}

export interface NewTaxRate {
  code: string;
  name?: string;
  percentMilli: bigint;
  /** Defaults to the beginning of time. */
  effectiveFrom?: string;
}

/**
 * When an item requires a deposit on sales orders (ADR 0010 part 3).
 * 'special_order' items are purchased per sale and must be prepaid in full
 * before the sales order is sent (ADR 0011 part 6).
 */
export type DepositPolicy = 'never' | 'always' | 'when_out_of_stock' | 'special_order';

/** A deposit request on a sales order: flat or percent of the grand total. */
export type DepositRequest = { amountMinor: bigint } | { percentMilli: bigint };

/** What auto-numbering sequences exist for (ADR 0010 part 2). */
export type SequenceKind = DocumentType | 'payment';

export interface NumberSequence {
  readonly kind: SequenceKind;
  readonly prefix: string;
  readonly next: number;
  readonly width: number;
}

export interface NewNumberSequence {
  prefix: string;
  /** Defaults to 1. */
  next?: number;
  /** Zero-padding width; defaults to 4 (INV-0001). */
  width?: number;
}

export function formatSequenceNumber(sequence: Pick<NumberSequence, 'prefix' | 'width'>, value: number): string {
  return `${sequence.prefix}${String(value).padStart(sequence.width, '0')}`;
}

/** Condition of a returned item (ADR 0009); unopened usually fees lowest. */
export const RETURN_CONDITIONS = ['unopened', 'opened', 'damaged'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

/** Percent of the line's credit and/or a flat amount, both optional. */
export interface RestockingFee {
  percentMilli?: bigint;
  amountMinor?: bigint;
}

export interface ReturnPolicy {
  /** Returns older than this many days need an approved override. */
  windowDays?: number;
  /** Default restocking fee per condition; per-item overrides win. */
  fees?: Partial<Record<ReturnCondition, RestockingFee>>;
}

/** Privileged actions the approval policy may gate (ADR 0009 part 3). */
export const APPROVAL_ACTIONS = [
  'charge_correction',
  'below_cost_sale',
  'void_document',
  'close_line',
  'return_window_override',
  'deposit_override',
  'minimum_order_override',
  'refund_credit',
  'stock_write_off',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export interface Item {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  /** Default tax code for lines selling this item (ADR 0010). */
  readonly taxCode: string | null;
  /** Deposit requirement on sales orders (ADR 0010 part 3). */
  readonly depositPolicy: DepositPolicy;
  /**
   * inventory = stock tracked by the movement ledger (inStock derived);
   * non_inventory = manual inStock flag; service = no stock (ADR 0014).
   */
  readonly kind: ItemKind;
  /** What damaged stock of this item may become (ADR 0014 part 2). */
  readonly dispositions: readonly Disposition[];
  /** Manual for non_inventory; derived (good on-hand > 0) for inventory. */
  readonly inStock: boolean;
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
    case 'bill':
    case 'vendor_credit':
      if (requested !== undefined && requested !== 'correction') {
        throw new LedgerError(
          'INVALID_REVISION_KIND',
          `A sent ${type.replace('_', ' ')} can only be changed by a correction`,
        );
      }
      return 'correction';
    case 'sales_order':
    case 'purchase_order':
    case 'receipt':
      if (requested !== 'correction' && requested !== 'substitution') {
        throw new LedgerError(
          'INVALID_REVISION_KIND',
          `Changing a sent ${type.replace('_', ' ')} requires kind "correction" or "substitution"`,
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

/** Pre-tax customer subtotal for the revision. */
export function revisionTotal(revision: Pick<DocumentRevision, 'lines'>): bigint {
  let total = 0n;
  for (const line of revision.lines) total += customerLineTotal(line);
  return total;
}

export interface TaxBreakdownEntry {
  readonly taxCode: string;
  readonly percentMilli: bigint;
  readonly taxableAmount: bigint;
  readonly tax: bigint;
}

/**
 * Tax per (code, percent) group, rounded half-up once per group (ADR 0010).
 * Derived entirely from line snapshots — rate changes never reach back.
 */
export function revisionTaxBreakdown(revision: Pick<DocumentRevision, 'lines'>): TaxBreakdownEntry[] {
  const groups = new Map<string, { taxCode: string; percentMilli: bigint; taxableAmount: bigint }>();
  for (const line of revision.lines) {
    if (line.taxCode === null || line.taxPercentMilli === 0n) continue;
    const key = `${line.taxCode}|${line.taxPercentMilli}`;
    const group = groups.get(key) ?? { taxCode: line.taxCode, percentMilli: line.taxPercentMilli, taxableAmount: 0n };
    group.taxableAmount += customerLineTotal(line);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    tax: divRoundHalf(group.taxableAmount * group.percentMilli, PERCENT_SCALE),
  }));
}

export function revisionTax(revision: Pick<DocumentRevision, 'lines'>): bigint {
  return revisionTaxBreakdown(revision).reduce((sum, entry) => sum + entry.tax, 0n);
}

/** What the customer owes: subtotal plus tax (ADR 0010). */
export function revisionGrandTotal(revision: Pick<DocumentRevision, 'lines'>): bigint {
  return revisionTotal(revision) + revisionTax(revision);
}

/** One line's customer amount including its own tax (prepayment cap, ADR 0010). */
export function lineGrossTotal(
  line: Pick<DocumentLine, 'quantityMilli' | 'unitPrice' | 'adjustment' | 'free' | 'taxPercentMilli' | 'taxCode'>,
): bigint {
  const net = customerLineTotal(line);
  if (line.taxCode === null || line.taxPercentMilli === 0n) return net;
  return net + divRoundHalf(net * line.taxPercentMilli, PERCENT_SCALE);
}

/** Resolve a deposit request against the revision's grand total (ADR 0010). */
export function computeDepositRequired(
  request: DepositRequest,
  grandTotal: bigint,
): bigint {
  const amount =
    'amountMinor' in request
      ? request.amountMinor
      : divRoundHalf(grandTotal * request.percentMilli, PERCENT_SCALE);
  if (amount <= 0n) {
    throw new LedgerError('INVALID_DOCUMENT', 'Deposit requests must be positive');
  }
  if (amount > grandTotal) {
    throw new LedgerError('INVALID_DOCUMENT', `Deposit ${amount} exceeds the order total ${grandTotal}`);
  }
  return amount;
}

/** Deposits belong to sales and purchase orders (ADR 0010 part 3, ADR 0016). */
export function resolveDepositRequest(
  type: DocumentType,
  request: DepositRequest | undefined,
  lines: readonly DocumentLine[],
): bigint | null {
  if (request === undefined) return null;
  if (type !== 'sales_order' && type !== 'purchase_order') {
    throw new LedgerError('INVALID_DOCUMENT', 'Deposits can only be requested on sales or purchase orders');
  }
  return computeDepositRequired(request, revisionGrandTotal({ lines }));
}

/** Which lines require a deposit before the order can be sent (ADR 0010). */
export function depositRequiringLines(
  lines: readonly DocumentLine[],
  getItem: (id: string) => Item | undefined,
): DocumentLine[] {
  return lines.filter((line) => {
    if (line.itemId === null) return false;
    const item = getItem(line.itemId);
    if (!item) return false;
    return item.depositPolicy === 'always' || (item.depositPolicy === 'when_out_of_stock' && !item.inStock);
  });
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
    if (line.taxPercentMilli < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Tax rates must not be negative');
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
   * price on `date` for the given quantity (tiers and below-cost guard
   * applied), or undefined when no rate applies (ADR 0007, ADR 0009).
   */
  customerPriceAt(
    itemId: string,
    customer: CustomerQuery,
    date: string,
    quantityMilli?: bigint,
  ): bigint | undefined;
  /** The scale-3 percent of a tax code effective on `date` (ADR 0010). */
  taxRateAt(code: string, date: string): bigint | undefined;
  /** The supplier's quoted unit cost effective on `date`, if any (ADR 0011). */
  supplierCostAt?(partyId: string, itemId: string, date: string): bigint | undefined;
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
  taxExempt = false,
  purchase = false,
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
    } else if (purchase) {
      // Purchase pricing (ADR 0011 part 4): explicit → supplier quote → cost
      // history. Customer rates and sales prices never apply.
      unitPrice =
        line.unitPrice ??
        (item && customer?.partyId !== undefined
          ? catalog.supplierCostAt?.(customer.partyId, item.id, date)
          : undefined) ??
        (item ? catalog.costAt(item.id, date) : undefined);
    } else {
      // Pricing order (ADR 0007): explicit price → customer rate → catalog.
      unitPrice =
        line.unitPrice ??
        (item && customer
          ? catalog.customerPriceAt(item.id, customer, date, line.quantityMilli)
          : undefined) ??
        (item ? catalog.priceAt(item.id, date) : undefined);
    }
    if (unitPrice === undefined) {
      throw new LedgerError(
        'INVALID_DOCUMENT',
        purchase
          ? 'Purchase lines need an explicit unitPrice, a supplier quote, or item cost history'
          : 'Lines without an item need an explicit unitPrice',
      );
    }
    const currency = line.currency ?? item?.currency;
    if (currency === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'Lines without an item need an explicit currency');
    }
    if (item && currency !== item.currency) {
      throw new LedgerError('CURRENCY_MISMATCH', `Item ${item.name} is priced in ${item.currency}`);
    }
    // Tax (ADR 0010): explicit code (null = force untaxed) → previous → item
    // default; a snapshot of the percent effective today rides the line.
    // Purchase lines carry no sales tax (ADR 0011 part 4).
    let taxCode: string | null;
    if (taxExempt || purchase) taxCode = null;
    else if (line.taxCode !== undefined) taxCode = line.taxCode;
    else if (previous !== undefined) taxCode = previous.taxCode;
    else taxCode = item?.taxCode ?? null;
    let taxPercentMilli = 0n;
    if (taxCode !== null) {
      const snapshot =
        line.taxPercentMilli ??
        (line.taxCode === undefined && previous !== undefined && previous.taxCode === taxCode
          ? previous.taxPercentMilli
          : catalog.taxRateAt(taxCode, date));
      if (snapshot === undefined) {
        throw new LedgerError('UNKNOWN_TAX_CODE', `No tax rate for code ${taxCode} effective on ${date}`);
      }
      taxPercentMilli = snapshot;
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
      returnCondition: line.returnCondition ?? previous?.returnCondition ?? null,
      taxCode,
      taxPercentMilli,
    };
  });
}

/**
 * ADR 0009 return guard: cumulative returns against a purchase line may never
 * exceed the quantity purchased. Shared by every storage engine.
 */
export function validateReturnQuantities(
  lines: readonly DocumentLine[],
  getSourceLine: (documentId: string, lineId: string) => DocumentLine | undefined,
  priorReturnedMilli: (documentId: string, lineId: string) => bigint,
): void {
  const consumed = new Map<string, bigint>();
  for (const line of lines) {
    if (line.sourceDocumentId === null || line.sourceLineId === null) continue;
    const key = `${line.sourceDocumentId}#${line.sourceLineId}`;
    consumed.set(key, (consumed.get(key) ?? 0n) + line.quantityMilli);
  }
  for (const [key, quantity] of consumed) {
    const [documentId, lineId] = key.split('#') as [string, string];
    const sourceLine = getSourceLine(documentId, lineId);
    if (!sourceLine) continue; // provenance to a non-purchase source
    const total = priorReturnedMilli(documentId, lineId) + quantity;
    if (total > sourceLine.quantityMilli) {
      throw new LedgerError(
        'RETURN_EXCEEDS_PURCHASE',
        `Returning ${total} (milli) of "${sourceLine.description}" exceeds the ${sourceLine.quantityMilli} purchased`,
      );
    }
  }
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
    total: revisionGrandTotal(current),
    subtotal: revisionTotal(current),
    taxTotal: revisionTax(current),
    taxBreakdown: revisionTaxBreakdown(current),
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
  /** Condition of the returned goods; defaults to 'unopened' (ADR 0009). */
  condition?: ReturnCondition;
  /** Override the policy's restocking fee for this item. */
  restockingFee?: RestockingFee;
}

export interface NewReturn {
  /** Omit to draw from the credit_memo sequence (ADR 0010 part 2). */
  number?: string;
  date: string;
  customerName?: string;
  accountNumber?: string;
  partyId?: string;
  poNumber?: string;
  settlement?: SettlementMode;
  memo?: string;
  items: ReturnItem[];
  /** Accept a return outside the policy window (approvable action). */
  overrideWindow?: boolean;
  /** Who authorized gated aspects of this return (ADR 0009 part 3). */
  approvedBy?: string;
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
  policy?: ReturnPolicy,
  overrideWindow = false,
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
  if (purchase && policy?.windowDays !== undefined && !overrideWindow) {
    const purchaseDate = purchase.record.revisions[purchase.record.revisions.length - 1]!.date;
    const age = daysBetween(purchaseDate, asOf);
    if (age > policy.windowDays) {
      throw new LedgerError(
        'RETURN_WINDOW',
        `Purchase of ${catalogItem.name} is ${age} days old; the return window is ${policy.windowDays} days (pass overrideWindow to accept anyway)`,
      );
    }
  }
  const condition: ReturnCondition = item.condition ?? 'unopened';
  const unitPrice = item.unitPrice ?? perUnitCustomerPrice(purchase!.line);
  // Restocking fee (ADR 0009): percent of the credit and/or flat, per
  // condition — applied through the standard adjustment machinery.
  const fee = item.restockingFee ?? policy?.fees?.[condition];
  let adjustment = 0n;
  if (fee) {
    const face = divRoundHalf(item.quantityMilli * unitPrice, QUANTITY_SCALE);
    let amount =
      (fee.percentMilli !== undefined ? divRoundHalf(face * fee.percentMilli, 100_000n) : 0n) +
      (fee.amountMinor ?? 0n);
    if (amount < 0n) amount = 0n;
    if (amount > face) amount = face;
    adjustment = -amount;
  }
  return {
    itemId: item.itemId,
    description: `${catalogItem.name} (return, ${condition})`,
    quantityMilli: item.quantityMilli,
    unitPrice,
    currency: catalogItem.currency,
    ...(adjustment !== 0n ? { adjustment } : {}),
    returnCondition: condition,
    // Refund the tax the customer actually paid (ADR 0010): copy the
    // purchase line's snapshot; explicit-price returns fall back to defaults.
    ...(purchase
      ? { taxCode: purchase.line.taxCode, taxPercentMilli: purchase.line.taxPercentMilli }
      : {}),
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
  /** Omit to draw from the type's number sequence (ADR 0010 part 2). */
  number?: string;
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
  /** Who authorized gated aspects (e.g. below-cost pricing) (ADR 0009). */
  approvedBy?: string;
  /** Credit memos and vendor credits only: defaults to 'account'. */
  settlement?: SettlementMode;
  /** Suppress tax codes on every line (defaults from the party) (ADR 0010). */
  taxExempt?: boolean;
  /** Sales orders only: request a deposit (ADR 0010 part 3). */
  deposit?: DepositRequest;
}

/** One-step cash sale / cash expense (ADR 0013): document + payment together. */
export interface NewCashTransaction {
  /** Document number; omit to draw from the invoice/bill sequence. */
  number?: string;
  /** Payment number; omit to draw from the payment sequence. */
  paymentNumber?: string;
  date: string;
  customerName?: string;
  accountNumber?: string;
  partyId?: string;
  poNumber?: string;
  memo?: string;
  /** Payment method ("cash", "VISA …9921", …). */
  method?: string;
  taxExempt?: boolean;
  approvedBy?: string;
  lines: NewDocumentLine[];
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
  /** Who authorized gated aspects (e.g. below-cost pricing) (ADR 0009). */
  approvedBy?: string;
  /** Sales orders only: change the requested deposit (ADR 0010 part 3). */
  deposit?: DepositRequest;
}

export interface NewItem {
  name: string;
  currency: string;
  unitPrice: bigint;
  cost?: bigint;
  taxCode?: string;
  depositPolicy?: DepositPolicy;
  /** Defaults to 'non_inventory' (ADR 0014). */
  kind?: ItemKind;
  /** Allowed damaged-stock dispositions; defaults to all (ADR 0014). */
  dispositions?: Disposition[];
  /** Defaults to true. */
  inStock?: boolean;
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
  private returnPolicyValue: ReturnPolicy = {};
  private approvalPolicy = new Set<ApprovalAction>();
  private readonly sequences = new Map<SequenceKind, NumberSequence>();

  // ── Auto-numbering (ADR 0010 part 2) ──────────────────────────────────

  setNumberSequence(kind: SequenceKind, input: NewNumberSequence): NumberSequence {
    const sequence: NumberSequence = {
      kind,
      prefix: input.prefix,
      next: input.next ?? 1,
      width: input.width ?? 4,
    };
    if (!Number.isInteger(sequence.next) || sequence.next < 1 || !Number.isInteger(sequence.width) || sequence.width < 1) {
      throw new LedgerError('INVALID_DOCUMENT', 'Sequence next/width must be positive integers');
    }
    this.sequences.set(kind, sequence);
    return sequence;
  }

  numberSequence(kind: SequenceKind): NumberSequence | undefined {
    return this.sequences.get(kind);
  }

  private drawNumber(kind: SequenceKind): string {
    const sequence = this.sequences.get(kind);
    if (!sequence) {
      throw new LedgerError('INVALID_DOCUMENT', `No number provided and no sequence configured for ${kind}`);
    }
    this.sequences.set(kind, { ...sequence, next: sequence.next + 1 });
    return formatSequenceNumber(sequence, sequence.next);
  }

  // ── Policies (ADR 0009) ───────────────────────────────────────────────

  setReturnPolicy(policy: ReturnPolicy): void {
    this.returnPolicyValue = policy;
  }

  returnPolicy(): ReturnPolicy {
    return this.returnPolicyValue;
  }

  setApprovalPolicy(actions: readonly ApprovalAction[]): void {
    this.approvalPolicy = new Set(actions);
  }

  private requireApproval(action: ApprovalAction, approvedBy: string | undefined): void {
    if (this.approvalPolicy.has(action) && approvedBy === undefined) {
      throw new LedgerError('APPROVAL_REQUIRED', `Action "${action}" requires an approver (approvedBy)`);
    }
  }

  /** Non-free sales lines priced under the item's cost are gated (ADR 0009). */
  private requireBelowCostApproval(
    type: DocumentType,
    date: string,
    lines: readonly DocumentLine[],
    approvedBy: string | undefined,
  ): void {
    if (type === 'credit_memo' || isPurchaseType(type)) return;
    for (const line of lines) {
      if (line.free || line.itemId === null) continue;
      const cost = this.costAt(line.itemId, date);
      if (cost !== undefined && line.unitPrice < cost) {
        this.requireApproval('below_cost_sale', approvedBy);
        return;
      }
    }
  }

  /** Cumulative quantity already credited against a line by this credit type. */
  private priorReturnedMilli(documentId: string, lineId: string, creditType: DocumentType = 'credit_memo'): bigint {
    let total = 0n;
    for (const record of this.documents.values()) {
      if (record.type !== creditType || record.status === 'void') continue;
      const current = record.revisions[record.revisions.length - 1]!;
      for (const line of current.lines) {
        if (line.sourceDocumentId === documentId && line.sourceLineId === lineId) {
          total += line.quantityMilli;
        }
      }
    }
    return total;
  }

  private sourceLineFor(documentId: string, lineId: string): DocumentLine | undefined {
    const record = this.documents.get(documentId);
    if (!record) return undefined;
    const current = record.revisions[record.revisions.length - 1]!;
    return current.lines.find((line) => line.lineId === lineId);
  }

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
      taxExempt: input.taxExempt ?? false,
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

  /** All parties, name order — the supplier/customer picker's read (ADR 0021). */
  listParties(): Party[] {
    return [...this.parties.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
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
      throw new LedgerError('UNKNOWN_PARTY', `No such party: ${id}`);
    }
    return party;
  }

  /** Effective customer fields: explicit values win, party supplies defaults. */
  private resolveCustomer(input: {
    partyId?: string;
    customerName?: string;
    accountNumber?: string;
    termsDays?: number;
    taxExempt?: boolean;
  }): {
    partyId: string | null;
    customerName: string;
    accountNumber?: string;
    termsDays?: number;
    taxExempt: boolean;
  } {
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
      taxExempt: input.taxExempt ?? party?.taxExempt ?? false,
    };
  }

  // ── Items & price history ─────────────────────────────────────────────

  createItem(input: NewItem, id: string = randomUUID()): Item {
    if (!input.name.trim()) {
      throw new LedgerError('UNKNOWN_ITEM', 'Item name must not be empty');
    }
    currencyExponent(input.currency);
    const kind = input.kind ?? 'non_inventory';
    if (!ITEM_KINDS.includes(kind)) {
      throw new LedgerError('INVALID_DOCUMENT', `Invalid item kind: ${String(kind)}`);
    }
    for (const disposition of input.dispositions ?? []) {
      if (!DISPOSITIONS.includes(disposition)) {
        throw new LedgerError('INVALID_DOCUMENT', `Invalid disposition: ${String(disposition)}`);
      }
    }
    const item: Item = {
      id,
      name: input.name.trim(),
      currency: input.currency,
      taxCode: input.taxCode ?? null,
      depositPolicy: input.depositPolicy ?? 'never',
      kind,
      dispositions: input.dispositions ?? [...DISPOSITIONS],
      inStock: input.inStock ?? true,
    };
    this.items.set(id, item);
    this.prices.set(id, []);
    this.setPrice(id, input.unitPrice, input.effectiveFrom ?? '0000-01-01');
    if (input.cost !== undefined) {
      this.setCost(id, input.cost, input.effectiveFrom ?? '0000-01-01');
    }
    return item;
  }

  getItem(id: string): Item | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    if (item.kind === 'inventory') {
      return { ...item, inStock: this.stockOnHand(id).goodMilli > 0n };
    }
    if (item.kind === 'service') {
      return { ...item, inStock: true };
    }
    return item;
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
    return this.costAtInternal(itemId, date, new Set());
  }

  /** Explicit cost wins; else additive BOM derivation, recursive (ADR 0014). */
  private costAtInternal(itemId: string, date: string, visiting: Set<string>): bigint | undefined {
    const own = this.lookupPrice(itemId, 'cost', date);
    if (own !== undefined) return own;
    const bom = this.bomAt(itemId, date);
    if (!bom) return undefined;
    if (visiting.has(itemId)) {
      throw new LedgerError('BOM_CYCLE', `Bill of materials for ${itemId} contains itself`);
    }
    visiting.add(itemId);
    let total = bom.assemblyCostMinor;
    for (const component of bom.components) {
      const unit = this.costAtInternal(component.componentItemId, date, visiting);
      if (unit === undefined) return undefined;
      total += divRoundHalf(component.quantityMilli * unit, QUANTITY_SCALE);
    }
    visiting.delete(itemId);
    return total;
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

  /** Manual stock flag for non_inventory items (ADR 0010 part 3 / ADR 0014). */
  setItemStock(itemId: string, inStock: boolean): Item {
    const item = this.items.get(itemId);
    if (!item) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (item.kind === 'inventory') {
      throw new LedgerError('INVALID_DOCUMENT', 'Stock of inventory items is tracked; record an adjustment instead');
    }
    if (item.kind === 'service') {
      throw new LedgerError('INVALID_DOCUMENT', 'Service items have no stock');
    }
    const updated: Item = { ...item, inStock };
    this.items.set(itemId, updated);
    return updated;
  }

  // ── Tax rates (ADR 0010) ──────────────────────────────────────────────

  private readonly taxRates: TaxRate[] = [];

  /** Append a tax rate; existing documents keep their snapshots. */
  setTaxRate(input: NewTaxRate, at?: string): TaxRate {
    if (!input.code.trim()) {
      throw new LedgerError('UNKNOWN_TAX_CODE', 'Tax code must not be empty');
    }
    if (input.percentMilli < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Tax rates must not be negative');
    }
    const rate: TaxRate = {
      taxSeq: this.taxRates.length + 1,
      code: input.code.trim(),
      name: input.name ?? input.code.trim(),
      percentMilli: input.percentMilli,
      effectiveFrom: input.effectiveFrom ?? '0000-01-01',
      at: at ?? new Date().toISOString(),
    };
    this.taxRates.push(rate);
    return rate;
  }

  taxRateAt(code: string, date: string): bigint | undefined {
    let best: TaxRate | undefined;
    for (const rate of this.taxRates) {
      if (rate.code !== code || rate.effectiveFrom > date) continue;
      if (
        !best ||
        rate.effectiveFrom > best.effectiveFrom ||
        (rate.effectiveFrom === best.effectiveFrom && rate.taxSeq > best.taxSeq)
      ) {
        best = rate;
      }
    }
    return best?.percentMilli;
  }

  listTaxRates(): readonly TaxRate[] {
    return this.taxRates;
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
    const rateParty = input.partyId !== undefined ? this.requireParty(input.partyId) : undefined;
    const effectiveFrom = input.effectiveFrom ?? '0000-01-01';
    // The below-cost default judges the item as of the rate's effective date;
    // for an open-ended rate, judge it by the latest known price and cost.
    const evalDate = input.effectiveFrom ?? '9999-12-31';
    const salePrice = this.priceAt(input.itemId, evalDate);
    const cost = this.costAt(input.itemId, evalDate);
    const specs = [input.rate, ...(input.tiers ?? []).map((tier) => tier.rate)];
    for (const spec of specs) {
      if (spec.kind === 'formula' && spec.base === 'cost' && cost === undefined) {
        throw new LedgerError('INVALID_DOCUMENT', 'Cost-based rate requires cost history for the item');
      }
      if (spec.kind === 'constant' && spec.unitPrice < 0n) {
        throw new LedgerError('INVALID_DOCUMENT', 'Rates must not be negative');
      }
    }
    if (input.rate.kind === 'revoked' && (input.tiers?.length ?? 0) > 0) {
      throw new LedgerError('INVALID_DOCUMENT', 'A revocation cannot carry tiers');
    }
    const tiers: RateTier[] = (input.tiers ?? []).map((tier, index) => {
      if (tier.minQuantityMilli === undefined && tier.multipleQuantityMilli === undefined) {
        throw new LedgerError('INVALID_DOCUMENT', 'A tier needs a minimum quantity and/or an exact multiple');
      }
      if ((tier.minQuantityMilli ?? 1n) <= 0n || (tier.multipleQuantityMilli ?? 1n) <= 0n) {
        throw new LedgerError('INVALID_QUANTITY', 'Tier quantities must be positive');
      }
      return {
        tierNo: index + 1,
        minQuantityMilli: tier.minQuantityMilli ?? null,
        multipleQuantityMilli: tier.multipleQuantityMilli ?? null,
        kind: tier.rate.kind,
        unitPrice: tier.rate.kind === 'constant' ? tier.rate.unitPrice : null,
        base: tier.rate.kind === 'formula' ? tier.rate.base : null,
        percentMilli: tier.rate.kind === 'formula' ? (tier.rate.percentMilli ?? 0n) : 0n,
        amountMinor: tier.rate.kind === 'formula' ? (tier.rate.amountMinor ?? 0n) : 0n,
      };
    });
    const rate: CustomerRate = {
      rateSeq: this.rates.length + 1,
      itemId: input.itemId,
      partyId: rateParty?.id ?? null,
      // Snapshot of the party's identity at grant time; matching is party-first.
      customerName: input.customerName ?? rateParty?.name ?? null,
      accountNumber: input.accountNumber ?? rateParty?.accountNumber ?? null,
      kind: input.rate.kind,
      unitPrice: input.rate.kind === 'constant' ? input.rate.unitPrice : null,
      base: input.rate.kind === 'formula' ? input.rate.base : null,
      percentMilli: input.rate.kind === 'formula' ? (input.rate.percentMilli ?? 0n) : 0n,
      amountMinor: input.rate.kind === 'formula' ? (input.rate.amountMinor ?? 0n) : 0n,
      allowBelowCost: input.allowBelowCost ?? defaultAllowBelowCost(salePrice, cost),
      effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      tiers,
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
    if (!best) return undefined;
    // Expiry ends special pricing (fall back to catalog, not older rates);
    // a revocation record ends it explicitly (ADR 0009).
    if (best.effectiveTo !== null && date > best.effectiveTo) return undefined;
    if (best.kind === 'revoked') return undefined;
    return best;
  }

  customerPriceAt(
    itemId: string,
    customer: CustomerQuery,
    date: string,
    quantityMilli: bigint = 1000n,
  ): bigint | undefined {
    const rate = this.customerRateAt(itemId, customer, date);
    if (!rate) return undefined;
    return resolveRateForQuantity(rate, quantityMilli, this.priceAt(itemId, date), this.costAt(itemId, date));
  }

  /** "Who has special pricing and is it still sane" (ADR 0009). */
  rateReview(asOf: string): RateReviewEntry[] {
    return computeRateReview(this.rates, this, asOf);
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
    taxExempt = false,
    purchase = false,
  ): DocumentLine[] {
    return resolveDocumentLines(lines, date, this, previousLines, customer, taxExempt, purchase);
  }

  createDocument(input: NewDocument, id: string = randomUUID(), at?: string): DocumentView {
    if (!DOCUMENT_TYPES.includes(input.type)) {
      throw new LedgerError('INVALID_DOCUMENT', `Invalid document type: ${String(input.type)}`);
    }
    if (input.number !== undefined && !input.number.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Document number must not be empty');
    }
    if (input.settlement !== undefined && input.type !== 'credit_memo' && input.type !== 'vendor_credit') {
      throw new LedgerError('INVALID_DOCUMENT', 'Only credit memos and vendor credits take a settlement mode');
    }
    const purchase = isPurchaseType(input.type);
    const customer = this.resolveCustomer(input);
    const lines = this.resolveLines(
      input.lines,
      input.date,
      undefined,
      {
        customerName: customer.customerName,
        ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
        ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
      },
      customer.taxExempt,
      purchase,
    );
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
    this.requireBelowCostApproval(input.type, input.date, lines, input.approvedBy);
    if (input.type === 'credit_memo' || input.type === 'vendor_credit') {
      validateReturnQuantities(
        lines,
        (documentId, lineId) => this.sourceLineFor(documentId, lineId),
        (documentId, lineId) => this.priorReturnedMilli(documentId, lineId, input.type),
      );
    }
    if (input.type === 'purchase_order') {
      this.validatePurchaseLinks(lines);
    }
    const number = input.number?.trim() ?? this.drawNumber(input.type);
    const numberKey = `${input.type}:${number}`;
    if (this.numbers.has(numberKey)) {
      throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Number already in use: ${number}`);
    }
    const document: DocumentRecord = {
      id,
      type: input.type,
      number,
      status: 'draft',
      sourceDocumentId: input.sourceDocumentId ?? null,
      partyId: customer.partyId,
      settlement:
        input.type === 'credit_memo' || input.type === 'vendor_credit' ? (input.settlement ?? 'account') : null,
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
          depositRequiredMinor: resolveDepositRequest(input.type, input.deposit, lines),
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
        ? this.resolveLines(
            changes.lines,
            date,
            previous.lines,
            {
              customerName,
              ...(accountNumber !== null ? { accountNumber } : {}),
              ...(document.partyId !== null ? { partyId: document.partyId } : {}),
            },
            false,
            isPurchaseType(document.type),
          )
        : [...previous.lines];
    validateRevisionContent({ date, lines, customerName });
    // ADR 0006: never orphan downstream links or over-consume a shrunk line.
    validateLineConsumption(lines, this.fulfillment(id));
    // ADR 0010 part 3: prepaid lines cannot vanish or shrink below their prepayment.
    if (document.type === 'sales_order') {
      for (const entry of this.linePrepayments(id)) {
        if (entry.prepaid === 0n) continue;
        const stillThere = lines.find((line) => line.lineId === entry.lineId);
        if (!stillThere) {
          throw new LedgerError('LINE_LINKED', `Line ${entry.lineId} has ${entry.prepaid} prepaid and cannot be removed`);
        }
        if (lineGrossTotal(stillThere) < entry.prepaid) {
          throw new LedgerError('LINE_LINKED', `Line ${entry.lineId} cannot shrink below its ${entry.prepaid} prepayment`);
        }
      }
      // ADR 0011 part 5: lines on order with a supplier cannot vanish or
      // shrink below the linked quantity — a PO must not point at nothing.
      for (const entry of this.purchaseCoverage(id)) {
        const ordered = entry.draftOrderedMilli + entry.sentOrderedMilli;
        if (ordered === 0n) continue;
        const stillThere = lines.find((line) => line.lineId === entry.lineId);
        if (!stillThere) {
          throw new LedgerError(
            'LINE_LINKED',
            `Line ${entry.lineId} has ${ordered} (milli) on purchase orders and cannot be removed`,
          );
        }
        if (stillThere.quantityMilli < ordered) {
          throw new LedgerError(
            'LINE_LINKED',
            `Line ${entry.lineId} cannot shrink below the ${ordered} (milli) on purchase orders`,
          );
        }
      }
    }
    if (document.type === 'purchase_order' && changes.lines !== undefined) {
      this.validatePurchaseLinks(lines, id);
    }
    this.requireBelowCostApproval(document.type, date, lines, changes.approvedBy);
    if ((document.type === 'credit_memo' || document.type === 'vendor_credit') && changes.lines !== undefined) {
      validateReturnQuantities(
        lines,
        (documentId, lineId) => this.sourceLineFor(documentId, lineId),
        (documentId, lineId) =>
          this.priorReturnedMilli(documentId, lineId, document.type) -
          previous.lines
            .filter((line) => line.sourceDocumentId === documentId && line.sourceLineId === lineId)
            .reduce((sum, line) => sum + line.quantityMilli, 0n),
      );
    }
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
      depositRequiredMinor:
        changes.deposit !== undefined
          ? resolveDepositRequest(document.type, changes.deposit, lines)
          : previous.depositRequiredMinor,
      memo: changes.memo ?? previous.memo,
      lines,
    });
    if (document.status === 'sent') {
      // ADR 0014: quantity-changing corrections keep stock consistent.
      const getItem = (itemId: string) => this.items.get(itemId);
      const sourceTypeOf = (documentId: string) => this.documents.get(documentId)?.type;
      this.applyStockEffects(
        diffStockEffects(
          stockEffects(document.type, previous.lines, getItem, sourceTypeOf),
          stockEffects(document.type, lines, getItem, sourceTypeOf),
        ),
        'correction',
        date,
        id,
      );
    }
    return this.view(id);
  }

  /**
   * "We accidentally charged the wrong amount": reduce the customer total of
   * a sent invoice to `actualTotal`, pro rata with cost floors (ADR 0005).
   */
  chargeCorrection(id: string, actualTotal: bigint, reason?: string, at?: string, approvedBy?: string): DocumentView {
    this.requireApproval('charge_correction', approvedBy);
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
      depositRequiredMinor: previous.depositRequiredMinor,
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
        ...(spec.number !== undefined ? { number: spec.number } : {}),
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
    if (input.overrideWindow === true) {
      this.requireApproval('return_window_override', input.approvedBy);
    }
    const invoices = [...this.documents.values()];
    const lines = input.items.map((item) =>
      buildReturnLine(item, query, input.date, invoices, this, this.returnPolicyValue, input.overrideWindow ?? false),
    );
    return this.createDocument(
      {
        type: 'credit_memo',
        ...(input.number !== undefined ? { number: input.number } : {}),
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

  /** What we owe a supplier, aged like a customer statement (ADR 0013). */
  supplierStatement(query: CustomerQuery, asOf: string, rules?: readonly AgingRule[]): Statement {
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
      'supplier',
    );
  }

  supplierStatementForParty(partyId: string, asOf: string, rules?: readonly AgingRule[]): Statement {
    const party = this.requireParty(partyId);
    return this.supplierStatement(
      {
        partyId,
        customerName: party.name,
        ...(party.accountNumber !== null ? { accountNumber: party.accountNumber } : {}),
      },
      asOf,
      rules,
    );
  }

  /** Who owes us, bucketed by age across the whole book (ADR 0017). */
  arAging(asOf: string, rules?: readonly AgingRule[]): AgingSummary {
    return computeAgingSummary([...this.documents.values()], [...this.payments.values()], this.applications, asOf, 'customer', rules);
  }

  /** Whom we owe, bucketed by age across the whole book (ADR 0017). */
  apAging(asOf: string, rules?: readonly AgingRule[]): AgingSummary {
    return computeAgingSummary([...this.documents.values()], [...this.payments.values()], this.applications, asOf, 'supplier', rules);
  }

  /** Per-item FIFO quantity and value for every tracked item (ADR 0017). */
  inventorySummary(asOf?: string): InventorySummary {
    const rows = [...this.items.values()]
      .filter((item) => item.kind === 'inventory')
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((item) => {
        const valuation = this.itemValuation(item.id, asOf);
        return { itemId: item.id, name: item.name, quantityMilli: valuation.quantityMilli, valueMinor: valuation.valueMinor };
      });
    return { asOf: asOf ?? null, rows, totalValueMinor: rows.reduce((sum, row) => sum + row.valueMinor, 0n) };
  }

  // ── Payments & credit application (Tier 1, ADR 0008) ──────────────────

  /** Record money received; optionally apply it to invoices immediately. */
  recordPayment(input: NewPayment, id: string = randomUUID()): Payment {
    if (input.amount <= 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Payment amounts must be positive');
    }
    const customer = this.resolveCustomer(input);
    const number = input.number ?? this.drawNumber('payment');
    if ([...this.payments.values()].some((payment) => payment.number === number)) {
      throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Payment number already in use: ${number}`);
    }
    const payment: Payment = {
      id,
      number,
      direction: input.direction ?? 'in',
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
    return record?.type === kind && record.status === 'sent' && record.settlement === 'account';
  }

  private sourceState(kind: CreditApplication['sourceKind'], id: string): {
    customerName: string;
    accountNumber: string | null;
    direction: 'in' | 'out';
    total: bigint;
  } {
    if (kind === 'payment') {
      const payment = this.payments.get(id);
      if (!payment) throw new LedgerError('UNKNOWN_DOCUMENT', `No such payment: ${id}`);
      if (payment.status !== 'received') {
        throw new LedgerError('INVALID_STATUS', 'Void payments cannot be applied');
      }
      return {
        customerName: payment.customerName,
        accountNumber: payment.accountNumber,
        direction: payment.direction,
        total: payment.amountMinor,
      };
    }
    const label = kind === 'vendor_credit' ? 'vendor credit' : 'credit memo';
    const record = this.documents.get(id);
    if (!record || record.type !== kind) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such ${label}: ${id}`);
    }
    if (record.status !== 'sent') {
      throw new LedgerError('INVALID_STATUS', `Only sent ${label}s can be applied`);
    }
    if (record.settlement !== 'account') {
      throw new LedgerError('INVALID_DOCUMENT', `Refund ${label}s were paid out and cannot be applied`);
    }
    const current = record.revisions[record.revisions.length - 1]!;
    // A vendor credit reduces what we owe: outbound credit (ADR 0013).
    return {
      customerName: current.customerName,
      accountNumber: current.accountNumber,
      direction: kind === 'vendor_credit' ? 'out' : 'in',
      total: revisionGrandTotal(current),
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
    // Line-level prepayments are a sales-order-only concept (ADR 0010 part 3).
    if (input.lineId !== undefined) {
      if (invoice.type !== 'sales_order') {
        throw new LedgerError('INVALID_DOCUMENT', 'Line-level prepayments apply only to sales orders');
      }
      const current = invoice.revisions[invoice.revisions.length - 1]!;
      const line = current.lines.find((candidate) => candidate.lineId === input.lineId);
      if (!line) {
        throw new LedgerError('UNKNOWN_LINE', `No such line: ${input.lineId}`);
      }
      const lineOpen =
        lineGrossTotal(line) -
        appliedToLine(this.applications, invoice.id, input.lineId, (kind, id) => this.isSourceActive(kind, id));
      if (input.amount > lineOpen) {
        throw new LedgerError(
          'INVALID_ALLOCATION',
          `Prepaying ${input.amount} exceeds the line's remaining ${lineOpen}`,
        );
      }
    }
    const application: CreditApplication = {
      applicationSeq: this.applications.length + 1,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      invoiceId: input.invoiceId,
      lineId: input.lineId ?? null,
      refund: false,
      amountMinor: input.amount,
      date: date ?? invoice.revisions[invoice.revisions.length - 1]!.date,
      at: at ?? new Date().toISOString(),
      reversesApplicationSeq: null,
    };
    this.applications.push(application);
    return application;
  }

  /**
   * Pay out (part of) a credit source's unapplied balance (ADR 0013):
   * a customer overpaid, or a supplier owes us back. Consumes the source
   * like an application; reversible the same way. Gated by refund_credit.
   */
  refundCredit(
    input: {
      sourceKind: CreditApplication['sourceKind'];
      sourceId: string;
      amount: bigint;
      date?: string;
      approvedBy?: string;
    },
    at?: string,
  ): CreditApplication {
    this.requireApproval('refund_credit', input.approvedBy);
    const source = this.sourceState(input.sourceKind, input.sourceId);
    if (input.amount <= 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Refund amounts must be positive');
    }
    const remaining = source.total - appliedFromSource(this.applications, input.sourceKind, input.sourceId);
    if (input.amount > remaining) {
      throw new LedgerError(
        'INVALID_ALLOCATION',
        `Refunding ${input.amount} exceeds the source's unapplied ${remaining}`,
      );
    }
    const refund: CreditApplication = {
      applicationSeq: this.applications.length + 1,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      invoiceId: null,
      lineId: null,
      refund: true,
      amountMinor: input.amount,
      date: input.date ?? (at ?? new Date().toISOString()).slice(0, 10),
      at: at ?? new Date().toISOString(),
      reversesApplicationSeq: null,
    };
    this.applications.push(refund);
    return refund;
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
      lineId: target.lineId,
      refund: target.refund,
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
    return settle(revisionGrandTotal(current), paid);
  }

  listApplications(): readonly CreditApplication[] {
    return this.applications;
  }

  /** Explicitly close (part of) a line without fulfilling it (ADR 0005). */
  closeLine(documentId: string, input: NewLineClosure, at?: string): LineClosure {
    this.requireApproval('close_line', input.approvedBy);
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

  /** The link graph around one document (ADR 0021). */
  documentLinks(id: string): DocumentLinks {
    return computeDocumentLinks(this.listDocuments(), id);
  }

  sendDocument(
    id: string,
    options?: { overrideDeposit?: boolean; overrideMinimum?: boolean; approvedBy?: string },
  ): DocumentView {
    const document = this.requireDocument(id);
    if (document.status !== 'draft') {
      throw new LedgerError('INVALID_STATUS', `Only draft documents can be sent (is ${document.status})`);
    }
    const current = document.revisions[document.revisions.length - 1]!;
    if (document.type === 'sales_order') {
      const requiring = depositRequiringLines(current.lines, (itemId) => this.getItem(itemId));
      if (requiring.length > 0 && (current.depositRequiredMinor ?? 0n) <= 0n) {
        if (options?.overrideDeposit === true) {
          this.requireApproval('deposit_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'DEPOSIT_REQUIRED',
            `These items require a deposit before sending: ${requiring.map((line) => line.description).join(', ')} (pass overrideDeposit to send anyway)`,
          );
        }
      }
      // ADR 0011 part 6: special-order items must be prepaid in full — the
      // deposit request has to cover their gross amount before sending.
      const floor = specialOrderDepositFloor(current.lines, (itemId) => this.getItem(itemId));
      if (floor > 0n && (current.depositRequiredMinor ?? 0n) < floor) {
        if (options?.overrideDeposit === true) {
          this.requireApproval('deposit_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'DEPOSIT_REQUIRED',
            `Special-order items must be prepaid: the deposit request must cover at least ${floor}, not ${current.depositRequiredMinor ?? 0n} (pass overrideDeposit to send anyway)`,
          );
        }
      }
    }
    if (document.type === 'purchase_order') {
      const readiness = this.purchaseOrderReadiness(id);
      if (!readiness.ready) {
        if (options?.overrideMinimum === true) {
          this.requireApproval('minimum_order_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'MINIMUM_NOT_MET',
            `Purchase order does not meet the supplier's terms: ${readiness.shortfalls
              .map((shortfall) => shortfall.message)
              .join('; ')} (pass overrideMinimum to send anyway)`,
          );
        }
      }
      // ADR 0016: special-order items and supplier prepayment terms require a
      // deposit committed before the order is submitted to the supplier.
      const info = document.partyId !== null ? this.supplierInfoAt(document.partyId, current.date) : undefined;
      const floor = purchaseDepositFloor(
        current.lines,
        (itemId) => this.getItem(itemId),
        info?.prepaymentPercentMilli ?? null,
      );
      if (floor > 0n && (current.depositRequiredMinor ?? 0n) < floor) {
        if (options?.overrideDeposit === true) {
          this.requireApproval('deposit_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'DEPOSIT_REQUIRED',
            `Supplier requires prepayment: the deposit request must cover at least ${floor}, not ${current.depositRequiredMinor ?? 0n} (pass overrideDeposit to send anyway)`,
          );
        }
      }
    }
    this.documents.set(id, { ...document, status: 'sent' });
    // ADR 0014: sending/approving moves stock for inventory items.
    this.applyStockEffects(
      stockEffects(
        document.type,
        current.lines,
        (itemId) => this.items.get(itemId),
        (documentId) => this.documents.get(documentId)?.type,
      ),
      'document',
      current.date,
      id,
    );
    if (document.type === 'invoice') {
      const source = document.sourceDocumentId !== null ? this.documents.get(document.sourceDocumentId) : undefined;
      if (source?.type === 'sales_order') this.transferDeposits(id, source);
    }
    if (document.type === 'bill') {
      // ADR 0016: deposits ride from the originating PO onto the bill,
      // resolving through a receipt in the three-way flow (ADR 0015).
      const po = this.originatingPurchaseOrder(document);
      if (po) this.transferDeposits(id, po);
    }
    return this.view(id);
  }

  /** Walk a bill's source chain (bill → receipt? → purchase_order). */
  private originatingPurchaseOrder(bill: DocumentRecord): DocumentRecord | undefined {
    let source = bill.sourceDocumentId !== null ? this.documents.get(bill.sourceDocumentId) : undefined;
    if (source?.type === 'receipt') {
      source = source.sourceDocumentId !== null ? this.documents.get(source.sourceDocumentId) : undefined;
    }
    return source?.type === 'purchase_order' ? source : undefined;
  }

  /** Total deposit money held against a sales or purchase order (ADR 0010/0016). */
  depositHeld(documentId: string): bigint {
    this.requireDocument(documentId);
    return appliedToInvoice(this.applications, documentId, (kind, id) => this.isSourceActive(kind, id));
  }

  /** Per-line prepayments on a sales order (ADR 0010 part 3). */
  linePrepayments(documentId: string): { lineId: string; description: string; prepaid: bigint; lineGross: bigint }[] {
    const document = this.requireDocument(documentId);
    const current = document.revisions[document.revisions.length - 1]!;
    return current.lines.map((line) => ({
      lineId: line.lineId,
      description: line.description,
      prepaid: appliedToLine(this.applications, documentId, line.lineId, (kind, id) => this.isSourceActive(kind, id)),
      lineGross: lineGrossTotal(line),
    }));
  }

  /**
   * Move deposits held on a source order onto a just-finalized document:
   * line-level prepayments whose line converted here first, then
   * document-level deposits, oldest first (ADR 0010 part 3, ADR 0016). Each
   * move is a reversal plus a fresh application — fully auditable.
   */
  private transferDeposits(invoiceId: string, source: DocumentRecord): void {
    const invoice = this.requireDocument(invoiceId);
    const invoiceCurrent = invoice.revisions[invoice.revisions.length - 1]!;
    const convertedLineIds = new Set(
      invoiceCurrent.lines
        .map((line) => line.sourceLineId)
        .filter((lineId): lineId is string => lineId !== null),
    );
    const held = this.applications
      .filter(
        (application) =>
          application.invoiceId === source.id &&
          application.reversesApplicationSeq === null &&
          !this.applications.some((other) => other.reversesApplicationSeq === application.applicationSeq) &&
          this.isSourceActive(application.sourceKind, application.sourceId),
      )
      .sort((a, b) => {
        const aLinked = a.lineId !== null && convertedLineIds.has(a.lineId) ? 0 : a.lineId === null ? 1 : 2;
        const bLinked = b.lineId !== null && convertedLineIds.has(b.lineId) ? 0 : b.lineId === null ? 1 : 2;
        return aLinked === bLinked ? a.applicationSeq - b.applicationSeq : aLinked - bLinked;
      });
    for (const application of held) {
      // Prepayments for lines NOT on this invoice stay held on the order.
      if (application.lineId !== null && !convertedLineIds.has(application.lineId)) continue;
      const open = this.invoiceSettlement(invoiceId).open;
      if (open === 0n) break;
      const move = application.amountMinor < open ? application.amountMinor : open;
      this.reverseApplication(application.applicationSeq);
      this.applyCredit({
        sourceKind: application.sourceKind,
        sourceId: application.sourceId,
        invoiceId,
        amount: move,
      });
      if (move < application.amountMinor) {
        // The unmoved remainder stays held on the order.
        this.applyCredit({
          sourceKind: application.sourceKind,
          sourceId: application.sourceId,
          invoiceId: source.id,
          amount: application.amountMinor - move,
          ...(application.lineId !== null ? { lineId: application.lineId } : {}),
        });
      }
    }
  }

  // ── Inventory (ADR 0014) ──────────────────────────────────────────────

  private readonly movements: StockMovement[] = [];
  private readonly boms: ItemBom[] = [];

  /** Derived on-hand levels, as-of any date; never stored (ADR 0014). */
  stockOnHand(itemId: string, asOf?: string): StockLevel {
    if (!this.items.has(itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    return sumStock(this.movements, itemId, asOf);
  }

  stockMovements(itemId: string): readonly StockMovement[] {
    return this.movements.filter((movement) => movement.itemId === itemId);
  }

  private requireInventoryItem(itemId: string): Item {
    const item = this.items.get(itemId);
    if (!item) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (item.kind !== 'inventory') {
      throw new LedgerError('INVALID_DOCUMENT', `${item.name} is ${item.kind.replace('_', '-')}; it has no tracked stock`);
    }
    return item;
  }

  private pushMovement(
    itemId: string,
    kind: StockMovementKind,
    condition: StockCondition,
    quantityMilli: bigint,
    date: string,
    options?: { reason?: string; sourceId?: string; disposition?: Disposition; valueMinor?: bigint; at?: string },
  ): StockMovement {
    const movement: StockMovement = {
      movementSeq: this.movements.length + 1,
      itemId,
      kind,
      condition,
      quantityMilli,
      date,
      at: options?.at ?? new Date().toISOString(),
      reason: options?.reason ?? null,
      sourceId: options?.sourceId ?? null,
      disposition: options?.disposition ?? null,
      valueMinor: options?.valueMinor ?? null,
    };
    this.movements.push(movement);
    return movement;
  }

  private applyStockEffects(effects: readonly StockEffect[], kind: StockMovementKind, date: string, sourceId: string): void {
    for (const effect of effects) {
      this.pushMovement(effect.itemId, kind, effect.condition, effect.deltaMilli, date, {
        sourceId,
        ...(effect.valueMinor !== undefined ? { valueMinor: effect.valueMinor } : {}),
      });
    }
  }

  /** FIFO valuation, derived from the movement ledger (ADR 0015). */
  itemValuation(itemId: string, asOf?: string): ItemValuation {
    if (!this.items.has(itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    const movements = this.movements.filter(
      (movement) => movement.itemId === itemId && (asOf === undefined || movement.date <= asOf),
    );
    return valueInventory(movements, (date) => this.costAt(itemId, date));
  }

  /** Manual signed count; negative = shrinkage write-off (approvable). */
  adjustStock(
    itemId: string,
    quantityMilli: bigint,
    options?: { reason?: string; date?: string; condition?: StockCondition; approvedBy?: string },
  ): StockMovement {
    this.requireInventoryItem(itemId);
    if (quantityMilli === 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Adjustments must move a nonzero quantity');
    }
    if (quantityMilli < 0n) {
      this.requireApproval('stock_write_off', options?.approvedBy);
    }
    return this.pushMovement(itemId, 'adjustment', options?.condition ?? 'good', quantityMilli, options?.date ?? new Date().toISOString().slice(0, 10), {
      ...(options?.reason !== undefined ? { reason: options.reason } : {}),
    });
  }

  /** Move good stock into the damaged bucket (ADR 0014 part 2). */
  markDamaged(itemId: string, quantityMilli: bigint, options?: { reason?: string; date?: string }): StockLevel {
    this.requireInventoryItem(itemId);
    const onHand = this.stockOnHand(itemId);
    if (quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Damaged quantities must be positive');
    }
    if (quantityMilli > onHand.goodMilli) {
      throw new LedgerError('INSUFFICIENT_STOCK', `Cannot damage ${quantityMilli} (milli); ${onHand.goodMilli} good on hand`);
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const reason = options?.reason !== undefined ? { reason: options.reason } : {};
    this.pushMovement(itemId, 'damage', 'good', -quantityMilli, date, reason);
    this.pushMovement(itemId, 'damage', 'damaged', quantityMilli, date, reason);
    return this.stockOnHand(itemId);
  }

  /**
   * Resolve damaged stock per the item's policy: restock (back to good),
   * recycle, or trash (both write it off; approvable) (ADR 0014 part 2).
   */
  disposeStock(
    itemId: string,
    quantityMilli: bigint,
    disposition: Disposition,
    options?: { reason?: string; date?: string; approvedBy?: string },
  ): StockLevel {
    const item = this.requireInventoryItem(itemId);
    if (!item.dispositions.includes(disposition)) {
      throw new LedgerError('INVALID_DOCUMENT', `${item.name} does not allow the "${disposition}" disposition`);
    }
    if (quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Disposal quantities must be positive');
    }
    const onHand = this.stockOnHand(itemId);
    if (quantityMilli > onHand.damagedMilli) {
      throw new LedgerError('INSUFFICIENT_STOCK', `Cannot dispose ${quantityMilli} (milli); ${onHand.damagedMilli} damaged on hand`);
    }
    if (disposition !== 'restock') {
      this.requireApproval('stock_write_off', options?.approvedBy);
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const extra = { disposition, ...(options?.reason !== undefined ? { reason: options.reason } : {}) };
    this.pushMovement(itemId, 'disposal', 'damaged', -quantityMilli, date, extra);
    if (disposition === 'restock') {
      this.pushMovement(itemId, 'disposal', 'good', quantityMilli, date, extra);
    }
    return this.stockOnHand(itemId);
  }

  // ── Bills of materials (ADR 0014 part 3) ──────────────────────────────

  /** Append a BOM version; earlier documents keep their cost snapshots. */
  setBom(input: NewItemBom, at?: string): ItemBom {
    if (!this.items.has(input.itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${input.itemId}`);
    }
    if (input.components.length === 0) {
      throw new LedgerError('INVALID_DOCUMENT', 'A bill of materials needs at least one component');
    }
    if ((input.assemblyCostMinor ?? 0n) < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Assembly cost must not be negative');
    }
    const seen = new Set<string>();
    for (const component of input.components) {
      if (!this.items.has(component.componentItemId)) {
        throw new LedgerError('UNKNOWN_ITEM', `No such item: ${component.componentItemId}`);
      }
      if (component.componentItemId === input.itemId || seen.has(component.componentItemId)) {
        throw new LedgerError('INVALID_DOCUMENT', `Duplicate or self component: ${component.componentItemId}`);
      }
      seen.add(component.componentItemId);
      if (component.quantityMilli <= 0n) {
        throw new LedgerError('INVALID_QUANTITY', 'Component quantities must be positive');
      }
    }
    const bom: ItemBom = {
      bomSeq: this.boms.length + 1,
      itemId: input.itemId,
      effectiveFrom: input.effectiveFrom ?? '0000-01-01',
      assemblyCostMinor: input.assemblyCostMinor ?? 0n,
      components: input.components.map((component) => ({ ...component })),
      at: at ?? new Date().toISOString(),
    };
    // Reject cycles up front: walking every path from the new BOM must
    // never reach the assembled item again (ADR 0014 part 3).
    const walk = (itemId: string, path: Set<string>): void => {
      const next = itemId === input.itemId ? bom : this.bomAt(itemId, '9999-12-31');
      if (!next) return;
      for (const component of next.components) {
        if (component.componentItemId === input.itemId || path.has(component.componentItemId)) {
          throw new LedgerError('BOM_CYCLE', `Adding this bill of materials would make ${input.itemId} contain itself`);
        }
        walk(component.componentItemId, new Set([...path, component.componentItemId]));
      }
    };
    walk(input.itemId, new Set());
    this.boms.push(bom);
    return bom;
  }

  /** The BOM version effective on `date`, if any. */
  bomAt(itemId: string, date: string): ItemBom | undefined {
    let best: ItemBom | undefined;
    for (const bom of this.boms) {
      if (bom.itemId !== itemId || bom.effectiveFrom > date) continue;
      if (!best || bom.effectiveFrom > best.effectiveFrom || (bom.effectiveFrom === best.effectiveFrom && bom.bomSeq > best.bomSeq)) {
        best = bom;
      }
    }
    return best;
  }

  /** Consume components, produce the assembly (ADR 0014 part 3). */
  buildAssembly(itemId: string, quantityMilli: bigint, options?: { date?: string; reason?: string }): StockLevel {
    return this.moveAssembly(itemId, quantityMilli, 1n, options);
  }

  /** The exact inverse: a full box becomes its pieces again. */
  breakAssembly(itemId: string, quantityMilli: bigint, options?: { date?: string; reason?: string }): StockLevel {
    return this.moveAssembly(itemId, quantityMilli, -1n, options);
  }

  private moveAssembly(
    itemId: string,
    quantityMilli: bigint,
    sign: 1n | -1n,
    options?: { date?: string; reason?: string },
  ): StockLevel {
    const item = this.requireInventoryItem(itemId);
    if (quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Assembly quantities must be positive');
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const bom = this.bomAt(itemId, date);
    if (!bom) {
      throw new LedgerError('INVALID_DOCUMENT', `${item.name} has no bill of materials`);
    }
    if (sign === -1n && this.stockOnHand(itemId).goodMilli < quantityMilli) {
      throw new LedgerError('INSUFFICIENT_STOCK', `Cannot break ${quantityMilli} (milli); only ${this.stockOnHand(itemId).goodMilli} on hand`);
    }
    const inventoryComponents = bom.components.filter(
      (component) => this.items.get(component.componentItemId)?.kind === 'inventory',
    );
    if (sign === 1n) {
      for (const component of inventoryComponents) {
        const need = componentNeed(component, quantityMilli);
        const onHand = this.stockOnHand(component.componentItemId).goodMilli;
        if (onHand < need) {
          throw new LedgerError(
            'INSUFFICIENT_STOCK',
            `Building needs ${need} (milli) of ${component.componentItemId}; ${onHand} on hand`,
          );
        }
      }
    }
    const reason = options?.reason !== undefined ? { reason: options.reason } : {};
    for (const component of inventoryComponents) {
      this.pushMovement(component.componentItemId, 'build', 'good', -sign * componentNeed(component, quantityMilli), date, reason);
    }
    this.pushMovement(itemId, 'build', 'good', sign * quantityMilli, date, reason);
    return this.stockOnHand(itemId);
  }

  // ── Purchase side (ADR 0011) ──────────────────────────────────────────

  private readonly supplierInfos: SupplierInfo[] = [];

  /** Record a supplier-info snapshot (append-only; `source` = 'manual' or a plugin id). */
  recordSupplierInfo(input: NewSupplierInfo, at?: string): SupplierInfo {
    this.requireParty(input.partyId);
    for (const term of input.items ?? []) {
      if (!this.items.has(term.itemId)) {
        throw new LedgerError('UNKNOWN_ITEM', `No such item: ${term.itemId}`);
      }
    }
    const info = buildSupplierInfo(input, this.supplierInfos.length + 1, at ?? new Date().toISOString());
    this.supplierInfos.push(info);
    return info;
  }

  /** Newest supplier snapshot observed on or before `date`. */
  supplierInfoAt(partyId: string, date: string): SupplierInfo | undefined {
    let best: SupplierInfo | undefined;
    for (const info of this.supplierInfos) {
      if (info.partyId !== partyId || info.asOf > date) continue;
      if (!best || info.asOf > best.asOf || (info.asOf === best.asOf && info.infoSeq > best.infoSeq)) {
        best = info;
      }
    }
    return best;
  }

  /** The latest supplier snapshot regardless of date. */
  supplierInfo(partyId: string): SupplierInfo | undefined {
    let best: SupplierInfo | undefined;
    for (const info of this.supplierInfos) {
      if (info.partyId !== partyId) continue;
      if (!best || info.infoSeq > best.infoSeq) best = info;
    }
    return best;
  }

  supplierInfoHistory(partyId: string): readonly SupplierInfo[] {
    return this.supplierInfos.filter((info) => info.partyId === partyId);
  }

  /** The supplier's quoted unit cost effective on `date` (ItemCatalog seam). */
  supplierCostAt(partyId: string, itemId: string, date: string): bigint | undefined {
    return this.supplierInfoAt(partyId, date)?.items.find((term) => term.itemId === itemId)?.unitCost;
  }

  /** Cumulative quantity of a sales-order line already on other purchase orders. */
  private priorLinkedMilli(salesOrderId: string, lineId: string, excludeDocumentId?: string): bigint {
    let total = 0n;
    for (const record of this.documents.values()) {
      if (record.type !== 'purchase_order' || record.status === 'void' || record.id === excludeDocumentId) {
        continue;
      }
      const current = record.revisions[record.revisions.length - 1]!;
      for (const line of current.lines) {
        if (line.sourceDocumentId === salesOrderId && line.sourceLineId === lineId) {
          total += line.quantityMilli;
        }
      }
    }
    return total;
  }

  /**
   * ADR 0011 part 5: PO line links must target existing sales-order lines,
   * and the cumulative linked quantity across non-void purchase orders may
   * not exceed what the sales order promises. Overage for stock is ordered
   * as an unlinked line.
   */
  private validatePurchaseLinks(lines: readonly DocumentLine[], excludeDocumentId?: string): void {
    const consumed = new Map<string, bigint>();
    for (const line of lines) {
      if (line.sourceDocumentId === null || line.sourceLineId === null) continue;
      const source = this.documents.get(line.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${line.sourceDocumentId}`);
      }
      if (source.type !== 'sales_order') {
        throw new LedgerError('INVALID_DOCUMENT', 'Purchase-order lines may only link to sales-order lines');
      }
      const current = source.revisions[source.revisions.length - 1]!;
      if (!current.lines.some((candidate) => candidate.lineId === line.sourceLineId)) {
        throw new LedgerError('UNKNOWN_LINE', `Sales order ${source.number} has no line ${line.sourceLineId}`);
      }
      const key = `${line.sourceDocumentId}#${line.sourceLineId}`;
      consumed.set(key, (consumed.get(key) ?? 0n) + line.quantityMilli);
    }
    for (const [key, quantity] of consumed) {
      const [documentId, lineId] = key.split('#') as [string, string];
      const source = this.documents.get(documentId)!;
      const sourceLine = source.revisions[source.revisions.length - 1]!.lines.find(
        (candidate) => candidate.lineId === lineId,
      )!;
      const total = this.priorLinkedMilli(documentId, lineId, excludeDocumentId) + quantity;
      if (total > sourceLine.quantityMilli) {
        throw new LedgerError(
          'LINE_OVERDRAWN',
          `Ordering ${total} (milli) of "${sourceLine.description}" exceeds the ${sourceLine.quantityMilli} on the sales order; order overage as an unlinked line`,
        );
      }
    }
  }

  /** How much of each sales-order line is on order with suppliers (ADR 0011). */
  purchaseCoverage(salesOrderId: string): PurchaseCoverageLine[] {
    const record = this.requireDocument(salesOrderId);
    if (record.type !== 'sales_order') {
      throw new LedgerError('INVALID_DOCUMENT', 'Purchase coverage applies to sales orders');
    }
    const linked = new Map<string, { draftMilli: bigint; sentMilli: bigint }>();
    for (const other of this.documents.values()) {
      if (other.type !== 'purchase_order' || other.status === 'void') continue;
      const current = other.revisions[other.revisions.length - 1]!;
      for (const line of current.lines) {
        if (line.sourceDocumentId !== salesOrderId || line.sourceLineId === null) continue;
        const entry = linked.get(line.sourceLineId) ?? { draftMilli: 0n, sentMilli: 0n };
        if (other.status === 'sent') entry.sentMilli += line.quantityMilli;
        else entry.draftMilli += line.quantityMilli;
        linked.set(line.sourceLineId, entry);
      }
    }
    const current = record.revisions[record.revisions.length - 1]!;
    return computePurchaseCoverage(current.lines, linked);
  }

  /** Readiness of a purchase order against the supplier's terms (ADR 0011 part 7). */
  purchaseOrderReadiness(id: string): PurchaseReadiness {
    const document = this.requireDocument(id);
    if (document.type !== 'purchase_order') {
      throw new LedgerError('INVALID_DOCUMENT', 'Readiness applies to purchase orders');
    }
    const current = document.revisions[document.revisions.length - 1]!;
    const info =
      document.partyId !== null ? this.supplierInfoAt(document.partyId, current.date) : undefined;
    return computePurchaseReadiness(current.lines, info);
  }

  /**
   * Cash sale (ADR 0013): invoice at Net 0, sent, and paid in full — one
   * atomic motion. Not a new document type: the books show an ordinary
   * paid invoice plus its payment.
   */
  recordSalesReceipt(input: NewCashTransaction): { document: DocumentView; payment: Payment | null } {
    return this.recordCashTransaction('invoice', 'in', input);
  }

  /** Cash expense (ADR 0013): bill approved and paid in one motion. */
  recordExpense(input: NewCashTransaction): { document: DocumentView; payment: Payment | null } {
    return this.recordCashTransaction('bill', 'out', input);
  }

  private recordCashTransaction(
    type: 'invoice' | 'bill',
    direction: 'in' | 'out',
    input: NewCashTransaction,
  ): { document: DocumentView; payment: Payment | null } {
    const view = this.createDocument({
      type,
      date: input.date,
      lines: input.lines,
      termsDays: 0,
      ...(input.number !== undefined ? { number: input.number } : {}),
      ...(input.customerName !== undefined ? { customerName: input.customerName } : {}),
      ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
      ...(input.partyId !== undefined ? { partyId: input.partyId } : {}),
      ...(input.poNumber !== undefined ? { poNumber: input.poNumber } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.taxExempt !== undefined ? { taxExempt: input.taxExempt } : {}),
      ...(input.approvedBy !== undefined ? { approvedBy: input.approvedBy } : {}),
    });
    this.sendDocument(view.id);
    let payment: Payment | null = null;
    if (view.total > 0n) {
      payment = this.recordPayment({
        direction,
        date: input.date,
        customerName: view.current.customerName,
        ...(view.current.accountNumber !== null ? { accountNumber: view.current.accountNumber } : {}),
        ...(input.partyId !== undefined ? { partyId: input.partyId } : {}),
        ...(input.paymentNumber !== undefined ? { number: input.paymentNumber } : {}),
        ...(input.method !== undefined ? { method: input.method } : {}),
        amount: view.total,
        applications: [{ invoiceId: view.id, amount: view.total }],
      });
    }
    return { document: this.view(view.id), payment };
  }

  voidDocument(id: string, approvedBy?: string): DocumentView {
    this.requireApproval('void_document', approvedBy);
    const document = this.requireDocument(id);
    if (document.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Document is already void');
    }
    const wasSent = document.status === 'sent';
    const current = document.revisions[document.revisions.length - 1]!;
    this.documents.set(id, { ...document, status: 'void' });
    if (wasSent) {
      // ADR 0014: voiding a sent document puts its stock back.
      const effects = stockEffects(
        document.type,
        current.lines,
        (itemId) => this.items.get(itemId),
        (documentId) => this.documents.get(documentId)?.type,
      );
      this.applyStockEffects(
        effects.map((effect) => ({ ...effect, deltaMilli: -effect.deltaMilli })),
        'void',
        current.date,
        id,
      );
    }
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
