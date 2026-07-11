# ADR 0018: Plugin host v1

## Status

Accepted.

## Context

"Plugins are the product" (PLAN.md principle 2) — the elevator pitch is
*the VS Code of accounting*, and every purchase-side ADR since 0011 has
deliberately shaped seams for plugins that don't exist yet: supplier info
is append-only and **source-tagged**, purchase-order submission is "however
that supplier takes orders", reports are pure functions with declared
shapes. This ADR makes the host real and proves the thesis: a plugin
package that extends the system through public API only, with zero core
edits.

## Decision

### 1. Scope: in-process, trusted, bundled

V1 loads plugins as ordinary code in the host process, registered
explicitly at attach time. Sandboxing, third-party loading, permissions,
and UI slots are Phase 2 by design (SPIKE.md cut line) — but the *API
surface* is designed as if they existed: plugins receive a scoped
`PluginHostApi`, never the host's internals, and every capability is an
explicit registration.

### 2. Extension points (v1)

- **Supplier connectors** — one per party: `fetchSupplierInfo()` pulls
  fresh terms which the host records as an ordinary supplier-info snapshot
  with `source = plugin id` (the seam from ADR 0011, closed at last);
  `submitPurchaseOrder(view)` delivers a sent PO to the supplier and may
  return a reference, which is audited.
- **Document lifecycle hooks** — observers on `document.created` /
  `document.sent` / `document.voided`, invoked with the committed
  `DocumentView` *after* the write transaction. Hooks are observers, not
  interceptors: a throwing hook is caught, routed to the host's error sink
  (audited as `plugin.error`), and never breaks the write.
- **Report contributions** — named reports over the book, exposed through
  the same `/reports/…` namespace as ADR 0017's built-ins (built-ins win
  name collisions).

### 3. Shape

`PluginHost<TBook>` lives in core — a registry plus a synchronous event
fan-out with per-listener error isolation. It is generic over the book
type because core cannot depend on storage; `CompanyFile.attachPlugins`
binds a `PluginHost<CompanyFile>`, wires the error sink to the audit log,
and gains:

- `refreshSupplierInfo(partyId)` — connector → recorded snapshot;
- `submitPurchaseOrder(poId, options)` — the ordinary send (every gate
  from ADRs 0011/0016 still applies) followed by connector delivery;
- `runPluginReport(name, params)` and plugin listing.

Registration conflicts (duplicate plugin id, report name, or connector for
a party) fail loudly at attach time with a new `PLUGIN_ERROR` code;
`UNKNOWN_REPORT` covers missing report names.

### 4. Dogfood

`@accounts/plugin-demo-supplier` (workspace `plugins/demo-supplier`)
exercises all three extension points from outside core: it quotes costs,
minimums, and prepayment terms; "submits" purchase orders (returning a
reference); observes sent documents; and contributes a purchase-pipeline
report. Its only dependency is `@accounts/core` types — the proof that the
public API suffices.

## Consequences

- The ADR 0011 promise is kept: supplier knowledge and PO submission now
  actually flow through plugins, with provenance (`source`, audit entries)
  showing exactly what a plugin did to the books.
- Because hooks observe committed state and cannot mutate, plugin failure
  modes are contained: the worst a v1 plugin can do through the hook/report
  surface is read and log. (Connectors write — through the same public,
  append-only, audited methods a human would use.)
- The host API is the contract Phase 2 sandboxing must preserve; keeping it
  small now is what makes that migration plausible.
