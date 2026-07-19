# Roadmap: what the spike says is necessary next

This list is derived, not brainstormed: every entry traces to something
the spike demonstrated — a gap the golden scenario pins to the cent, a
hole a screen exposed, or a cost the findings recommend paying down.
Ordering within tiers is by how soon real use would hit the gap.

## Tier 0 — architecture debts to pay before feature work

These are the findings' "change these" items; every Tier 1+ feature gets
cheaper after them.

1. **One write model.** Extract the command layer both engines share so
   features stop being implemented twice (findings cost #1 — the method's
   biggest tax, measured across 21 ADRs). Keep the conformance tests.
2. **Explicit `lineId`s required at the API boundary.** Positional
   revision-line matching (findings cost #5) is the single blocker for a
   document-editing UI. Make `lineId` mandatory on `change` requests,
   version the route, and the editor becomes buildable.
3. **Lookup-table enums in SQLite.** Five full `documents` table rebuilds
   to widen one CHECK constraint (findings cost #2). Do this before the
   next document type, not after.
4. **Build orchestration with dependency hashing** (`tsc -b` project
   references or Turborepo) — stale sibling `dist/` produced phantom type
   errors all spike long (findings cost #4), plus a browser-target build
   of core in CI (the `node:crypto` lesson, ADR 0020).

## Tier 1 — needed for daily use (the UI made these visible)

1. **Document editing.** Blocked on Tier 0 #2, then: revision editor with
   per-line identity, price/quantity changes with the existing
   `LINE_LINKED`/prepayment guards surfaced inline. The APIs all exist.
2. **Recording forms**: payments (with application picking against open
   documents), returns, cash sales/expenses, stock adjustments — every
   write the API has that the UI still lacks. The three-screens-four-holes
   finding says to build these *now*, while each missing read is cheap.
3. **Party, item, and settings management screens** (create/rename,
   supplier terms, BOMs, tax rates, sequences, posting-account mapping,
   approval policy). Today these are CLI/API-only; `GET /sequences` and
   `GET /posting-accounts` reads don't exist yet and will be the next
   holes found.
4. **Pagination and search.** Every list endpoint returns everything;
   fine for a spike file, wrong for year two of a real business.
5. **Printable documents** (invoice/PO as PDF or print-CSS HTML) and
   email-out — an invoice you cannot hand to a customer is a demo.
6. **Audit-log read + screen.** The table exists and is append-only;
   nothing exposes it. Trivial read, high trust value.
7. **Backup/restore commands.** `VACUUM INTO` already runs pre-migration;
   promote it to a user-facing `accounts backup`.

## Tier 2 — accounting correctness (the golden scenario pins each gap)

1. **Unify cash movement as one payment-shaped fact.** `refundCredit`
   moves real money but isn't a `Payment`, so bank reconciliation cannot
   match refund lines — golden scenario ch. 11 demonstrates the exact
   unmatched −33.00 (findings, open gaps).
2. **Shrinkage/write-off posting.** Damage disposal and negative
   adjustments move inventory value without a G/L entry — ch. 9 asserts
   the exact 12.00 discrepancy today.
3. **Retro-costing of negative-stock issues** once the covering receipt
   arrives (currently costed at `costAt` forever).
4. **Fiscal periods**: closing, locked periods, retained-earnings
   rollover (retained earnings is currently derived on the fly — right
   for a spike, wrong across year boundaries).
5. **Tax remittance report** (tax collected vs `sales_tax_payable` by
   period) — the snapshots are all there.
6. **Bill payment runs** (select approved bills, one batch payment out)
   and **partial/split bank matches** (one deposit covering several
   payments) — both are "more suggestion shapes, not new state" per
   ADR 0019's consequences.

## Tier 3 — product and platform

1. **Auth and multi-user** (the server currently trusts everyone), then
   roles aligned with the approval-policy machinery that already exists.
2. **Plugin sandboxing + registry**, and UI contribution points mirroring
   the server's (panels, actions) — the host API is the contract
   (ADR 0018); the demo plugin is the compatibility test.
3. **OpenAPI generation from the route catalog** (`GET /api` is the seed;
   generation belongs in the real project, not hand-maintenance).
4. **Live updates** (SSE/websocket events from the storage layer's
   existing post-transaction event emission) so screens stop refetching.
5. **Multi-currency** (money is already `{amount, currency}` with
   per-currency exponents — the design anticipates it; postings and
   reports do not yet).
6. **Importers** (QuickBooks, generic CSV) and **recurring documents**.
7. **Attachments** (receipts scanned onto bills; the audit story wants it).

## Explicit non-goals until demand proves otherwise

Payroll, e-invoicing mandates, consolidation/multi-entity, and
inventory serial/lot tracking — each is a subsystem, none was probed by
the spike, and all four are plugin-shaped in this architecture.
