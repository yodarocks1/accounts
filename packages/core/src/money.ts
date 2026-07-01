import { LedgerError } from './errors.js';

/**
 * Money is a bigint count of minor units (cents, pence, …) tagged with an
 * ISO 4217 currency code. See docs/adr/0002-integer-money.md.
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

/** ISO 4217 exponents that differ from the default of 2. */
const CURRENCY_EXPONENTS: Record<string, number> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function currencyExponent(currency: string): number {
  if (!CURRENCY_CODE.test(currency)) {
    throw new LedgerError('UNKNOWN_CURRENCY', `Invalid currency code: ${JSON.stringify(currency)}`);
  }
  return CURRENCY_EXPONENTS[currency] ?? 2;
}

export function money(amount: bigint, currency: string): Money {
  currencyExponent(currency); // validates the code
  return { amount, currency };
}

const MONEY_STRING = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string ("123.45", "-7", "0.005") into minor units for the
 * given currency. This is the only sanctioned path from user input to Money;
 * `number` never participates. Rejects excess precision rather than rounding.
 */
export function parseMoney(input: string, currency: string): Money {
  const exponent = currencyExponent(currency);
  const match = MONEY_STRING.exec(input.trim());
  if (!match) {
    throw new LedgerError('INVALID_MONEY_STRING', `Not a valid amount: ${JSON.stringify(input)}`);
  }
  const sign = match[1]!;
  const whole = match[2]!;
  const fraction = match[3] ?? '';
  if (fraction.length > exponent) {
    throw new LedgerError(
      'INVALID_MONEY_STRING',
      `${currency} allows ${exponent} decimal place(s); got ${JSON.stringify(input)}`,
    );
  }
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  return { amount: sign === '-' ? -minor : minor, currency };
}

/** Format minor units back to a decimal string ("-123.45"). */
export function formatMoney(value: Money): string {
  const exponent = currencyExponent(value.currency);
  const negative = value.amount < 0n;
  const abs = negative ? -value.amount : value.amount;
  const base = 10n ** BigInt(exponent);
  const whole = (abs / base).toString();
  const fraction = exponent === 0 ? '' : '.' + (abs % base).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new LedgerError('CURRENCY_MISMATCH', `Cannot mix ${a.currency} and ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function negateMoney(a: Money): Money {
  return { amount: -a.amount, currency: a.currency };
}
