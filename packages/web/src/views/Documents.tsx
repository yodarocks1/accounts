import { useEffect, useState } from 'react';
import { get, ApiError, type DocumentWire, type SettlementWire } from '../api';
import { fmtMoney, fmtQty } from '../format';

const DOCUMENT_TYPES = [
  'estimate', 'sales_order', 'invoice', 'credit_memo',
  'purchase_order', 'receipt', 'bill', 'vendor_credit',
] as const;

function DocumentDetail({ id }: { id: string }) {
  const [view, setView] = useState<DocumentWire | null>(null);
  const [settlement, setSettlement] = useState<SettlementWire | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setSettlement(null);
    setError(null);
    void get<DocumentWire>(`/documents/${id}`).then(
      (loaded) => {
        setView(loaded);
        if (loaded.type === 'invoice' || loaded.type === 'bill') {
          // Settlement only means something for owing documents.
          void get<SettlementWire>(`/documents/${id}/settlement`).then(setSettlement, () => setSettlement(null));
        }
      },
      (cause: Error) => setError(cause instanceof ApiError ? `[${cause.code}] ${cause.message}` : cause.message),
    );
  }, [id]);

  if (error !== null) return <p className="error">{error}</p>;
  if (view === null) return <p className="empty">Loading…</p>;

  return (
    <div>
      <h2>
        {view.label} <span className="muted">{view.type}</span>{' '}
        <span className={view.status === 'void' ? 'badge bad' : 'badge ok'}>{view.status}</span>
      </h2>
      <p className="muted">
        {view.current.date} · {view.current.customerName}
        {view.current.memo !== null ? ` · ${view.current.memo}` : ''}
      </p>
      <table>
        <thead>
          <tr><th>Description</th><th className="n">Qty</th><th className="n">Unit</th><th className="n">Amount</th></tr>
        </thead>
        <tbody>
          {view.current.lines.map((line, index) => (
            <tr key={line.lineId}>
              <td>{line.description}{line.free ? ' (free)' : ''}</td>
              <td className="n">{fmtQty(line.quantityMilli)}</td>
              <td className="n">{fmtMoney(line.unitPrice, view.currency)}</td>
              {/* As booked, from the server — the UI never re-derives money. */}
              <td className="n">{fmtMoney(view.recordedLineTotals[index] ?? '0', view.currency)}</td>
            </tr>
          ))}
          <tr><td>Subtotal</td><td /><td /><td className="n">{fmtMoney(view.subtotal, view.currency)}</td></tr>
          <tr><td>Tax</td><td /><td /><td className="n">{fmtMoney(view.taxTotal, view.currency)}</td></tr>
          <tr className="total"><td>Total</td><td /><td /><td className="n">{fmtMoney(view.total, view.currency)}</td></tr>
        </tbody>
      </table>
      {settlement !== null && (
        <p>
          Paid {fmtMoney(settlement.paid, view.currency)} · open{' '}
          <strong>{fmtMoney(settlement.open, view.currency)}</strong>
        </p>
      )}
      <p><a href="#/documents">← all documents</a></p>
    </div>
  );
}

export function DocumentsView({ id }: { id?: string | undefined }) {
  const [documents, setDocuments] = useState<DocumentWire[] | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id !== undefined) return;
    const query = filter === '' ? '' : `?type=${filter}`;
    void get<DocumentWire[]>(`/documents${query}`).then(setDocuments, (cause: Error) => setError(cause.message));
  }, [id, filter]);

  if (id !== undefined) return <DocumentDetail id={id} />;
  if (error !== null) return <p className="error">{error}</p>;
  if (documents === null) return <p className="empty">Loading…</p>;

  return (
    <div>
      <h2>Documents</h2>
      <div className="row">
        <label htmlFor="type-filter">Type</label>
        <select id="type-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="">all</option>
          {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </div>
      {documents.length === 0 ? (
        <p className="empty">No documents.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Number</th><th>Type</th><th>Status</th><th>Date</th><th>Party</th><th className="n">Total</th></tr>
          </thead>
          <tbody>
            {documents.map((view) => (
              <tr key={view.id} className="click" onClick={() => { window.location.hash = `#/documents/${view.id}`; }}>
                <td>{view.label}</td>
                <td>{view.type}</td>
                <td>{view.status}</td>
                <td>{view.current.date}</td>
                <td>{view.current.customerName}</td>
                <td className="n">{fmtMoney(view.total, view.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
