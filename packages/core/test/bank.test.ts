import { describe, expect, it } from 'vitest';
import {
  bankDedupeKey,
  matchBankTransactions,
  parseBankCsv,
  type BankTransaction,
  type Payment,
} from '../src/index.js';

const never = () => false;
const none = new Set<string>();

function bankRow(overrides: Partial<BankTransaction>): BankTransaction {
  return {
    bankSeq: 1,
    source: 'test-bank',
    date: '2026-07-10',
    amountMinor: 10_000n,
    description: 'DEPOSIT',
    reference: null,
    dedupeKey: 'k',
    importedAt: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

function payment(overrides: Partial<Payment>): Payment {
  return {
    id: 'p1',
    number: 'PMT-0001',
    direction: 'in',
    date: '2026-07-10',
    partyId: null,
    customerName: 'Acme',
    accountNumber: null,
    poNumber: null,
    memo: null,
    method: null,
    amountMinor: 10_000n,
    status: 'received',
    ...overrides,
  };
}

describe('parseBankCsv edges (ADR 0019)', () => {
  it('rejects a wrong header, malformed rows, and zero amounts', () => {
    expect(() => parseBankCsv('amount,date,description\n2026-07-01,1.00,X', 'USD')).toThrowError(/must start with header/);
    expect(() => parseBankCsv('date,amount,description\nJuly 1,1.00,X', 'USD')).toThrowError(/row 2 is malformed/);
    expect(() => parseBankCsv('date,amount,description\n2026-07-01,,X', 'USD')).toThrowError(/row 2 is malformed/);
    expect(() => parseBankCsv('date,amount,description\n2026-07-01,0.00,X', 'USD')).toThrowError(/row 2 has a zero amount/);
    expect(() => parseBankCsv('', 'USD')).toThrowError(/empty/);
  });

  it('parses signs exactly, keeps optional references, skips blank lines', () => {
    const rows = parseBankCsv(
      ['date,amount,description,reference', '2026-07-01,12.34,DEPOSIT,ref-9', '', '2026-07-02,-0.05,FEE,'].join('\n'),
      'USD',
    );
    expect(rows).toEqual([
      { date: '2026-07-01', amountMinor: 1234n, description: 'DEPOSIT', reference: 'ref-9' },
      { date: '2026-07-02', amountMinor: -5n, description: 'FEE' },
    ]);
  });

  it('dedupe keys collide exactly when date, amount, description, reference all agree', () => {
    const [a, b] = parseBankCsv('date,amount,description\n2026-07-01,1.00,X\n2026-07-01,1.00,X', 'USD');
    expect(bankDedupeKey(a!)).toBe(bankDedupeKey(b!));
    expect(bankDedupeKey({ ...a!, reference: 'r' })).not.toBe(bankDedupeKey(a!));
  });
});

describe('matchBankTransactions edges (ADR 0019)', () => {
  it('the date window is inclusive at ±windowDays and closed beyond it', () => {
    const pay = payment({ date: '2026-07-10' });
    for (const [date, expected] of [
      ['2026-07-07', 1], // −3: inside
      ['2026-07-13', 1], // +3: inside
      ['2026-07-06', 0], // −4: out
      ['2026-07-14', 0], // +4: out
    ] as const) {
      expect(matchBankTransactions([bankRow({ date })], [pay], never, none)).toHaveLength(expected);
    }
    // A wider window is honored when asked for.
    expect(matchBankTransactions([bankRow({ date: '2026-07-14' })], [pay], never, none, 7)).toHaveLength(1);
  });

  it('direction and magnitude must both agree with the signed bank amount', () => {
    const inbound = payment({ id: 'in', direction: 'in' });
    const outbound = payment({ id: 'out', number: 'PMT-0002', direction: 'out' });
    const deposit = bankRow({ amountMinor: 10_000n });
    const withdrawal = bankRow({ bankSeq: 2, amountMinor: -10_000n });
    const matches = matchBankTransactions([deposit, withdrawal], [inbound, outbound], never, none);
    expect(matches.map((entry) => [entry.bankSeq, entry.paymentId])).toEqual([
      [1, 'in'],
      [2, 'out'],
    ]);
    // Same direction, off-by-one magnitude: no match — never "close enough".
    expect(matchBankTransactions([bankRow({ amountMinor: 10_001n })], [inbound], never, none)).toHaveLength(0);
  });

  it('ambiguity is returned ranked by |dayOffset|, never resolved silently', () => {
    const near = payment({ id: 'near', number: 'PMT-0002', date: '2026-07-09' });
    const exact = payment({ id: 'exact', number: 'PMT-0001', date: '2026-07-10' });
    const matches = matchBankTransactions([bankRow({})], [near, exact], never, none);
    expect(matches.map((entry) => entry.paymentId)).toEqual(['exact', 'near']);
    expect(matches.map((entry) => entry.dayOffset)).toEqual([0, 1]);
  });

  it('reconciled rows, reconciled payments, and void payments never match', () => {
    const pay = payment({});
    expect(matchBankTransactions([bankRow({})], [pay], (seq) => seq === 1, none)).toHaveLength(0);
    expect(matchBankTransactions([bankRow({})], [pay], never, new Set(['p1']))).toHaveLength(0);
    expect(matchBankTransactions([bankRow({})], [payment({ status: 'void' })], never, none)).toHaveLength(0);
  });
});
