import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { LedgerError, type LedgerErrorCode } from '@accounts/core';
import type { CompanyFile } from '@accounts/storage';
import { renderDashboard } from './dashboard.js';

/**
 * The document-layer API (ADR 0010 part 4): a dependency-free JSON HTTP
 * server over one company file. Monetary/quantity bigints travel as strings
 * in JSON; requests send them the same way.
 */

/** bigint → string on the way out; Maps become arrays of [key, value]. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'bigint') return entry.toString();
    if (entry instanceof Map) return [...entry.entries()];
    return entry;
  });
}

const money = (value: unknown, field: string): bigint => {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new LedgerError('INVALID_DOCUMENT', `${field} must be an integer string of minor units`);
};
const optMoney = (value: unknown, field: string): bigint | undefined =>
  value === undefined || value === null ? undefined : money(value, field);
const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new LedgerError('INVALID_DOCUMENT', `${field} must be a string`);
  return value;
};
const optStr = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value);
const optNum = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : Number(value);
const optBool = (value: unknown): boolean | undefined =>
  value === undefined || value === null ? undefined : Boolean(value);

type Body = Record<string, unknown>;

function mapLine(raw: Body): Record<string, unknown> {
  return {
    description: str(raw.description, 'description'),
    quantityMilli: money(raw.quantityMilli, 'quantityMilli'),
    ...(raw.itemId !== undefined ? { itemId: str(raw.itemId, 'itemId') } : {}),
    ...(raw.unitPrice !== undefined ? { unitPrice: money(raw.unitPrice, 'unitPrice') } : {}),
    ...(raw.currency !== undefined ? { currency: str(raw.currency, 'currency') } : {}),
    ...(raw.lineId !== undefined ? { lineId: str(raw.lineId, 'lineId') } : {}),
    ...(raw.adjustment !== undefined ? { adjustment: money(raw.adjustment, 'adjustment') } : {}),
    ...(raw.free !== undefined ? { free: Boolean(raw.free) } : {}),
    ...(raw.substituted !== undefined ? { substituted: Boolean(raw.substituted) } : {}),
    ...(raw.sourceDocumentId !== undefined ? { sourceDocumentId: str(raw.sourceDocumentId, 'sourceDocumentId') } : {}),
    ...(raw.sourceLineId !== undefined ? { sourceLineId: str(raw.sourceLineId, 'sourceLineId') } : {}),
    ...(raw.taxCode !== undefined ? { taxCode: raw.taxCode === null ? null : str(raw.taxCode, 'taxCode') } : {}),
  };
}

function mapCustomer(raw: Body): Record<string, unknown> {
  return {
    ...(raw.customerName !== undefined ? { customerName: str(raw.customerName, 'customerName') } : {}),
    ...(raw.accountNumber !== undefined ? { accountNumber: str(raw.accountNumber, 'accountNumber') } : {}),
    ...(raw.partyId !== undefined ? { partyId: str(raw.partyId, 'partyId') } : {}),
    ...(raw.poNumber !== undefined ? { poNumber: str(raw.poNumber, 'poNumber') } : {}),
    ...(raw.termsDays !== undefined ? { termsDays: Number(raw.termsDays) } : {}),
  };
}

function mapDeposit(raw: unknown): Record<string, unknown> {
  const body = raw as Body;
  if (body.amountMinor !== undefined) return { deposit: { amountMinor: money(body.amountMinor, 'deposit.amountMinor') } };
  return { deposit: { percentMilli: money(body.percentMilli, 'deposit.percentMilli') } };
}

function mapSupplierInfo(partyId: string, body: Body): Record<string, unknown> {
  return {
    partyId,
    asOf: str(body.asOf, 'asOf'),
    currency: str(body.currency, 'currency'),
    ...(body.source !== undefined ? { source: str(body.source, 'source') } : {}),
    ...(optMoney(body.minimumOrderMinor, 'minimumOrderMinor') !== undefined
      ? { minimumOrderMinor: optMoney(body.minimumOrderMinor, 'minimumOrderMinor')! }
      : {}),
    ...(optMoney(body.minimumOrderQuantityMilli, 'minimumOrderQuantityMilli') !== undefined
      ? { minimumOrderQuantityMilli: optMoney(body.minimumOrderQuantityMilli, 'minimumOrderQuantityMilli')! }
      : {}),
    ...(optMoney(body.prepaymentPercentMilli, 'prepaymentPercentMilli') !== undefined
      ? { prepaymentPercentMilli: optMoney(body.prepaymentPercentMilli, 'prepaymentPercentMilli')! }
      : {}),
    ...(body.shipping !== undefined
      ? {
          shipping: (body.shipping as Body[]).map((raw) => ({
            method: str(raw.method, 'shipping.method'),
            ...(optMoney(raw.costMinor, 'shipping.costMinor') !== undefined ? { costMinor: optMoney(raw.costMinor, 'shipping.costMinor')! } : {}),
            ...(optMoney(raw.freeAboveMinor, 'shipping.freeAboveMinor') !== undefined ? { freeAboveMinor: optMoney(raw.freeAboveMinor, 'shipping.freeAboveMinor')! } : {}),
            ...(optNum(raw.minDays) !== undefined ? { minDays: optNum(raw.minDays)! } : {}),
            ...(optNum(raw.maxDays) !== undefined ? { maxDays: optNum(raw.maxDays)! } : {}),
          })),
        }
      : {}),
    ...(body.items !== undefined
      ? {
          items: (body.items as Body[]).map((raw) => ({
            itemId: str(raw.itemId, 'items.itemId'),
            unitCost: money(raw.unitCost, 'items.unitCost'),
            ...(raw.supplierSku !== undefined ? { supplierSku: str(raw.supplierSku, 'items.supplierSku') } : {}),
            ...(optBool(raw.inStock) !== undefined ? { inStock: optBool(raw.inStock)! } : {}),
            ...(optMoney(raw.minQuantityMilli, 'items.minQuantityMilli') !== undefined ? { minQuantityMilli: optMoney(raw.minQuantityMilli, 'items.minQuantityMilli')! } : {}),
            ...(optMoney(raw.multipleQuantityMilli, 'items.multipleQuantityMilli') !== undefined ? { multipleQuantityMilli: optMoney(raw.multipleQuantityMilli, 'items.multipleQuantityMilli')! } : {}),
            ...(optNum(raw.leadDays) !== undefined ? { leadDays: optNum(raw.leadDays)! } : {}),
          })),
        }
      : {}),
    ...(body.notes !== undefined ? { notes: str(body.notes, 'notes') } : {}),
  };
}

function mapCashTransaction(body: Body): Record<string, unknown> {
  return {
    date: str(body.date, 'date'),
    lines: (body.lines as Body[]).map(mapLine),
    ...mapCustomer(body),
    ...(body.number !== undefined ? { number: str(body.number, 'number') } : {}),
    ...(body.paymentNumber !== undefined ? { paymentNumber: str(body.paymentNumber, 'paymentNumber') } : {}),
    ...(body.memo !== undefined ? { memo: str(body.memo, 'memo') } : {}),
    ...(body.method !== undefined ? { method: str(body.method, 'method') } : {}),
    ...(body.taxExempt !== undefined ? { taxExempt: Boolean(body.taxExempt) } : {}),
    ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
  };
}

/**
 * Error → HTTP status policy: UNKNOWN_* is 404 (the noun doesn't exist),
 * APPROVAL_REQUIRED is 403 (the request is fine, you aren't), state
 * conflicts are 409 (the request is well-formed but the books disagree),
 * and anything else — a malformed request — defaults to 422.
 */
