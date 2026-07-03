# ADR 0011: The purchase side — purchase orders, supplier terms, special orders

## Status

Accepted.

## Context

Everything so far is sales-side: estimates, sales orders, invoices, credit
memos. The business also *buys*: goods are ordered from suppliers, often to
satisfy specific sales-order lines ("special orders"), and often accumulated
in a draft order until the supplier's minimum order size is met or shipping
becomes cheaper in bulk.

Plugins are a first-class architectural requirement (PLAN.md). On the
purchase side they will eventually:

- **submit purchase orders** to a supplier, however that supplier's process
  works (EDI, web portal, email, API…);
- **supply live supplier data**: item costs, shipping time and cost
  estimates, minimum order sizes — all varying by supplier, by their stock
  at the time, and by preferred shipping method;
- feed **estimate derivation**: one day a customer estimate could quote
  delivery time and cost from supplier data.

This ADR builds the non-plugin machinery and the seams those plugins will
plug into. The plugin registry itself stays deferred.

## Decision

### 1. `purchase_order` joins the document type union

A purchase order is a document like any other: immutable revisions,
snapshot pricing, auto-numbering, line identity, fulfillment, closures.
Rather than a parallel structure, `purchase_order` joins `DOCUMENT_TYPES`
and reuses all of it.

- The revision's `customerName` field holds the **counterparty** name — for
  purchase documents, the supplier. `partyId` links to the supplier's Party
  record. (The field keeps its name; renaming it across every table and API
  would churn the whole codebase for zero behavior.)
- Draft purchase orders are freely editable — this is the "accumulate lines
  until the order is worth sending" state. Sent purchase orders change only
  by `correction` or `substitution`, exactly like sent sales orders
  (suppliers substitute too).
- `CONVERSION_TARGETS.purchase_order = []` for now. Vendor bills /
  accounts-payable are future work; when they land, a purchase order will
  convert to a bill the way a sales order converts to an invoice.
- Purchase orders never post to the ledger — they are commitments, not
  transactions. (Bills will post, against an `accounts_payable` role.)
- Statements are customer documents and already filter to
  invoices/credit memos; purchase orders never appear on them. Credit
  applications keep targeting invoices and sales orders only.

### 2. Suppliers are Parties

No new entity. A party becomes a supplier the moment supplier info is
recorded against it. One party can be both customer and supplier.

### 3. Supplier info — the plugin seam

Append-only, source-tagged snapshots of what we know about ordering from a
supplier, keyed by party:

```
SupplierInfo {
  partyId, infoSeq, source,      // 'manual' or a plugin id
  asOf,                          // date the info was observed
  currency,
  minimumOrderMinor?,            // order value floor
  minimumOrderQuantityMilli?,    // order quantity floor
  shipping: [{ method, costMinor?, freeAboveMinor?, minDays?, maxDays? }],
  items: [{ itemId, unitCost, supplierSku?, inStock?,
            minQuantityMilli?, multipleQuantityMilli?, leadDays? }],
  notes?
}
```

- **Append-only**: newer snapshots supersede older ones; history is kept
  (supplier stock and pricing genuinely change between quotes, and "what
  did we know when we ordered" matters). `supplierInfoAt(partyId, date)`
  returns the newest snapshot observed on or before `date`;
  `supplierInfo(partyId)` the latest.
- **`source`** is the seam: today a human types `'manual'` entries; later a
  plugin records snapshots under its own id (and a `SupplierConnector`
  plugin interface will wrap `recordSupplierInfo` + `sendDocument`).
  Nothing in the core ever needs to change for that.
- Costs here are *supplier quotes*; the item's own cost history (ADR 0005)
  remains the books' cost of record. PO pricing consults both (below).

### 4. Purchase-order pricing

PO lines are priced at **cost**, not sales price. Resolution order:

1. explicit `unitPrice` on the line;
2. the supplier's latest quoted `unitCost` for the item (from supplier info
   effective on the document date);
