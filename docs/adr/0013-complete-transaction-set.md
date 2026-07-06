# ADR 0013: Completing the transaction set

## Status

Accepted.

## Context

With ADR 0012 the document chains mirror each other (SO→PO→bill, payments
in both directions), but an audit against what a real business records
daily shows four remaining holes:

1. **Vendor credits** — the supplier credits us (return to supplier,
   rebate, billing error). Deferred in ADR 0012; without it, a supplier
   credit can only be faked with a corrected bill.
2. **Refunds of on-account credit** — a customer overpays or holds an
   account credit and wants money back. Today that balance can only sit
   or be applied; there is no "cut them a check" primitive.
3. **Cash sales and cash expenses** — the counter sale (invoice + payment
   in one motion, QuickBooks' "sales receipt") and its purchase mirror
   (bill + disbursement, an "expense"). Expressible today as three calls;
   they deserve one atomic one.
4. **Supplier statements / A/P aging** — customers get aged statements;
   "what do we owe, and how old is it" has no equivalent.

Out of scope, deliberately: bank deposits & reconciliation (banking
phase), inventory receipts/adjustments (inventory ADR), recurring
transactions (automation/plugins), transfers (a plain journal entry).

## Decision

### 1. `vendor_credit` joins the document type union

The purchase-side mirror of a credit memo:

- Shares the purchase pricing path (cost-based, untaxed) and the
  correction-only rule once sent. Carries a `settlement` mode like a
  credit memo: `'account'` (apply against bills) or `'refund'` (the
  supplier paid the credit out in cash).
- Becomes a third **credit-application source kind**. Its direction is
  `'out'`, so the ADR 0012 direction guard already routes it: vendor
  credits apply to bills only, never to customer documents.
- The cumulative-return guard extends to vendor credits: lines may link
  to bill lines, and linked returns may never exceed the quantity billed
  (same rule as customer returns against invoices).
- Posting: account credit DR accounts_payable / CR purchases_expense;
  refund credit DR cash / CR purchases_expense.

### 2. Refunds of unapplied credit

`refundCredit(sourceKind, sourceId, amount, …)` pays out (part of) a
credit source's **unapplied** balance:

- Recorded as a credit-application row with `refund = true` and **no
  target document** (`invoiceId` becomes nullable). Refunds consume the
  source's remaining balance exactly like applications, are reversible
  the same way, and disappear from "money on account" on statements
  (listed under a separate `refundedAmount`).
- Works in both directions, posting by the source's direction:
  - inbound source (customer payment, account credit memo):
    DR accounts_receivable / CR cash (`refund_out`);
  - outbound source (supplier disbursement, account vendor credit):
    DR cash / CR accounts_payable (`refund_in`).
- Money leaving the till is gated by a new approval action,
  `refund_credit`.

### 3. Cash sales and cash expenses

`recordSalesReceipt(...)` = create invoice (Net 0) → send → record an
inbound payment for the grand total applied in full, atomically;
returns `{ invoice, payment }`. `recordExpense(...)` is the purchase
mirror: bill → approve → outbound payment. These are **conveniences over
existing primitives, not new document types** — the books show an
ordinary paid invoice/bill plus its payment, statements and posting all
behave normally, and nothing new needs to be learned to correct one.

### 4. Supplier statements

`computeStatement` gains a `side` (`'customer'` default): the supplier
side reads bills for invoices, vendor credits for credit memos, and
outbound payments for receipts — aging rules, corrections-below-original,
applied/unapplied splits and the balance formula all reused verbatim.
`supplierStatement` / `supplierStatementForParty` expose it; the balance
is "what we owe them".

### 5. Storage (schema v17)

- `documents.type` and `number_sequences.kind` CHECKs gain
  `'vendor_credit'`.
- `credit_applications` is rebuilt: `source_kind` gains
  `'vendor_credit'`, `invoice_id` becomes nullable (refunds have no
  target), and a `refund` flag column is added — still append-only,
  reversal-only.

## Consequences

- Every day-to-day money event a small business records now has a
  first-class, immutable representation: quote → order → invoice/bill →
  credit → payment → refund, on both sides of the ledger, plus one-step
  cash transactions.
- A/R and A/P are fully symmetrical, including aging — which is exactly
  the shape the report layer (P&L, balance sheet, aging reports) will
  read next.
- The remaining known gaps are phase-scoped, not model-scoped: banking,
  inventory, recurring automation.
