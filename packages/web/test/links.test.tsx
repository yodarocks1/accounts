import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentDetail } from '../src/views/DocumentDetail';
import { mockApi } from './mock-api';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const line = (lineId: string, description: string, quantityMilli: string) => ({
  lineId, itemId: `item-${lineId}`, description, quantityMilli, unitPrice: '2500',
  adjustment: '0', free: false, substituted: false, sourceDocumentId: null, sourceLineId: null,
});

const so = {
  id: 'so1', type: 'sales_order', number: 'SO-1', status: 'sent', sourceDocumentId: 'est1',
  label: 'SO-1', currency: 'USD', total: '30000', subtotal: '30000', taxTotal: '0',
  recordedLineTotals: ['25000', '5000'],
  current: {
    date: '2026-07-02', customerName: 'Acme LLC', memo: null,
    lines: [line('L1', 'Widget', '10000'), line('L2', 'Gadget', '2000')],
  },
  tags: [],
};

const endpoint = (documentId: string, number: string, type: string, status: string, lineId: string, description: string) => ({
  documentId, type, number, label: number, status, lineId, description,
});

const reads = {
  'GET /api/documents/so1': so,
  'GET /api/documents/so1/links': {
    documentId: 'so1',
    lines: [
      {
        lineId: 'L1', description: 'Widget', quantityMilli: '10000',
        upstream: { ...endpoint('est1', 'EST-1', 'estimate', 'sent', 'E1', 'Widget'), kind: 'conversion' },
        downstream: [
          { ...endpoint('inv1', 'INV-1', 'invoice', 'sent', 'I1', 'Widget'), kind: 'conversion', quantityMilli: '4000' },
          { ...endpoint('po1', 'PO-1', 'purchase_order', 'sent', 'P1', 'Widget'), kind: 'cross', quantityMilli: '6000' },
          { ...endpoint('inv2', 'INV-2', 'invoice', 'void', 'I2', 'Widget'), kind: 'conversion', quantityMilli: '1000' },
        ],
      },
      { lineId: 'L2', description: 'Gadget', quantityMilli: '2000', upstream: null, downstream: [] },
    ],
    family: {
      nodes: [
        { documentId: 'est1', type: 'estimate', number: 'EST-1', label: 'EST-1', status: 'sent', date: '2026-07-01' },
        { documentId: 'so1', type: 'sales_order', number: 'SO-1', label: 'SO-1', status: 'sent', date: '2026-07-02' },
        { documentId: 'po1', type: 'purchase_order', number: 'PO-1', label: 'PO-1', status: 'sent', date: '2026-07-03' },
        { documentId: 'inv1', type: 'invoice', number: 'INV-1', label: 'INV-1', status: 'sent', date: '2026-07-04' },
        { documentId: 'inv2', type: 'invoice', number: 'INV-2', label: 'INV-2', status: 'void', date: '2026-07-05' },
      ],
      edges: [
        { from: 'est1', fromLineId: 'E1', to: 'so1', toLineId: 'L1', quantityMilli: '10000', kind: 'conversion', substituted: false },
        { from: 'so1', fromLineId: 'L1', to: 'po1', toLineId: 'P1', quantityMilli: '6000', kind: 'cross', substituted: false },
        { from: 'so1', fromLineId: 'L1', to: 'inv1', toLineId: 'I1', quantityMilli: '4000', kind: 'conversion', substituted: false },
      ],
    },
  },
  'GET /api/documents/so1/fulfillment': [
    { lineId: 'L1', description: 'Widget', quantityMilli: '10000', convertedMilli: '5000', closedMilli: '0', openMilli: '5000', status: 'partial' },
    { lineId: 'L2', description: 'Gadget', quantityMilli: '2000', convertedMilli: '1000', closedMilli: '1000', openMilli: '0', status: 'closed' },
  ],
  'GET /api/documents/so1/closures': [
    { closureSeq: 1, lineId: 'L2', kind: 'unfulfilled', quantityMilli: '1000', reason: 'discontinued', at: '2026-07-06T00:00:00Z' },
  ],
  'GET /api/documents/so1/prepayments': [
    { lineId: 'L1', description: 'Widget', prepaid: '5000', lineGross: '25000' },
    { lineId: 'L2', description: 'Gadget', prepaid: '0', lineGross: '5000' },
  ],
  'GET /api/documents/so1/purchase-coverage': [
    { lineId: 'L1', description: 'Widget', quantityMilli: '10000', draftOrderedMilli: '0', sentOrderedMilli: '6000', unorderedMilli: '4000' },
    { lineId: 'L2', description: 'Gadget', quantityMilli: '2000', draftOrderedMilli: '0', sentOrderedMilli: '0', unorderedMilli: '2000' },
  ],
  'GET /api/parties': [
    { id: 'sup1', name: 'Widgets Wholesale', accountNumber: null, termsDays: null, taxExempt: false },
  ],
};

