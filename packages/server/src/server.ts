import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LedgerError, type LedgerErrorCode } from '@accounts/core';
import type { CompanyFile } from '@accounts/storage';

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

const STATUS_BY_CODE: Partial<Record<LedgerErrorCode, number>> = {
  UNKNOWN_ACCOUNT: 404,
  UNKNOWN_ENTRY: 404,
  UNKNOWN_ITEM: 404,
  UNKNOWN_DOCUMENT: 404,
  UNKNOWN_LINE: 404,
  UNKNOWN_TAX_CODE: 404,
  DUPLICATE_ACCOUNT_CODE: 409,
  DUPLICATE_DOCUMENT_NUMBER: 409,
  ALREADY_REVERSED: 409,
  APPROVAL_REQUIRED: 403,
  DEPOSIT_REQUIRED: 409,
  MINIMUM_NOT_MET: 409,
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

/** Route the request; returns the response payload or undefined for 404. */
async function route(file: CompanyFile, method: string, segments: string[], query: URLSearchParams, body: Body): Promise<unknown> {
  const [head, id, sub] = segments;
  const asOf = query.get('asOf') ?? new Date().toISOString().slice(0, 10);

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
        ...(body.inStock !== undefined ? { inStock: Boolean(body.inStock) } : {}),
      });
    }
    if (method === 'POST' && id !== undefined && sub === 'stock') return file.setItemStock(id, Boolean(body.inStock));
    if (method === 'POST' && id !== undefined && sub === 'prices') {
      const effectiveFrom = str(body.effectiveFrom, 'effectiveFrom');
      const unitPrice = money(body.unitPrice, 'unitPrice');
      return body.kind === 'cost' ? file.setCost(id, unitPrice, effectiveFrom) : file.setPrice(id, unitPrice, effectiveFrom);
    }
  }

  if (head === 'parties') {
    if (method === 'POST' && id === undefined) {
      return file.createParty({
        name: str(body.name, 'name'),
        ...(body.accountNumber !== undefined ? { accountNumber: str(body.accountNumber, 'accountNumber') } : {}),
        ...(optNum(body.termsDays) !== undefined ? { termsDays: optNum(body.termsDays)! } : {}),
        ...(body.taxExempt !== undefined ? { taxExempt: Boolean(body.taxExempt) } : {}),
      });
    }
    if (method === 'GET' && id !== undefined && sub === undefined) return file.getParty(id);
    if (method === 'GET' && id !== undefined && sub === 'names') return file.partyNameHistory(id);
    if (method === 'POST' && id !== undefined && sub === 'rename') return file.renameParty(id, str(body.name, 'name'));
    if (method === 'POST' && id !== undefined && sub === 'supplier-info') {
      return file.recordSupplierInfo(mapSupplierInfo(id, body) as never);
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
    if (method === 'GET' && sub === 'suggestions') return file.suggestSpecialRates(id);
    if (method === 'GET' && sub === 'prepayments') return file.linePrepayments(id);
    if (method === 'POST' && sub === 'send') {
      return file.sendDocument(id, {
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

/** Build (but do not start) the HTTP server for a company file. */
export function createApiServer(file: CompanyFile): Server {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
      try {
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
