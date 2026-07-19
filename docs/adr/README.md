# Architecture decision records

Every feature in this project began as a written design, implemented and
tested against that document before the next began. Read in order, they are
the project's narrative; read individually, each states its context, the
decision, and the consequences — including what was deliberately deferred
and why.

| ADR | Decision |
|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript pnpm monorepo; boring, widely-modifiable technology |
| [0002](0002-integer-money.md) | Money is bigint minor units; floats are lint errors in financial code |
| [0003](0003-append-only-journal.md) | The journal is append-only at the database level; corrections are reversals |
| [0004](0004-document-revisions.md) | Documents are immutable revision stacks with snapshot pricing; "with corrections" tags derive |
| [0005](0005-conversions-and-adjustments.md) | Conversions with line-level links, partial fulfillment, charge corrections with cost floors, free items |
| [0006](0006-links-returns-statements.md) | Link-integrity guards, returns priced at last purchase, customer statements with aging |
| [0007](0007-customer-special-rates.md) | Customer special rates: persist-this-price suggestions, constant/formula rates |
| [0008](0008-payments-terms-posting-parties.md) | Payments & credit application, Net-N terms, ledger posting via account roles, the Party entity |
| [0009](0009-return-policy-rates-approvals.md) | Return conditions & restocking fees, rate expiry/review, quantity price breaks, approval gates |
| [0010](0010-tax-numbering-deposits-api.md) | Sales tax snapshots, auto-numbering, deposits & line-level prepayments, HTTP API + CLI |
| [0011](0011-purchase-side.md) | Purchase orders, source-tagged supplier info (the plugin seam), PO↔SO line links, `special_order` |
| [0012](0012-vendor-bills.md) | Vendor bills & accounts payable; payments gain a direction |
| [0013](0013-complete-transaction-set.md) | Vendor credits, refunds of unapplied credit, cash sales/expenses, supplier statements |
| [0014](0014-inventory.md) | Item kinds, the append-only stock ledger, damage dispositions, BOM assemblies |
| [0015](0015-receipts-and-cogs.md) | Three-way receiving with GRNI, FIFO valuation, COGS posting with graceful degradation |
| [0016](0016-purchase-prepayments.md) | Supplier deposits mirror the sales side; deposits follow the goods PO → bill |
| [0017](0017-reports.md) | P&L, balance sheet, aging summaries, inventory valuation — pure reads |
| [0018](0018-plugin-host.md) | Plugin host v1: connectors, isolated hooks, report contributions — the thesis, demonstrated |
| [0019](0019-bank-import.md) | Bank import & reconciliation: idempotent facts, pure suggestions, reversal-only marks |
| [0020](0020-web-ui.md) | React web UI: core in the browser, bigint-exact wire edge, `/api` alias + `/app` hosting |
| [0021](0021-document-links.md) | The link graph as a first-class read; UI shows every link fact and creates every safe link |
| [0022](0022-family-numbers.md) | Family-shared numbers: single-source documents suffix the root (412 → 412b); multi-source starts fresh |

Recurring patterns worth noticing across the set: **append-only facts with
derived views** (0003, 0004, 0014, 0019), **snapshot-at-write so history
never drifts** (0004, 0010, 0011, 0015), **reversal instead of mutation**
(0003, 0008, 0013, 0019), **seams named before they're needed** (0011 →
0018), and **opt-in accounting via role mapping** (0008, 0010, 0012, 0015).
