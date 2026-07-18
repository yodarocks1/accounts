/**
 * Thin typed client for the JSON API (ADR 0020). The wire carries bigints
 * as strings (the Tier 3.4 contract); wire types below say `string` where
 * the server means minor units or milli quantities, and conversion happens
 * only in format.ts — with BigInt, never Number.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const record = payload as { error?: string; message?: string };
    throw new ApiError(record.error ?? 'UNKNOWN', record.message ?? response.statusText, response.status);
  }
  return payload as T;
}

export const get = <T>(path: string): Promise<T> => request<T>('GET', path);
export const post = <T>(path: string, body: unknown): Promise<T> => request<T>('POST', path, body);

// ── Wire shapes (string = bigint on the wire) ──────────────────────────────

export interface CompanyInfoWire {
  name: string;
  baseCurrency: string;
}

export interface ReportRowWire {
  accountId: string;
  code: string | null;
  name: string;
  currency: string;
  amount: string;
}

export interface BalanceSheetWire {
  asOf: string;
  assets: ReportRowWire[];
  liabilities: ReportRowWire[];
  equity: ReportRowWire[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  balanced: boolean;
}

export interface ProfitAndLossWire {
  from: string;
  to: string;
  income: ReportRowWire[];
  expense: ReportRowWire[];
  totalIncome: string;
  totalExpense: string;
  netProfit: string;
}

export interface AgingBucketWire {
  label: string;
  amount: string;
}

export interface AgingSummaryWire {
  asOf: string;
  side: 'customer' | 'supplier';
  labels: string[];
  rows: { partyId: string | null; name: string; accountNumber: string | null; buckets: AgingBucketWire[]; total: string }[];
  totals: AgingBucketWire[];
  grandTotal: string;
}

export interface InventorySummaryWire {
  asOf: string | null;
  rows: { itemId: string; name: string; quantityMilli: string; valueMinor: string }[];
  totalValueMinor: string;
}

export interface DocumentLineWire {
  lineId: string;
  itemId: string | null;
  description: string;
  quantityMilli: string;
  unitPrice: string;
  adjustment: string;
  free: boolean;
}

export interface DocumentWire {
  id: string;
  type: string;
  number: string;
  status: string;
  label: string;
  currency: string;
  total: string;
  subtotal: string;
  taxTotal: string;
  current: { date: string; customerName: string; memo: string | null; lines: DocumentLineWire[] };
  /** Per-line amounts as booked, aligned with current.lines (ADR 0005). */
  recordedLineTotals: string[];
  tags: string[];
}

export interface SettlementWire {
  total: string;
  paid: string;
  open: string;
}

export interface PluginsWire {
  plugins: { id: string; name: string; version: string }[];
  reports: string[];
}

export interface BankTransactionWire {
  bankSeq: number;
  source: string;
  date: string;
  amountMinor: string;
  description: string;
  reference: string | null;
}

export interface BankSuggestionWire {
  bankSeq: number;
  paymentId: string;
  paymentNumber: string;
  dayOffset: number;
}

export interface BankReconciliationWire {
  bankSeq: number;
  reconSeq: number;
  paymentId: string;
}
