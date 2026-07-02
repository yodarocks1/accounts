# ADR 0008: Payments, terms, ledger posting, and parties (Tier 1)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Builds on:** ADR 0003 (append-only journal), ADR 0006 (statements, customer identity)

## Part 1 — Payment application

A **Payment** records money received: number, date, customer identity
(name + optional account number + optional PO, per ADR 0006), method, and an
amount. Payments are immutable once recorded; the only transition is `void`.

Credit is **applied** from a source — a received payment or a sent
*account-settled* credit memo (refunds were paid out and can never be
applied) — to specific sent invoices, in append-only `CreditApplication`
records. Undo is a *reversal record*, never an edit. Guards:

- an application must be positive, within the source's remaining unapplied
  amount, and within the invoice's open balance (the remainder stays on
  account — over-application is rejected);
- source and invoice must belong to the same customer (account number when
  both have one, else exact name);
- voiding a payment deactivates every application funded by it.

An invoice's paid/open state is **derived**, never stored:
`paid = Σ active applications from active sources`, `open = max(0, total −
paid)`, `overpaid = max(0, paid − total)` — the overpaid case arises
legitimately when a charge correction (ADR 0005) reduces an already-paid
invoice; the surplus shows as money on account.

Statements gain a payments section and per-invoice paid/open amounts; only
open balances age (settled invoices read "paid"), and the balance becomes
`open invoices − unapplied credit` (unapplied payments + unapplied account
credit memos).

## Part 2 — Payment terms and due-date aging

Revisions carry optional `termsDays` (Net N). The due date is derived —
`date + termsDays` — and aging is measured **from the due date** when terms
exist, else from the invoice date as before. Ages can be negative (not yet
due); aging rules may use negative `minDays` to build "due in the next week"
buckets, and anything below all rules reads "not due".

## Part 3 — Ledger posting

Documents finally post to the double-entry ledger (ADR 0003) through
configurable **posting roles**: `accounts_receivable`, `sales_income`, and
`cash`. When roles are configured:

- sending an invoice posts DR AR / CR income;
- sending an account credit memo posts DR income / CR AR; a refund posts
  DR income / CR cash;
- recording a payment posts DR cash / CR AR; voiding reverses;
- a correction to a sent, posted document **reverses the original entry and
  posts the corrected one in the same transaction** — document history and
  ledger history stay in lockstep (as promised in ADR 0004);
- voiding a posted document reverses its entry.

Posting links live in an append-only `postings` table (source → journal
entry, kind post/reversal). Without configured roles, documents work exactly
as before (books-less mode) — posting activates when the chart of accounts
is ready.

## Part 4 — Parties

A **Party** is the durable customer record: current name (with append-only
rename history), unique optional account number, and default terms. Documents
and payments may reference a `partyId`; when they do, customer name, account
number, and terms default from the party (still snapshotted onto the revision
— historical documents keep the name the customer had at the time). Statement
and rate matching accept a party and resolve through its identity, ending the
"typo splits a customer's history" failure mode. Free-text matching remains
for partyless documents.

## Consequences

- Aging finally means what bookkeepers expect ("past due" = past the *due
  date*), and statements show real open balances.
- Charge corrections interact safely with payments (overpayment is visible,
  not hidden).
- The ledger now reflects sales and receipts; trial balance shows AR.
- Renaming a customer is an event, not a data-loss hazard.
