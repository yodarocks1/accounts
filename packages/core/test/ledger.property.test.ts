import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Ledger, LedgerError, type Account, type NewJournalEntry } from '../src/index.js';

/**
 * Property-based invariants (PLAN.md §10): for ANY sequence of operations the
 * books stay balanced, invalid operations are rejected atomically, and
 * reversals cancel exactly.
 */

const CURRENCIES = ['USD', 'EUR', 'JPY'] as const;

interface Chart {
  ledger: Ledger;
  accounts: Account[];
}

const chartArb: fc.Arbitrary<{ specs: { type: Account['type']; currency: string }[] }> = fc.record({
  specs: fc.array(
    fc.record({
      type: fc.constantFrom<Account['type']>('asset', 'liability', 'equity', 'income', 'expense'),
      currency: fc.constantFrom(...CURRENCIES),
    }),
    { minLength: 2, maxLength: 8 },
  ),
});

function buildChart(specs: { type: Account['type']; currency: string }[]): Chart {
  const ledger = new Ledger();
  const accounts = specs.map((spec, index) =>
    ledger.createAccount({ name: `Account ${index}`, type: spec.type, currency: spec.currency, code: String(1000 + index) }),
  );
  return { ledger, accounts };
}

const amountArb = fc.bigInt({ min: 1n, max: 10_000_000n });

/**
 * A "transfer" moves an amount between two accounts of the same currency; an
 * entry is 1–4 transfers merged, so every generated entry is balanced by
 * construction and may touch many accounts.
 */
function balancedEntryArb(accounts: Account[]): fc.Arbitrary<NewJournalEntry | null> {
  return fc
    .array(
      fc.record({
        from: fc.nat({ max: accounts.length - 1 }),
        to: fc.nat({ max: accounts.length - 1 }),
        amount: amountArb,
      }),
      { minLength: 1, maxLength: 4 },
    )
    .chain((transfers) =>
      fc.record({
        transfers: fc.constant(transfers),
        day: fc.integer({ min: 1, max: 28 }),
        month: fc.integer({ min: 1, max: 12 }),
      }),
    )
    .map(({ transfers, day, month }) => {
      const lines: NewJournalEntry['lines'] = [];
      for (const transfer of transfers) {
        const from = accounts[transfer.from]!;
        const candidates = accounts.filter((account) => account.currency === from.currency);
        const to = candidates[transfer.to % candidates.length]!;
        lines.push(
          { accountId: to.id, side: 'debit', amount: transfer.amount, currency: to.currency },
          { accountId: from.id, side: 'credit', amount: transfer.amount, currency: from.currency },
        );
      }
      if (lines.length < 2) return null;
      const pad = (value: number) => String(value).padStart(2, '0');
      return { date: `2026-${pad(month)}-${pad(day)}`, lines } satisfies NewJournalEntry;
    });
}

function totalsAreBalanced(ledger: Ledger): void {
  const balance = ledger.trialBalance();
  for (const [currency, total] of balance.totals) {
    expect(total.debits, `${currency} debits == credits`).toBe(total.credits);
  }
  // Net across all rows sums to zero per currency as well.
  const nets = new Map<string, bigint>();
  for (const row of balance.rows) {
    nets.set(row.currency, (nets.get(row.currency) ?? 0n) + row.net);
  }
  for (const [currency, net] of nets) {
    expect(net, `${currency} nets sum to zero`).toBe(0n);
  }
}

describe('ledger invariants', () => {
  it('any sequence of balanced entries keeps the trial balance at zero', () => {
    fc.assert(
      fc.property(chartArb, fc.integer({ min: 0, max: 25 }), ({ specs }, entryCount) => {
        const { ledger, accounts } = buildChart(specs);
        for (const entry of fc.sample(balancedEntryArb(accounts), entryCount)) {
          if (entry) ledger.post(entry);
        }
        totalsAreBalanced(ledger);
      }),
      { numRuns: 50 },
    );
  });

  it('a rejected entry leaves the ledger completely unchanged', () => {
    fc.assert(
      fc.property(chartArb, fc.bigInt({ min: 1n, max: 999n }), ({ specs }, skew) => {
        const { ledger, accounts } = buildChart(specs);
        for (const entry of fc.sample(balancedEntryArb(accounts), 5)) {
          if (entry) ledger.post(entry);
        }
        const before = JSON.stringify(ledger.trialBalance(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        const entryCount = ledger.listEntries().length;

        const [candidate] = fc.sample(balancedEntryArb(accounts), 1);
        if (candidate) {
          // Skew one line so the entry no longer balances.
          const firstLine = candidate.lines[0]!;
          const broken: NewJournalEntry = {
            ...candidate,
            lines: [{ ...firstLine, amount: firstLine.amount + skew }, ...candidate.lines.slice(1)],
          };
          expect(() => ledger.post(broken)).toThrow(LedgerError);
        }

        const after = JSON.stringify(ledger.trialBalance(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        expect(after).toBe(before);
        expect(ledger.listEntries().length).toBe(entryCount);
      }),
      { numRuns: 50 },
    );
  });

  it('reversing every entry returns every account to zero', () => {
    fc.assert(
      fc.property(chartArb, ({ specs }) => {
        const { ledger, accounts } = buildChart(specs);
        const posted = [];
        for (const entry of fc.sample(balancedEntryArb(accounts), 10)) {
          if (entry) posted.push(ledger.post(entry));
        }
        for (const entry of posted) {
          ledger.reverse(entry.id, '2026-12-31');
        }
        for (const row of ledger.trialBalance().rows) {
          expect(row.net).toBe(0n);
        }
        totalsAreBalanced(ledger);
      }),
      { numRuns: 50 },
    );
  });

  it('as-of trial balances are balanced at every cut-off date', () => {
    fc.assert(
      fc.property(chartArb, fc.integer({ min: 1, max: 12 }), ({ specs }, month) => {
        const { ledger, accounts } = buildChart(specs);
        for (const entry of fc.sample(balancedEntryArb(accounts), 15)) {
          if (entry) ledger.post(entry);
        }
        const asOf = `2026-${String(month).padStart(2, '0')}-28`;
        const balance = ledger.trialBalance(asOf);
        for (const [currency, total] of balance.totals) {
          expect(total.debits, `${currency} balanced as of ${asOf}`).toBe(total.credits);
        }
      }),
      { numRuns: 50 },
    );
  });
});
