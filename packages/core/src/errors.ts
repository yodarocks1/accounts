export type LedgerErrorCode =
  | 'EMPTY_ENTRY'
  | 'NONPOSITIVE_AMOUNT'
  | 'UNBALANCED_ENTRY'
  | 'UNKNOWN_ACCOUNT'
  | 'ARCHIVED_ACCOUNT'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_ACCOUNT_CODE'
  | 'UNKNOWN_ENTRY'
  | 'ALREADY_REVERSED'
  | 'INVALID_MONEY_STRING'
  | 'UNKNOWN_CURRENCY';

export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
