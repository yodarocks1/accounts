# ADR 0022: Family-shared document numbers

## Status

Accepted.

## Context

Every document draws its number from a per-type sequence, so one
transaction's paper trail reads EST-0412 → SO-0007 → INV-0031 — three
unrelated-looking numbers for one continuous deal. The link graph
(ADR 0021) knows they belong together; the numbers should say so too. The
requested scheme: a transaction that begins as Estimate #412 continues as
Sales Order #412b; if it takes two invoices to bill the order, they are
#412c and #412d. A document drawing on multiple sources is a genuinely
new transaction and gets a fresh number.

## Decision

1. **A single-source document inherits its family's number.** At
   creation, when no explicit number is given: if the document's sources
   (its document-level source plus every line-level link) name exactly
   one document *on the same side*, its number is the family base plus
   the next letter. Zero same-side sources or two-plus → the type
   sequence, as before. An explicitly provided number always wins —
   numbering is a default, never a constraint.
2. **Sales and supply sides number separately.** Sales documents
   (estimate, sales order, invoice, credit memo) and purchase documents
   (purchase order, receipt, bill, vendor credit) never share a family
   number. A special-order PO cross-linked to a sales order is a new
   supply-side transaction: it draws the PO sequence, and *its* receipts
   and bills suffix the PO's number (PO-0001 → PO-0001b → PO-0001c).
   Cross-side links are references, not lineage — the link graph
   (ADR 0021) still shows the connection; the numbers name the side's
   own paper trail, matching how counterparties see it (your customer
   never learns your PO numbers, your supplier never sees your invoice
   numbers).
3. **The base is derived from the source's number, not the graph.** Strip
   a trailing lowercase suffix when a digit precedes it ("412b" → "412";
   "EST-0412" stays itself), so chains extend the root rather than
   stacking letters ("412b" begets "412c", never "412bb"). Deriving from
   the number rather than the connected component keeps merged families
   sane: a multi-source document starts a new base, and its descendants
   suffix *that*.
4. **Letters are assigned monotonically.** The root is the unsuffixed
   number (an implicit "a"); the next member takes the letter after the
   highest suffix in use anywhere in the books ("b", …, "z", "aa", …,
   bijective base 26). Voided members and explicitly numbered members
   keep their letters — gaps are possible, collisions are not.
5. **The family scan crosses type boundaries within a side** (number
   uniqueness is per-type, but a family spans types by definition), so a
   receipt and a bill converted from PO-0001 become PO-0001b and
   PO-0001c — the number records where the transaction started, which is
   the point.

This applies uniformly to conversions (estimate→SO→invoice, PO→receipt→
bill) and returns (credit memo linked to one invoice). The
implementation is three pure functions in core (`family-numbers.ts`)
called at the single number-resolution point of each engine, with each
engine supplying the same-side predicate (`isPurchaseType`).

**Cut (recorded):** renumbering existing documents (numbers are
snapshots; history does not drift — ADR 0004 applies to numbers too),
and per-family sequence configuration (the letter scheme is fixed; if a
business needs different family numbering, that's a future numbering
policy, and this ADR is where its default is written down).

## Consequences

- A printed document set for one deal now sorts and groups by number in
  any external system (email, filing cabinet, spreadsheet).
- The type prefix of a family number names the *root* type ("EST-0412c"
  is an invoice whose transaction began as an estimate). This is
  deliberate: the prefix records provenance, and the document's own type
  is always printed beside its number.
- Existing files are unaffected: numbers already issued never change,
  and new members of old families suffix the source's number exactly as
  they would a fresh one.
- Sequences advance only for family roots, so sequence numbers stop
  encoding "how many invoices exist" — they now count transactions
  begun, which is the more meaningful figure.
