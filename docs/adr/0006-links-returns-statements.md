# ADR 0006: Link integrity, returns & credits, statements, customer identity

- **Status:** Accepted
- **Date:** 2026-07-02
- **Builds on:** ADR 0004 (revisions), ADR 0005 (conversions & adjustments)

## Part 1 — The plan for keeping line-level links intact

Line-level links (`sourceDocumentId` + `sourceLineId`) must survive every kind
of change the linked documents can undergo. The design rests on five rules:

### 1. Links target identities, never positions or revisions

A link points at a `lineId`, which is a *stable identity* that persists across
revisions of the source document. It never points at "revision 3, line 2".
When a source document is corrected, its lines keep their `lineId`s, so every
inbound link automatically resolves against the *current* revision — readers
see up-to-date content through an unchanged link. Nothing needs rewriting on
either side.

### 2. Substitutions replace content, not identity

An in-document substitution (a sales-order revision of kind `substitution`)
rewrites what a line *is* — item, description, price — but the revised line
inherits the `lineId` of the line it replaces. The `substituted` flag and the
revision history record that the swap happened; links from documents already
issued against that line stay valid and now resolve to the substitute.
A *conversion* substitution (deliver something else on the target document)
creates a new line with its own `lineId` on the target, linked back via
`sourceLineId` — the source line's identity is untouched.

### 3. Consumption can never be orphaned (enforced)

A revision of a document that has been partially converted or closed may not:
- **remove** a line whose quantity has been consumed (converted + closed > 0), or
- **shrink** such a line below its consumed quantity.

`validateLineConsumption` enforces this at every `changeDocument` in every
storage engine. To genuinely retract a promised line, the downstream documents
must first be voided (which returns quantity) or the correction must keep the
line at ≥ the consumed amount. This makes "converted > promised" states
unrepresentable instead of merely unlikely.

### 4. Identities are never reused

A `lineId` retired by a revision stays retired. New lines always get fresh
ids; carrying a line forward positionally (same index, no explicit id) only
reuses the previous id when the previous line exists at that index. Explicit
`lineId`s win over position, and duplicate ids within a revision are rejected.

### 5. Links carry their own document context

Each line stores `sourceDocumentId` alongside `sourceLineId` (conversion lines
inherit the document-level source automatically). Documents whose lines link
to *several* sources — a return crediting items bought across multiple
invoices — resolve unambiguously without a document-level source.

**Invariant (tested):** for every line in every current revision, if
`sourceLineId` is set it resolves to a line in the source document's current
revision, and per-source-line consumption ≤ that line's current quantity.

## Part 2 — Returns and other credits

A **credit memo** is a fourth document type (same revision machinery,
immutability, and tags as invoices; sent credit memos take only corrections).
It carries a `settlement` mode fixed at creation:

- `account` — credits the customer's account (reduces the statement balance);
- `refund` — money was paid back out; listed on statements but not netted.

**Returns:** `createReturn(...)` looks up, per returned item, *the price at
which this customer last purchased it* on or before the return date: the most
recent sent invoice for the customer containing that item, using the line's
customer-facing per-unit price (face + adjustments; a free line yields zero).
The credit line links back to that invoice line (`sourceDocumentId` +
`sourceLineId` — Part 1 provenance, reused). No purchase history and no
explicit price → the return is rejected rather than guessed. Explicit price
overrides are allowed for out-of-band cases.

## Part 3 — Statements

A statement is a **computed view** (never stored): for a customer as of a
date —

- every sent invoice, oldest first, showing the **original amount due first**;
  if corrections exist they appear **directly below** the invoice with the
  corrected totals and reasons;
- an **age label** per invoice from configurable rules (defaults per product
  decision: ≤ 22 days "current", 23–30 "due soon", > 30 "past due");
- all **credits** to the account (returns and other credit memos, with
  settlement mode);
- balance = Σ invoice current totals − Σ `account`-settled credits.

Aging is measured from the invoice's current date to the statement date.
(When payment application lands, statements will age only *open* balances.)

## Part 4 — Customer identity on every transaction

Every document revision **must** carry a `customerName`, and **may** carry an
`accountNumber` and a `poNumber`. They are revision content (correctable,
history-tracked, like everything else). Statements and return lookups match by
`accountNumber` when given, else by exact `customerName`. A first-class
`Party` entity (PLAN §6.3) will replace free-text matching in Phase 1; these
fields then become foreign keys with the same semantics.

## Consequences

- Correcting a sales order that has been partially invoiced can no longer
  silently strand the invoice's links — the guard forces the books to stay
  reconcilable.
- Returns are priced from evidence (the customer's own purchase history), not
  from the current catalog, consistent with "price changes never change past
  transactions".
- Statement layout encodes the correction-transparency rule: customers always
  see what was originally billed and what it became.
