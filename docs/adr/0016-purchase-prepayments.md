# ADR 0016: Purchase prepayments — supplier deposits

## Status

Accepted.

## Context

The sales side has a complete prepayment story: item `special_order`
policy forces a customer to prepay the full line gross before a sales
order is sent (ADR 0011), item `always`/`when_out_of_stock` policies
require *some* deposit, and deposits sit on the sales order and transfer
to the invoice on send (ADR 0010). The purchase side has no mirror. But
suppliers routinely require *us* to prepay: a percentage down on every
order, or full prepayment for made-to-order / special-order goods. Today
that money can only be recorded as an unapplied outbound payment with no
link to the order it secures.

## Decision

Mirror the deposit machinery onto purchase orders. The primitives already
generalize — a deposit is just credit applied to an order ahead of the
document that owes — so this is mostly widening existing guards plus one
new send gate.

### 1. Purchase orders can request a deposit

`resolveDepositRequest` now accepts `purchase_order` as well as
`sales_order`; a PO's `depositRequiredMinor` records what we have
committed to prepay. Deposits stay a purchase/sales-order concept — bills,
invoices, receipts, and credits still reject a deposit request.

### 2. Outbound payments apply to purchase orders

`validateApplication` routes `purchase_order` like `bill`: settled by
**outbound** payments only (ADR 0012 direction guard). Applying an
outbound payment to a sent PO is the deposit we paid the supplier;
`depositHeld(poId)` reports it, exactly as for sales orders. (The money
arrives after the PO is sent/submitted, since applications require a sent
target — same asymmetry as sales.)

### 3. Two sources of a required purchase deposit

`purchaseDepositFloor(lines, getItem, prepaymentPercentMilli)` returns the
larger of:

- **item-driven**: the full gross of `special_order` lines — the same
  policy that forces customer prepayment now also means "we must prepay
  the supplier for these" (`specialOrderDepositFloor`, reused verbatim);
- **supplier-driven**: `prepaymentPercentMilli` × order total, a new
  optional field on supplier info (ADR 0011's append-only, effective-dated
  snapshot — the plugin seam), e.g. "this supplier wants 50% down".

Sending a purchase order is gated on the floor being covered by its
deposit request, throwing `DEPOSIT_REQUIRED` unless `overrideDeposit` is
passed (gated by the existing `deposit_override` approval action) — the
exact shape of the sales `special_order` gate. The supplier-minimum gate
(ADR 0011) still applies independently with its own `overrideMinimum`.

### 4. Deposits transfer from the PO to the bill

`transferDeposits` is generalized to move held deposits from a source
order onto a just-finalized document, oldest-first, remainder left on the
order. On invoice send it pulls from the source sales order (unchanged);
on **bill** send it pulls from the originating purchase order — resolving
through a receipt when the three-way flow (PO → receipt → bill, ADR 0015)
put a receipt between them. Each move is a reversal plus a fresh
application, so the audit trail shows the deposit following the goods.

### 5. Storage (schema v20)

- `supplier_info` gains `prepayment_percent_milli` (nullable, append-only
  like the rest of the snapshot).

No document/CHECK changes: `documents.deposit_required_minor` already
exists (ADR 0010) and credit applications already target any document.

## Consequences

- Purchase and sales prepayments are now fully symmetric: the same
  `special_order` item flag drives customer-prepays-us and
  we-prepay-supplier, and deposits flow order → owing-document on both
  sides through one code path.
- "How much have we prepaid this supplier, and against which order" is
  answerable from the application ledger; the prepaid amount reduces the
  bill's open balance automatically when it transfers.
- Deferred: line-level prepayments on POs (sales orders have them;
  purchase deposits stay document-level for now) and prepayment posting to
  a supplier-advances asset account (the deposit currently nets against
  A/P when it transfers, like customer deposits net against A/R).
