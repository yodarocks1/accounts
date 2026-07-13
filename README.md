# Accounts (working name)

An open-source, moddable alternative to QuickBooks: a real double-entry
ledger, local-first data you own, and a plugin system as the core
architectural feature — *"the VS Code of accounting."*

**Status: design spike, complete.** Nineteen design-first features (ADRs
0001–0019) implemented, tested, and shipped in sequence. The books run a
real business end to end; a plugin extends the system through public API
with zero core edits. Read the record:

| Document | What it tells you |
|---|---|
| **[docs/SPIKE-FINDINGS.md](docs/SPIKE-FINDINGS.md)** | The conclusions: what the manual-design method bought, what it cost, the verdict |
| [docs/SPIKE.md](docs/SPIKE.md) | The plan the spike ran on: workstreams, cut lines, exit criteria |
| [docs/adr/](docs/adr/README.md) | Nineteen ADRs — every feature's design, written before its code |
| [PLAN.md](PLAN.md) | The full product plan the spike was proving out |

## The five-minute tour

```sh
pnpm install && pnpm build && pnpm test   # 271 tests, all green
```

**The golden scenario** is the demo: one business's story — plugin-quoted
supplier terms, prepayment gates on both sides, PO → receipt → bill with
deposits riding along, assembly builds, an invoice landing revenue + COGS +
deposit in one entry, a damaged return refunded and written off — with the
trial balance asserted balanced after every chapter:

```sh
pnpm --filter @accounts/storage test golden
```

**The CLI**, for hands-on books:

```sh
CLI=packages/cli/dist/main.js
node $CLI init books.sqlite --name "My Business" --currency USD
node $CLI account add books.sqlite --name Cash  --type asset  --code 1000
node $CLI account add books.sqlite --name Sales --type income --code 4000
node $CLI post books.sqlite --date 2026-07-01 --memo "First sale" \
  --debit 1000:1500.00 --credit 4000:1500.00
node $CLI report pnl books.sqlite --from 2026-07-01 --to 2026-07-31
node $CLI report balance-sheet books.sqlite
```

**The plugin thesis**, demonstrated: [plugins/demo-supplier](plugins/demo-supplier/README.md)
quotes supplier costs and terms, submits purchase orders, observes document
events, and contributes a report — depending only on `@accounts/core`.

## What works today

- **Ledger**: integer-money double-entry journal, append-only at the DB
  level, corrections by reversal, full audit log.
- **Documents**: estimates, sales orders, invoices, credit memos, purchase
  orders, receipts, bills, vendor credits — immutable revision stacks with
  snapshot pricing, line-level links, partial conversion/fulfillment,
  corrections and substitutions.
- **Money movement**: payments in and out with direction guards, deposits
  and prepayments on both order types (transferring to the owing document),
  refunds of unapplied credit, cash sales/expenses, statements with aging
  on both sides.
- **Inventory**: append-only stock ledger driven by documents, damage with
  per-item dispositions, BOM assemblies with additive costs, three-way
  receiving with GRNI, FIFO valuation, and COGS posting — all opt-in by
  mapping ledger roles, degrading gracefully otherwise.
- **Reports**: P&L, balance sheet, A/R + A/P aging, inventory valuation —
  pure reads that reconcile to the ledger by construction.
- **Plugins**: in-process host with supplier connectors, isolated document
  hooks, and report contributions.
- **Banking**: idempotent CSV import, suggestion-based reconciliation with
  reversal-only undo.

## Packages

| Package | Purpose |
|---|---|
| `@accounts/core` | The pure domain: money, journal, documents, inventory/FIFO, reports, plugin host. No I/O. |
| `@accounts/storage` | One business = one SQLite file (schema v21). Mirrors the in-memory reference engine; conformance-tested against it. |
| `@accounts/server` | Dependency-free JSON HTTP API over one company file. |
| `@accounts/cli` | `accounts` command: ledger ops, documents, reports, statements, serve. |
| `@accounts/plugin-demo-supplier` | The dogfood plugin — proof the public API suffices. |

Development ritual: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.

## Principles (proven in the spike, kept for the real project)

1. **The ledger is sacred** — append-only facts, derived views, reversal-only
   corrections. The golden scenario never balances the books; they balance
   by construction.
2. **Plugins are the product** — seams are named and source-tagged before
   they're needed; the host API is the contract sandboxing must preserve.
3. **Your data is a file** — SQLite with immutability enforced by triggers,
   pre-migration backups, 21 in-place schema migrations and counting.
4. **Money is exact** — bigint minor units everywhere; floats are lint errors.

What comes next (web UI, sandboxed third-party plugins, multi-currency,
QuickBooks import) is scoped in [PLAN.md](PLAN.md) phases 1–3; what the
real project should do differently is in the
[findings](docs/SPIKE-FINDINGS.md).
