import { LedgerError } from './errors.js';
import { parseMoney } from './money.js';
import { daysBetween } from './statement.js';
import type { Payment } from './payments.js';

/**
 * Bank import & reconciliation (ADR 0019): imported bank lines are
 * append-only facts; matching is a pure suggestion; reconciliation marks
 * follow the credit-application pattern (append + reversal).
 */

export interface BankTransaction {
  readonly bankSeq: number;
  /** Which feed/export this came from ("chase-checking"). */
  readonly source: string;
  readonly date: string;
  /** Signed: deposits positive, withdrawals negative. */
  readonly amountMinor: bigint;
  readonly description: string;
  readonly reference: string | null;
  /** Idempotency key within a source. */
  readonly dedupeKey: string;
  readonly importedAt: string;
}

export interface NewBankTransaction {
  date: string;
  amountMinor: bigint;
  description: string;
  reference?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function bankDedupeKey(row: NewBankTransaction): string {
  return [row.date, row.amountMinor.toString(), row.description, row.reference ?? ''].join('|');
}

/**
 * Parse the v1 CSV shape: header `date,amount,description[,reference]`,
 * signed decimal amounts in the book's currency. Deliberately strict —
 * richer formats are plugin territory (ADR 0019 cut list).
 */
export function parseBankCsv(text: string, currency: string): NewBankTransaction[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new LedgerError('INVALID_DOCUMENT', 'Bank CSV is empty');
  }
  const header = lines[0]!.toLowerCase().split(',').map((cell) => cell.trim());
  if (header[0] !== 'date' || header[1] !== 'amount' || header[2] !== 'description') {
    throw new LedgerError('INVALID_DOCUMENT', 'Bank CSV must start with header: date,amount,description[,reference]');
  }
  return lines.slice(1).map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const [date, amount, description, reference] = [cells[0], cells[1], cells[2], cells[3]];
    if (!date || !ISO_DATE.test(date) || !amount || !description) {
      throw new LedgerError('INVALID_DOCUMENT', `Bank CSV row ${index + 2} is malformed: ${JSON.stringify(line)}`);
    }
    const negative = amount.startsWith('-');
    const magnitude = parseMoney(negative ? amount.slice(1) : amount, currency).amount;
    if (magnitude === 0n) {
      throw new LedgerError('INVALID_DOCUMENT', `Bank CSV row ${index + 2} has a zero amount`);
    }
    return {
      date,
      amountMinor: negative ? -magnitude : magnitude,
      description,
      ...(reference !== undefined && reference !== '' ? { reference } : {}),
    };
  });
}

export interface BankMatchSuggestion {
  readonly bankSeq: number;
  readonly paymentId: string;
  readonly paymentNumber: string;
  /** bank date − payment date, in days; 0 is an exact-date match. */
  readonly dayOffset: number;
}

/**
 * Pure matcher: signed amount agrees with the payment's direction and
 * magnitude, dates within the window, both sides unreconciled. Ambiguity
 * is returned ranked by |dayOffset|, never resolved silently.
 */
export function matchBankTransactions(
  transactions: readonly BankTransaction[],
  payments: readonly Payment[],
  isBankReconciled: (bankSeq: number) => boolean,
  reconciledPaymentIds: ReadonlySet<string>,
  windowDays = 3,
): BankMatchSuggestion[] {
  const suggestions: BankMatchSuggestion[] = [];
  for (const transaction of transactions) {
    if (isBankReconciled(transaction.bankSeq)) continue;
    const direction = transaction.amountMinor > 0n ? 'in' : 'out';
    const magnitude = transaction.amountMinor > 0n ? transaction.amountMinor : -transaction.amountMinor;
    for (const payment of payments) {
      if (payment.status !== 'received' || reconciledPaymentIds.has(payment.id)) continue;
      if (payment.direction !== direction || payment.amountMinor !== magnitude) continue;
      const dayOffset = daysBetween(payment.date, transaction.date);
      if (Math.abs(dayOffset) > windowDays) continue;
      suggestions.push({
        bankSeq: transaction.bankSeq,
        paymentId: payment.id,
        paymentNumber: payment.number,
        dayOffset,
      });
    }
  }
  return suggestions.sort(
    (a, b) => a.bankSeq - b.bankSeq || Math.abs(a.dayOffset) - Math.abs(b.dayOffset) || (a.paymentNumber < b.paymentNumber ? -1 : 1),
  );
}
