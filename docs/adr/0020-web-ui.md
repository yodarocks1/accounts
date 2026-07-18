# ADR 0020: Web UI (React)

## Status

Accepted (spike purview extended by request — WS5 in SPIKE.md).

## Context

Every surface so far — CLI, JSON API, server-rendered dashboard — was
built to prove the *domain* design. Extending the spike to a React UI
tests the last untested claim: that the API contract and the pure core
are genuinely consumable by an interactive client written by someone who
isn't the engine's author. The interesting questions are boundary
questions: does bigint-as-string survive a browser round trip without
precision bugs? Can `@accounts/core` run in a browser unchanged? Does the
route surface have the reads a UI actually needs, or did we design an API
only its own tests can love?

## Decision

1. **One new package, `@accounts/web`: Vite + React + TypeScript strict.**
   React because the ecosystem the "VS Code of accounting" thesis courts
   lives there; Vite because it is boring and fast. No router library, no
   CSS framework, no state manager — a hash-based view switch, one
   stylesheet, and `useState`. The spike is testing boundaries, not
   frameworks.
2. **`@accounts/core` runs in the browser, unchanged.** The web app
   imports `formatMoney`, `parseMoney`, `formatQuantity`, and the domain
   types directly from core — the same zero-core-edits bar the demo
   plugin had to clear (ADR 0018). Money stays `bigint` end to end;
   `Number` never touches an amount (the API client converts the wire's
   string bigints at the edge, both directions).
3. **The JSON API also answers under `/api/*`.** The server strips one
   leading `api` segment before routing — same handlers, same contract.
   The web app always calls `/api/...`, which gives the Vite dev server
   one prefix to proxy and keeps the built app origin-relative (no CORS
   machinery, no configuration).
4. **`accounts serve` serves the built app at `/app`.** `createApiServer`
   gains an optional `webRoot`; when set, `/app/*` serves static files
   from it (path-traversal-safe, SPA fallback to `index.html`). The CLI
   flag is `serve --web <dist-dir>`. The server-rendered dashboard at `/`
   stays — it is the zero-dependency fallback and the API's own demo.
5. **Views v1 (function over form):** Dashboard (balance sheet with the
   BALANCED badge, YTD P&L, A/R + A/P aging, inventory, plugins);
   Documents (list with type filter → detail: lines, totals, tags,
   settlement); Bank (paste-CSV import, ranked match suggestions,
   one-click reconcile/undo — the most interactive write path we have).
   Errors surface the API's stable `error` code, not just prose.
6. **Component tests over mocked `fetch`, in jsdom.** The API contract is
   already integration-tested server-side; UI tests assert rendering and
   interaction wiring (money formatting, reconcile round trip, error
   display) without a live server.

**Cut (recorded):** document creation/editing forms (positional
revision-line matching makes a hand-rolled editor the riskiest possible
UI — see findings #5; a real editor waits for explicit `lineId`s at the
API boundary), auth, routing beyond hashes, optimistic updates, live
refresh, and any component library. These are Phase 2 product work, not
spike questions.

## Consequences

- The bigint-as-string wire contract now has a second consumer, which
  either validates it or finds its edges — both outcomes are spike data.
- `/api/*` is additive; every existing path keeps working. The dashboard,
  CLI, and tests are untouched by the prefix.
- The web package builds with Vite (not tsc), so `pnpm -r build` gains a
  bundler step; `typecheck` still runs plain `tsc --noEmit` there.
- A UI that cannot create documents is honest about why (findings #5) —
  the cut is itself a finding about designing APIs for UIs.
