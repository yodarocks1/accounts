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
  | 'UNKNOWN_CURRENCY'
  | 'INVALID_QUANTITY'
  | 'UNKNOWN_ITEM'
  | 'UNKNOWN_DOCUMENT'
  | 'DUPLICATE_DOCUMENT_NUMBER'
  | 'DOCUMENT_LOCKED'
  | 'INVALID_REVISION_KIND'
  | 'INVALID_DOCUMENT'
  | 'INVALID_STATUS'
  | 'INVALID_ALLOCATION'
  | 'PRICE_FLOOR'
  | 'CHARGE_INCREASE'
  | 'INVALID_CONVERSION'
  | 'UNKNOWN_LINE'
  | 'LINE_OVERDRAWN'
  | 'LINE_LINKED'
  | 'NO_PURCHASE_HISTORY';

export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
