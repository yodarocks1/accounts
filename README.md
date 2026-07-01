# Accounts (working name)

An open-source, moddable alternative to QuickBooks: a real double-entry ledger,
a modern UI, local-first data you own, and a plugin system as the core
architectural feature — "the VS Code of accounting."

**Status:** Planning. Read the full plan and outline in **[PLAN.md](PLAN.md)**.

## At a glance

- **Open source** end-to-end (AGPL core, MIT plugin SDK) — no open-core paywalls
- **Moddable**: custom fields, document types, reports, UI, integrations, and
  per-country tax packs, all via a versioned plugin API
- **Local-first**: one business = one SQLite file; or self-host the multi-user
  server with Postgres
- **Accountant-grade**: append-only journal, audit log, property-tested ledger
- **Escape hatch from QuickBooks**: importers with trial-balance verification

## Roadmap (summary)

| Phase | Milestone |
|---|---|
| 0 | Ledger engine, schema, API/CLI — balanced books, proven by tests |
| 1 | v0.1 alpha — invoices, bills, bank import, core reports, web UI |
| 2 | v0.5 beta — public plugin API, sandboxed plugins, QuickBooks import, desktop + server builds |
| 3 | v1.0 — plugin registry, report builder, automation rules, stable API promise |

See [PLAN.md](PLAN.md) for architecture, data model, plugin system design,
licensing/governance, and open questions.
