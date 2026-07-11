# ADR 0019: Bank import and reconciliation

## Status

Accepted (time-boxed scope per SPIKE.md WS3).

## Context

The books record what we *believe* happened; the bank records what
*actually* happened. Reconciliation — matching bank lines to recorded
payments — is the daily ritual that keeps them honest. The spike needs the
minimal, correctly-shaped version: import, suggest, confirm, undo.

## Decision

1. **Bank transactions are append-only imported facts.** CSV import
   (`date,amount,description[,reference]`, signed decimal amounts) into
   `bank_transactions`, keyed by a per-source dedupe key
   (date|amount|description|reference) with a UNIQUE constraint — re-importing
   an overlapping export is idempotent by construction and reports
   imported vs skipped. Rows are frozen by triggers like every other fact.
2. **Matching is a pure suggestion, never an action.** A bank line matches
   a payment when the signed amount agrees with the payment's direction
   and magnitude, the payment is received and unreconciled, and the dates
   fall within a window (default ±3 days). Suggestions are ranked by day
   offset; ambiguity is returned, not resolved.
3. **Reconciliation marks are append-only and reversal-undone** —
   the credit-application pattern verbatim: a mark links one bank line to
   one payment (amount/direction re-validated at write time,
   `ALREADY_RECONCILED` guards both sides); unreconciling appends a
   reversal record. Derived state, never a status column.

Parsing and matching live in core (`bank.ts`, pure); persistence in
`CompanyFile` (schema v21); `POST /bank/import`, `GET /bank/transactions`,
`GET /bank/suggestions`, `POST /bank/reconcile`, `POST
/bank/reconcile/:seq/reverse`.

**Cut (recorded):** OFX/QIF/CAMT parsing, auto-reconcile rules, creating
payments *from* bank lines, bank feeds, multi-column CSV mapping UI. The
shapes here (source-tagged imports, pure matcher) are where plugins attach
those later.

## Consequences

- "Which recorded payments never hit the bank" and "which bank lines have
  no book entry" are now first-class queries — the two questions
  reconciliation exists to answer.
- One payment reconciles to one bank line; partial/split matching is
  future work and will arrive as more suggestion shapes, not new state.
