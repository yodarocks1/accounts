import { useEffect, useState } from 'react';
import { get, type DocumentWire } from '../api';
import { fmtMoney } from '../format';
import { DocumentDetail } from './DocumentDetail';

const DOCUMENT_TYPES = [
  'estimate', 'sales_order', 'invoice', 'credit_memo',
  'purchase_order', 'receipt', 'bill', 'vendor_credit',
] as const;

export function DocumentsView({ id }: { id?: string | undefined }) {
  const [documents, setDocuments] = useState<DocumentWire[] | null>(null);
  const [everything, setEverything] = useState<DocumentWire[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id !== undefined) return;
    // The unfiltered list also resolves "from" numbers for linked rows.
    void get<DocumentWire[]>('/documents').then(
      (all) => {
        setEverything(all);
        setDocuments(filter === '' ? all : all.filter((view) => view.type === filter));
      },
      (cause: Error) => setError(cause.message),
    );
  }, [id, filter]);

  if (id !== undefined) return <DocumentDetail id={id} />;
  if (error !== null) return <p className="error">{error}</p>;
  if (documents === null) return <p className="empty">Loading…</p>;

  const byId = new Map(everything.map((view) => [view.id, view]));
  const provenance = (view: DocumentWire): string => {
    const sources = new Set<string>();
    if (view.sourceDocumentId !== null) {
      const source = byId.get(view.sourceDocumentId);
      if (source !== undefined) sources.add(source.number);
    }
    for (const line of view.current.lines) {
      if (line.sourceDocumentId !== null) {
        const source = byId.get(line.sourceDocumentId);
        if (source !== undefined) sources.add(source.number);
      }
    }
    return [...sources].join(', ');
  };

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
            <tr>
              <th>Number</th><th>Type</th><th>Status</th><th>Date</th><th>Party</th>
              <th>From</th><th className="n">Total</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((view) => (
              <tr key={view.id} className="click" onClick={() => { window.location.hash = `#/documents/${view.id}`; }}>
                <td>{view.label}</td>
                <td>{view.type}</td>
                <td>{view.status}</td>
                <td>{view.current.date}</td>
                <td>{view.current.customerName}</td>
                <td className="muted">{provenance(view)}</td>
                <td className="n">{fmtMoney(view.total, view.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
