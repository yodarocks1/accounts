# ADR 0003: Append-only journal; corrections are reversals

- **Status:** Accepted
- **Date:** 2026-07-01

## Context

Auditability is a core promise (PLAN.md §3.1). If posted history can mutate,
no report is trustworthy after the fact and audit trails are reconstructions
rather than guarantees.

## Decision

- A posted `JournalEntry` is immutable: no UPDATE or DELETE, ever — enforced in
  the core API (no mutation methods exist) *and* by SQLite triggers in storage.
- Corrections create a **reversing entry** that links back to the original via
  `reverses_entry_id`; both remain visible in the ledger.
- Draft documents are editable; posting is the commit point that generates the
  immutable entry.

## Consequences

- Trial balance and reports are reproducible for any point in time.
- "Edit an invoice" in the UI becomes reverse-and-repost under the hood; the
  document layer hides this from users but never from the ledger.
- Storage engines must enforce immutability at the database level, not just in
  application code, so plugins and raw SQL can't corrupt history.