3. the item's cost history (`costAt`);
4. otherwise an error — same rule as sales lines with no price source.

As always, the resolved price is snapshotted onto the line; later quotes
never reach back. PO lines carry no sales tax (`taxCode` null), no customer
rates, and no below-cost gate (a purchase at less than our recorded cost is
good news, not a policy breach).

### 5. PO lines link to sales-order lines

A PO line may carry `sourceDocumentId`/`sourceLineId` pointing at a
**sales-order line** — the same line-link vocabulary as conversions and
returns (ADR 0005/0006), but *without* a record-level source: a purchase
order is not converted *from* a sales order, and one PO may aggregate lines
from many sales orders (that is the point of accumulating an order).

- **Guard**: cumulative linked quantity across non-void purchase orders may
  not exceed the sales-order line's quantity (mirror of the return guard).
  Ordering extra for stock is an *unlinked* line on the same PO.
- **Coverage query**: `purchaseCoverage(salesOrderId)` reports, per line,
  how much is on order — split into draft (accumulating) and sent —
  and what remains unordered. This is how the user sees which promised
  special orders still need purchasing.
- Because PO links are provenance, not consumption, they do not feed the
  sales order's `fulfillment()` (invoicing does). A sales-order revision
  that removes/shrinks a line with linked purchases is rejected the same
  way consumed lines are (`LINE_LINKED`) — a PO must not silently point at
  nothing.

### 6. Deposit policy `special_order`

Items can now declare `depositPolicy: 'special_order'`: they are ordered
from a supplier per sale and **must be prepaid**. Enforcement is stronger
than `always`:

- `always` / `when_out_of_stock`: sending the sales order requires *some*
  deposit request (ADR 0010 part 3) — unchanged.
- `special_order`: the deposit request must cover **the full gross amount
  (incl. tax) of the special-order lines**. `specialOrderDepositFloor`
  computes the floor; sending with a smaller request throws
  `DEPOSIT_REQUIRED`. The existing `overrideDeposit` escape (gated by the
  `deposit_override` approval action) still applies.

(The money itself arrives after sending, as line-level prepayments —
applications require a sent target, ADR 0010 part 3. The gate is on the
*requirement*, which is what the customer signs.)

### 7. Minimum-order gating on send

`purchaseOrderReadiness(id)` evaluates a PO against the supplier's info
effective on the PO date and returns a structured report:

- order total vs `minimumOrderMinor`;
- total quantity vs `minimumOrderQuantityMilli`;
- per-item `minQuantityMilli` / `multipleQuantityMilli` (case packs).

`{ ready, shortfalls: [{ kind, message, … }] }` — with no supplier info on
file, a PO is trivially ready. `sendDocument` on a purchase order throws
`MINIMUM_NOT_MET` (listing the shortfalls) unless `overrideMinimum` is
passed; the override is gated by the new `minimum_order_override` approval
action. Drafts accumulate lines through ordinary edits until ready.

### 8. Storage (schema v15)

- `documents.type` and `number_sequences.kind` CHECKs gain
  `'purchase_order'`; `items.deposit_policy` gains `'special_order'` —
  all table rebuilds (SQLite cannot alter CHECKs), foreign keys off with
  `foreign_key_check` after, as in v4/v11/v12.
- New append-only tables `supplier_info`, `supplier_info_shipping`,
  `supplier_info_items` with the usual immutability triggers.

## Consequences

- One document engine serves both sides of the business; every invariant
  (immutability, snapshots, link guards, numbering, approvals) applies to
  purchasing for free.
- Supplier knowledge is durable data with provenance, not plugin state —
  the books can always answer "why did we order 12 and pay 9.40".
- Estimate derivation (delivery quotes from `leadDays` + shipping
  estimates) becomes a pure read over supplier info when we want it.
- Vendor bills, receiving, and inventory remain future ADRs; the PO's
  empty conversion-target list is where bills will attach.
