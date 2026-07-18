# Spike plan: from here to done

**What this spike is.** A working proof of the *design method* as much as the
product: sixteen ADRs of deliberately written design, each implemented,
tested, and pushed before the next began. The spike ends with (a) a books
engine that runs a real business's story end to end, (b) proof of the
"VS Code of accounting" thesis — extension without touching core — and
(c) a written record of what the manual-design process got right and wrong.

**Deadline.** End of tomorrow. Priorities below are ordered; everything has
an explicit cut line. Function over form: no UI work in the spike.

---

## Where we are (done, tested, pushed)

- **Ledger core** — integer money, balanced double-entry journal,
  DB-trigger immutability, reversal-only corrections (ADR 0001–0003).
- **Document engine** — estimates / sales orders / invoices / credit memos /
  purchase orders / receipts / bills / vendor credits as immutable revision
  stacks; snapshot pricing; conversions with line-level links; partial
  fulfillment; corrections & substitutions; tagging (ADR 0004–0006, 0011,
  0012, 0013, 0015).
- **Money movement** — payments in/out, credit application with direction
  guards, deposits & line-level prepayments on both order types with
  order→owing-document transfer, refunds of unapplied credit, cash
  sales/expenses, customer & supplier statements with aging
  (ADR 0008, 0010, 0013, 0016).
- **Pricing & policy** — customer special rates with tiers/expiry/review,
  return policy with conditions and restocking fees, sales tax snapshots,
  auto-numbering, approval gates on every privileged action
  (ADR 0007, 0009, 0010).
- **Inventory** — item kinds, append-only stock ledger driven by documents,
  damage + per-item dispositions, BOM assemblies with additive costs,
  three-way receiving (PO→receipt→bill) with GRNI, FIFO valuation and COGS
  posting with graceful degradation (ADR 0014, 0015).
- **Supplier seam** — append-only, source-tagged supplier info (costs,
  minimums, shipping estimates, prepayment %) explicitly designed as the
  surface plugins will write through (ADR 0011, 0016).
- **Surfaces** — `@accounts/storage` (SQLite, schema v20, conformance-tested
  against the in-memory reference), JSON HTTP API, CLI. 252 tests.

## Workstreams to completion (in priority order)

### WS1 — Reports (ADR 0017) · *the books must answer questions*
Pure reads over what exists; no new state.
- P&L for a period; balance sheet as-of (retained earnings derived, always
  balances by construction of the trial balance).
- A/R aging and A/P aging summaries per counterparty (reusing the statement
  machinery and aging rules).
- Inventory valuation summary (per-item FIFO quantity/value).
- CLI `report …` + `GET /reports/…`.
**Cut line:** none — this ships.

### WS2 — Plugin host v1 (ADR 0018) · *the thesis of the project*
In-process, bundled-plugin host proving extension without core changes:
- `PluginHost` with typed extension points: **supplier connectors**
  (fetch supplier terms → recorded with `source = plugin id`; submit
  purchase orders), **document lifecycle hooks** (observe created/sent/
  voided), **report contributions** (named reports over a read facade).
- CompanyFile integration: events emitted inside the existing write paths;
  `refreshSupplierInfo(partyId)` and `submitPurchaseOrder(poId)` drive the
  connector seam designed back in ADR 0011.
- A real bundled plugin package (`@accounts/plugin-demo-supplier`)
  dogfooding all three extension points.
**Cut line:** sandboxing, third-party loading, UI slots — Phase 2 by design.

### WS3 — Bank import + reconciliation (ADR 0019) · *time-boxed*
- CSV import → append-only `bank_transactions`; import batches idempotent
  by (date, amount, reference) hash.
- Match suggestions against payments by amount/date window; append-only
  reconciliation marks (unmatch = reversal record, as everywhere else).
**Cut line:** OFX parsing, auto-reconcile rules, bank feeds. If the clock
runs out, WS3 drops entirely — it exercises no novel design.

### WS5 — Web UI (ADR 0020) · *purview extended after WS4 shipped*
- React + Vite `@accounts/web`, added when the spike's scope was widened
  to test the last unconsumed boundary: a real interactive client on the
  JSON API. Core runs in the browser; money stays bigint end to end.
- Views: dashboard (reports), documents (list/detail), bank
  reconciliation (import → suggest → confirm → undo).
- `/api/*` alias + `serve --web <dist>` static hosting keep the whole
  demo on one origin, one process.
**Cut line:** document editing forms — blocked on findings #5 (positional
line matching) by design, and recorded as such.

### WS4 — Golden scenario + findings · *the spike's actual deliverables*
- One narrative end-to-end test telling a full business story across every
  subsystem (quote→order→deposit→PO→receipt→bill→invoice→payment→return→
  refund→reports), asserting the books balance at every step.
- `docs/SPIKE-FINDINGS.md`: what the manual-design method (ADR-per-feature,
  reference implementation + conformance testing, append-only-everything)
  bought us, what it cost, and what we'd change.
**Cut line:** none — findings are the point of a spike.

## Exit criteria

1. `pnpm lint && pnpm typecheck && pnpm build && pnpm test` green at HEAD.
2. The golden scenario runs the whole story on one SQLite file and the
   trial balance is balanced at every checkpoint.
3. A plugin extends the system through public seams only — zero core edits.
4. ADRs 0001–0019 (± WS3) form a complete, honest design record; FINDINGS
   states conclusions a reader can act on.

## Deliberately out of spike scope

~~Web UI shell~~ (purview extended → WS5, ADR 0020),
plugin sandboxing/registry, QuickBooks import, multi-currency,
recurring transactions, payroll, e-invoicing, multi-user/Postgres — all
recorded in PLAN.md phases 1–3 with their existing rationale.