describe('document links UI (ADR 0021)', () => {
  it('shows upstream, downstream (void included), fulfillment, coverage, prepayments, closures, family', async () => {
    mockApi(reads);
    render(<DocumentDetail id="so1" />);

    // Upstream and downstream chips, with quantities; the void consumer stays visible.
    expect(await screen.findByText(/← EST-1/)).toBeTruthy();
    expect(screen.getByText(/→ INV-1 · 4/)).toBeTruthy();
    expect(screen.getByText(/→ PO-1 · 6/)).toBeTruthy();
    const voided = screen.getByText(/→ INV-2 · 1/);
    expect(voided.className).toContain('void');
    // Fulfillment, prepayment, and coverage per line.
    expect(screen.getByText('5 partial')).toBeTruthy();
    expect(screen.getByText(/prepaid 50\.00/)).toBeTruthy();
    expect(screen.getByText(/on order: 6 sent, 0 draft, 4 unordered/)).toBeTruthy();
    // Closures table.
    expect(screen.getByText('Closed short')).toBeTruthy();
    expect(screen.getByText('discontinued')).toBeTruthy();
    // Family: five nodes, edges with kinds; current node disabled.
    expect(screen.getAllByText(/cross/).length).toBeGreaterThan(0);
    const here = screen.getByRole('button', { name: /SO-1 sales_order/ });
    expect((here as HTMLButtonElement).disabled).toBe(true);
    // Chips navigate.
    fireEvent.click(screen.getByText(/← EST-1/));
    expect(window.location.hash).toBe('#/documents/est1');
  });

  it('converts selected lines with explicit sourceLineIds and quantities', async () => {
    const { calls } = mockApi({
      ...reads,
      'POST /api/documents/so1/convert': { ...so, id: 'inv9' },
    });
    render(<DocumentDetail id="so1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Convert…' }));

    // L1 defaults to its open 5; L2 is fully consumed and excluded.
    const quantity = screen.getByLabelText('quantity Widget');
    expect((quantity as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('include Gadget') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(quantity, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }));

    await waitFor(() => {
      const write = calls.find((call) => call.url === '/api/documents/so1/convert');
      expect(write?.body).toMatchObject({
        type: 'invoice',
        lines: [{ sourceLineId: 'L1', quantityMilli: '3000' }],
      });
    });
    expect(window.location.hash).toBe('#/documents/inv9');
  });

  it('orders unordered quantities from a supplier as a cross-linked draft PO', async () => {
    const { calls } = mockApi({
      ...reads,
      'POST /api/documents': { ...so, id: 'po9' },
    });
    render(<DocumentDetail id="so1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Order from supplier…' }));

    // Defaults: the supplier picker offers the party; quantities default to unordered.
    expect((screen.getByLabelText('quantity Widget') as HTMLInputElement).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Create purchase order' }));

    await waitFor(() => {
      const write = calls.find((call) => call.method === 'POST' && call.url === '/api/documents');
      expect(write?.body).toMatchObject({
        type: 'purchase_order',
        partyId: 'sup1',
        lines: [
          { itemId: 'item-L1', description: 'Widget', quantityMilli: '4000', sourceDocumentId: 'so1', sourceLineId: 'L1' },
          { itemId: 'item-L2', description: 'Gadget', quantityMilli: '2000', sourceDocumentId: 'so1', sourceLineId: 'L2' },
        ],
      });
    });
    expect(window.location.hash).toBe('#/documents/po9');
  });

  it('closes a line short with kind and reason; the API error code surfaces', async () => {
    const { calls } = mockApi({
      ...reads,
      'POST /api/documents/so1/close-line': {
        status: 409,
        json: { error: 'LINE_OVERDRAWN', message: 'Cannot close 9000 (milli); line has 5000 open' },
      },
    });
    render(<DocumentDetail id="so1" />);
    // Only the line with open quantity offers Close…
    const closeButtons = await screen.findAllByRole('button', { name: 'Close…' });
    expect(closeButtons).toHaveLength(1);
    fireEvent.click(closeButtons[0]!);
    fireEvent.change(screen.getByLabelText(/Qty \(open 5\)/), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(await screen.findByText(/\[LINE_OVERDRAWN\]/)).toBeTruthy();
    const write = calls.find((call) => call.url === '/api/documents/so1/close-line');
    expect(write?.body).toMatchObject({ lineId: 'L1', kind: 'unfulfilled', quantityMilli: '9000' });
  });
});
