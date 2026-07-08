import { divRoundHalf, QUANTITY_SCALE } from './quantity.js';
import { customerLineTotal, type DocumentLine, type DocumentType, type Item } from './documents.js';

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
  /**
   * Write-time value snapshot for inbound purchase movements (bill/receipt
   * line value); null elsewhere — the FIFO engine derives it (ADR 0015).
   */
  readonly valueMinor: bigint | null;
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
  /** Line value of inbound purchase movements (bill/receipt) (ADR 0015). */
  readonly valueMinor?: bigint;
}

/**
 * How a sent document of this type moves stock: invoice −good, bill +good,
 * receipt +good, credit memo +good (unopened) / +damaged (otherwise),
 * vendor credit −good. Bill lines whose source line lives in a receipt move
 * nothing — the receipt already did (ADR 0015). Commitments move nothing.
 * Only inventory-kind items. Purchase inbound carries its line value.
 */
export function stockEffects(
  type: DocumentType,
  lines: readonly DocumentLine[],
  getItem: (id: string) => Pick<Item, 'kind'> | undefined,
  sourceTypeOf?: (documentId: string) => DocumentType | undefined,
): StockEffect[] {
  let sign: bigint;
  if (type === 'invoice' || type === 'vendor_credit') sign = -1n;
  else if (type === 'bill' || type === 'credit_memo' || type === 'receipt') sign = 1n;
  else return [];
  const valued = type === 'bill' || type === 'receipt';
  const byKey = new Map<string, { itemId: string; deltaMilli: bigint; condition: StockCondition; valueMinor: bigint }>();
  for (const line of lines) {
    if (line.itemId === null || getItem(line.itemId)?.kind !== 'inventory') continue;
    if (
      type === 'bill' &&
      line.sourceDocumentId !== null &&
      sourceTypeOf?.(line.sourceDocumentId) === 'receipt'
    ) {
      continue; // the receipt already moved this stock
    }
    const condition: StockCondition =
      type === 'credit_memo' && line.returnCondition !== null && line.returnCondition !== 'unopened'
        ? 'damaged'
        : 'good';
    const key = `${line.itemId}|${condition}`;
    const existing = byKey.get(key) ?? { itemId: line.itemId, deltaMilli: 0n, condition, valueMinor: 0n };
    existing.deltaMilli += sign * line.quantityMilli;
    if (valued) existing.valueMinor += customerLineTotal(line);
    byKey.set(key, existing);
  }
  return [...byKey.values()]
    .filter((effect) => effect.deltaMilli !== 0n)
    .map((effect) => ({
      itemId: effect.itemId,
      deltaMilli: effect.deltaMilli,
      condition: effect.condition,
      ...(valued && effect.deltaMilli > 0n ? { valueMinor: effect.valueMinor } : {}),
    }));
}

/** The movements needed to go from one revision's effects to another's. */
export function diffStockEffects(before: readonly StockEffect[], after: readonly StockEffect[]): StockEffect[] {
  interface Entry { itemId: string; deltaMilli: bigint; condition: StockCondition; valueMinor: bigint | undefined }
  const byKey = new Map<string, Entry>();
  for (const effect of after) {
    byKey.set(`${effect.itemId}|${effect.condition}`, {
      itemId: effect.itemId,
      deltaMilli: effect.deltaMilli,
      condition: effect.condition,
      valueMinor: effect.valueMinor,
    });
  }
  for (const effect of before) {
    const key = `${effect.itemId}|${effect.condition}`;
    const existing = byKey.get(key);
    const valueMinor =
      effect.valueMinor === undefined && existing?.valueMinor === undefined
        ? undefined
        : (existing?.valueMinor ?? 0n) - (effect.valueMinor ?? 0n);
    byKey.set(key, {
      itemId: effect.itemId,
      condition: effect.condition,
      deltaMilli: (existing?.deltaMilli ?? 0n) - effect.deltaMilli,
      valueMinor,
    });
  }
  return [...byKey.values()]
    .filter((effect) => effect.deltaMilli !== 0n)
    .map((effect) => ({
      itemId: effect.itemId,
      deltaMilli: effect.deltaMilli,
      condition: effect.condition,
      // Inbound value deltas ride along; shrinking consumes the source's
      // own layer inside the engine, so negative deltas carry no value.
      ...(effect.deltaMilli > 0n && effect.valueMinor !== undefined && effect.valueMinor > 0n
        ? { valueMinor: effect.valueMinor }
        : {}),
    }));
}

// ── FIFO valuation (ADR 0015) ──────────────────────────────────────────────

export interface FifoLayer {
  readonly quantityMilli: bigint;
  readonly valueMinor: bigint;
  readonly sourceId: string | null;
}

