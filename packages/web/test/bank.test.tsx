import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BankView } from '../src/views/Bank';
import { mockApi } from './mock-api';

afterEach(cleanup);

const transaction = {
  bankSeq: 1, source: 'first-national', date: '2026-06-22',
  amountMinor: '55000', description: 'CHECK 101 ACME LLC', reference: null,
};
const suggestion = { bankSeq: 1, paymentId: 'pay-1', paymentNumber: 'PMT-0001', dayOffset: 0 };

const reads = {
  'GET /api/bank/transactions': [transaction],
  'GET /api/bank/suggestions': [suggestion],
  'GET /api/bank/reconciliations': [],
};

describe('bank reconciliation view (ADR 0020)', () => {
  it('reconciles a suggested match with one click and refetches', async () => {
    const { calls } = mockApi({
      ...reads,
      'POST /api/bank/reconcile': { reconSeq: 1 },
    });
    render(<BankView currency="USD" />);

    // Both the suggestion row and the bank-lines row show the line.
    expect(await screen.findAllByText(/CHECK 101 ACME LLC/)).toHaveLength(2);
    expect(screen.getAllByText(/550\.00/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === 'POST')).toMatchObject({
        url: '/api/bank/reconcile',
        body: { bankSeq: 1, paymentId: 'pay-1' },
      });
      // The view re-reads the server's state after every write.
      expect(calls.filter((call) => call.url === '/api/bank/transactions').length).toBeGreaterThan(1);
    });
  });

  it('surfaces the API error code, not just prose', async () => {
    mockApi({
      ...reads,
      'POST /api/bank/reconcile': {
        status: 409,
        json: { error: 'ALREADY_RECONCILED', message: 'Bank transaction 1 is already reconciled' },
      },
    });
    render(<BankView currency="USD" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile' }));
    expect(await screen.findByText(/\[ALREADY_RECONCILED\] Bank transaction 1 is already reconciled/)).toBeTruthy();
  });

  it('imports pasted CSV against the chosen source', async () => {
    const { calls } = mockApi({
      ...reads,
      'POST /api/bank/import': { imported: 2, skipped: 1 },
    });
    render(<BankView currency="USD" />);
    await screen.findAllByText(/CHECK 101 ACME LLC/);

    fireEvent.change(screen.getByLabelText('Bank CSV'), {
      target: { value: 'date,amount,description\n2026-07-01,1.00,X' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Imported 2, skipped 1 (already known)')).toBeTruthy();
    const write = calls.find((call) => call.url === '/api/bank/import');
    expect(write?.body).toMatchObject({ source: 'bank', csv: 'date,amount,description\n2026-07-01,1.00,X' });
  });
});
