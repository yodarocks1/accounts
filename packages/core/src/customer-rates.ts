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
  /** 'revoked' explicitly ends special pricing from effectiveFrom (ADR 0009). */
  readonly kind: 'constant' | 'formula' | 'revoked';
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
  /** Last date this rate applies; expiry falls back to the catalog (ADR 0009). */
  readonly effectiveTo: string | null;
  /** Quantity price breaks (ADR 0009): lowest applicable price wins. */
  readonly tiers: readonly RateTier[];
  readonly at: string;
}

/**
 * A quantity price break: applies when the line quantity meets the threshold
 * and/or is an exact multiple (full box / pallet). At least one condition.
 */
export interface RateTier {
  readonly tierNo: number;
  /** "This many or more" (scale-3 quantity). */
  readonly minQuantityMilli: bigint | null;
  /** "Exact multiples only" — e.g. a full box of 12 (scale-3 quantity). */
  readonly multipleQuantityMilli: bigint | null;
  readonly kind: 'constant' | 'formula';
  readonly unitPrice: bigint | null;
  readonly base: RateBase | null;
  readonly percentMilli: bigint;
  readonly amountMinor: bigint;
}

export interface NewRateTier {
  minQuantityMilli?: bigint;
  multipleQuantityMilli?: bigint;
  rate: RateSpec;
}

export type RateSpec =
  | { kind: 'constant'; unitPrice: bigint }
  | { kind: 'formula'; base: RateBase; percentMilli?: bigint; amountMinor?: bigint };

export interface NewCustomerRate {
  itemId: string;
  partyId?: string;
  customerName?: string;
  accountNumber?: string;
  rate: RateSpec | { kind: 'revoked' };
  /** Quantity price breaks; lowest applicable price wins (ADR 0009). */
  tiers?: NewRateTier[];
  /**
   * Defaults to false — unless the item's typical sales price is below its
   * cost on the effective date (ADR 0007).
   */
  allowBelowCost?: boolean;
  /** Defaults to the beginning of time. */
  effectiveFrom?: string;
  /** Last date the rate applies (ADR 0009). */
  effectiveTo?: string;
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
 * Resolve a rate for a specific line quantity (ADR 0009): among the base rate
 * and every tier whose threshold/multiple condition the quantity meets, the
 * lowest resulting price wins. Revoked rates resolve to nothing.
 */
export function resolveRateForQuantity(
  rate: Pick<
    CustomerRate,
    'kind' | 'unitPrice' | 'base' | 'percentMilli' | 'amountMinor' | 'allowBelowCost' | 'tiers'
  >,
  quantityMilli: bigint,
  salePrice: bigint,
  cost: bigint | undefined,
): bigint | undefined {
  if (rate.kind === 'revoked') return undefined;
  let best = resolveRatePrice(rate, salePrice, cost);
  for (const tier of rate.tiers) {
    if (tier.minQuantityMilli !== null && quantityMilli < tier.minQuantityMilli) continue;
    if (tier.multipleQuantityMilli !== null && quantityMilli % tier.multipleQuantityMilli !== 0n) continue;
    const price = resolveRatePrice({ ...tier, allowBelowCost: rate.allowBelowCost }, salePrice, cost);
    if (price < best) best = price;
  }
  return best;
}

/** Scale-3 margin percent of a price over cost, or null when unknowable. */
export function marginPercentMilli(price: bigint, cost: bigint | undefined): bigint | null {
  if (cost === undefined || price <= 0n) return null;
  return divRoundHalf((price - cost) * PERCENT_SCALE, price);
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
  /** Scale-3 margin of the given price over cost (ADR 0009), when known. */
  readonly marginPercentMilli: bigint | null;
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
    const expectedPrice =
      catalog.customerPriceAt(line.itemId, customer, current.date, line.quantityMilli) ?? catalogPrice;
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
      marginPercentMilli: marginPercentMilli(givenPrice, cost),
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


/** One row of the "who has special pricing" report (ADR 0009). */
export interface RateReviewEntry {
  readonly rate: CustomerRate;
  readonly itemName: string;
  readonly salePrice: bigint;
  readonly cost: bigint | undefined;
  /** Resolved for a single unit; undefined when revoked. */
  readonly resolvedPrice: bigint | undefined;
  readonly marginPercentMilli: bigint | null;
  /** Effective as of the review date (not superseded, expired, or revoked). */
  readonly active: boolean;
}

/**
 * Review every customer's special pricing as of a date: the winning rate per
 * (item, customer) with current sale price, cost, resolved price, and margin.
 */
export function computeRateReview(
  rates: readonly CustomerRate[],
  catalog: ItemCatalog,
  asOf: string,
): RateReviewEntry[] {
  const winners = new Map<string, CustomerRate>();
  for (const rate of rates) {
    if (rate.effectiveFrom > asOf) continue;
    const key = `${rate.itemId}|${rate.partyId ?? ''}|${rate.accountNumber ?? ''}|${rate.customerName ?? ''}`;
    const current = winners.get(key);
    if (
      !current ||
      rate.effectiveFrom > current.effectiveFrom ||
      (rate.effectiveFrom === current.effectiveFrom && rate.rateSeq > current.rateSeq)
    ) {
      winners.set(key, rate);
    }
  }
  const entries: RateReviewEntry[] = [];
  for (const rate of winners.values()) {
    const item = catalog.getItem(rate.itemId);
    if (!item) continue;
    const salePrice = catalog.priceAt(rate.itemId, asOf);
    const cost = catalog.costAt(rate.itemId, asOf);
    const expired = rate.effectiveTo !== null && asOf > rate.effectiveTo;
    const resolvedPrice =
      expired || rate.kind === 'revoked'
        ? undefined
        : resolveRateForQuantity(rate, 1000n, salePrice, cost);
    entries.push({
      rate,
      itemName: item.name,
      salePrice,
      cost,
      resolvedPrice,
      marginPercentMilli: resolvedPrice === undefined ? null : marginPercentMilli(resolvedPrice, cost),
      active: !expired && rate.kind !== 'revoked',
    });
  }
  entries.sort((a, b) => (a.itemName === b.itemName ? a.rate.rateSeq - b.rate.rateSeq : a.itemName < b.itemName ? -1 : 1));
  return entries;
}
