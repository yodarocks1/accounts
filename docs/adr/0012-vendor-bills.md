# ADR 0012: Vendor bills, accounts payable, and outbound payments

## Status

Accepted.

## Context

ADR 0011 built purchase orders — commitments to buy. What arrives next in
real life is the supplier's **bill**: the document that actually owes money
and belongs on the books. `CONVERSION_TARGETS.purchase_order` was left
empty as the slot where bills attach, mirroring how sales orders convert to
invoices. Settling a bill also means money flowing **out**, which the
payment machinery (built for customer receipts) cannot yet express.

## Decision

### 1. `bill` joins the document type union

A bill is the purchase-side mirror of an invoice:

- `purchase_order → bill` conversion, using the standard machinery:
  line-level links, partial conversion, fulfillment. A PO's fulfillment now
  reads as "how much of this order has been billed", and only *sent* POs
  can be billed (existing conversion rule). Standalone bills (no PO) are
  ordinary document creation.
- Bills share the purchase pricing path (ADR 0011 part 4): cost-based
  resolution, untaxed lines, no customer rates, no below-cost gate.
  (Recoverable purchase tax / VAT is future work.)
- For a bill, the draft→sent lifecycle reads as **record→approve**: the
  supplier wrote the document; "sending" it finalizes it onto the books.
  A sent bill changes only by `correction` (like an invoice); the PO is
  where substitutions happen.
- Bills never appear on customer statements (statements already filter to
  invoices/credit memos) and never take deposits.

### 2. Payments gain a direction

`Payment.direction: 'in' | 'out'` (default `'in'`, so nothing changes for
existing callers or rows):

- `'in'` — money received from a customer (unchanged behavior).
- `'out'` — money paid to a supplier ("disbursement").

Credit application is direction-checked: **bills are settled only by
outbound payments**, and customer documents (invoices, sales-order
deposits) only by inbound ones. Credit-memo sources remain inbound-only;
vendor credits are future work. Bill settlement state reuses
`invoiceSettlement` unchanged — open/partial/paid/overpaid are
direction-agnostic. Outbound payments are excluded from customer
statements even when the same party is both customer and supplier.

### 3. Accounts-payable posting

Two new posting roles — `accounts_payable` and `purchases_expense` — and
two new posting kinds:

- `bill` (on approval): DR purchases_expense / CR accounts_payable.
- `disbursement` (on recording an outbound payment): DR accounts_payable /
  CR cash.

As with every posting role (ADR 0008), nothing posts until the roles are
mapped; corrections on posted bills reverse-and-repost, and voiding a bill
or outbound payment reverses its entry — all existing machinery.
(Inventory-vs-expense treatment of purchases is deferred to the inventory
ADR; until then purchases post to one expense-side role.)

### 4. Storage (schema v16)

- `documents.type` and `number_sequences.kind` CHECKs gain `'bill'`;
  `posting_accounts.role` gains the two new roles — table rebuilds as
  usual.
- `payments` gains a `direction` column (`DEFAULT 'in'`), frozen by the
  status-only-update trigger like every other payment field.

## Consequences

- The purchase document chain now mirrors the sales chain end to end:
  SO-linked PO → bill → outbound payment, with A/P aging derivable the
  same way A/R is.
- One settlement engine serves both directions; the only asymmetry is the
  direction check at application time.
- Future work this sets up: vendor credits (mirror of credit memos),
  purchase tax, receiving/inventory, and supplier-side statements.
