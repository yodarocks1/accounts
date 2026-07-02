import { LedgerError } from './errors.js';

/**
 * Allocate `target` across positions proportionally to `face` amounts, in
 * exact bigint arithmetic (largest-remainder rounding), honoring per-position
 * floors. Used by charge corrections and free-item recording (ADR 0005).
 *
 * Guarantees, when it returns:
 * - result sums to exactly `target`
 * - floors[i] ≤ result[i] ≤ face[i] (floors are clamped to face first)
 * - positions with a bound floor absorb it; the rest stays proportional
 *
 * Throws PRICE_FLOOR if the floors make `target` unreachable, and
 * INVALID_ALLOCATION if target is negative or exceeds the face total
 * (allocation only ever reduces).
 */
export function allocateProportional(
  face: readonly bigint[],
  target: bigint,
  floors?: readonly bigint[],
): bigint[] {
  for (const amount of face) {
    if (amount < 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Face amounts must not be negative');
    }
  }
  const effectiveFloors = face.map((amount, index) => {
    const floor = floors?.[index] ?? 0n;
    if (floor <= 0n) return 0n;
    return floor > amount ? amount : floor;
  });
  const faceTotal = face.reduce((sum, amount) => sum + amount, 0n);
  if (target < 0n || target > faceTotal) {
    throw new LedgerError('INVALID_ALLOCATION', `Target ${target} outside [0, ${faceTotal}]`);
  }
  const floorTotal = effectiveFloors.reduce((sum, amount) => sum + amount, 0n);
  if (target < floorTotal) {
    throw new LedgerError(
      'PRICE_FLOOR',
      `Cannot allocate ${target}: per-item floors already total ${floorTotal}`,
    );
  }

  const result = new Array<bigint>(face.length).fill(0n);
  let active = face.map((_, index) => index);
  let remaining = target;

  for (;;) {
    const activeFace = active.reduce((sum, index) => sum + face[index]!, 0n);
    if (activeFace === 0n) {
      // remaining is provably 0 here (remaining ≤ activeFace throughout).
      break;
    }
    const shares = new Map<number, bigint>();
    const remainders: { index: number; remainder: bigint }[] = [];
    let allocated = 0n;
    for (const index of active) {
      const raw = face[index]! * remaining;
      const share = raw / activeFace;
      shares.set(index, share);
      remainders.push({ index, remainder: raw % activeFace });
      allocated += share;
    }
    let leftover = remaining - allocated;
    remainders.sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1,
    );
    for (const { index } of remainders) {
      if (leftover <= 0n) break;
      shares.set(index, shares.get(index)! + 1n);
      leftover -= 1n;
    }
    const violated = active.filter((index) => shares.get(index)! < effectiveFloors[index]!);
    if (violated.length === 0) {
      for (const index of active) result[index] = shares.get(index)!;
      break;
    }
    for (const index of violated) {
      result[index] = effectiveFloors[index]!;
      remaining -= effectiveFloors[index]!;
    }
    active = active.filter((index) => !violated.includes(index));
  }
  return result;
}
