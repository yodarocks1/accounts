# ADR 0004: Document revisions, corrections, and price snapshots

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

Business documents (estimates, sales orders, invoices) sit above the ledger
(ADR 0003) and face the outside world: once an invoice has been *sent* to a
customer, silently editing it destroys trust and breaks the paper trail. At the
same time, real corrections do happen and users must be able to make them
without losing what was originally sent. Catalog price changes are a related
hazard: repricing an item must never rewrite a document that was already issued.

## Decision

### Documents are stacks of immutable revisions

A document is an identity (`id`, `type`, `number`, `status`, provenance) plus an
append-only list of **revisions**. Every content change — lines, dates,
counterparty, memo — is a new revision; revisions are never updated or deleted
(enforced by DB triggers, like the journal). Looking up a document returns the
**latest revision** as its current content, plus derived tags and the full
history.

### Edit policy per document type

| Type | Before sending (`draft`) | After sending (`sent`) | Tag on lookup |
|---|---|---|---|
| Estimate | free edits | free edits — but every change is a revision in the visible history | none (history only) |
| Sales order | free edits | only `correction` or `substitution` revisions, chosen explicitly by the caller | "with corrections" / "with substitutions" |
| Invoice | free edits | only `correction` revisions | "with corrections" |

`void` documents accept no further revisions. Draft-phase edits are recorded as
`edit` revisions and do not trigger any tag.

### Tag derivation and inheritance

Tags are **derived, never stored as user-editable state**: a document is "with
corrections" iff any post-send revision of kind `correction` exists (analogously
for substitutions). A document created *from* another (invoice from a sales
order) snapshots the source's tags at creation time as **inherited tags** — an
invoice generated from a corrected/substituted sales order is marked the same
way, even though the invoice itself was never edited.

### Prices snapshot into documents

Items carry an append-only, effective-dated price history. When a line is added
to a document, the unit price is **copied** into the revision (either given
explicitly or resolved from the price effective on the document date). Changing
an item's price appends a new price record and touches nothing else — past
documents and posted journal entries are unaffected, no matter what, including
retroactive `effectiveFrom` dates.

### Interaction with the ledger (Phase 1)

When invoice posting lands, a `correction` to a posted invoice will reverse the
original journal entry and post a fresh one (ADR 0003 machinery) in the same
transaction as the revision — document history and ledger history stay in
lockstep, and neither ever mutates.

## Consequences

- "What did we send the customer on March 3rd?" is always answerable exactly.
- Quantities need exact fixed-point handling in financial code: quantities are
  bigint thousandths (scale 3), line totals round half-up at the final step.
- Storage cost of full-revision copies is accepted; documents are small and the
  auditability is the product.
