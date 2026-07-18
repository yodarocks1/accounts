import { useCallback, useEffect, useState } from 'react';
import {
  get,
  post,
  ApiError,
  type BankReconciliationWire,
  type BankSuggestionWire,
  type BankTransactionWire,
} from '../api';
import { fmtMoney } from '../format';

/**
 * The reconciliation screen (ADR 0020): paste a CSV export, confirm ranked
 * suggestions, undo mistakes. Every action is one of the API's append-only
 * writes; the view re-derives everything by refetching — no client state
 * that the server doesn't own.
 */

export function BankView({ currency }: { currency: string }) {
  const [source, setSource] = useState('bank');
  const [csv, setCsv] = useState('');
  const [transactions, setTransactions] = useState<BankTransactionWire[]>([]);
  const [suggestions, setSuggestions] = useState<BankSuggestionWire[]>([]);
  const [reconciliations, setReconciliations] = useState<BankReconciliationWire[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [rows, matches, marks] = await Promise.all([
      get<BankTransactionWire[]>('/bank/transactions'),
      get<BankSuggestionWire[]>('/bank/suggestions'),
      get<BankReconciliationWire[]>('/bank/reconciliations'),
    ]);
    setTransactions(rows);
    setSuggestions(matches);
    setReconciliations(marks);
  }, []);

  useEffect(() => {
    void reload().catch((cause: Error) => setError(cause.message));
  }, [reload]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? `[${cause.code}] ${cause.message}` : String(cause));
    }
  };

  const importCsv = () =>
    act(async () => {
      const result = await post<{ imported: number; skipped: number }>('/bank/import', { source, csv });
      setNotice(`Imported ${result.imported}, skipped ${result.skipped} (already known)`);
      setCsv('');
    });

  const reconcile = (suggestion: BankSuggestionWire) =>
    act(async () => {
      await post('/bank/reconcile', { bankSeq: suggestion.bankSeq, paymentId: suggestion.paymentId });
    });

  const undo = (mark: BankReconciliationWire) =>
    act(async () => {
      await post(`/bank/reconcile/${mark.reconSeq}/reverse`, {});
    });

  const markBySeq = new Map(reconciliations.map((mark) => [mark.bankSeq, mark]));
  const suggestionSeqs = new Set(suggestions.map((suggestion) => suggestion.bankSeq));

  return (
    <div>
      <h2>Import</h2>
      <p className="muted">Paste a CSV export: date,amount,description[,reference] — re-imports are idempotent.</p>
      <div className="row">
        <label htmlFor="bank-source">Source</label>
        <input id="bank-source" value={source} onChange={(event) => setSource(event.target.value)} />
        <button onClick={() => void importCsv()} disabled={csv.trim() === ''}>Import</button>
      </div>
      <textarea
        aria-label="Bank CSV"
        rows={5}
        placeholder={'date,amount,description\n2026-07-01,550.00,CHECK 101'}
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
      />
      {notice !== null && <p className="muted">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      <h2>Suggested matches</h2>
      {suggestions.length === 0 ? (
        <p className="empty">No unreconciled lines match a payment.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Bank line</th><th>Payment</th><th className="n">Day offset</th><th /></tr>
          </thead>
          <tbody>
            {suggestions.map((suggestion) => {
              const row = transactions.find((entry) => entry.bankSeq === suggestion.bankSeq);
              return (
                <tr key={`${suggestion.bankSeq}|${suggestion.paymentId}`}>
                  <td>
                    {row !== undefined
                      ? `${row.date} · ${row.description} · ${fmtMoney(row.amountMinor, currency)}`
                      : `#${suggestion.bankSeq}`}
                  </td>
                  <td>{suggestion.paymentNumber}</td>
                  <td className="n">{suggestion.dayOffset}</td>
                  <td><button onClick={() => void reconcile(suggestion)}>Reconcile</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Bank lines</h2>
      {transactions.length === 0 ? (
        <p className="empty">Nothing imported yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Date</th><th>Description</th><th className="n">Amount</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {transactions.map((row) => {
              const mark = markBySeq.get(row.bankSeq);
              return (
                <tr key={row.bankSeq}>
                  <td>{row.date}</td>
                  <td>{row.description}{row.reference !== null ? ` (${row.reference})` : ''}</td>
                  <td className="n">{fmtMoney(row.amountMinor, currency)}</td>
                  <td>
                    {mark !== undefined ? (
                      <span className="badge ok">reconciled</span>
                    ) : suggestionSeqs.has(row.bankSeq) ? (
                      <span className="badge">suggested</span>
                    ) : (
                      <span className="badge bad">unmatched</span>
                    )}
                  </td>
                  <td>{mark !== undefined && <button onClick={() => void undo(mark)}>Undo</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
