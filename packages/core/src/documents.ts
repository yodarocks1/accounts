import { randomUUID } from 'node:crypto';
import { allocateProportional } from './allocation.js';
import { LedgerError } from './errors.js';
import { currencyExponent } from './money.js';
import { divRoundHalf, QUANTITY_SCALE } from './quantity.js';

export const DOCUMENT_TYPES = ['estimate', 'sales_order', 'invoice'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type DocumentStatus = 'draft' | 'sent' | 'void';

export type RevisionKind = 'initial' | 'edit' | 'correction' | 'substitution';

export type DocumentTag = 'with corrections' | 'with substitutions';

/** Allowed conversion targets per source type (ADR 0005). */
export const CONVERSION_TARGETS: Record<DocumentType, readonly DocumentType[]> = {
  estimate: ['sales_order', 'invoice'],
  sales_order: ['invoice'],
  invoice: [],
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
  readonly counterparty: string | null;
  readonly memo: string | null;
  readonly lines: readonly DocumentLine[];
}

export interface DocumentRecord {
  readonly id: string;
  readonly type: DocumentType;
  readonly number: string;
  readonly status: DocumentStatus;
  readonly sourceDocumentId: string | null;
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
  counterparty?: string;
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
      if (requested !== undefined && requested !== 'correction') {
        throw new LedgerError(
          'INVALID_REVISION_KIND',
          'A sent invoice can only be changed by a correction',
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
  counterparty?: string;
  memo?: string;
}

/** Validate revision content; returns the document's single currency. */
export function validateRevisionContent(content: RevisionContent): string {
  if (!ISO_DATE.test(content.date)) {
    throw new LedgerError('INVALID_DOCUMENT', `Document date must be YYYY-MM-DD; got ${JSON.stringify(content.date)}`);
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
      unitPrice = line.unitPrice ?? (item ? catalog.priceAt(item.id, date) : undefined);
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
      sourceLineId: line.sourceLineId ?? previous?.sourceLineId ?? null,
    };
  });
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
      sourceLineId: spec.sourceLineId,
      ...(spec.free !== undefined ? { free: spec.free } : {}),
    };
  });
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
  counterparty?: string;
  memo?: string;
  sourceDocumentId?: string;
}

export interface DocumentChanges {
  kind?: RevisionKind;
  reason?: string;
  date?: string;
  lines?: NewDocumentLine[];
  counterparty?: string;
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

  // ── Documents ─────────────────────────────────────────────────────────

  private resolveLines(
    lines: NewDocumentLine[],
    date: string,
    previousLines?: readonly DocumentLine[],
  ): DocumentLine[] {
    return resolveDocumentLines(lines, date, this, previousLines);
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
    const lines = this.resolveLines(input.lines, input.date);
    let inheritedTags: readonly DocumentTag[] = [];
    if (input.sourceDocumentId !== undefined) {
      const source = this.documents.get(input.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${input.sourceDocumentId}`);
      }
      validateConversion(source, input.type, lines, this.fulfillment(source.id));
      inheritedTags = deriveTags(source, this.closures.get(source.id) ?? []);
    }
    validateRevisionContent({ date: input.date, lines });
    const document: DocumentRecord = {
      id,
      type: input.type,
      number: input.number.trim(),
      status: 'draft',
      sourceDocumentId: input.sourceDocumentId ?? null,
      inheritedTags,
      revisions: [
        {
          revisionNo: 1,
          kind: 'initial',
          at: at ?? new Date().toISOString(),
          reason: null,
          date: input.date,
          counterparty: input.counterparty ?? null,
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
    const lines =
      changes.lines !== undefined
        ? this.resolveLines(changes.lines, date, previous.lines)
        : [...previous.lines];
    validateRevisionContent({ date, lines });
    this.appendRevision(document, {
      revisionNo: previous.revisionNo + 1,
      kind,
      at: at ?? new Date().toISOString(),
      reason: changes.reason ?? null,
      date,
      counterparty: changes.counterparty ?? previous.counterparty,
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
      counterparty: previous.counterparty,
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
        ...(spec.counterparty !== undefined
          ? { counterparty: spec.counterparty }
          : previous.counterparty !== null
            ? { counterparty: previous.counterparty }
            : {}),
        ...(spec.memo !== undefined ? { memo: spec.memo } : {}),
      },
      id,
      at,
    );
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
