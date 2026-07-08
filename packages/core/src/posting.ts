import type { NewJournalEntry } from './journal.js';

/**
 * Ledger posting (ADR 0008 part 3): documents and payments post through
 * configurable account roles. Without configured roles, nothing posts —
 * the document layer keeps working books-less.
 */
export const POSTING_ROLES = [
  'accounts_receivable',
  'sales_income',
  'cash',
  'sales_tax_payable',
  'accounts_payable',
  'purchases_expense',
  'inventory_asset',
  'cogs',
  'goods_received_not_invoiced',
] as const;
export type PostingRole = (typeof POSTING_ROLES)[number];

export type PostingKind =
  /** Sent invoice: DR AR / CR income. */
  | 'invoice'
  /** Sent account credit memo: DR income / CR AR. */
  | 'credit_account'
  /** Sent refund credit memo: DR income / CR cash. */
  | 'credit_refund'
  /** Received payment: DR cash / CR AR. */
  | 'payment'
  /** Approved vendor bill: DR purchases / CR AP (ADR 0012). */
  | 'bill'
  /** Outbound payment to a supplier: DR AP / CR cash (ADR 0012). */
  | 'disbursement'
  /** Sent account vendor credit: DR AP / CR purchases (ADR 0013). */
  | 'vendor_credit_account'
  /** Sent refund vendor credit (supplier paid us): DR cash / CR purchases. */
  | 'vendor_credit_refund'
  /** Refund of inbound on-account credit to a customer: DR AR / CR cash. */
  | 'refund_out'
  /** Supplier refunds our outbound on-account credit: DR cash / CR AP. */
  | 'refund_in';

const POSTING_SIDES: Record<PostingKind, [debit: PostingRole, credit: PostingRole]> = {
  invoice: ['accounts_receivable', 'sales_income'],
  credit_account: ['sales_income', 'accounts_receivable'],
  credit_refund: ['sales_income', 'cash'],
  payment: ['cash', 'accounts_receivable'],
  bill: ['purchases_expense', 'accounts_payable'],
  disbursement: ['accounts_payable', 'cash'],
  vendor_credit_account: ['accounts_payable', 'purchases_expense'],
  vendor_credit_refund: ['cash', 'purchases_expense'],
  refund_out: ['accounts_receivable', 'cash'],
  refund_in: ['cash', 'accounts_payable'],
};

/** Which roles a posting kind needs; posting is skipped unless all are mapped. */
export function rolesFor(kind: PostingKind): readonly PostingRole[] {
  return POSTING_SIDES[kind];
}

/**
 * Plan the balanced journal entry for a business event, or null when there is
 * nothing to post (zero amount) or the needed roles aren't configured.
 * Documents with tax split the gross across income and tax payable
 * (ADR 0010); tax posts only when the sales_tax_payable role is mapped.
 */
export function planPosting(
  kind: PostingKind,
  amount: bigint,
  currency: string,
  date: string,
  accounts: Partial<Record<PostingRole, string>>,
  memo?: string,
  taxAmount = 0n,
): NewJournalEntry | null {
  const gross = amount + taxAmount;
  if (gross <= 0n) return null;
  const [debitRole, creditRole] = POSTING_SIDES[kind];
  const debitAccount = accounts[debitRole];
  const creditAccount = accounts[creditRole];
  if (debitAccount === undefined || creditAccount === undefined) return null;
  const taxAccount = accounts.sales_tax_payable;
  const splitTax =
    (kind === 'invoice' || kind === 'credit_account' || kind === 'credit_refund') &&
    taxAmount > 0n &&
    taxAccount !== undefined;
  // Income-side role carries the net when tax splits; the AR/cash side is gross.
  const incomeAmount = splitTax ? amount : gross;
  if (kind === 'invoice') {
    return {
      date,
      ...(memo !== undefined ? { memo } : {}),
      lines: [
        { accountId: debitAccount, side: 'debit', amount: gross, currency },
        ...(incomeAmount > 0n
          ? [{ accountId: creditAccount, side: 'credit' as const, amount: incomeAmount, currency }]
          : []),
        ...(splitTax ? [{ accountId: taxAccount, side: 'credit' as const, amount: taxAmount, currency }] : []),
      ],
    };
  }
  if (kind === 'credit_account' || kind === 'credit_refund') {
    return {
      date,
      ...(memo !== undefined ? { memo } : {}),
      lines: [
        ...(incomeAmount > 0n
          ? [{ accountId: debitAccount, side: 'debit' as const, amount: incomeAmount, currency }]
          : []),
        ...(splitTax ? [{ accountId: taxAccount, side: 'debit' as const, amount: taxAmount, currency }] : []),
        { accountId: creditAccount, side: 'credit', amount: gross, currency },
      ],
    };
  }
  return {
    date,
    ...(memo !== undefined ? { memo } : {}),
    lines: [
      { accountId: debitAccount, side: 'debit', amount: gross, currency },
      { accountId: creditAccount, side: 'credit', amount: gross, currency },
    ],
  };
}

// ── Document entries with inventory accounting (ADR 0015) ──────────────────

export type DocumentPostingKind =
  | 'invoice'
  | 'credit_account'
  | 'credit_refund'
  | 'bill'
  | 'receipt'
  | 'vendor_credit_account'
  | 'vendor_credit_refund';

