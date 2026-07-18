import { formatMoney, formatQuantity, money } from '@accounts/core';

/**
 * The wire→display edge (ADR 0020): @accounts/core runs in the browser
 * unchanged, so display formatting is the same exact-bigint code the
 * ledger uses. Number never touches an amount.
 */

export function fmtMoney(minorWire: string, currency: string): string {
  return formatMoney(money(BigInt(minorWire), currency));
}

export function fmtQty(milliWire: string): string {
  return formatQuantity(BigInt(milliWire));
}
