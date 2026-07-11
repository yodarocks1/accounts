# ADR 0017: Financial reports

## Status

Accepted.

## Context

Every subsystem now produces immutable facts — journal entries, document
revisions, applications, stock movements — but the books cannot yet answer
the four questions every owner asks: *did we make money* (P&L), *what do we
own and owe* (balance sheet), *who owes us / whom do we owe, and how late*
(A/R and A/P aging), and *what is the shelf worth* (inventory valuation).

## Decision

Reports are **pure reads** — computed on demand from existing facts, never
stored, in keeping with every derived value in the system (settlements,
stock levels, FIFO layers, tags).

1. **Profit & loss** for a period: per-account nets of income (credit-
   positive) and expense (debit-positive) accounts over entries dated
   within `[from, to]`, reusing `computeTrialBalance` on the filtered
   entries. `netProfit = income − expense`.
2. **Balance sheet** as-of a date: asset nets (debit-positive) against
   liability/equity nets (credit-positive), plus a derived **retained
   earnings** equity row = accumulated income − expense through the date.
   Because the trial balance sums to zero, the sheet balances by
   construction; the report still carries a `balanced` flag as a tripwire.
3. **Aging summaries**, both sides: open sent invoices (customer) or bills
   (supplier) bucketed by the existing aging rules from their due dates,
   grouped per counterparty — the statement machinery's aging semantics
   (settled documents drop out; ages can be negative → "not due") applied
   across the whole book instead of one party.
4. **Inventory summary**: per tracked item, on-hand quantity and FIFO value
   from `itemValuation` (ADR 0015), with a grand total that reconciles to
   the inventory_asset account when the roles are mapped.

P&L and balance sheet live on `CompanyFile` only (the journal lives there);
aging and inventory summaries also exist on `DocumentBook` for conformance.
Amounts assume a single-currency book; multi-currency stays Phase 2
(PLAN.md) and rows carry their currency so nothing is lost.

Exposure: `GET /reports/{pnl,balance-sheet,ar-aging,ap-aging,inventory}`
and `accounts report …` in the CLI.

## Consequences

- The exit-criteria story ("a freelancer can run their real books") is now
  demonstrable end to end: transact all year, then read the four reports.
- Report contributions are one of the plugin host's extension points
  (ADR 0018); this module defines the shape a contributed report returns.
- Nothing new to migrate, freeze, or audit — no schema change.
