# Project Plan: An Open-Source, Moddable QuickBooks Alternative

**Working name:** *Accounts* (final name TBD — see [Open Questions](#15-open-questions))
**Status:** Planning
**Last updated:** 2026-07-01

---

## 1. Vision

Small-business accounting software is dominated by closed, subscription-priced,
cloud-locked products. QuickBooks in particular is the de-facto standard, yet its
users routinely hit walls: forced migrations to subscriptions, no real data
ownership, a closed extension marketplace, and pricing that punishes accountants
managing many small clients.

**We are building a double-entry accounting platform that is:**

1. **Open source** — the full product, not an open-core teaser. You can self-host
   it, audit it, and never lose access to your books.
2. **Moddable at every layer** — a plugin system is a *first-class architectural
   requirement*, not a bolted-on afterthought. Custom fields, custom documents,
   custom reports, custom workflows, custom integrations — all without forking.
3. **Local-first, cloud-optional** — a single business's books live in one
   portable file/database you own. Sync and multi-user hosting are features, not
   prerequisites.
4. **Accountant-grade** — a real immutable double-entry ledger underneath a
   small-business-friendly UI. Bookkeepers should trust it; owners shouldn't need
   to understand debits and credits to use it.

**Elevator pitch:** *"The VS Code of accounting"* — a solid, opinionated core with
an extension ecosystem that adapts it to any business, jurisdiction, or workflow.

---

## 2. Prior Art & Positioning

| Project | What it does well | Gap we fill |
|---|---|---|
| GnuCash | Mature double-entry, desktop, free | Dated UX, no web/multi-user, weak extensibility |
| Ledger / hledger / beancount | Plain-text, scriptable, auditable | CLI-only; not usable by non-technical owners |
| Akaunting | Web UI, app marketplace | Key features paywalled; open-core friction |
| Bigcapital | Modern web QuickBooks-alike | Limited plugin story, young ecosystem |
| ERPNext / Odoo | Full ERP, huge scope | Heavyweight; overkill and complex for SMB books |
| Firefly III | Great personal finance | Not built for business accounting (AR/AP, invoicing) |
| Manager.io | Excellent SMB desktop UX | Closed source |

**Positioning:** the depth of GnuCash + the UX of modern SaaS + the extensibility
of VS Code/Obsidian, under a license that keeps hosted forks honest.

---

## 3. Guiding Principles

1. **The ledger is sacred.** Every financial event is a balanced journal entry in
   an append-only journal. Corrections are reversals, never mutations. Everything
   else (invoices, bills, reports) is a view or a workflow *around* the ledger.
2. **Plugins are the product.** Core stays small; even "built-in" features
   (invoicing, bank import, reports) are implemented as bundled plugins using the
   same public API third parties get. If the API can't build our own features, it
   isn't good enough.
3. **Your data is a file.** One business = one SQLite database you can copy,
   back up, encrypt, and open on another machine. No export needed to leave.
4. **Money is exact.** Integer minor units (or exact decimal) everywhere. No IEEE
   floats in any financial code path, ever. Enforced by lint rule and code review.
5. **Boring technology, stable API.** Choose widely-known tools; version the
   plugin API semantically; never break mods casually.
6. **Compliance is pluggable.** Tax rules, payroll, and jurisdiction-specific
   logic live in plugins so the core stays universal and community members can
   maintain their own country's rules.

---

## 4. Scope

### 4.1 In scope (feature parity targets vs. QuickBooks)

- Chart of accounts, general ledger, journal entries
- Customers, vendors, products & services
- Sales: estimates → invoices → payments → deposits; credit memos
- Purchases: bills, bill payments, vendor credits, expense records
- Banking: account import (CSV/OFX/QIF/CAMT), transaction matching, reconciliation
- Sales tax: rates, groups, tax codes, liability reporting (rules via plugins)
- Reports: P&L, balance sheet, cash flow, trial balance, AR/AP aging, GL detail,
  custom report builder
- Multi-currency with realized/unrealized gain handling
- Basic inventory (FIFO cost tracking; advanced inventory = plugin territory)
- Attachments/receipts on any record
- Multi-user with roles/permissions (server mode)
- Full audit log
- QuickBooks migration (QBO/QBXML/IIF/CSV import)

### 4.2 Explicit non-goals (for core; plugins welcome)

- Payroll processing (huge compliance surface — plugin per jurisdiction)
- Payment processing (Stripe/GoCardless/etc. as plugins)
- Bank feed aggregation service (Plaid/GoCardless/SimpleFIN connectors as plugins)
- Time tracking, CRM, e-commerce, POS — integration points, not core features
- Tax *filing* with government agencies

---

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Clients                                                    │
│   • Web app (React)   • Desktop shell (Tauri, wraps web)    │
│   • CLI (admin/scripting)   • Third-party apps via API      │
├─────────────────────────────────────────────────────────────┤
│  API Layer — REST + webhooks, OpenAPI-generated clients     │
├─────────────────────────────────────────────────────────────┤
│  Plugin Host — loads/sandboxes plugins, routes hooks,       │
│  registers custom entities, UI slots, report definitions    │
├──────────────┬──────────────────────────────────────────────┤
│  Core Domain │ Bundled Plugins (same public API)            │
│  • Ledger    │ • Invoicing        • Bank import/matching    │
│  • Accounts  │ • Bills/Expenses   • Reconciliation          │
│  • Parties   │ • Standard reports • Sales tax (per-country) │
│  • Documents │ • Inventory (FIFO) • QuickBooks importer     │
│  • AuthZ     │                                              │
├──────────────┴──────────────────────────────────────────────┤
│  Storage — SQLite (single-user/local) or PostgreSQL         │
│  (server/multi-user) behind one repository interface        │
└─────────────────────────────────────────────────────────────┘
```

### 5.1 Deployment modes (one codebase)

1. **Desktop app** (Tauri): local SQLite file, no server needed. The "buy it once,
   own your books" mode QuickBooks Desktop users are losing.
2. **Self-hosted server** (Docker): Postgres, multi-user, web UI — the QBO
   replacement.
3. **Hosted SaaS** (by us or anyone): same server image. AGPL keeps improvements
   flowing back.

### 5.2 Technology choices (proposed)

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript end-to-end | Largest contributor/modder pool; one language for core, plugins, and UI |
| Server runtime | Node.js (Fastify) | Boring, stable, well-documented |
| Web UI | React + Vite | Ecosystem, plugin UI-component story |
| Desktop | Tauri 2 | Small binaries, wraps the web UI, Rust shell |
| DB | SQLite + PostgreSQL via Drizzle ORM | Local-first + scalable server from one schema |
| Money math | Integer minor units + `dinero.js`-style utility lib | Exactness (Principle 4) |
| Plugin sandbox | In-process for trusted/bundled; isolated worker (`isolated-vm`/WASM) for untrusted | Safety without killing DX |
| API | REST + OpenAPI, webhooks | Codegen for client SDKs; scripting-friendly |
| Monorepo | pnpm workspaces + Turborepo | Standard TS monorepo tooling |

> Alternative considered: Rust core with WASM plugins — better perf/safety, but
> dramatically smaller modding community and slower feature velocity. TypeScript
> wins on ecosystem; revisit hot paths later if profiling demands it.

---

## 6. Core Data Model

### 6.1 Ledger (the foundation)

- **Account** — node in the chart of accounts tree. Type ∈ {Asset, Liability,
  Equity, Income, Expense} + subtypes. Currency-denominated.
- **JournalEntry** — balanced set of ≥2 **JournalLines** (account, amount in minor
  units, direction, currency + FX rate, memo, dimensions). Append-only: posted
  entries are never updated or deleted, only **reversed**.
- **Period** — soft/hard close dates; posting into closed periods requires
  privilege + creates audit trail.
- **Dimensions** — class/location/project tags on lines (extensible by plugins).

### 6.2 Documents (business layer)

Invoices, bills, payments, credit memos, etc. are **Documents**: structured
records with lifecycle state (`draft → sent/posted → paid/void`) that *generate*
journal entries when posted. Documents are editable in draft; sending/posting is
the commit point. Plugins can define entirely new document types with their own
posting rules.

**Revision & correction semantics (ADR 0004):** a document is an append-only
stack of immutable revisions; lookup shows the latest revision plus derived
tags and full history.

- **Invoices** cannot be edited after they are sent. Post-send changes are
  recorded as *correction* revisions; lookup shows the up-to-date content
  tagged **"with corrections"**.
- **Sales orders** behave the same, except post-send revisions are explicitly
  either *corrections* or *substitutions* ("with corrections" / "with
  substitutions"). An invoice generated from such a sales order inherits its
  tags at creation.
- **Estimates** may be changed at any time, but every change lands in the
  visible revision history.
- **Price changes never change past transactions, no matter what.** Item prices
  are effective-dated, append-only history; documents snapshot the unit price
  into each line when the line is written.

**Conversion & adjustment semantics (ADR 0005):**

- Estimates convert to sales orders or invoices; sales orders convert to
  invoices. Conversions may be **partial** and carry **line-level links**
  (`sourceLineId`) from target back to source. Lines may be explicitly
  **closed** — unfulfilled or with a substitution — and substitutions may
  change the price or keep it.
- **Charge corrections** on sent invoices only ever reduce the total; the
  reduction spreads pro rata across lines but never takes a line below
  `quantity × min(item cost, sales price)`.
- **Free items** show as free to the customer but are recorded at
  min(cost, sales price), with all recorded amounts scaled so the recorded
  total equals what was actually charged.

### 6.3 Parties & items

- **Party** — unified contact (customer and/or vendor roles), addresses, terms,
  default accounts, currency.
- **Item** — product/service with income/expense/inventory account mappings and
  optional stock tracking.

### 6.4 Extensibility in the schema

- Every entity carries a JSON `custom_fields` column, with plugin-registered
  typed field definitions (validated, indexed where declared, surfaced in UI and
  reports).
- Plugins may create their own namespaced tables via a migration API.
- Global **event log** (entity created/updated/posted/…) that plugins subscribe to.

---

## 7. The Plugin System (the differentiator)

### 7.1 What a plugin can do

| Extension point | Examples |
|---|---|
| **Hooks/events** | `document.beforePost`, `journal.posted`, `bank.transactionImported`, cron schedules |
| **Custom entities & fields** | Add "PO Number" to invoices; define a whole new `WorkOrder` document type |
| **UI slots** | Dashboard widgets, extra tabs on record pages, custom pages, list-view columns, menu items |
| **Reports** | New report definitions against a stable read-model/query API |
| **Importers/exporters** | Bank formats, e-invoicing (UBL/Peppol, ZUGFeRD), payroll journals |
| **Integrations** | Payment providers, bank feeds, e-commerce, CRM sync via API + webhooks |
| **Tax/compliance packs** | Country VAT/GST rules, digital filing formats |
| **Automation** | Rules engine actions ("when a bank line matches X, categorize as Y") |
| **Theming** | Design tokens, invoice/PDF templates (user-editable templates too) |

### 7.2 Anatomy

```
my-plugin/
├── plugin.json        # manifest: id, version, apiVersion, permissions, UI slots
├── src/index.ts       # activate(ctx) entry point — VS Code-style
├── src/ui/            # React components for declared UI slots
└── migrations/        # optional namespaced tables
```

```ts
export function activate(ctx: PluginContext) {
  ctx.hooks.on('document.beforePost', async (doc) => { /* validate/augment */ });
  ctx.ui.registerWidget('dashboard', MyWidget);
  ctx.reports.register(myAgingVariantReport);
  ctx.fields.register('invoice', { key: 'po_number', type: 'string', label: 'PO #' });
}
```

### 7.3 Safety & trust model

- **Manifest-declared permissions** (which entities, network access, UI slots);
  shown to the user at install time.
- **Bundled/trusted plugins** run in-process; **third-party plugins** run in an
  isolated worker with a capability-based API — no ambient filesystem/network.
- **The ledger invariant is non-negotiable:** no plugin can post an unbalanced
  entry or mutate posted history. The core enforces this below the plugin API.
- **Semantic API versioning** with a documented deprecation policy (≥2 minor
  versions of warning) and a compatibility test suite plugins can run in CI.

### 7.4 Distribution

- Phase 1: install from local path / URL / GitHub release.
- Phase 2: community registry (static index repo, signed packages) + in-app
  browser. No gatekeeping beyond malware review; no revenue cut required.

---

## 8. Migration from QuickBooks

A first-class, obsessively-tested onramp — this determines adoption.

- **Importers:** QuickBooks Desktop (IIF, QBXML via company-file export tools),
  QuickBooks Online (export CSVs + API where feasible), and generic CSV mapping.
- **Import scope:** chart of accounts, customers/vendors, items, open invoices &
  bills, historical transactions, attachments where obtainable.
- **Verification report:** post-import trial balance diffed against the source's
  trial balance, per-account — imports must *prove* they balanced.
- Also: GnuCash, Wave, and Xero importers (community-friendly plugin projects).

---

## 9. Security, Privacy, Compliance

- Audit log on every write (who, what, when, before/after) — required for
  accountant trust.
- At-rest encryption option for local SQLite files (SQLCipher).
- Server mode: argon2 password hashing, TOTP 2FA, session management, role-based
  permissions (Owner / Accountant / Bookkeeper / Read-only / custom roles).
- No telemetry by default; opt-in, documented, and aggregate-only if ever added.
- Threat model doc for the plugin sandbox before third-party plugin support ships.

---

## 10. Testing Strategy

- **Property-based tests on the ledger:** every generated operation sequence must
  leave the books balanced; trial balance always sums to zero.
- **Golden-file accounting scenarios:** curated business scenarios (with
  accountant review) whose reports must match known-correct outputs to the cent.
- **Plugin API contract tests** shipped as a reusable harness for plugin authors.
- **Migration tests** against a corpus of sample QuickBooks exports.
- E2E (Playwright) for critical flows: invoice→payment→reconcile→report.
- CI gate: no financial-path merge without tests; float-in-money lint rule.

---

## 11. Roadmap

### Phase 0 — Foundation (months 0–2)
- [ ] Finalize name, license, governance docs (this plan → ratified)
- [x] Monorepo scaffold, CI, lint rules (incl. no-float-money), ADR process
- [x] Core schema v0: accounts, journal, audit log (parties & documents: Phase 1)
- [x] Ledger engine with property-based test suite (`@accounts/core`)
- [x] SQLite storage with DB-level immutability triggers (`@accounts/storage`)
- [x] CLI: init / account add|list / post / reverse / entries / trial-balance (`@accounts/cli`)
- [ ] Minimal REST API (`@accounts/server`)
- **Exit criteria (met via CLI):** can create a company file, post balanced
  entries, and produce a correct trial balance.

### Phase 1 — Usable books (months 2–6) → **v0.1 alpha**
- [ ] Web UI shell: chart of accounts, journal entry, register views
- [x] Document revision machinery: estimates, sales orders, invoices with
      correction/substitution tagging and snapshot pricing (ADR 0004)
- [x] Conversions with line-level links, partial fulfillment, closures,
      charge corrections with cost floors, free items (ADR 0005)
- [x] Link-integrity guards, returns & credit memos with last-purchase
      pricing, customer statements with aging, customer/PO identity on all
      transactions (ADR 0006)
- [x] Customer special rates: persist-this-rate suggestions after send,
      constant/formula rates (% or $ off sale / over cost), below-cost
      checkbox with loss-leader default (ADR 0007)
- [x] Payments & credit application, terms with due-date aging, ledger
      posting via account roles, Party entity (ADR 0008)
- [x] Return policy (conditions incl. unopened, restocking fees, window,
      quantity guard), rate expiry/revocation/review, quantity price
      breaks incl. exact multiples, approval gates, pre-migration
      backups (ADR 0009)
- [ ] Documents: bills, payments; invoice posting to the ledger (as bundled plugins)
- [ ] CSV/OFX bank import + manual reconciliation
- [ ] Core reports: P&L, balance sheet, trial balance, AR/AP aging
- [ ] Plugin host v1 (in-process, bundled plugins only) — dogfooding the API
- **Exit criteria:** a freelancer can run their real books on it.

### Phase 2 — Moddable (months 6–10) → **v0.5 beta**
- [ ] Public plugin API v1: hooks, custom fields, UI slots, report registration
- [ ] Third-party plugin loading with sandbox + permissions
- [ ] Sales tax framework + first two country packs (e.g., US sales tax, UK VAT)
- [ ] QuickBooks importer with trial-balance verification
- [ ] Multi-currency; Tauri desktop build; Docker server w/ Postgres + multi-user
- **Exit criteria:** an external developer ships a working plugin without
  touching core; a real business migrates off QuickBooks.

### Phase 3 — Ecosystem (months 10–15) → **v1.0**
- [ ] Plugin registry + in-app browser
- [ ] Custom report builder; automation/rules engine
- [ ] Inventory (FIFO), estimates/credit memos, period close workflow
- [ ] Webhooks, OpenAPI SDKs, accountant multi-client view
- [ ] Docs site: user guide, plugin dev guide, API reference, migration guides
- **Exit criteria:** 1.0 = stable plugin API v1 covered by compatibility promise.

### Post-1.0 candidates
Bank feed connector plugins (SimpleFIN/GoCardless/Plaid), payroll plugin
framework, e-invoicing (Peppol/ZUGFeRD), mobile receipt capture, sync/multi-device
for desktop mode, AI-assisted categorization (local-model-friendly, opt-in).

---

## 12. Licensing & Governance

- **Core + bundled plugins: AGPL-3.0.** Anyone can self-host or offer hosting,
  but hosted modifications must be shared. Protects against the classic
  "cloud vendor strips-mines the project" failure mode.
- **Plugin SDK/API types & client SDKs: MIT/Apache-2.0**, so proprietary and
  commercial plugins are explicitly allowed and safe to build. (License boundary
  documented so plugin authors have certainty.)
- **CLA: none.** Use DCO sign-offs; the project stays un-relicensable-by-fiat,
  which builds contributor trust.
- Governance: BDFL-with-maintainers to start; documented RFC/ADR process; move
  to a foundation/steering council if the community grows enough to need it.
- Sustainability options (later): paid hosted offering, support contracts,
  certified-accountant directory, sponsorships — never feature-gating the core.

---

## 13. Repository Layout (target)

```
accounts/
├── PLAN.md                    # this document
├── docs/
│   ├── adr/                   # architecture decision records
│   ├── plugin-dev/            # plugin author guide
│   └── accounting/            # ledger semantics, posting rules
├── packages/
│   ├── core/                  # ledger engine, domain model (no I/O)
│   ├── storage/               # SQLite/Postgres repositories, migrations
│   ├── server/                # Fastify API, auth, plugin host
│   ├── plugin-sdk/            # public plugin API (MIT-licensed)
│   ├── web/                   # React app
│   ├── desktop/               # Tauri shell
│   └── cli/
├── plugins/                   # bundled first-party plugins
│   ├── invoicing/
│   ├── bills/
│   ├── bank-import/
│   ├── reports-standard/
│   ├── tax-us-sales/
│   └── importer-quickbooks/
└── examples/
    └── example-plugin/        # canonical third-party plugin template
```

---

## 14. Success Metrics

- **Correctness:** zero known ledger-integrity bugs in any release.
- **Migration:** QuickBooks import produces a matching trial balance on ≥95% of
  test corpus files without manual fixes.
- **Moddability:** ≥10 third-party plugins within 6 months of API v1; every
  bundled feature built on the public API.
- **Adoption:** real businesses running real books (tracked via opt-in registry
  and community reports, not telemetry).

## 15. Open Questions

1. **Name** — "Accounts" is a placeholder; needs a trademark-checked name before
   public launch.
2. **First tax jurisdictions** — proposal: US sales tax + UK VAT first; confirm
   based on early-community geography.
3. **Plugin UI isolation** — iframe-based vs. shared-React-runtime for untrusted
   plugin UI (safety vs. look-and-feel); prototype both in Phase 2.
4. **Sync protocol for desktop mode** — CRDT vs. server-authoritative for
   multi-device local-first; defer until post-1.0 but keep schema append-friendly.
5. **Rust rewrite of ledger hot paths** — only if profiling shows need.

---

*Next step: ratify this plan (or amend via PR), then start Phase 0 with the
monorepo scaffold and the ledger engine + property-based tests.*