const STATUS_BY_CODE: Partial<Record<LedgerErrorCode, number>> = {
  UNKNOWN_ACCOUNT: 404,
  UNKNOWN_ENTRY: 404,
  UNKNOWN_ITEM: 404,
  UNKNOWN_DOCUMENT: 404,
  UNKNOWN_PARTY: 404,
  UNKNOWN_LINE: 404,
  UNKNOWN_TAX_CODE: 404,
  UNKNOWN_REPORT: 404,
  APPROVAL_REQUIRED: 403,
  DUPLICATE_ACCOUNT_CODE: 409,
  DUPLICATE_DOCUMENT_NUMBER: 409,
  ALREADY_REVERSED: 409,
  ALREADY_RECONCILED: 409,
  DOCUMENT_LOCKED: 409,
  ARCHIVED_ACCOUNT: 409,
  INVALID_STATUS: 409,
  INVALID_CONVERSION: 409,
  LINE_OVERDRAWN: 409,
  LINE_LINKED: 409,
  NO_PURCHASE_HISTORY: 409,
  RETURN_EXCEEDS_PURCHASE: 409,
  RETURN_WINDOW: 409,
  DEPOSIT_REQUIRED: 409,
  MINIMUM_NOT_MET: 409,
  INSUFFICIENT_STOCK: 409,
  BOM_CYCLE: 409,
  PLUGIN_ERROR: 409,
};

async function readBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Body;
  } catch {
    throw new LedgerError('INVALID_DOCUMENT', 'Request body is not valid JSON');
  }
}

/**
 * The API's self-description, served at GET /api. Hand-maintained beside
 * the routes it describes — a discoverability read, not an OpenAPI spec
 * (that generation belongs to the real project; see docs/ROADMAP.md).
 */
