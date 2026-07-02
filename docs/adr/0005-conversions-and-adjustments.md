# ADR 0005: Conversions, fulfillment, charge corrections, and free items

- **Status:** Accepted
- **Date:** 2026-07-02
- **Builds on:** ADR 0004 (document revisions)

## Context

Documents flow into each other — estimate → sales order → invoice — often
partially, and lines get closed, substituted, given away free, or re-charged at
a corrected amount. Each of these must keep the customer-facing story and the
books consistent without ever rewriting history.

## Decision

### Stable line identities and conversion links

Every document line carries a `lineId` that persists across revisions (edits
that carry a line forward keep its id). Conversions are documents created with
a `sourceDocumentId` whose lines carry a `sourceLineId` — line-level provenance
from A to B, just like corrections link revisions.

Allowed conversions: **estimate → sales order**, **estimate → invoice**,
**sales order → invoice**. Only *sent* documents can be converted. Conversions
may be **partial**: any subset of lines, any quantity up to each line's open
quantity. Converted lines keep the source line's snapshot price by default.

### Fulfillment and closures

For each source line: `open = quantity − converted − closed`, where
*converted* sums the quantities of linked lines in non-void conversion
documents, and *closed* sums explicit **closures**. A closure records that a
quantity will never be fulfilled — either `unfulfilled` (dropped) or
`substituted` (something else was delivered instead). Closures are append-only
records with reason and timestamp.

A conversion line may itself be a **substitution** (different item,
description, and/or price — the price may change or stay). Substitute lines
are flagged; a document containing them, or whose lines were closed as
substituted, is tagged **"with substitutions"** (and tags inherit into
downstream documents per ADR 0004).

### Charge corrections ("we charged the wrong amount")

`chargeCorrection(invoice, actualTotal)` applies to sent invoices and may
**only reduce** the total — never increase it. The reduction is allocated
across lines *pro rata* (each line reduced by the percentage difference
between the documented total and the actual amount, exact bigint largest-
remainder arithmetic so the new total matches the actual to the minor unit),
with a **floor per line**: never below `quantity × min(item cost, normal sales
price)` (both resolved from the item's effective-dated history on the document
date). If floors bind, the shortfall is redistributed to lines that still have
room; if the target is unreachable without breaking a floor, the correction is
rejected (`PRICE_FLOOR`) rather than silently mis-booked. Lines without a
catalog item have no cost data and floor at zero. The result is recorded as a
`correction` revision via per-line `adjustment` amounts, so the invoice is
tagged "with corrections" and the original remains in history.

### Free items

A line may be marked **free**. To the customer it appears as free: its
customer-facing amount is zero and other lines show their normal prices. For
record-keeping it is priced at **min(item cost, normal sales price)** on the
document date, and all lines' *recorded* amounts are scaled down
proportionally so the recorded total equals the actual charged total. This
recorded allocation is **derived, not stored** — it is recomputed from the
lines, so it can never drift from the customer-facing truth, and the two
totals are equal by construction.

## Consequences

- Fulfillment status ("what's still open on this sales order?") is a pure
  computation over links and closures — no mutable counters to corrupt.
- Voiding a conversion document automatically returns its quantities to the
  source's open balance.
- Charge corrections require cost data to enforce meaningful floors; items
  without cost records floor at zero.
- Proportional allocation lives in one audited utility
  (`allocateProportional`) shared by charge corrections and free-item
  recording, with property tests for exactness (sums match to the minor unit),
  bounds (never below floor, never above face), and monotonicity.
