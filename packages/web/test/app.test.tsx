import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../src/App';
import { mockApi } from './mock-api';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const emptyAging = (side: 'customer' | 'supplier') => ({
  asOf: '2026-07-18', side, labels: ['not due'], rows: [], totals: [{ label: 'not due', amount: '0' }], grandTotal: '0',
});

function dashboardRoutes(asOf: string, yearStart: string) {
  return {
    'GET /api/company': { name: 'Test Books Inc', baseCurrency: 'USD' },
    [`GET /api/reports/balance-sheet?asOf=${asOf}`]: {
      asOf,
      assets: [{ accountId: 'a1', code: '1000', name: 'Cash', currency: 'USD', amount: '123456' }],
      liabilities: [],
      equity: [{ accountId: 'retained-earnings', code: null, name: 'Retained earnings', currency: 'USD', amount: '123456' }],
      totalAssets: '123456', totalLiabilities: '0', totalEquity: '123456', balanced: true,
    },
    [`GET /api/reports/pnl?from=${yearStart}&to=${asOf}`]: {
      from: yearStart, to: asOf, income: [], expense: [], totalIncome: '0', totalExpense: '0', netProfit: '0',
    },
    [`GET /api/reports/ar-aging?asOf=${asOf}`]: emptyAging('customer'),
    [`GET /api/reports/ap-aging?asOf=${asOf}`]: emptyAging('supplier'),
    [`GET /api/reports/inventory?asOf=${asOf}`]: {
      asOf, rows: [{ itemId: 'w1', name: 'Widget', quantityMilli: '2500', valueMinor: '900' }], totalValueMinor: '900',
    },
    'GET /api/plugins': { plugins: [{ id: 'demo-supplier', name: 'Demo Supplier', version: '0.0.1' }], reports: ['demo.purchase-pipeline'] },
  };
}

describe('App shell + dashboard (ADR 0020)', () => {
  it('renders the dashboard from the JSON API with exact money', async () => {
    const asOf = new Date().toISOString().slice(0, 10);
    mockApi(dashboardRoutes(asOf, `${asOf.slice(0, 4)}-01-01`));
    render(<App />);

    expect(await screen.findByText('Test Books Inc')).toBeTruthy();
    expect(await screen.findByText('BALANCED')).toBeTruthy();
    expect(await screen.findByText('1000 Cash')).toBeTruthy();
    // '123456' minor units → '1234.56', via @accounts/core in the browser.
    expect((await screen.findAllByText('1234.56')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Widget')).toBeTruthy();
    expect(await screen.findByText('2.5')).toBeTruthy();
    expect(await screen.findByText(/demo\.purchase-pipeline/)).toBeTruthy();
  });

  it('routes by hash: #/documents shows the list view', async () => {
    const asOf = new Date().toISOString().slice(0, 10);
    mockApi({
      ...dashboardRoutes(asOf, `${asOf.slice(0, 4)}-01-01`),
      'GET /api/documents': [],
    });
    window.location.hash = '#/documents';
    render(<App />);
    expect(await screen.findByText('Documents')).toBeTruthy();
    expect(await screen.findByText('No documents.')).toBeTruthy();
  });
});
