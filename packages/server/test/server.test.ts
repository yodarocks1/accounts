import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { CompanyFile } from '@accounts/storage';
import { createApiServer } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-api-'));
  file = CompanyFile.create(join(dir, 'books.sqlite'), { name: 'API Co', baseCurrency: 'USD' });
  server = createApiServer(file);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: never }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as never };
}

describe('document API (Tier 3)', () => {
  it('drives the full sales flow over HTTP with string bigints', async () => {
    expect((await get('/company')).json).toEqual({ name: 'API Co', baseCurrency: 'USD' });

    await post('/tax-rates', { code: 'TX', percentMilli: '8250' });
    const widget = (await post('/items', {
      name: 'Widget', currency: 'USD', unitPrice: '2500', cost: '1000', taxCode: 'TX', depositPolicy: 'always',
    })).json as { id: string };
    const party = (await post('/parties', { name: 'Acme LLC', accountNumber: 'A-100', termsDays: 30 })).json as { id: string };
    await post('/sequences/sales_order', { prefix: 'SO-' });
    await post('/sequences/invoice', { prefix: 'INV-' });
    await post('/sequences/payment', { prefix: 'PMT-' });

    // Sales order with a 25% deposit request (required by the item policy).
    const order = (await post('/documents', {
      type: 'sales_order', date: '2026-07-01', partyId: party.id,
      deposit: { percentMilli: '25000' },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: '4000', lineId: 'L1' }],
    })).json as { id: string; number: string; total: string; subtotal: string; taxTotal: string };
    expect(order.number).toBe('SO-0001');
    expect(order.subtotal).toBe('10000');
    expect(order.taxTotal).toBe('825');
    expect(order.total).toBe('10825');

    await post(`/documents/${order.id}/send`, {});

    // Line-level prepayment via a payment.
    const payment = (await post('/payments', {
      date: '2026-07-02', partyId: party.id, amount: '5000', method: 'check #9',
      applications: [{ invoiceId: order.id, amount: '5000', lineId: 'L1' }],
    })).json as { id: string; number: string };
    expect(payment.number).toBe('PMT-0001');
    const prepayments = (await get(`/documents/${order.id}/prepayments`)).json as { prepaid: string }[];
    expect(prepayments[0]!.prepaid).toBe('5000');

    // Convert to invoice; deposit transfers on send.
    const invoice = (await post(`/documents/${order.id}/convert`, { type: 'invoice', date: '2026-07-03' })).json as {
      id: string; number: string;
    };
    expect(invoice.number).toBe('INV-0001');
    await post(`/documents/${invoice.id}/send`, {});
    const settlement = (await get(`/documents/${invoice.id}/settlement`)).json as { paid: string; open: string };
    expect(settlement.paid).toBe('5000');
    expect(settlement.open).toBe('5825');

    // Statement through the party.
    const statement = (await get(`/statements?partyId=${party.id}&asOf=2026-07-10`)).json as {
      invoices: { number: string; openAmount: string; dueDate: string }[];
      balance: string;
    };
    expect(statement.invoices[0]!.number).toBe('INV-0001');
    expect(statement.invoices[0]!.dueDate).toBe('2026-08-02');
    expect(statement.balance).toBe('5825');
  });

  it('maps LedgerError codes to HTTP statuses', async () => {
    const missing = await get('/documents/nope');
    expect(missing.status).toBe(404);

    await post('/items', { name: 'W', currency: 'USD', unitPrice: '100' });
    const bad = await post('/documents', {
      type: 'invoice', date: '2026-07-01', customerName: '',
      lines: [{ description: 'x', quantityMilli: '1000', unitPrice: '100', currency: 'USD' }],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe('INVALID_DOCUMENT');

    const unknownRoute = await get('/frobnicate');
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.json.error).toBe('NOT_FOUND');
  });

  it('gated actions surface 403 APPROVAL_REQUIRED', async () => {
    await post('/policies/approval', { actions: ['void_document'] });
    const item = (await post('/items', { name: 'W', currency: 'USD', unitPrice: '100' })).json as { id: string };
    const doc = (await post('/documents', {
      type: 'invoice', number: 'INV-X', date: '2026-07-01', customerName: 'Acme',
      lines: [{ itemId: item.id, description: 'W', quantityMilli: '1000' }],
    })).json as { id: string };
    const denied = await post(`/documents/${doc.id}/void`, {});
    expect(denied.status).toBe(403);
    const allowed = await post(`/documents/${doc.id}/void`, { approvedBy: 'owner' });
    expect(allowed.status).toBe(201);
  });
});
