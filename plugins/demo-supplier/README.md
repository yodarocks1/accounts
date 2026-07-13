# @accounts/plugin-demo-supplier

The dogfood plugin (ADR 0018): proof that the public API is enough to
extend the system, because this package depends on `@accounts/core` types
only and never touches core internals.

## What it does

- **Quotes supplier terms.** `fetchSupplierInfo()` returns costs, order
  minimums, and prepayment requirements; the host records them as an
  ordinary append-only supplier-info snapshot with `source =
  'demo-supplier'` — so the books always show *which plugin* said a part
  costs 9.00.
- **Submits purchase orders.** After the host runs the ordinary gated send
  (minimums, prepayment floors, approvals — a plugin cannot skip them),
  `submitPurchaseOrder(view)` delivers the order and returns a reference,
  which the host audits.
- **Observes document events** (`document.sent`) — hooks see committed
  state and cannot mutate; a throwing hook is audited, never breaks a write.
- **Contributes a report** (`demo.purchase-pipeline`), served under the same
  `/reports/…` namespace as the built-ins.

## Writing your own plugin

A plugin is a manifest plus an `activate` function that makes explicit
registrations:

```ts
import type { AccountsPlugin } from '@accounts/core';

export function myPlugin(): AccountsPlugin {
  return {
    manifest: { id: 'my-plugin', name: 'My Plugin', version: '0.1.0' },
    activate(api) {
      api.registerSupplierConnector({ partyId, fetchSupplierInfo, submitPurchaseOrder });
      api.onDocumentEvent('document.sent', (view) => api.log(`saw ${view.number}`));
      api.registerReport({ name: 'my.report', run: (book) => ({ ... }) });
    },
  };
}
```

Attach it to a company file:

```ts
const host = new PluginHost<CompanyFile>();
host.register(myPlugin());
file.attachPlugins(host);
```

Rules of the road (enforced by the host):

- One plugin id, one connector per party, one report per name — conflicts
  throw `PLUGIN_ERROR` at registration, not at 2 a.m.
- Hooks are observers. Writes happen only through the same public,
  append-only, audited methods a human uses.
- v1 is in-process and trusted (bundled plugins). The API surface is the
  contract Phase 2 sandboxing preserves — build against it, not around it.