const ROUTE_CATALOG: readonly { method: string; path: string; summary: string }[] = [
  { method: 'GET', path: '/company', summary: 'Company name and base currency' },
  { method: 'GET', path: '/items', summary: 'List items' },
  { method: 'POST', path: '/items', summary: 'Create an item' },
  { method: 'GET', path: '/items/:id/stock', summary: 'On-hand good/damaged quantities (?asOf)' },
  { method: 'POST', path: '/items/:id/stock', summary: 'Set the in-stock flag' },
  { method: 'GET', path: '/items/:id/movements', summary: 'The append-only stock ledger' },
  { method: 'GET', path: '/items/:id/valuation', summary: 'FIFO layers and value (?asOf)' },
  { method: 'POST', path: '/items/:id/stock-adjustments', summary: 'Signed count adjustment' },
  { method: 'POST', path: '/items/:id/damage', summary: 'Move good stock to damaged' },
  { method: 'POST', path: '/items/:id/dispose', summary: 'Resolve damaged stock (restock/recycle/trash)' },
  { method: 'POST', path: '/items/:id/build', summary: 'Build assemblies from BOM components' },
  { method: 'POST', path: '/items/:id/break', summary: 'Break assemblies back into components' },
  { method: 'GET', path: '/items/:id/bom', summary: 'Bill of materials (?asOf)' },
  { method: 'POST', path: '/items/:id/bom', summary: 'Set the bill of materials' },
  { method: 'POST', path: '/items/:id/prices', summary: 'Price/cost effective from a date' },
  { method: 'GET', path: '/parties', summary: 'List parties' },
  { method: 'POST', path: '/parties', summary: 'Create a party' },
  { method: 'GET', path: '/parties/:id', summary: 'One party' },
  { method: 'GET', path: '/parties/:id/names', summary: 'Rename history' },
  { method: 'POST', path: '/parties/:id/rename', summary: 'Rename (history kept)' },
  { method: 'GET', path: '/parties/:id/supplier-info', summary: 'Effective supplier terms (?asOf)' },
  { method: 'POST', path: '/parties/:id/supplier-info', summary: 'Record supplier terms snapshot' },
  { method: 'GET', path: '/parties/:id/supplier-info-history', summary: 'All supplier-info snapshots' },
  { method: 'POST', path: '/parties/:id/refresh-supplier-info', summary: 'Pull terms via the plugin connector' },
  { method: 'GET', path: '/tax-rates', summary: 'List tax rates' },
  { method: 'POST', path: '/tax-rates', summary: 'Set a tax rate effective from a date' },
  { method: 'POST', path: '/sequences/:type', summary: 'Configure auto-numbering' },
  { method: 'GET', path: '/documents', summary: 'List documents (?type)' },
  { method: 'POST', path: '/documents', summary: 'Create a document (draft)' },
  { method: 'GET', path: '/documents/:id', summary: 'Current view of one document' },
  { method: 'GET', path: '/documents/:id/history', summary: 'Every revision' },
  { method: 'GET', path: '/documents/:id/links', summary: 'Line links + the whole family graph' },
  { method: 'GET', path: '/documents/:id/fulfillment', summary: 'Per-line open/converted/closed' },
  { method: 'GET', path: '/documents/:id/closures', summary: 'Lines closed short' },
  { method: 'GET', path: '/documents/:id/suggestions', summary: 'Special-rate suggestions' },
  { method: 'GET', path: '/documents/:id/prepayments', summary: 'Per-line prepaid amounts' },
  { method: 'GET', path: '/documents/:id/readiness', summary: 'PO readiness vs supplier terms' },
  { method: 'GET', path: '/documents/:id/purchase-coverage', summary: 'SO lines on order with suppliers' },
  { method: 'GET', path: '/documents/:id/settlement', summary: 'Paid/open for an owing document' },
  { method: 'GET', path: '/documents/:id/deposit', summary: 'Deposit currently held' },
  { method: 'POST', path: '/documents/:id/send', summary: 'Send (gates: deposit, supplier minimums)' },
  { method: 'POST', path: '/documents/:id/submit', summary: 'Send a PO and deliver via its connector' },
  { method: 'POST', path: '/documents/:id/void', summary: 'Void (stock and postings unwind)' },
  { method: 'POST', path: '/documents/:id/change', summary: 'Append a revision (edit/correction/substitution)' },
  { method: 'POST', path: '/documents/:id/convert', summary: 'Convert with explicit source line ids' },
  { method: 'POST', path: '/documents/:id/charge-correction', summary: 'Reduce the charged total' },
  { method: 'POST', path: '/documents/:id/close-line', summary: 'Close an open quantity short' },
  { method: 'POST', path: '/returns', summary: 'Return priced at last purchase, linked' },
  { method: 'GET', path: '/payments', summary: 'List payments' },
  { method: 'POST', path: '/payments', summary: 'Record a payment (in/out) with applications' },
  { method: 'POST', path: '/payments/:id/void', summary: 'Void a payment' },
  { method: 'POST', path: '/refunds', summary: 'Refund unapplied credit' },
  { method: 'POST', path: '/sales-receipts', summary: 'Cash sale: invoice + payment atomically' },
  { method: 'POST', path: '/expenses', summary: 'Cash expense: bill + payment atomically' },
  { method: 'GET', path: '/applications', summary: 'List credit applications' },
  { method: 'POST', path: '/applications', summary: 'Apply credit to an owing document' },
  { method: 'POST', path: '/applications/:seq/reverse', summary: 'Reverse an application' },
  { method: 'GET', path: '/statements', summary: 'Customer statement (?partyId|customerName|accountNumber, ?asOf)' },
  { method: 'GET', path: '/supplier-statements', summary: 'Supplier statement (same selectors)' },
  { method: 'POST', path: '/bank/import', summary: 'Import a CSV export (idempotent)' },
  { method: 'GET', path: '/bank/transactions', summary: 'Imported bank lines (?source)' },
  { method: 'GET', path: '/bank/suggestions', summary: 'Ranked match suggestions (?source, ?windowDays)' },
  { method: 'GET', path: '/bank/reconciliations', summary: 'Active reconciliation marks' },
  { method: 'POST', path: '/bank/reconcile', summary: 'Confirm a match' },
  { method: 'POST', path: '/bank/reconcile/:seq/reverse', summary: 'Undo a reconciliation' },
  { method: 'GET', path: '/plugins', summary: 'Attached plugins and their reports' },
  { method: 'GET', path: '/reports/pnl', summary: 'Profit & loss (?from, ?to)' },
  { method: 'GET', path: '/reports/balance-sheet', summary: 'Balance sheet (?asOf)' },
  { method: 'GET', path: '/reports/ar-aging', summary: 'A/R aging (?asOf)' },
  { method: 'GET', path: '/reports/ap-aging', summary: 'A/P aging (?asOf)' },
  { method: 'GET', path: '/reports/inventory', summary: 'Inventory valuation (?asOf)' },
  { method: 'GET', path: '/reports/:plugin-report', summary: 'Plugin report contributions' },
  { method: 'GET', path: '/rate-review', summary: 'Customer rates due for review (?asOf)' },
  { method: 'GET', path: '/trial-balance', summary: 'Trial balance (?asOf)' },
  { method: 'POST', path: '/posting-accounts/:role', summary: 'Map a ledger role to an account' },
  { method: 'POST', path: '/policies/approval', summary: 'Gate actions behind approval' },
  { method: 'POST', path: '/policies/return', summary: 'Return window and restocking fees' },
];

