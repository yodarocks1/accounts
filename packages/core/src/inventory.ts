import { divRoundHalf, QUANTITY_SCALE } from './quantity.js';
import type { DocumentLine, DocumentType, Item } from './documents.js';

/**
 * Inventory (ADR 0014). Stock is never stored as a level: it is an
 * append-only movement log — signed quantities against a good or damaged
 * bucket — and on-hand is a derived sum, as-of any date.
 */

export const ITEM_KINDS = ['inventory', 'non_inventory', 'service'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What may happen to damaged stock, per item (ADR 0014 part 2). */
export const DISPOSITIONS = ['restock', 'recycle', 'trash'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type StockCondition = 'good' | 'damaged';

export type StockMovementKind =
  /** Manual signed count ("initial count", "cycle count correction"). */
  | 'adjustment'
  /** Written when a document is sent/approved. */
  | 'document'
  /** Delta written when a sent document's correction changes quantities. */
  | 'correction'
  /** Opposite movements written when a sent document is voided. */
  | 'void'
  /** Good → damaged transfer. */
  | 'damage'
  /** Damaged stock resolved: restock / recycle / trash. */
  | 'disposal'
  /** Assembly built (components out, item in) or broken (inverse). */
  | 'build';

export interface StockMovement {
  readonly movementSeq: number;
  readonly itemId: string;
  readonly kind: StockMovementKind;
  readonly condition: StockCondition;
  /** Signed, never zero. */
  readonly quantityMilli: bigint;
  readonly date: string;
  readonly at: string;
  readonly reason: string | null;
  /** Document id for document/correction/void movements. */
  readonly sourceId: string | null;
  readonly disposition: Disposition | null;
}

export interface StockLevel {
  readonly goodMilli: bigint;
  readonly damagedMilli: bigint;
}

export function sumStock(movements: readonly StockMovement[], itemId: string, asOf?: string): StockLevel {
  let goodMilli = 0n;
  let damagedMilli = 0n;
  for (const movement of movements) {
    if (movement.itemId !== itemId) continue;
    if (asOf !== undefined && movement.date > asOf) continue;
    if (movement.condition === 'good') goodMilli += movement.quantityMilli;
    else damagedMilli += movement.quantityMilli;
  }
  return { goodMilli, damagedMilli };
}

// ── Document stock effects (ADR 0014 part 2) ──────────────────────────────

export interface StockEffect {
  readonly itemId: string;
  /** Signed change to the bucket when the document is in force. */
  readonly deltaMilli: bigint;
  readonly condition: StockCondition;
}

/**
 * How a sent document of this type moves stock: invoice −good, bill +good,
 * credit memo +good (unopened) / +damaged (otherwise), vendor credit −good.
 * Commitments (orders, estimates) move nothing. Only inventory-kind items.
 */
export function stockEffects(
  type: DocumentType,
  lines: readonly DocumentLine[],
  getItem: (id: string) => Pick<Item, 'kind'> | undefined,
): StockEffect[] {
  let sign: bigint;
  if (type === 'invoice' || type === 'vendor_credit') sign = -1n;
  else if (type === 'bill' || type === 'credit_memo') sign = 1n;
  else return [];
  const byKey = new Map<string, StockEffect>();
  for (const line of lines) {
    if (line.itemId === null || getItem(line.itemId)?.kind !== 'inventory') continue;
    const condition: StockCondition =
      type === 'credit_memo' && line.returnCondition !== null && line.returnCondition !== 'unopened'
        ? 'damaged'
        : 'good';
    const key = `${line.itemId}|${condition}`;
    const existing = byKey.get(key);
    const deltaMilli = (existing?.deltaMilli ?? 0n) + sign * line.quantityMilli;
    byKey.set(key, { itemId: line.itemId, deltaMilli, condition });
  }
  return [...byKey.values()].filter((effect) => effect.deltaMilli !== 0n);
}

/** The movements needed to go from one revision's effects to another's. */
export function diffStockEffects(before: readonly StockEffect[], after: readonly StockEffect[]): StockEffect[] {
  const byKey = new Map<string, StockEffect>();
  for (const effect of after) {
    byKey.set(`${effect.itemId}|${effect.condition}`, effect);
  }
  for (const effect of before) {
    const key = `${effect.itemId}|${effect.condition}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      itemId: effect.itemId,
      condition: effect.condition,
      deltaMilli: (existing?.deltaMilli ?? 0n) - effect.deltaMilli,
    });
  }
  return [...byKey.values()].filter((effect) => effect.deltaMilli !== 0n);
}

// ── Bills of materials (ADR 0014 part 3) ──────────────────────────────────

export interface BomComponent {
  readonly componentItemId: string;
  /** Quantity of the component per ONE unit assembled (milli). */
  readonly quantityMilli: bigint;
}

export interface ItemBom {
  readonly bomSeq: number;
  readonly itemId: string;
  readonly effectiveFrom: string;
  /** Extra per-unit cost of assembling (labor, packaging), minor units. */
  readonly assemblyCostMinor: bigint;
  readonly components: readonly BomComponent[];
  readonly at: string;
}

export interface NewItemBom {
  itemId: string;
  /** Defaults to the beginning of time. */
  effectiveFrom?: string;
  assemblyCostMinor?: bigint;
  components: { componentItemId: string; quantityMilli: bigint }[];
}

/** Component quantity needed to build `buildMilli` of the assembly. */
export function componentNeed(component: BomComponent, buildMilli: bigint): bigint {
  return divRoundHalf(buildMilli * component.quantityMilli, QUANTITY_SCALE);
}
