import { LedgerError } from './errors.js';
import { currencyExponent } from './money.js';
import { formatQuantity } from './quantity.js';
import { lineGrossTotal, revisionGrandTotal, type DocumentLine } from './documents.js';

/**
 * Supplier info (ADR 0011 part 3): append-only, source-tagged snapshots of
 * what we know about ordering from a supplier — minimums, shipping estimates,
 * per-item costs and pack sizes. `source` is the plugin seam: 'manual' today,
 * a plugin id later. Newer snapshots supersede older ones; history is kept.
 */
export interface ShippingEstimate {
  readonly method: string;
  /** Estimated shipping cost in minor units, when quoted. */
  readonly costMinor: bigint | null;
  /** Shipping is free above this order total, when the supplier offers it. */
  readonly freeAboveMinor: bigint | null;
  readonly minDays: number | null;
  readonly maxDays: number | null;
}

export interface SupplierItemTerm {
  readonly itemId: string;
  /** The supplier's quoted unit cost (minor units). */
  readonly unitCost: bigint;
  readonly supplierSku: string | null;
  /** Supplier's stock at quote time, when known. */
  readonly inStock: boolean | null;
  /** Smallest quantity the supplier sells (milli). */
  readonly minQuantityMilli: bigint | null;
  /** Order in exact multiples of this (case packs), when required (milli). */
  readonly multipleQuantityMilli: bigint | null;
  readonly leadDays: number | null;
}

export interface SupplierInfo {
  readonly infoSeq: number;
  readonly partyId: string;
  /** Where this snapshot came from: 'manual' or a plugin id (ADR 0011). */
  readonly source: string;
  /** Date the info was observed/valid (YYYY-MM-DD). */
  readonly asOf: string;
  readonly at: string;
  readonly currency: string;
  /** Minimum order value (minor units), when the supplier imposes one. */
  readonly minimumOrderMinor: bigint | null;
  /** Minimum order quantity across all lines (milli), when imposed. */
  readonly minimumOrderQuantityMilli: bigint | null;
  readonly shipping: readonly ShippingEstimate[];
  readonly items: readonly SupplierItemTerm[];
  readonly notes: string | null;
}

export interface NewShippingEstimate {
  method: string;
  costMinor?: bigint;
  freeAboveMinor?: bigint;
  minDays?: number;
  maxDays?: number;
}

export interface NewSupplierItemTerm {
  itemId: string;
  unitCost: bigint;
  supplierSku?: string;
  inStock?: boolean;
  minQuantityMilli?: bigint;
  multipleQuantityMilli?: bigint;
  leadDays?: number;
}

export interface NewSupplierInfo {
  partyId: string;
  /** Defaults to 'manual'. */
  source?: string;
  asOf: string;
  currency: string;
  minimumOrderMinor?: bigint;
  minimumOrderQuantityMilli?: bigint;
  shipping?: NewShippingEstimate[];
  items?: NewSupplierItemTerm[];
  notes?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDays(value: number | undefined, what: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new LedgerError('INVALID_DOCUMENT', `${what} must be a non-negative integer; got ${value}`);
  }
  return value;
}

/** Validate and normalize a supplier-info snapshot (pure; no party/item lookups). */
export function buildSupplierInfo(input: NewSupplierInfo, infoSeq: number, at: string): SupplierInfo {
  if (!ISO_DATE.test(input.asOf)) {
    throw new LedgerError('INVALID_DOCUMENT', `asOf must be YYYY-MM-DD; got ${JSON.stringify(input.asOf)}`);
  }
  currencyExponent(input.currency);
  if ((input.minimumOrderMinor ?? 0n) < 0n || (input.minimumOrderQuantityMilli ?? 0n) < 0n) {
    throw new LedgerError('INVALID_DOCUMENT', 'Order minimums must not be negative');
  }
  const shipping: ShippingEstimate[] = (input.shipping ?? []).map((estimate) => {
    if (!estimate.method.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Shipping method must not be empty');
    }
    if ((estimate.costMinor ?? 0n) < 0n || (estimate.freeAboveMinor ?? 0n) < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Shipping amounts must not be negative');
    }
    const minDays = validDays(estimate.minDays, 'minDays');
    const maxDays = validDays(estimate.maxDays, 'maxDays');
    if (minDays !== null && maxDays !== null && maxDays < minDays) {
      throw new LedgerError('INVALID_DOCUMENT', `Shipping maxDays ${maxDays} is below minDays ${minDays}`);
    }
    return {
      method: estimate.method.trim(),
      costMinor: estimate.costMinor ?? null,
      freeAboveMinor: estimate.freeAboveMinor ?? null,
      minDays,
      maxDays,
    };
  });
  const seen = new Set<string>();
  const items: SupplierItemTerm[] = (input.items ?? []).map((term) => {
    if (seen.has(term.itemId)) {
      throw new LedgerError('INVALID_DOCUMENT', `Duplicate supplier term for item ${term.itemId}`);
    }
    seen.add(term.itemId);
    if (term.unitCost < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Supplier costs must not be negative');
    }
    if ((term.minQuantityMilli ?? 1n) <= 0n || (term.multipleQuantityMilli ?? 1n) <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Supplier quantity terms must be positive');
    }
    return {
      itemId: term.itemId,
      unitCost: term.unitCost,
      supplierSku: term.supplierSku ?? null,
      inStock: term.inStock ?? null,
      minQuantityMilli: term.minQuantityMilli ?? null,
      multipleQuantityMilli: term.multipleQuantityMilli ?? null,
      leadDays: validDays(term.leadDays, 'leadDays'),
    };
  });
  return {
    infoSeq,
    partyId: input.partyId,
    source: input.source ?? 'manual',
    asOf: input.asOf,
    at,
    currency: input.currency,
    minimumOrderMinor: input.minimumOrderMinor ?? null,
    minimumOrderQuantityMilli: input.minimumOrderQuantityMilli ?? null,
    shipping,
    items,
    notes: input.notes ?? null,
  };
}

