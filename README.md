# Accounts (working name)

An open-source, moddable alternative to QuickBooks: a real double-entry
ledger, local-first data you own, and a plugin system as the core
architectural feature — *"the VS Code of accounting."*

**Status: design spike, complete.** Twenty-one design-first features
(ADRs 0001–0021) implemented, tested, and shipped in sequence. The books run a
real business end to end; a plugin extends the system through public API
with zero core edits; a React UI consumes the same JSON API everything
else uses. Read the record:

| Document | What it tells you |
|---|---|
| **[docs/SPIKE-FINDINGS.md](docs/SPIKE-FINDINGS.md)** | The conclusions: what the manual-design method bought, what it cost, the verdict |
| [docs/SPIKE.md](docs/SPIKE.md) | The plan the spike ran on: workstreams, cut lines, exit criteria |
| [docs/adr/](docs/adr/README.md) | Twenty-one ADRs — every feature's design, written before its code |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What's necessary next — every entry traced to spike evidence |
| [PLAN.md](PLAN.md) | The full product plan the spike was proving out |

## The five-minute tour

```sh
pnpm install && pnpm build && pnpm test   # 305 tests, all green
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

## See the end product

```sh
pnpm install && pnpm build   # once
pnpm demo                    # seeds demo.sqlite (first run only), then serves it
```

Open **http://127.0.0.1:3000/app** and try, in order:

1. **Dashboard** — the BALANCED badge is computed, not decorative; below
   it: P&L, balance sheet, A/R + A/P aging, and FIFO inventory from one
   seeded month of business.
2. **Documents → SO-0001** — the links panel: the sales order's family
   (EST-0001 → SO-0001 → INV-0001, plus a cross-linked purchase order),
   per-line upstream/downstream chips, fulfillment (6 of 10 widgets
   billed), and purchase coverage. Click **Convert…** to invoice the open
   4, or **Order from supplier…** to cross-link a new PO.
3. **Documents → PO-0002** — a draft purchase order linked to the sales
   order's open lines. Click **Send** and watch readiness gate against
   the supplier's 50.00 minimum (override checkbox provided).
4. **Bank** — three imported lines match recorded payments at day-offset
   zero; click **Reconcile** on each. The 12.00 SERVICE FEE finds no
   match — that's the system being honest, not broken.
5. **http://127.0.0.1:3000/** — the zero-dependency server-rendered
   dashboard; **http://127.0.0.1:3000/api** — the API's own route
   catalog (77 routes, self-described).

Delete `demo.sqlite` to reseed from scratch. To serve your own books:
`node packages/cli/dist/main.js serve books.sqlite --port 3000 --web packages/web/dist`.

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
- **Web UI**: React app over the JSON API — dashboard, document browsing
  with the full link graph (upstream/downstream per line, family tree,
  fulfillment, coverage, closures), link-creating flows (convert,
  order-from-supplier, close line, send/void), and interactive bank
  reconciliation — with `@accounts/core` running in the browser so money
  stays bigint-exact end to end.

## Packages

| Package | Purpose |
|---|---|
| `@accounts/core` | The pure domain: money, journal, documents, inventory/FIFO, reports, plugin host. No I/O. |
| `@accounts/storage` | One business = one SQLite file (schema v21). Mirrors the in-memory reference engine; conformance-tested against it. |
| `@accounts/server` | Dependency-free JSON HTTP API over one company file, plus a read-only HTML dashboard at `GET /`. |
| `@accounts/cli` | `accounts` command: ledger ops, documents, reports, statements, serve. |
| `@accounts/web` | React + Vite UI over the JSON API; served at `/app` by `accounts serve --web`. |
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

What comes next (document editing in the UI, sandboxed third-party
plugins, multi-currency, QuickBooks import) is scoped in
[PLAN.md](PLAN.md) phases 1–3; what the real project should do
differently is in the [findings](docs/SPIKE-FINDINGS.md).
