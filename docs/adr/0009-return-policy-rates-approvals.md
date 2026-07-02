# ADR 0009: Return policy, rate hygiene, price breaks, approvals (Tier 2)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Builds on:** ADR 0006 (returns), ADR 0007 (rates), ADR 0008 (parties)

## Part 1 — Return guards and policy

**Quantity guard:** cumulative returns against a purchase line may never
exceed the quantity purchased. Enforced on credit-memo creation and revision
via the line links (ADR 0006) — the same consumption-guard pattern as
conversions.

**Conditions:** every returned item carries a condition — `unopened`,
`opened`, or `damaged` — stored on the credit line.

**Restocking fees:** company policy maps each condition to a fee (percent of
the line's credit and/or a flat amount) — `unopened` typically carries the
lowest fee. Fees are applied as the line's `adjustment` (the same customer-
visible reduction machinery as charge corrections), clamped to [0, line
amount], and per-item overrides are allowed.

**Return window:** policy may set `windowDays`; returning an item whose
purchase is older is rejected unless explicitly overridden — and the override
is an approvable action (Part 3).

## Part 2 — Rate hygiene and quantity price breaks

- Rates gain `effectiveTo`: an expired rate ends special pricing (fall back
  to catalog, not to older rates — predictability over cleverness).
- A rate of kind `revoked` explicitly ends a customer's special pricing from
  its effective date, appended like any other rate.
- **Quantity price breaks:** a rate may carry tiers, each with a threshold
  (`minQuantityMilli`: "10 or more") and/or an exact-multiple condition
  (`multipleQuantityMilli`: "full boxes of 12 / pallets of 480 only" — the
  line quantity must be an exact multiple). Each tier prices via the same
  constant/formula shapes. Among the base rate and all tiers applicable to
  the line's quantity, the **lowest resulting price wins** (customer-
  favorable and deterministic); the rate-level below-cost checkbox applies to
  every candidate.
- Suggestions now report the margin of the given price
  (`marginPercentMilli`, when cost is known), and `rateReview` lists every
  customer's special pricing with current sale price, cost, resolved price,
  and margin — the "who has special pricing and is it still sane" report.

## Part 3 — Approvals

A company-level **approval policy** names privileged actions that require an
`approvedBy` identity: `charge_correction`, `below_cost_sale` (a non-free
line priced under the item's cost on a sales document), `void_document`,
`close_line`, and `return_window_override`. Gated operations without an
approver are rejected (`APPROVAL_REQUIRED`); the approver lands in the audit
log. This is deliberately not user management — it's the enforcement point
that roles/permissions will plug into later.

## Part 4 — Pre-migration backup

Opening a company file that needs migration first snapshots it with
`VACUUM INTO` (a consistent copy even under WAL) to
`<file>.v<N>.backup[.<timestamp>]`. A failed table rebuild can no longer
cost anyone their books.

## Consequences

- Returns get real-world policy teeth without new mutation paths: fees are
  adjustments, conditions are line facts, windows are date math.
- Special pricing becomes reviewable and endable; box/pallet pricing is
  expressible without a separate mechanism.
- Sensitive actions gain a named human, cheaply, before real RBAC exists.
