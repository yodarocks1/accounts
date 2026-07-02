import { LedgerError } from './errors.js';

/**
 * Quantities are bigint thousandths (scale 3): "2.5" hours = 2500n.
 * Exact fixed point, same no-float rule as money (ADR 0002, ADR 0004).
 */
export const QUANTITY_SCALE = 1000n;

/** Scale-3 percentage: 100% = 100_000n; −10% = −10_000n. */
export const PERCENT_SCALE = 100_000n;

const QUANTITY_STRING = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;

export function parseQuantity(input: string): bigint {
  const match = QUANTITY_STRING.exec(input.trim());
  if (!match) {
    throw new LedgerError('INVALID_QUANTITY', `Not a valid quantity (max 3 decimals): ${JSON.stringify(input)}`);
  }
  const sign = match[1]!;
  const whole = match[2]!;
  const fraction = (match[3] ?? '').padEnd(3, '0');
  const milli = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction || '0');
  return sign === '-' ? -milli : milli;
}

export function formatQuantity(quantityMilli: bigint): string {
  const negative = quantityMilli < 0n;
  const abs = negative ? -quantityMilli : quantityMilli;
  const whole = (abs / QUANTITY_SCALE).toString();
  const fraction = (abs % QUANTITY_SCALE).toString().padStart(3, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Integer division rounding half away from zero; exact until the last step. */
export function divRoundHalf(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new LedgerError('INVALID_QUANTITY', 'Denominator must be positive');
  }
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}
