export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type BalanceSide = 'debit' | 'credit';

export function normalBalance(type: AccountType): BalanceSide {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

export interface Account {
  readonly id: string;
  /** Optional human-facing code, unique when present (e.g. "1000"). */
  readonly code: string | null;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly parentId: string | null;
  readonly archived: boolean;
}

export interface NewAccount {
  name: string;
  type: AccountType;
  currency: string;
  code?: string;
  parentId?: string;
}