export interface ItemValuation {
  /** Net on-hand across both buckets (may be negative when oversold). */
  readonly quantityMilli: bigint;
  /** Value of the open layers. */
  readonly valueMinor: bigint;
  readonly layers: readonly FifoLayer[];
  /** Net inventory value moved by each source document (+in / −out). */
  readonly costBySource: ReadonlyMap<string, bigint>;
}

/**
 * Replay one item's movements (ordered, both buckets pooled) into FIFO
 * layers (ADR 0015). Inbound creates layers — at the stored purchase value,
 * at the source's original issue cost when re-entering (voids/corrections),
 * else at `costAt` on the movement date. Outbound consumes its own source's
 * layer first, then front-first; shortfalls (negative stock) fall back to
 * `costAt`. Damage and restock disposals are transfers, not value events.
 */
export function valueInventory(
  movements: readonly StockMovement[],
  costAt: (date: string) => bigint | undefined,
): ItemValuation {
  interface Layer { quantityMilli: bigint; valueMinor: bigint; sourceId: string | null }
  const layers: Layer[] = [];
  const costBySource = new Map<string, bigint>();
  const issuedBySource = new Map<string, { quantityMilli: bigint; costMinor: bigint }>();
  let quantity = 0n;

  const addCost = (sourceId: string | null, delta: bigint): void => {
    if (sourceId === null) return;
    costBySource.set(sourceId, (costBySource.get(sourceId) ?? 0n) + delta);
  };
  const fallbackValue = (quantityMilli: bigint, date: string): bigint =>
    divRoundHalf(quantityMilli * (costAt(date) ?? 0n), QUANTITY_SCALE);
  const consume = (layer: Layer, takeMilli: bigint): bigint => {
    const share =
      takeMilli >= layer.quantityMilli
        ? layer.valueMinor
        : divRoundHalf(takeMilli * layer.valueMinor, layer.quantityMilli);
    layer.quantityMilli -= takeMilli;
    layer.valueMinor -= share;
    return share;
  };

  for (const movement of movements) {
    if (movement.kind === 'damage') continue;
    if (movement.kind === 'disposal' && movement.disposition === 'restock') continue;
    quantity += movement.quantityMilli;

    if (movement.quantityMilli > 0n) {
      let value = movement.valueMinor ?? undefined;
      const remaining = movement.quantityMilli;
      if (value === undefined && movement.sourceId !== null) {
        // Re-entry (void / corrected-down issue): at the original issue cost.
        const issued = issuedBySource.get(movement.sourceId);
        if (issued && issued.quantityMilli > 0n) {
          const take = remaining < issued.quantityMilli ? remaining : issued.quantityMilli;
          const share =
            take >= issued.quantityMilli
              ? issued.costMinor
              : divRoundHalf(take * issued.costMinor, issued.quantityMilli);
          issued.quantityMilli -= take;
          issued.costMinor -= share;
          value = share + (remaining > take ? fallbackValue(remaining - take, movement.date) : 0n);
        }
      }
      if (value === undefined) {
        value = fallbackValue(remaining, movement.date);
      }
      layers.push({ quantityMilli: movement.quantityMilli, valueMinor: value, sourceId: movement.sourceId });
      addCost(movement.sourceId, value);
      continue;
    }

    // Outbound: own source's layers first (exact removal), then FIFO.
    let need = -movement.quantityMilli;
    let cost = 0n;
    if (movement.sourceId !== null) {
      for (const layer of layers) {
        if (need === 0n) break;
        if (layer.sourceId !== movement.sourceId || layer.quantityMilli === 0n) continue;
        const take = need < layer.quantityMilli ? need : layer.quantityMilli;
        cost += consume(layer, take);
        need -= take;
      }
    }
    for (const layer of layers) {
      if (need === 0n) break;
      if (layer.quantityMilli === 0n) continue;
      const take = need < layer.quantityMilli ? need : layer.quantityMilli;
      cost += consume(layer, take);
      need -= take;
    }
    if (need > 0n) {
      cost += fallbackValue(need, movement.date); // negative stock: costAt fallback
    }
    addCost(movement.sourceId, -cost);
    if (movement.sourceId !== null) {
      const issued = issuedBySource.get(movement.sourceId) ?? { quantityMilli: 0n, costMinor: 0n };
      issued.quantityMilli += -movement.quantityMilli;
      issued.costMinor += cost;
      issuedBySource.set(movement.sourceId, issued);
    }
  }

  const open = layers.filter((layer) => layer.quantityMilli > 0n);
  return {
    quantityMilli: quantity,
    valueMinor: open.reduce((sum, layer) => sum + layer.valueMinor, 0n),
    layers: open.map((layer) => ({ ...layer })),
    costBySource,
  };
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
