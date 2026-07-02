import { LedgerError } from './errors.js';
import { divRoundHalf } from './quantity.js';
import {
  perUnitCustomerPrice,
  type CustomerQuery,
  type DocumentRecord,
  type ItemCatalog,
} from './documents.js';

/** Scale-3 percentage: 100% = 100_000n; −10% = −10_000n. */
export const PERCENT_SCALE = 100_000n;

export type RateBase = 'sale' | 'cost';

/**
 * A customer's standing special rate for one item (ADR 0007): either a
 * constant unit price, or `base × (100% + percent) + amount` resolved against
 * the item's sale/cost history on each document's date.
 */
export interface CustomerRate {
  readonly rateSeq: number;
  readonly itemId: string;
  readonly partyId: string | null;
  readonly customerName: string | null;
  readonly accountNumber: string | null;
  readonly kind: 'constant' | 'formula';
  /** Constant rates only. */
  readonly unitPrice: bigint | null;
  /** Formula rates only. */
  readonly base: RateBase | null;
  /** Signed scale-3 percent adjustment relative to the base (−10% = −10_000n). */
  readonly percentMilli: bigint;
  /** Signed minor-unit adjustment applied after the percent. */
  readonly amountMinor: bigint;
  /** May the resolved price drop below the item's cost? (ADR 0007 checkbox) */
  readonly allowBelowCost: boolean;
  readonly effectiveFrom: string;
  readonly at: string;
}

export type RateSpec =
  | { kind: 'constant'; unitPrice: bigint }
  | { kind: 'formula'; base: RateBase; percentMilli?: bigint; amountMinor?: bigint };

export interface NewCustomerRate {
  itemId: string;
  partyId?: string;
  customerName?: string;
  accountNumber?: string;
  rate: RateSpec;
  /**
   * Defaults to false — unless the item's typical sales price is below its
   * cost on the effective date (ADR 0007).
   */
  allowBelowCost?: boolean;
  /** Defaults to the beginning of time. */
  effectiveFrom?: string;
}

/** ADR 0007 default: only loss-leader items may default below cost. */
export function defaultAllowBelowCost(salePrice: bigint, cost: bigint | undefined): boolean {
  return cost !== undefined && salePrice < cost;
}

/** Does this rate apply to the document customer? Account number wins when the rate has one. */
export function rateMatchesCustomer(
  rate: Pick<CustomerRate, 'partyId' | 'customerName' | 'accountNumber'>,
  customer: CustomerQuery,
): boolean {
  if (rate.partyId !== null) {
    return rate.partyId === customer.partyId;
  }
  if (rate.accountNumber !== null) {
    return rate.accountNumber === customer.accountNumber;
  }
  return rate.customerName !== null && rate.customerName === customer.customerName;
}

/**
 * Resolve a rate to a unit price against the item's sale price and cost on
 * the document date. Floors at zero always, and at cost unless the rate
 * explicitly allows going below cost (ADR 0007).
 */
export function resolveRatePrice(
  rate: Pick<CustomerRate, 'kind' | 'unitPrice' | 'base' | 'percentMilli' | 'amountMinor' | 'allowBelowCost'>,
  salePrice: bigint,
  cost: bigint | undefined,
): bigint {
  let price: bigint;
  if (rate.kind === 'constant') {
    price = rate.unitPrice!;
  } else {
    const base = rate.base === 'sale' ? salePrice : cost;
    if (base === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'Rate is based on cost but the item has no cost history');
    }
    price = base + divRoundHalf(base * rate.percentMilli, PERCENT_SCALE) + rate.amountMinor;
  }
  if (price < 0n) price = 0n;
  if (!rate.allowBelowCost && cost !== undefined && price < cost) price = cost;
  return price;
}

/**
 * One "should this special rate persist?" question (ADR 0007). Produced when
 * a line was priced differently from what the system would have charged; the
 * proposed rate is prefilled with the most common answer — a constant at the
 * charged price, effective from the document date.
 */
export interface SpecialRateSuggestion {
  readonly itemId: string;
  readonly itemName: string;
  readonly customerName: string;
  readonly accountNumber: string | null;
  /** Per-unit price the customer was actually given. */
  readonly givenPrice: bigint;
  /** What the system would have charged (existing rate, else catalog). */
  readonly expectedPrice: bigint;
  readonly catalogPrice: bigint;
  readonly cost: bigint | undefined;
  /** Prefill for the ADR 0007 checkbox. */
  readonly defaultAllowBelowCost: boolean;
  /** True when the given price is under cost — the UI should flag this. */
  readonly belowCost: boolean;
  readonly proposedRate: NewCustomerRate;
}

/**
 * Detect special rates on a document — call after sending, present each
 * suggestion as a prompt, and persist accepted ones via setCustomerRate.
 * Pure and stateless: once a rate is saved, the same price stops differing
 * from expectations and the question retires itself.
 */
export function computeRateSuggestions(
  record: DocumentRecord,
  catalog: ItemCatalog,
): SpecialRateSuggestion[] {
  if (record.type === 'credit_memo') return [];
  const current = record.revisions[record.revisions.length - 1]!;
  const customer: CustomerQuery = {
    customerName: current.customerName,
    ...(current.accountNumber !== null ? { accountNumber: current.accountNumber } : {}),
    ...(record.partyId !== null ? { partyId: record.partyId } : {}),
  };
  const suggestions: SpecialRateSuggestion[] = [];
  const seen = new Set<string>();
  for (const line of current.lines) {
    if (line.itemId === null || line.free || seen.has(line.itemId)) continue;
    const item = catalog.getItem(line.itemId);
    if (!item) continue;
    const catalogPrice = catalog.priceAt(line.itemId, current.date);
    const expectedPrice = catalog.customerPriceAt(line.itemId, customer, current.date) ?? catalogPrice;
    const givenPrice = perUnitCustomerPrice(line);
    if (givenPrice === expectedPrice) continue;
    seen.add(line.itemId);
    const cost = catalog.costAt(line.itemId, current.date);
    suggestions.push({
      itemId: line.itemId,
      itemName: item.name,
      customerName: current.customerName,
      accountNumber: current.accountNumber,
      givenPrice,
      expectedPrice,
      catalogPrice,
      cost,
      defaultAllowBelowCost: defaultAllowBelowCost(catalogPrice, cost),
      belowCost: cost !== undefined && givenPrice < cost,
      proposedRate: {
        itemId: line.itemId,
        customerName: current.customerName,
        ...(current.accountNumber !== null ? { accountNumber: current.accountNumber } : {}),
        ...(record.partyId !== null ? { partyId: record.partyId } : {}),
        rate: { kind: 'constant', unitPrice: givenPrice },
        allowBelowCost: defaultAllowBelowCost(catalogPrice, cost),
        effectiveFrom: current.date,
      },
    });
  }
  return suggestions;
}
