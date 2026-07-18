import { describe, expect, it } from 'vitest';
import { fmtMoney, fmtQty } from '../src/format';

describe('the wire→display edge (ADR 0020)', () => {
  it('formats minor units through core, exactly', () => {
    expect(fmtMoney('123456', 'USD')).toBe('1234.56');
    expect(fmtMoney('-3300', 'USD')).toBe('-33.00');
    expect(fmtMoney('0', 'USD')).toBe('0.00');
  });

  it('survives amounts beyond Number precision — the reason for the contract', () => {
    // 2^53 is 9007199254740992; one past it is unrepresentable as a double.
    expect(fmtMoney('9007199254740993', 'USD')).toBe('90071992547409.93');
    expect(String(Number('9007199254740993'))).not.toBe('9007199254740993'); // the bug we refuse to have
  });

  it('formats milli quantities', () => {
    expect(fmtQty('2500')).toBe('2.5');
    expect(fmtQty('-1000')).toBe('-1');
  });
});
