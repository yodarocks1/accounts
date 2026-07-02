# ADR 0007: Customer special rates

- **Status:** Accepted
- **Date:** 2026-07-02
- **Builds on:** ADR 0004 (snapshot pricing), ADR 0006 (customer identity)

## Context

When a customer is given a special rate on one occasion, the business usually
wants to honor it going forward — but that must be a deliberate choice, not an
accident. And customer pricing comes in many shapes: percentages off list,
markups over cost, flat discounts, or simply "this customer pays $X".

## Decision

### The ask

When a document is sent with a line priced differently from what the system
would have charged (the customer's existing rate if any, else the catalog
price), `suggestSpecialRates(documentId)` reports it: item, customer, the
price charged, the expected price, cost, and a **prefilled proposed rate**
(a constant at the charged price, effective from the document date — the most
common answer). The UI layer presents this as a yes/no prompt with the
below-cost checkbox; accepting calls `setCustomerRate`. Suggestions are
computed, never stored — asking again costs nothing, and once a rate is
saved the same price no longer differs from expectations, so the question
retires itself. Credit memos and free lines never trigger suggestions.

### The rate model

A `CustomerRate` binds (item, customer) — matched by account number when the
rate has one, else by exact customer name — and is one of:

- **constant** — the customer pays this unit price (`unitPrice`);
- **formula** — `base × (100% + percent) + amount`, where `base` is the
  item's **sales price** or **cost** effective on the document date, `percent`
  is a signed scale-3 percentage (−10% = −10 000 milli-percent), and `amount`
  is a signed minor-unit adjustment.

The formula shape natively expresses every requested form:

| Requested | Encoding |
|---|---|
| % discount off sales price | base `sale`, percent −X |
| % markup above cost | base `cost`, percent +X |
| $ amount off sales price | base `sale`, amount −X |
| $ markup above cost | base `cost`, amount +X |
| combination | base + percent + amount together |
| constant value (most common) | kind `constant` |

Combinations across *two* bases (e.g. % off sale plus $ over cost) are not
representable in one rate; that generality wasn't needed and can be added
later as a term list without breaking storage.

### Below-cost guard

Every rate carries `allowBelowCost`. When false, the resolved price floors at
the item's cost on the document date. **Default: false — unless the item's
typical sales price is below its cost on the rate's effective date** (a
deliberate loss-leader), in which case it defaults to true. Resolved prices
also floor at zero unconditionally.

### Application and history

- Rates are **effective-dated, append-only** history, exactly like item
  prices: a new rate supersedes by being newer, nothing is edited.
- When resolving document lines with no explicit `unitPrice`, the pricing
  order is: free-line rule (ADR 0005) → **customer rate** → catalog price.
- Snapshot semantics are unchanged (ADR 0004): rates affect only documents
  written afterwards; a rate created or changed later never touches an
  existing document. Returns still credit the *actually paid* price.
- Formula rates re-resolve against the base on each document's date, so a
  "10% off list" customer automatically follows list-price changes, while a
  constant-rate customer doesn't — both behaviors are expressible.

## Consequences

- One-off favors stop silently becoming precedents: the system asks, the
  answer is recorded, and the audit log shows who granted what and when.
- A cost-based formula requires cost history; setting one without it is
  rejected at save time rather than failing on a future invoice.
- The below-cost default requires cost data to be meaningful; without cost
  records the checkbox defaults to false and no floor can apply.
