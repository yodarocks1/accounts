# ADR 0010: Sales tax, auto-numbering, deposits, and the document API (Tier 3)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Builds on:** ADR 0004 (snapshots), ADR 0008 (payments, posting, parties)

## Part 1 — Sales tax

Tax rates are **append-only, effective-dated history** keyed by a code
(`setTaxRate('TX-STATE', 8.25%, from …)`), exactly like item prices. Items
carry a default tax code; lines resolve `line.taxCode ?? item.taxCode` and
**snapshot the percent** effective on the document date into the line — a
later rate change never touches an issued document, the same rule as prices.
`taxCode: null` on a line forces no tax; a tax-exempt party (or a per-document
`taxExempt` override) suppresses codes entirely.

Computation: taxable customer amounts are grouped by (code, percent) and each
group's tax rounds half-up **once per group** — fewer rounding disputes than
per-line. Views expose `subtotal` (pre-tax), `taxTotal`, `taxBreakdown`, and
`total` — which is now the **grand total** everywhere money moves: settlement,
statements, credit capacity, and posting. Documents without tax codes behave
exactly as before (tax 0).

Returns copy the purchase line's tax snapshot, so a credit refunds the tax the
customer actually paid. Charge corrections keep targeting the **pre-tax
subtotal**; the snapshotted percents recompute tax from the corrected lines
(a tax-inclusive entry point is a UI conversion, not a core concern).

Posting gains a `sales_tax_payable` role: an invoice posts DR AR (grand) /
CR income (subtotal) / CR tax payable (tax); credits reverse the same split.
Jurisdiction *rules* (what's taxable where) remain plugin territory per the
plan — this is the plumbing they target.

## Part 2 — Auto-numbering

Per-kind **number sequences** (estimate, sales order, invoice, credit memo,
payment): prefix + zero-padded counter (`INV-0001`), stored and incremented
transactionally. `number` becomes optional on every create; omitted numbers
draw from the sequence, explicit numbers still work (uniqueness enforced as
before). No sequence and no number is an error, not a guess.

## Part 3 — Deposits and prepayments on sales orders

A sales order may carry a **deposit request** — a flat amount or a percent of
the grand total, resolved and snapshotted onto the revision. Payments (and
account credits) can now be **applied to sent sales orders** up to their grand
total; that held money is the deposit. When an invoice converted from the
order is **sent**, held deposits transfer automatically: each application is
reversed off the order and re-applied to the invoice, oldest first, up to the
invoice's open balance — the paper trail shows both movements.

**Item deposit policies:** an item may require a deposit `always`, or
`when_out_of_stock` (against a manually maintained `inStock` flag until real
inventory tracking lands — documented placeholder). Sending a sales order
containing a requiring item without a deposit request is rejected
(`DEPOSIT_REQUIRED`) unless overridden — and `deposit_override` is an
approvable action like the rest of ADR 0009's gates.

Deposits held are visible via `depositHeld(orderId)`; accounting-wise they
ride the existing payment posting (DR cash / CR AR) — reclassifying held
deposits as a customer-deposit liability is deferred to the inventory/period
work.

## Part 4 — The document API (CLI + REST)

`@accounts/server` exposes the whole document layer as a dependency-free JSON
HTTP API over a company file: items, parties, tax rates, sequences, documents
(create/change/send/void/convert/close-line/charge-correction/suggestions/
fulfillment), returns, payments, applications, statements, rate review, and
the trial balance. Monetary amounts travel as **strings** in JSON (bigint has
no JSON form; precision survives). Errors map `LedgerError` codes to HTTP
statuses with the code in the body.

The CLI gains document commands (`item`, `doc list/show/send`, `statement`)
and `accounts serve <file>` to launch the API — the first non-library surface
for everything built since Phase 0.

## Consequences

- Tax follows every invariant documents already obey: snapshotted, immutable,
  derived-on-view, zero-cost when unused.
- "Amount due" now means grand total in every money path; pre-tax figures are
  explicitly named `subtotal`.
- Deposits reuse payment application wholesale — no new money mutation paths,
  and the transfer is two auditable application records, not an edit.
