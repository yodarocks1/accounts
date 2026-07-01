import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LedgerError, currencyExponent, formatMoney, money, parseMoney } from '../src/index.js';

describe('parseMoney', () => {
  it('parses whole and fractional USD', () => {
    expect(parseMoney('123.45', 'USD').amount).toBe(12345n);
    expect(parseMoney('7', 'USD').amount).toBe(700n);
    expect(parseMoney('-0.05', 'USD').amount).toBe(-5n);
    expect(parseMoney('0.5', 'USD').amount).toBe(50n);
  });

  it('respects currency exponents', () => {
    expect(parseMoney('100', 'JPY').amount).toBe(100n);
    expect(parseMoney('1.005', 'BHD').amount).toBe(1005n);
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => parseMoney('1.005', 'USD')).toThrow(LedgerError);
    expect(() => parseMoney('1.5', 'JPY')).toThrow(LedgerError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', '1,000', '1.2.3', '1e5', 'NaN', 'Infinity', '--1', '.']) {
      expect(() => parseMoney(bad, 'USD'), bad).toThrow(LedgerError);
    }
  });

  it('rejects unknown currency codes', () => {
    expect(() => parseMoney('1', 'usd')).toThrow(LedgerError);
    expect(() => parseMoney('1', 'DOLLARS')).toThrow(LedgerError);
  });

  it('round-trips with formatMoney for any minor-unit amount', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.constantFrom('USD', 'EUR', 'JPY', 'BHD'),
        (amount, currency) => {
          const formatted = formatMoney(money(amount, currency));
          expect(parseMoney(formatted, currency).amount).toBe(amount);
        },
      ),
    );
  });

  it('parse ∘ format is exact even beyond float precision', () => {
    // 2^53 + 1 is not representable as a double; bigint handles it exactly.
    const huge = '90071992547409.93';
    expect(formatMoney(parseMoney(huge, 'USD'))).toBe(huge);
  });
});

describe('currencyExponent', () => {
  it('defaults to 2 and honors exceptions', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });
});