/** Route the request; returns the response payload or undefined for 404. */
async function route(file: CompanyFile, method: string, segments: string[], query: URLSearchParams, body: Body): Promise<unknown> {
  const [head, id, sub] = segments;
  const asOf = query.get('asOf') ?? new Date().toISOString().slice(0, 10);

  // GET /api with no further path: the API describes itself.
  if (head === undefined && method === 'GET') {
    return { service: 'accounts-api', routes: ROUTE_CATALOG };
  }

  if (head === 'company' && method === 'GET') return file.info();

  if (head === 'items') {
    if (method === 'GET' && id === undefined) return file.listItems();
    if (method === 'POST' && id === undefined) {
      return file.createItem({
        name: str(body.name, 'name'),
        currency: str(body.currency, 'currency'),
        unitPrice: money(body.unitPrice, 'unitPrice'),
        ...(body.cost !== undefined ? { cost: money(body.cost, 'cost') } : {}),
        ...(body.taxCode !== undefined ? { taxCode: str(body.taxCode, 'taxCode') } : {}),
        ...(body.depositPolicy !== undefined ? { depositPolicy: str(body.depositPolicy, 'depositPolicy') as never } : {}),
        ...(body.kind !== undefined ? { kind: str(body.kind, 'kind') as never } : {}),
        ...(body.dispositions !== undefined ? { dispositions: body.dispositions as never } : {}),
        ...(body.inStock !== undefined ? { inStock: Boolean(body.inStock) } : {}),
      });
    }
    if (method === 'POST' && id !== undefined && sub === 'stock') return file.setItemStock(id, Boolean(body.inStock));
    if (method === 'GET' && id !== undefined && sub === 'stock') {
      return file.stockOnHand(id, query.get('asOf') ?? undefined);
    }
    if (method === 'GET' && id !== undefined && sub === 'movements') return file.stockMovements(id);
    if (method === 'GET' && id !== undefined && sub === 'valuation') {
      return file.itemValuation(id, query.get('asOf') ?? undefined);
    }
    if (method === 'POST' && id !== undefined && sub === 'stock-adjustments') {
      return file.adjustStock(id, money(body.quantityMilli, 'quantityMilli'), {
        ...(body.reason !== undefined ? { reason: str(body.reason, 'reason') } : {}),
        ...(body.date !== undefined ? { date: str(body.date, 'date') } : {}),
        ...(body.condition !== undefined ? { condition: str(body.condition, 'condition') as never } : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      });
    }
    if (method === 'POST' && id !== undefined && sub === 'damage') {
      return file.markDamaged(id, money(body.quantityMilli, 'quantityMilli'), {
        ...(body.reason !== undefined ? { reason: str(body.reason, 'reason') } : {}),
        ...(body.date !== undefined ? { date: str(body.date, 'date') } : {}),
      });
    }
    if (method === 'POST' && id !== undefined && sub === 'dispose') {
      return file.disposeStock(id, money(body.quantityMilli, 'quantityMilli'), str(body.disposition, 'disposition') as never, {
        ...(body.reason !== undefined ? { reason: str(body.reason, 'reason') } : {}),
        ...(body.date !== undefined ? { date: str(body.date, 'date') } : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      });
    }
    if (method === 'POST' && id !== undefined && (sub === 'build' || sub === 'break')) {
      const quantity = money(body.quantityMilli, 'quantityMilli');
      const options = {
        ...(body.reason !== undefined ? { reason: str(body.reason, 'reason') } : {}),
        ...(body.date !== undefined ? { date: str(body.date, 'date') } : {}),
      };
      return sub === 'build' ? file.buildAssembly(id, quantity, options) : file.breakAssembly(id, quantity, options);
    }
    if (method === 'POST' && id !== undefined && sub === 'bom') {
      return file.setBom({
        itemId: id,
        components: (body.components as Body[]).map((raw) => ({
          componentItemId: str(raw.componentItemId, 'componentItemId'),
          quantityMilli: money(raw.quantityMilli, 'quantityMilli'),
        })),
        ...(body.effectiveFrom !== undefined ? { effectiveFrom: str(body.effectiveFrom, 'effectiveFrom') } : {}),
        ...(optMoney(body.assemblyCostMinor, 'assemblyCostMinor') !== undefined
          ? { assemblyCostMinor: optMoney(body.assemblyCostMinor, 'assemblyCostMinor')! }
          : {}),
      });
    }
    if (method === 'GET' && id !== undefined && sub === 'bom') {
      return file.bomAt(id, query.get('asOf') ?? new Date().toISOString().slice(0, 10)) ?? null;
    }
    if (method === 'POST' && id !== undefined && sub === 'prices') {
      const effectiveFrom = str(body.effectiveFrom, 'effectiveFrom');
      const unitPrice = money(body.unitPrice, 'unitPrice');
      return body.kind === 'cost' ? file.setCost(id, unitPrice, effectiveFrom) : file.setPrice(id, unitPrice, effectiveFrom);
    }
  }

  if (head === 'parties') {
    if (method === 'GET' && id === undefined) return file.listParties();
    if (method === 'POST' && id === undefined) {
      return file.createParty({
        name: str(body.name, 'name'),
        ...(body.accountNumber !== undefined ? { accountNumber: str(body.accountNumber, 'accountNumber') } : {}),
        ...(optNum(body.termsDays) !== undefined ? { termsDays: optNum(body.termsDays)! } : {}),
        ...(body.taxExempt !== undefined ? { taxExempt: Boolean(body.taxExempt) } : {}),
      });
    }
    if (method === 'GET' && id !== undefined && sub === undefined) {
      const party = file.getParty(id);
      if (!party) throw new LedgerError('UNKNOWN_PARTY', `No such party: ${id}`);
      return party;
    }
    if (method === 'GET' && id !== undefined && sub === 'names') return file.partyNameHistory(id);
    if (method === 'POST' && id !== undefined && sub === 'rename') return file.renameParty(id, str(body.name, 'name'));
    if (method === 'POST' && id !== undefined && sub === 'supplier-info') {
      return file.recordSupplierInfo(mapSupplierInfo(id, body) as never);
    }
    if (method === 'POST' && id !== undefined && sub === 'refresh-supplier-info') {
      return await file.refreshSupplierInfo(id);
    }
    if (method === 'GET' && id !== undefined && sub === 'supplier-info') {
      const at = query.get('asOf');
      return (at !== null ? file.supplierInfoAt(id, at) : file.supplierInfo(id)) ?? null;
    }
    if (method === 'GET' && id !== undefined && sub === 'supplier-info-history') {
      return file.supplierInfoHistory(id);
    }
  }

  if (head === 'tax-rates') {
    if (method === 'GET') return file.listTaxRates();
    if (method === 'POST') {
      return file.setTaxRate({
        code: str(body.code, 'code'),
        percentMilli: money(body.percentMilli, 'percentMilli'),
        ...(body.name !== undefined ? { name: str(body.name, 'name') } : {}),
        ...(body.effectiveFrom !== undefined ? { effectiveFrom: str(body.effectiveFrom, 'effectiveFrom') } : {}),
      });
    }
  }

  if (head === 'sequences' && method === 'POST' && id !== undefined) {
    return file.setNumberSequence(id as never, {
      prefix: str(body.prefix, 'prefix'),
      ...(optNum(body.next) !== undefined ? { next: optNum(body.next)! } : {}),
      ...(optNum(body.width) !== undefined ? { width: optNum(body.width)! } : {}),
    });
  }

  if (head === 'documents') {
    if (method === 'GET' && id === undefined) {
      const type = query.get('type');
      return file.listDocuments(type === null ? undefined : (type as never));
    }
    if (method === 'POST' && id === undefined) {
      const lines = (body.lines as Body[]).map(mapLine);
      return file.createDocument({
        type: str(body.type, 'type') as never,
        date: str(body.date, 'date'),
        lines: lines as never,
        ...(body.number !== undefined ? { number: str(body.number, 'number') } : {}),
        ...mapCustomer(body),
        ...(body.memo !== undefined ? { memo: str(body.memo, 'memo') } : {}),
        ...(body.sourceDocumentId !== undefined ? { sourceDocumentId: str(body.sourceDocumentId, 'sourceDocumentId') } : {}),
        ...(body.settlement !== undefined ? { settlement: str(body.settlement, 'settlement') as never } : {}),
        ...(body.taxExempt !== undefined ? { taxExempt: Boolean(body.taxExempt) } : {}),
        ...(body.deposit !== undefined ? mapDeposit(body.deposit) : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      } as never);
    }
    if (id === undefined) return undefined;
    if (method === 'GET' && sub === undefined) return file.viewDocument(id);
    if (method === 'GET' && sub === 'history') return file.documentHistory(id);
    if (method === 'GET' && sub === 'fulfillment') return file.fulfillment(id);
    if (method === 'GET' && sub === 'links') return file.documentLinks(id);
    if (method === 'GET' && sub === 'closures') return file.lineClosures(id);
    if (method === 'GET' && sub === 'suggestions') return file.suggestSpecialRates(id);
    if (method === 'GET' && sub === 'prepayments') return file.linePrepayments(id);
    if (method === 'POST' && sub === 'send') {
      return file.sendDocument(id, {
        ...(body.overrideDeposit !== undefined ? { overrideDeposit: Boolean(body.overrideDeposit) } : {}),
        ...(body.overrideMinimum !== undefined ? { overrideMinimum: Boolean(body.overrideMinimum) } : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      });
    }
    if (method === 'POST' && sub === 'submit') {
      return await file.submitPurchaseOrder(id, {
        ...(body.overrideDeposit !== undefined ? { overrideDeposit: Boolean(body.overrideDeposit) } : {}),
        ...(body.overrideMinimum !== undefined ? { overrideMinimum: Boolean(body.overrideMinimum) } : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      });
    }
    if (method === 'GET' && sub === 'readiness') return file.purchaseOrderReadiness(id);
    if (method === 'GET' && sub === 'purchase-coverage') return file.purchaseCoverage(id);
    if (method === 'POST' && sub === 'void') return file.voidDocument(id, optStr(body.approvedBy));
    if (method === 'POST' && sub === 'change') {
      return file.changeDocument(id, {
        ...(body.kind !== undefined ? { kind: str(body.kind, 'kind') as never } : {}),
        ...(body.reason !== undefined ? { reason: str(body.reason, 'reason') } : {}),
        ...(body.date !== undefined ? { date: str(body.date, 'date') } : {}),
        ...(body.lines !== undefined ? { lines: (body.lines as Body[]).map(mapLine) as never } : {}),
        ...mapCustomer(body),
        ...(body.memo !== undefined ? { memo: str(body.memo, 'memo') } : {}),
        ...(body.deposit !== undefined ? mapDeposit(body.deposit) : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      } as never);
    }
    if (method === 'POST' && sub === 'convert') {
      return file.convertDocument(id, {
        type: str(body.type, 'type') as never,
        date: str(body.date, 'date'),
        ...(body.number !== undefined ? { number: str(body.number, 'number') } : {}),
        ...mapCustomer(body),
        ...(body.memo !== undefined ? { memo: str(body.memo, 'memo') } : {}),
        ...(body.lines !== undefined
          ? {
              lines: (body.lines as Body[]).map((raw) => ({
                sourceLineId: str(raw.sourceLineId, 'sourceLineId'),
                ...(raw.quantityMilli !== undefined ? { quantityMilli: money(raw.quantityMilli, 'quantityMilli') } : {}),
                ...(raw.free !== undefined ? { free: Boolean(raw.free) } : {}),
                ...(raw.substitution !== undefined
                  ? {
                      substitution: {
                        ...((raw.substitution as Body).itemId !== undefined ? { itemId: str((raw.substitution as Body).itemId, 'itemId') } : {}),
                        ...((raw.substitution as Body).description !== undefined ? { description: str((raw.substitution as Body).description, 'description') } : {}),
                        ...(optMoney((raw.substitution as Body).unitPrice, 'unitPrice') !== undefined
                          ? { unitPrice: optMoney((raw.substitution as Body).unitPrice, 'unitPrice')! }
                          : {}),
                      },
                    }
                  : {}),
              })),
            }
          : {}),
      } as never);
    }
    if (method === 'POST' && sub === 'charge-correction') {
      return file.chargeCorrection(id, money(body.actualTotal, 'actualTotal'), optStr(body.reason), optStr(body.approvedBy));
    }
    if (method === 'POST' && sub === 'close-line') {
      return file.closeLine(id, {
        lineId: str(body.lineId, 'lineId'),
        kind: str(body.kind, 'kind') as never,
        ...(optMoney(body.quantityMilli, 'quantityMilli') !== undefined ? { quantityMilli: optMoney(body.quantityMilli, 'quantityMilli')! } : {}),
        ...(body.reason !== undefined ? { reason: str(body.reason, 'reason') } : {}),
        ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      });
    }
    if (method === 'GET' && sub === 'settlement') return file.invoiceSettlement(id);
    if (method === 'GET' && sub === 'deposit') return { held: file.depositHeld(id) };
  }

  if (head === 'returns' && method === 'POST') {
    return file.createReturn({
      date: str(body.date, 'date'),
      ...(body.number !== undefined ? { number: str(body.number, 'number') } : {}),
      ...mapCustomer(body),
      ...(body.settlement !== undefined ? { settlement: str(body.settlement, 'settlement') as never } : {}),
      ...(body.memo !== undefined ? { memo: str(body.memo, 'memo') } : {}),
      ...(body.overrideWindow !== undefined ? { overrideWindow: Boolean(body.overrideWindow) } : {}),
      ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
      items: (body.items as Body[]).map((raw) => ({
        itemId: str(raw.itemId, 'itemId'),
        quantityMilli: money(raw.quantityMilli, 'quantityMilli'),
        ...(optMoney(raw.unitPrice, 'unitPrice') !== undefined ? { unitPrice: optMoney(raw.unitPrice, 'unitPrice')! } : {}),
        ...(raw.condition !== undefined ? { condition: str(raw.condition, 'condition') as never } : {}),
      })),
    } as never);
  }

  if (head === 'payments') {
    if (method === 'GET' && id === undefined) return file.listPayments();
    if (method === 'POST' && id === undefined) {
      return file.recordPayment({
        date: str(body.date, 'date'),
        amount: money(body.amount, 'amount'),
        ...(body.direction !== undefined ? { direction: str(body.direction, 'direction') as never } : {}),
        ...(body.number !== undefined ? { number: str(body.number, 'number') } : {}),
        ...mapCustomer(body),
        ...(body.memo !== undefined ? { memo: str(body.memo, 'memo') } : {}),
        ...(body.method !== undefined ? { method: str(body.method, 'method') } : {}),
        ...(body.applications !== undefined
          ? {
              applications: (body.applications as Body[]).map((raw) => ({
                invoiceId: str(raw.invoiceId, 'invoiceId'),
                amount: money(raw.amount, 'amount'),
                ...(raw.lineId !== undefined ? { lineId: str(raw.lineId, 'lineId') } : {}),
              })),
            }
          : {}),
      } as never);
    }
    if (method === 'POST' && id !== undefined && sub === 'void') return file.voidPayment(id);
  }

  if (head === 'refunds' && method === 'POST') {
    return file.refundCredit({
      sourceKind: str(body.sourceKind, 'sourceKind') as never,
      sourceId: str(body.sourceId, 'sourceId'),
      amount: money(body.amount, 'amount'),
      ...(body.date !== undefined ? { date: str(body.date, 'date') } : {}),
      ...(body.approvedBy !== undefined ? { approvedBy: str(body.approvedBy, 'approvedBy') } : {}),
    });
  }

  if (head === 'sales-receipts' && method === 'POST') {
    return file.recordSalesReceipt(mapCashTransaction(body) as never);
  }

  if (head === 'expenses' && method === 'POST') {
    return file.recordExpense(mapCashTransaction(body) as never);
  }

  if (head === 'applications') {
    if (method === 'GET') return file.listApplications();
    if (method === 'POST' && id === undefined) {
      return file.applyCredit({
        sourceKind: str(body.sourceKind, 'sourceKind') as never,
        sourceId: str(body.sourceId, 'sourceId'),
        invoiceId: str(body.invoiceId, 'invoiceId'),
        amount: money(body.amount, 'amount'),
        ...(body.lineId !== undefined ? { lineId: str(body.lineId, 'lineId') } : {}),
      });
    }
    if (method === 'POST' && id !== undefined && sub === 'reverse') return file.reverseApplication(Number(id));
  }

  if (head === 'statements' && method === 'GET') {
    const partyId = query.get('partyId');
    if (partyId !== null) return file.statementForParty(partyId, asOf);
    return file.statement(
      {
        ...(query.get('customerName') !== null ? { customerName: query.get('customerName')! } : {}),
        ...(query.get('accountNumber') !== null ? { accountNumber: query.get('accountNumber')! } : {}),
      },
      asOf,
    );
  }

  if (head === 'supplier-statements' && method === 'GET') {
    const partyId = query.get('partyId');
    if (partyId !== null) return file.supplierStatementForParty(partyId, asOf);
    return file.supplierStatement(
      {
        ...(query.get('customerName') !== null ? { customerName: query.get('customerName')! } : {}),
        ...(query.get('accountNumber') !== null ? { accountNumber: query.get('accountNumber')! } : {}),
      },
      asOf,
    );
  }

  if (head === 'bank') {
    if (method === 'POST' && id === 'import') {
      return file.importBankTransactions(str(body.source, 'source'), str(body.csv, 'csv'));
    }
    if (method === 'GET' && id === 'transactions') {
      return file.listBankTransactions(query.get('source') ?? undefined);
    }
    if (method === 'GET' && id === 'reconciliations') {
      return file.bankReconciliations();
    }
    if (method === 'GET' && id === 'suggestions') {
      const window = query.get('windowDays');
      return file.bankMatchSuggestions(query.get('source') ?? undefined, window !== null ? Number(window) : undefined);
    }
    if (method === 'POST' && id === 'reconcile' && sub === undefined) {
      return file.reconcileBankTransaction(Number(body.bankSeq), str(body.paymentId, 'paymentId'));
    }
    if (method === 'POST' && id === 'reconcile' && sub !== undefined) {
      return file.unreconcileBankTransaction(Number(sub));
    }
  }

  if (head === 'plugins' && method === 'GET') {
    return { plugins: file.plugins(), reports: file.pluginReportNames() };
  }

  if (head === 'reports' && method === 'GET') {
    if (id === 'pnl') {
      const from = query.get('from');
      const to = query.get('to');
      if (from === null || to === null) {
        throw new LedgerError('INVALID_DOCUMENT', 'P&L needs from and to dates');
      }
      return file.profitAndLoss(from, to);
    }
    if (id === 'balance-sheet') return file.balanceSheet(asOf);
    if (id === 'ar-aging') return file.arAging(asOf);
    if (id === 'ap-aging') return file.apAging(asOf);
    if (id === 'inventory') return file.inventorySummary(query.get('asOf') ?? undefined);
    if (id !== undefined && file.pluginReportNames().includes(id)) {
      // Plugin contributions share the namespace; built-ins win collisions.
      return file.runPluginReport(id, Object.fromEntries(query.entries()));
    }
  }

  if (head === 'rate-review' && method === 'GET') return file.rateReview(asOf);

  if (head === 'trial-balance' && method === 'GET') {
    const balance = file.trialBalance(query.get('asOf') ?? undefined);
    return { asOf: balance.asOf, rows: balance.rows, totals: balance.totals };
  }

  if (head === 'posting-accounts' && method === 'POST' && id !== undefined) {
    file.setPostingAccount(id as never, str(body.accountId, 'accountId'));
    return { ok: true };
  }

  if (head === 'policies' && method === 'POST') {
    if (id === 'approval') {
      file.setApprovalPolicy(body.actions as never);
      return { ok: true };
    }
    if (id === 'return') {
      const fees = (body.fees ?? {}) as Record<string, Body>;
      file.setReturnPolicy({
        ...(optNum(body.windowDays) !== undefined ? { windowDays: optNum(body.windowDays)! } : {}),
        fees: Object.fromEntries(
          Object.entries(fees).map(([condition, fee]) => [
            condition,
            {
              ...(optMoney(fee.percentMilli, 'percentMilli') !== undefined ? { percentMilli: optMoney(fee.percentMilli, 'percentMilli')! } : {}),
              ...(optMoney(fee.amountMinor, 'amountMinor') !== undefined ? { amountMinor: optMoney(fee.amountMinor, 'amountMinor')! } : {}),
            },
          ]),
        ),
      });
      return { ok: true };
    }
  }

  return undefined;
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Serve one file under /app from the built web bundle (ADR 0020): resolved
 * paths must stay inside webRoot; unknown extensionless paths fall back to
 * index.html so hash/deep links load the SPA.
 */
async function serveStatic(webRoot: string, rest: readonly string[], response: ServerResponse): Promise<void> {
  const root = resolve(webRoot);
  const requested = resolve(join(root, ...rest));
  const safe = requested === root || requested.startsWith(root + sep) ? requested : root;
  const target = extname(safe) === '' ? join(root, 'index.html') : safe;
  try {
    const content = await readFile(target);
    response.writeHead(200, { 'content-type': STATIC_TYPES[extname(target)] ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(toJson({ error: 'NOT_FOUND', message: `No such asset under /app` }));
  }
}

export interface ApiServerOptions {
  /** Directory of the built @accounts/web bundle; enables GET /app/*. */
  webRoot?: string;
}

/** Build (but do not start) the HTTP server for a company file. */
export function createApiServer(file: CompanyFile, options: ApiServerOptions = {}): Server {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      let segments = url.pathname.split('/').filter((segment) => segment.length > 0);
      try {
        // The human-facing surface: GET / (or /dashboard) renders HTML;
        // every other path stays JSON.
        const wantsDashboard =
          request.method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'dashboard'));
        if (wantsDashboard) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(renderDashboard(file, url.searchParams));
          return;
        }
        if (segments[0] === 'app' && options.webRoot !== undefined && request.method === 'GET') {
          await serveStatic(options.webRoot, segments.slice(1), response);
          return;
        }
        // The same API answers with and without the /api prefix (ADR 0020):
        // the prefix gives dev servers one thing to proxy.
        if (segments[0] === 'api') segments = segments.slice(1);
        const body = request.method === 'GET' ? {} : await readBody(request);
        const result = await route(file, request.method ?? 'GET', segments, url.searchParams, body);
        if (result === undefined) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(toJson({ error: 'NOT_FOUND', message: `No route ${request.method} ${url.pathname}` }));
          return;
        }
        response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
        response.end(toJson(result));
      } catch (error) {
        if (error instanceof LedgerError) {
          response.writeHead(STATUS_BY_CODE[error.code] ?? 422, { 'content-type': 'application/json' });
          response.end(toJson({ error: error.code, message: error.message }));
          return;
        }
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(toJson({ error: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });
}