// ── Readiness (ADR 0011 part 7) ────────────────────────────────────────────

export interface ReadinessShortfall {
  readonly kind: 'order_minimum' | 'order_quantity' | 'item_minimum' | 'item_multiple';
  readonly itemId: string | null;
  readonly message: string;
}

export interface PurchaseReadiness {
  readonly ready: boolean;
  /** The supplier-info snapshot the order was judged against, if any. */
  readonly infoSeq: number | null;
  readonly shortfalls: readonly ReadinessShortfall[];
}

/**
 * Judge a purchase order against the supplier's terms: order-value and
 * order-quantity minimums plus per-item minimums and exact multiples
 * (case packs). No supplier info on file ⇒ trivially ready.
 */
export function computePurchaseReadiness(
  lines: readonly DocumentLine[],
  info: SupplierInfo | undefined,
): PurchaseReadiness {
  if (info === undefined) {
    return { ready: true, infoSeq: null, shortfalls: [] };
  }
  const shortfalls: ReadinessShortfall[] = [];
  const total = revisionGrandTotal({ lines });
  if (info.minimumOrderMinor !== null && total < info.minimumOrderMinor) {
    shortfalls.push({
      kind: 'order_minimum',
      itemId: null,
      message: `Order total ${total} is below the supplier minimum ${info.minimumOrderMinor}`,
    });
  }
  const quantity = lines.reduce((sum, line) => sum + line.quantityMilli, 0n);
  if (info.minimumOrderQuantityMilli !== null && quantity < info.minimumOrderQuantityMilli) {
    shortfalls.push({
      kind: 'order_quantity',
      itemId: null,
      message: `Order quantity ${formatQuantity(quantity)} is below the supplier minimum ${formatQuantity(info.minimumOrderQuantityMilli)}`,
    });
  }
  const byItem = new Map<string, bigint>();
  for (const line of lines) {
    if (line.itemId === null) continue;
    byItem.set(line.itemId, (byItem.get(line.itemId) ?? 0n) + line.quantityMilli);
  }
  for (const term of info.items) {
    const ordered = byItem.get(term.itemId);
    if (ordered === undefined) continue;
    if (term.minQuantityMilli !== null && ordered < term.minQuantityMilli) {
      shortfalls.push({
        kind: 'item_minimum',
        itemId: term.itemId,
        message: `Item ${term.itemId}: ${formatQuantity(ordered)} ordered is below the supplier minimum ${formatQuantity(term.minQuantityMilli)}`,
      });
    }
    if (term.multipleQuantityMilli !== null && ordered % term.multipleQuantityMilli !== 0n) {
      shortfalls.push({
        kind: 'item_multiple',
        itemId: term.itemId,
        message: `Item ${term.itemId}: ${formatQuantity(ordered)} ordered is not a multiple of the supplier pack size ${formatQuantity(term.multipleQuantityMilli)}`,
      });
    }
  }
  return { ready: shortfalls.length === 0, infoSeq: info.infoSeq, shortfalls };
}

// ── Purchase coverage of a sales order (ADR 0011 part 5) ──────────────────

export interface PurchaseCoverageLine {
  readonly lineId: string;
  readonly description: string;
  readonly quantityMilli: bigint;
  /** Linked from draft purchase orders (still accumulating). */
  readonly draftOrderedMilli: bigint;
  /** Linked from sent purchase orders. */
  readonly sentOrderedMilli: bigint;
  readonly unorderedMilli: bigint;
}

/**
 * How much of each sales-order line is on order with suppliers, computed
 * from PO line links (draft vs sent split). Pure; callers supply the
 * linked quantities.
 */
export function computePurchaseCoverage(
  lines: readonly DocumentLine[],
  linked: ReadonlyMap<string, { draftMilli: bigint; sentMilli: bigint }>,
): PurchaseCoverageLine[] {
  return lines.map((line) => {
    const entry = linked.get(line.lineId) ?? { draftMilli: 0n, sentMilli: 0n };
    let unordered = line.quantityMilli - entry.draftMilli - entry.sentMilli;
    if (unordered < 0n) unordered = 0n;
    return {
      lineId: line.lineId,
      description: line.description,
      quantityMilli: line.quantityMilli,
      draftOrderedMilli: entry.draftMilli,
      sentOrderedMilli: entry.sentMilli,
      unorderedMilli: unordered,
    };
  });
}

/** Sum of the gross totals of special-order lines (ADR 0011 part 6). */
export function specialOrderLines(
  lines: readonly DocumentLine[],
  getItem: (id: string) => { depositPolicy: string } | undefined,
): DocumentLine[] {
  return lines.filter(
    (line) => line.itemId !== null && getItem(line.itemId)?.depositPolicy === 'special_order',
  );
}

/**
 * The deposit floor for special-order items: their full gross amount
 * (incl. tax) must be requested before the sales order is sent.
 */
export function specialOrderDepositFloor(
  lines: readonly DocumentLine[],
  getItem: (id: string) => { depositPolicy: string } | undefined,
): bigint {
  return specialOrderLines(lines, getItem).reduce((sum, line) => sum + lineGrossTotal(line), 0n);
}
