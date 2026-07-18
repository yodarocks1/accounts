import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { valueInventory, type StockMovement } from '../src/index.js';

/**
 * Property: for any no-oversell sequence of valued receipts and issues, the
 * FIFO engine conserves value exactly — open value equals everything that
 * came in minus everything issued out, to the minor unit, and the per-source
 * ledger sums to the same number. No rounding drift, ever (ADR 0015).
 */

interface Command {
  readonly kind: 'in' | 'out';
  readonly quantityMilli: bigint;
  readonly valueMinor: bigint; // ignored for 'out'
}

const command = fc.record({
  kind: fc.constantFrom<'in' | 'out'>('in', 'out', 'in'), // bias inbound so sequences build stock
  units: fc.integer({ min: 1, max: 40 }),
  valueMinor: fc.integer({ min: 0, max: 500_000 }),
});

function movement(seq: number, entry: Command): StockMovement {
  return {
    movementSeq: seq,
    itemId: 'item',
    kind: 'document',
    condition: 'good',
    quantityMilli: entry.kind === 'in' ? entry.quantityMilli : -entry.quantityMilli,
    date: '2026-07-01',
    at: '2026-07-01T00:00:00Z',
    reason: null,
    sourceId: `${entry.kind === 'in' ? 'BILL' : 'INV'}-${seq}`,
    disposition: null,
    valueMinor: entry.kind === 'in' ? entry.valueMinor : null,
  };
}

describe('valueInventory conservation (property)', () => {
  it('open value == Σ inbound − Σ issued, exactly, for every no-oversell sequence', () => {
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 60 }), (raw) => {
        // Clamp issues to the running balance so the costAt fallback never fires.
        let onHand = 0n;
        const commands: Command[] = [];
        for (const entry of raw) {
          const quantityMilli = BigInt(entry.units) * 1000n;
          if (entry.kind === 'in') {
            onHand += quantityMilli;
            commands.push({ kind: 'in', quantityMilli, valueMinor: BigInt(entry.valueMinor) });
          } else if (onHand > 0n) {
            const clamped = quantityMilli < onHand ? quantityMilli : onHand;
            onHand -= clamped;
            commands.push({ kind: 'out', quantityMilli: clamped, valueMinor: 0n });
          }
        }
        fc.pre(commands.length > 0);
        const movements = commands.map((entry, index) => movement(index + 1, entry));
        const costAt = (): bigint | undefined => undefined; // must never matter
        const valuation = valueInventory(movements, costAt);

        const totalIn = commands.filter((entry) => entry.kind === 'in').reduce((sum, entry) => sum + entry.valueMinor, 0n);
        const issued = [...valuation.costBySource.entries()]
          .filter(([source]) => source.startsWith('INV-'))
          .reduce((sum, [, delta]) => sum - delta, 0n); // issue deltas are negative

        // Conservation, to the minor unit.
        expect(valuation.valueMinor).toBe(totalIn - issued);
        // The per-source ledger sums to the open value: nothing leaks.
        const netBySource = [...valuation.costBySource.values()].reduce((sum, delta) => sum + delta, 0n);
        expect(netBySource).toBe(valuation.valueMinor);
        // Physical sanity: quantity matches the clamped sequence, layers are all positive.
        expect(valuation.quantityMilli).toBe(onHand);
        expect(valuation.valueMinor >= 0n).toBe(true);
        for (const layer of valuation.layers) {
          expect(layer.quantityMilli > 0n).toBe(true);
          expect(layer.valueMinor >= 0n).toBe(true);
        }
        // Fully drained books hold zero value — full consumption is exact.
        if (onHand === 0n) expect(valuation.valueMinor).toBe(0n);
      }),
      { numRuns: 200 },
    );
  });
});
