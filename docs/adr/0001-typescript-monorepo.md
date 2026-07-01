# ADR 0001: TypeScript end-to-end in a pnpm monorepo

- **Status:** Accepted
- **Date:** 2026-07-01

## Context

The project's differentiator is its plugin ecosystem (PLAN.md §7). The language
choice determines who can write plugins and contribute to core. Candidates were
TypeScript (Node), Rust (with WASM plugins), and Python.

## Decision

TypeScript end-to-end: core domain, storage, server, CLI, plugin SDK, and web UI
all in one language, organized as a pnpm workspace monorepo.

## Consequences

- Largest possible contributor and plugin-author pool; one language from plugin
  manifest to UI component.
- Plugins and core share types directly; the plugin SDK is just a package.
- We give up Rust-level performance and memory safety in the core. Ledger hot
  paths may be rewritten in Rust behind the same interface if profiling ever
  demands it (PLAN.md §15.5).
- bigint is used for money to escape JS float semantics (see ADR 0002).