export interface DocumentPostingAmounts {
  /** Pre-tax customer/supplier amount. */
  net: bigint;
  tax: bigint;
  /**
   * Inventory value moved (positive): FIFO cost for invoices/credits and
   * vendor credits, line value for bills/receipts. Zero when the document
   * touches no tracked stock.
   */
  inventory: bigint;
  /** Portion of a bill's inventory value that clears GRNI (received earlier). */
  grni?: bigint;
}

interface EntryLine {
  accountId: string;
  side: 'debit' | 'credit';
  amount: bigint;
  currency: string;
}

/**
 * One balanced entry per document (ADR 0015). With inventory_asset unmapped,
 * bills post entirely to purchases and invoices post revenue only — exactly
 * the pre-inventory behavior; books opt in by mapping the roles.
 */
export function planDocumentPosting(
  kind: DocumentPostingKind,
  amounts: DocumentPostingAmounts,
  currency: string,
  date: string,
  accounts: Partial<Record<PostingRole, string>>,
  memo?: string,
): NewJournalEntry | null {
  const gross = amounts.net + amounts.tax;
  if (gross <= 0n) return null;
  const lines: EntryLine[] = [];
  const push = (accountId: string | undefined, side: 'debit' | 'credit', amount: bigint): boolean => {
    if (amount === 0n) return true;
    if (amount < 0n || accountId === undefined) return false;
    lines.push({ accountId, side, amount, currency });
    return true;
  };
  const done = (): NewJournalEntry | null =>
    lines.length === 0 ? null : { date, ...(memo !== undefined ? { memo } : {}), lines };

  if (kind === 'invoice' || kind === 'credit_account' || kind === 'credit_refund') {
    const splitTax = amounts.tax > 0n && accounts.sales_tax_payable !== undefined;
    const income = splitTax ? amounts.net : gross;
    const facing = kind === 'invoice' || kind === 'credit_account' ? accounts.accounts_receivable : accounts.cash;
    if (facing === undefined || accounts.sales_income === undefined) return null;
    if (kind === 'invoice') {
      push(facing, 'debit', gross);
      push(accounts.sales_income, 'credit', income);
      if (splitTax) push(accounts.sales_tax_payable, 'credit', amounts.tax);
    } else {
      push(accounts.sales_income, 'debit', income);
      if (splitTax) push(accounts.sales_tax_payable, 'debit', amounts.tax);
      push(facing, 'credit', gross);
    }
    // COGS rides in the same entry when the inventory roles are mapped.
    if (amounts.inventory > 0n && accounts.cogs !== undefined && accounts.inventory_asset !== undefined) {
      if (kind === 'invoice') {
        push(accounts.cogs, 'debit', amounts.inventory);
        push(accounts.inventory_asset, 'credit', amounts.inventory);
      } else {
        push(accounts.inventory_asset, 'debit', amounts.inventory);
        push(accounts.cogs, 'credit', amounts.inventory);
      }
    }
    return done();
  }

  if (kind === 'receipt') {
    // DR inventory / CR goods-received-not-invoiced; both roles or nothing.
    if (
      amounts.inventory <= 0n ||
      accounts.inventory_asset === undefined ||
      accounts.goods_received_not_invoiced === undefined
    ) {
      return null;
    }
    push(accounts.inventory_asset, 'debit', amounts.inventory);
    push(accounts.goods_received_not_invoiced, 'credit', amounts.inventory);
    return done();
  }

  if (kind === 'bill') {
    if (accounts.accounts_payable === undefined) return null;
    let inventory = accounts.inventory_asset !== undefined ? amounts.inventory : 0n;
    if (inventory > amounts.net) inventory = amounts.net;
    let grni = accounts.goods_received_not_invoiced !== undefined ? (amounts.grni ?? 0n) : 0n;
    if (grni > inventory) grni = inventory;
    const expensed = amounts.net - inventory;
    if (grni > 0n) push(accounts.goods_received_not_invoiced, 'debit', grni);
    if (inventory - grni > 0n && !push(accounts.inventory_asset, 'debit', inventory - grni)) return null;
    if (expensed > 0n && !push(accounts.purchases_expense, 'debit', expensed)) return null;
    push(accounts.accounts_payable, 'credit', amounts.net);
    return done();
  }

  // Vendor credits: DR AP/cash gross, CR inventory at consumed FIFO value,
  // remainder (price variance) against purchases.
  const facing = kind === 'vendor_credit_account' ? accounts.accounts_payable : accounts.cash;
  if (facing === undefined) return null;
  const inventory = accounts.inventory_asset !== undefined ? amounts.inventory : 0n;
  const remainder = amounts.net - inventory;
  push(facing, 'debit', amounts.net);
  if (inventory > 0n) push(accounts.inventory_asset, 'credit', inventory);
  if (remainder !== 0n) {
    if (accounts.purchases_expense === undefined) return null;
    if (remainder > 0n) push(accounts.purchases_expense, 'credit', remainder);
    else push(accounts.purchases_expense, 'debit', -remainder);
  }
  // A pure-variance entry with nothing mapped degenerates; require balance.
  const debits = lines.filter((line) => line.side === 'debit').reduce((sum, line) => sum + line.amount, 0n);
  const credits = lines.filter((line) => line.side === 'credit').reduce((sum, line) => sum + line.amount, 0n);
  if (debits !== credits) return null;
  return done();
}
