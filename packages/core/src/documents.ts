import { randomUUID } from 'node:crypto';
import { LedgerError } from './errors.js';
import { currencyExponent } from './money.js';
import { divRoundHalf, QUANTITY_SCALE } from './quantity.js';

export const DOCUMENT_TYPES = ['estimate', 'sales_order', 'invoice'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type DocumentStatus = 'draft' | 'sent' | 'void';

export type RevisionKind = 'initial' | 'edit' | 'correction' | 'substitution';

export type DocumentTag = 'with corrections' | 'with substitutions';

export interface DocumentLine {
  readonly itemId: string | null;
  readonly description: string;
  /** Quantity in thousandths (scale 3). */
  readonly quantityMilli: bigint;
  /** Unit price in minor units, snapshotted when the line was written (ADR 0004). */
  readonly unitPrice: bigint;
  readonly currency: string;
}

export interface NewDocumentLine {
  itemId?: string;
  description: string;
  quantityMilli: bigint;
  /** Omit to resolve from the item's price history on the document date. */
  unitPrice?: bigint;
  currency?: string;
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
  readonly total: bigint;
  readonly currency: string;
  readonly revisionCount: number;
}

export interface Item {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

export interface ItemPrice {
  readonly itemId: string;
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

/** Tags are derived from revision history plus inherited tags — never stored. */
export function deriveTags(
  document: Pick<DocumentRecord, 'revisions' | 'inheritedTags'>,
): DocumentTag[] {
  const tags = new Set<DocumentTag>(document.inheritedTags);
  for (const revision of document.revisions) {
    if (revision.kind === 'correction') tags.add('with corrections');
    if (revision.kind === 'substitution') tags.add('with substitutions');
  }
  // Stable order: corrections first.
  return (['with corrections', 'with substitutions'] as const).filter((tag) => tags.has(tag));
}

export function documentLabel(number: string, tags: readonly DocumentTag[]): string {
  return tags.length === 0 ? number : `${number} (${tags.join(', ')})`;
}

export function lineTotal(line: Pick<DocumentLine, 'quantityMilli' | 'unitPrice'>): bigint {
  return divRoundHalf(line.quantityMilli * line.unitPrice, QUANTITY_SCALE);
}

export function revisionTotal(revision: Pick<DocumentRevision, 'lines'>): bigint {
  let total = 0n;
  for (const line of revision.lines) total += lineTotal(line);
  return total;
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
  for (const line of content.lines) {
    if (!line.description.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Line description must not be empty');
    }
    if (line.quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Line quantities must be positive');
    }
    if (line.unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Unit prices must not be negative');
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
  /** Latest price effective on `date`; later records win ties. Throws if none. */
  priceAt(itemId: string, date: string): bigint;
}

/**
 * Resolve incoming lines into full snapshots: prices default to the catalog
 * price effective on the document date and are copied into the line, so later
 * price changes can never reach back into this document (ADR 0004).
 */
export function resolveDocumentLines(
  lines: NewDocumentLine[],
  date: string,
  catalog: ItemCatalog,
): DocumentLine[] {
  return lines.map((line) => {
    const item = line.itemId !== undefined ? catalog.getItem(line.itemId) : undefined;
    if (line.itemId !== undefined && !item) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${line.itemId}`);
    }
    const unitPrice = line.unitPrice ?? (item ? catalog.priceAt(item.id, date) : undefined);
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
      itemId: item?.id ?? null,
      description: line.description,
      quantityMilli: line.quantityMilli,
      unitPrice,
      currency,
    };
  });
}

export function viewDocument(document: DocumentRecord): DocumentView {
  const current = document.revisions[document.revisions.length - 1];
  if (!current) {
    throw new LedgerError('INVALID_DOCUMENT', `Document ${document.id} has no revisions`);
  }
  const tags = deriveTags(document);
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
    currency: current.lines[0]!.currency,
    revisionCount: document.revisions.length,
  };
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
  /** Defaults to the beginning of time. */
  effectiveFrom?: string;
}

/**
 * In-memory reference for items, price history, and revisioned documents —
 * the conformance oracle for storage engines, mirroring the Ledger class.
 */
export class DocumentBook implements ItemCatalog {
  private readonly items = new Map<string, Item>();
  private readonly prices = new Map<string, ItemPrice[]>();
  private readonly documents = new Map<string, DocumentRecord>();
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
    const price: ItemPrice = { itemId, effectiveFrom, unitPrice, priceSeq: history.length + 1 };
    history.push(price);
    return price;
  }

  /** Latest price effective on `date`; later records win ties. */
  priceAt(itemId: string, date: string): bigint {
    const history = this.prices.get(itemId);
    if (!history) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    let best: ItemPrice | undefined;
    for (const price of history) {
      if (price.effectiveFrom > date) continue;
      if (
        !best ||
        price.effectiveFrom > best.effectiveFrom ||
        (price.effectiveFrom === best.effectiveFrom && price.priceSeq > best.priceSeq)
      ) {
        best = price;
      }
    }
    if (!best) {
      throw new LedgerError('UNKNOWN_ITEM', `Item ${itemId} has no price effective on ${date}`);
    }
    return best.unitPrice;
  }

  priceHistory(itemId: string): readonly ItemPrice[] {
    return this.prices.get(itemId) ?? [];
  }

  // ── Documents ─────────────────────────────────────────────────────────

  private resolveLines(lines: NewDocumentLine[], date: string): DocumentLine[] {
    return resolveDocumentLines(lines, date, this);
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
    let inheritedTags: readonly DocumentTag[] = [];
    if (input.sourceDocumentId !== undefined) {
      const source = this.documents.get(input.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${input.sourceDocumentId}`);
      }
      inheritedTags = deriveTags(source);
    }
    const lines = this.resolveLines(input.lines, input.date);
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
    return viewDocument(document);
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
      changes.lines !== undefined ? this.resolveLines(changes.lines, date) : [...previous.lines];
    validateRevisionContent({ date, lines });
    const revision: DocumentRevision = {
      revisionNo: previous.revisionNo + 1,
      kind,
      at: at ?? new Date().toISOString(),
      reason: changes.reason ?? null,
      date,
      counterparty: changes.counterparty ?? previous.counterparty,
      memo: changes.memo ?? previous.memo,
      lines,
    };
    const updated: DocumentRecord = { ...document, revisions: [...document.revisions, revision] };
    this.documents.set(id, updated);
    return viewDocument(updated);
  }

  sendDocument(id: string): DocumentView {
    const document = this.requireDocument(id);
    if (document.status !== 'draft') {
      throw new LedgerError('INVALID_STATUS', `Only draft documents can be sent (is ${document.status})`);
    }
    const updated: DocumentRecord = { ...document, status: 'sent' };
    this.documents.set(id, updated);
    return viewDocument(updated);
  }

  voidDocument(id: string): DocumentView {
    const document = this.requireDocument(id);
    if (document.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Document is already void');
    }
    const updated: DocumentRecord = { ...document, status: 'void' };
    this.documents.set(id, updated);
    return viewDocument(updated);
  }

  getDocument(id: string): DocumentRecord | undefined {
    return this.documents.get(id);
  }

  view(id: string): DocumentView {
    return viewDocument(this.requireDocument(id));
  }

  history(id: string): readonly DocumentRevision[] {
    return this.requireDocument(id).revisions;
  }

  listDocuments(type?: DocumentType): DocumentView[] {
    return [...this.documents.values()]
      .filter((document) => type === undefined || document.type === type)
      .map(viewDocument);
  }

  private requireDocument(id: string): DocumentRecord {
    const document = this.documents.get(id);
    if (!document) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such document: ${id}`);
    }
    return document;
  }
}
