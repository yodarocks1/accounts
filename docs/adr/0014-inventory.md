# ADR 0014: Inventory — item kinds, stock ledger, damage, assemblies

## Status

Accepted.

## Context

Items so far carry a manual `inStock` boolean and no quantities. Real
operations need: tracked stock levels; damaged goods that are then resold,
recycled, or trashed *depending on the item*; items built from other items
(a full box, half-box, and single piece of the same product are different
items; a kit is 12 of one item and 1 of another) with **additive costs plus
an optional assembly cost**; and service items that have no stock at all.

## Decision

### 1. Item kinds

`Item.kind: 'inventory' | 'non_inventory' | 'service'`, fixed at creation:

- **`non_inventory`** (default — every existing item): physical but
  untracked; the manual `inStock` flag keeps working exactly as today.
- **`inventory`**: quantities are tracked by the stock ledger below;
  `inStock` is **derived** (good on-hand > 0) and `setItemStock` is
  rejected — the `when_out_of_stock` deposit policy now reacts to real
  levels automatically.
- **`service`**: no stock semantics at all; always "in stock". Services
  can still carry price/cost history — which lets a service be a BOM
  component (labor priced into a kit).

### 2. The stock ledger

Stock is never stored as a level. It is an **append-only movement log**
(mirroring the journal): signed quantities against one of two buckets,
`good` or `damaged`; on-hand is a derived sum, as-of any date.

Movements come from:

- **Documents** (automatic, inventory items only): approving/sending moves
  stock — invoice −good, bill +good, credit memo +good for `unopened`
  returns and +damaged otherwise, vendor credit −good. Orders and
  estimates are commitments and move nothing. **Voiding** a document
  writes the opposite movements; a **correction** that changes quantities
  on a sent document writes the delta. The movement log is thus always
  consistent with the current revision of every sent document.
- **Adjustments** (`adjustStock`): signed manual counts ("initial count",
  "cycle count found 3 fewer"). Negative adjustments are shrinkage
  write-offs and are gated by a new `stock_write_off` approval action.
- **Damage** (`markDamaged`): moves quantity good → damaged (two rows,
  one event). Bounded by good on-hand.
- **Disposition** (`disposeStock`): resolves damaged stock per the item's
  policy — `restock` (damaged → good, e.g. repackaged), `recycle`, or
  `trash` (both remove it). Each item declares which dispositions it
  allows (`dispositions`, default all three) — food can forbid restock,
  electronics can forbid trash. Recycle/trash are write-offs and share
  the `stock_write_off` gate. Bounded by damaged on-hand.
- **Assembly** (below): building consumes components, breaking returns
  them.

Sales may drive good on-hand **negative** (overselling/backorder is a
fact to record, not to hide); operational acts on stock we claim to hold
(damage, disposition, assembly) are bounded by the relevant bucket and
throw `INSUFFICIENT_STOCK`.

### 3. Assemblies — bills of materials

An item may have a **BOM**: append-only, effective-dated versions (like
prices and supplier info) of `{ components: [{itemId, quantityMilli}],
assemblyCostMinor }`.

- **Additive cost**: `costAt` resolves an item's cost as — explicit cost
  history first (a deliberate override always wins), else the BOM
  effective on that date: Σ(component `costAt` × quantity) +
  `assemblyCostMinor`, recursing through nested BOMs (a pallet of boxes
  of pieces). Cycles are rejected at `setBom` time (`BOM_CYCLE`) and
  guarded again at resolution. Because this flows through the existing
  `costAt` seam, snapshot pricing, below-cost gates, cost-based customer
  rates, and free-item valuation all see assembly costs with no changes.
- **Build / break**: `buildAssembly(item, qty)` consumes each inventory
  component's good stock (bounded) and produces the item;
  `breakAssembly` is the exact inverse — how a full box becomes twelve
  sellable pieces. Non-inventory and service components contribute cost
  only, never stock. Only inventory items can be built or broken.
- Selling a box does **not** auto-break pieces; kitting-on-demand is
  future work.

### 4. What this deliberately defers

- **Inventory valuation** (FIFO/average, inventory-asset + COGS posting):
  purchases keep posting to `purchases_expense` (ADR 0012). The movement
  log is exactly the input that valuation will need.
- Auto-kitting, receiving distinct from bill approval (ADR 0012's
  simplification stands: bill approval = ownership = stock in), stock
  reservations against sales orders, multi-location.

### 5. Storage (schema v18)

- `items` gains `kind` (CHECK) and `dispositions` (JSON array, null =
  all).
- New append-only `stock_movements` (signed `quantity_milli`, bucket,
  kind, provenance, immutability triggers) and `item_boms` /
  `item_bom_components` tables.

## Consequences

- "How many do we have" is auditable: every unit on hand traces to a
  document, count, damage event, disposition, or build — and on-hand can
  be reconstructed as of any date.
- Box/piece/kit pricing stays honest automatically: change a piece's
  cost and every assembly's derived cost follows, while documents keep
  their snapshots (ADR 0004 unchanged).
- The `when_out_of_stock` deposit policy and stock-aware supplier
  reorder decisions (purchase coverage, ADR 0011) now rest on real
  quantities for tracked items.
