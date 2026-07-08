# ADR 0015: Inventory receipts and cost of goods sold

## Status

Accepted.

## Context

ADR 0014 gave stock an append-only movement ledger but deferred two
things: **receiving** as an event distinct from bill approval (goods often
arrive before the supplier's bill), and **valuation** — what the stock on
the shelf is worth, what selling it costs (COGS), and how any of that
reaches the general ledger. Purchases still post to `purchases_expense`
and sales post revenue only, so inventory-heavy books misstate both the
balance sheet (no inventory asset) and the P&L (expense at purchase time,
not at sale time).

## Decision

### 1. `receipt` joins the document type union — the three-way flow

`purchase_order → receipt → bill`, alongside the existing direct
`purchase_order → bill`:

- A receipt records goods physically arriving. It is purchase-side
  (cost-priced, untaxed), converts from a sent PO (consuming the PO's
  fulfillment — a PO is *fulfilled by receiving* when receipts are used),
  and converts onward to a bill. Sending a receipt = "the goods are on
  the dock": stock moves **+good**, valued at the receipt's line prices.
- A bill line whose source line lives in a receipt moves **no stock** —
  the receipt already did. Direct-billed lines keep moving stock at bill
  approval, so both flows coexist on one bill.
- Sent receipts change by correction/substitution (like orders — the
  count on the dock gets corrected); they carry no settlement, take no
  payments, and never appear on statements.

### 2. FIFO valuation, derived from the movement ledger

A pure engine (`valueInventory`) replays an item's movements in order:

- **Inbound movements create layers** `(quantity, value)`. Bill/receipt
  movements carry their actual line value, snapshotted at write time;
  other inbound (adjustments, customer returns, built assemblies, broken
  components) is valued at the item's `costAt` on the movement date —
  which, per ADR 0014, already includes derived BOM costs.
- **Outbound movements consume layers front-first** (FIFO); the consumed
  value is that movement's cost — an invoice's movements are its COGS.
  Layers are tagged with their source document, and an outbound movement
  first consumes its *own source's* remaining layer (so a corrected-down
  bill removes exactly the value it added), then FIFO.
- **Voids and corrections re-enter at original cost**: the engine tracks
  what each source consumed, so a voided invoice's stock returns at the
  cost it left with, not today's cost.
- **Damage and restock-disposals are transfers**, not value events; the
  pool keeps its value until recycle/trash consumes it.
- **Negative stock**: issues beyond available layers are costed at
  `costAt` as a fallback; later receipts do not retroactively re-cost
  them (documented approximation).

`itemValuation(itemId, asOf?)` exposes quantity, total value, and open
layers, as of any date — never stored, always reproducible.

### 3. Posting: inventory asset, COGS, and GRNI

Three new roles — `inventory_asset`, `cogs`,
`goods_received_not_invoiced` — and document entries built by a new
`planDocumentPosting`, one balanced journal entry per document as before:

- **Receipt**: DR inventory_asset / CR goods_received_not_invoiced, at
  line value (posts only when both roles are mapped).
- **Bill**: DR goods_received_not_invoiced for the received portion
  (clearing the accrual), DR inventory_asset for direct-billed inventory
  lines, DR purchases_expense for everything else, CR accounts_payable
  gross.
- **Invoice**: the revenue entry as today, plus DR cogs / CR
  inventory_asset at the engine's FIFO cost for the invoice's movements.
- **Credit memo**: revenue reversal as today, plus DR inventory_asset /
  CR cogs at the restocked value.
- **Vendor credit**: DR accounts_payable gross / CR inventory_asset at
  the FIFO value the return consumed / CR purchases_expense for any
  remainder (price variance).

**Graceful degradation is the compatibility story**: with
`inventory_asset` unmapped, bills post entirely to `purchases_expense`
and invoices post revenue only — exactly the pre-ADR-0015 behavior.
Books opt into inventory accounting by mapping the roles. Corrections
and voids reuse the reverse-and-repost machinery unchanged, and because
postings snapshot the engine's values inside the same transaction that
writes the movements, the inventory account and the FIFO valuation agree.

### 4. Deliberately deferred

Assembly-labor absorption (builds transfer component value only;
`assemblyCostMinor` informs `costAt` estimates but is expensed as
incurred), shrinkage/write-off posting for damage-disposals and negative
adjustments, standard-cost revaluation, and landed costs.

### 5. Storage (schema v19)

- `documents.type` / `number_sequences.kind` CHECKs gain `'receipt'`;
  `posting_accounts.role` gains the three new roles.
- `stock_movements` gains a nullable `value_minor` (the write-time value
  snapshot for bill/receipt inbound movements).

## Consequences

- The classic three-way match (ordered vs received vs billed) is now
  answerable per line, and goods-received-not-invoiced is a real accrual
  instead of a timing hole.
- The P&L shows margin (revenue and COGS in the same period); the
  balance sheet shows inventory at auditable FIFO value that reconciles
  to the movement ledger by construction.
- Everything remains derived from immutable facts: re-running the engine
  over the movement log reproduces every layer, every COGS figure, and
  the inventory account balance.
