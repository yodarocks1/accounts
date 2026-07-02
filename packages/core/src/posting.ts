import type { NewJournalEntry } from './journal.js';

/**
 * Ledger posting (ADR 0008 part 3): documents and payments post through
 * configurable account roles. Without configured roles, nothing posts —
 * the document layer keeps working books-less.
 */
export const POSTING_ROLES = ['accounts_receivable', 'sales_income', 'cash'] as const;
export type PostingRole = (typeof POSTING_ROLES)[number];

export type PostingKind =
  /** Sent invoice: DR AR / CR income. */
  | 'invoice'
  /** Sent account credit memo: DR income / CR AR. */
  | 'credit_account'
  /** Sent refund credit memo: DR income / CR cash. */
  | 'credit_refund'
  /** Received payment: DR cash / CR AR. */
  | 'payment';

const POSTING_SIDES: Record<PostingKind, [debit: PostingRole, credit: PostingRole]> = {
  invoice: ['accounts_receivable', 'sales_income'],
  credit_account: ['sales_income', 'accounts_receivable'],
  credit_refund: ['sales_income', 'cash'],
  payment: ['cash', 'accounts_receivable'],
};

/** Which roles a posting kind needs; posting is skipped unless all are mapped. */
export function rolesFor(kind: PostingKind): readonly PostingRole[] {
  return POSTING_SIDES[kind];
}

/**
 * Plan the balanced journal entry for a business event, or null when there is
 * nothing to post (zero amount) or the needed roles aren't configured.
 */
export function planPosting(
  kind: PostingKind,
  amount: bigint,
  currency: string,
  date: string,
  accounts: Partial<Record<PostingRole, string>>,
  memo?: string,
): NewJournalEntry | null {
  if (amount <= 0n) return null;
  const [debitRole, creditRole] = POSTING_SIDES[kind];
  const debitAccount = accounts[debitRole];
  const creditAccount = accounts[creditRole];
  if (debitAccount === undefined || creditAccount === undefined) return null;
  return {
    date,
    ...(memo !== undefined ? { memo } : {}),
    lines: [
      { accountId: debitAccount, side: 'debit', amount, currency },
      { accountId: creditAccount, side: 'credit', amount, currency },
    ],
  };
}
