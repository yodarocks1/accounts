import { useCallback, useEffect, useState } from 'react';
import { CONVERSION_TARGETS, parseMoney, parseQuantity, type DocumentType } from '@accounts/core';
import {
  get,
  post,
  ApiError,
  type ClosureWire,
  type CoverageLineWire,
  type DocumentLinksWire,
  type DocumentWire,
  type FulfillmentLineWire,
  type PartyWire,
  type PrepaymentLineWire,
  type ReadinessWire,
  type SettlementWire,
} from '../api';
import { fmtMoney, fmtQty } from '../format';

/**
 * The document page (ADR 0021): every link fact visible — per-line
 * upstream/downstream, fulfillment, coverage, prepayments, closures,
 * readiness, and the whole family — and every safe link-creating write:
 * convert, order-from-supplier, close line, send, void. The client owns no
 * derived state: every write refetches.
 */

interface Loaded {
  view: DocumentWire;
  links: DocumentLinksWire;
  fulfillment: FulfillmentLineWire[];
  closures: ClosureWire[];
  prepayments: PrepaymentLineWire[];
  settlement: SettlementWire | null;
  coverage: CoverageLineWire[] | null;
  readiness: ReadinessWire | null;
  parties: PartyWire[];
}

const goTo = (documentId: string): void => {
  window.location.hash = `#/documents/${documentId}`;
};

function LinkChip({ endpoint, prefix, quantity }: {
  endpoint: { documentId: string; label: string; status: string; description: string; kind: string };
  prefix: '←' | '→';
  quantity?: string;
}) {
  return (
    <button
      className={`chip${endpoint.status === 'void' ? ' void' : ''}`}
      onClick={() => goTo(endpoint.documentId)}
      title={`${endpoint.description} (${endpoint.kind}${endpoint.status === 'void' ? ', void' : ''})`}
    >
      {prefix} {endpoint.label}
      {quantity !== undefined ? ` · ${fmtQty(quantity)}` : ''}
      {endpoint.kind === 'cross' ? ' ⤳' : ''}
    </button>
  );
}

/** Per-line quantity picker rows shared by the convert and order forms. */
interface LinePick {
  lineId: string;
  description: string;
  boundMilli: bigint; // open (convert) or unordered (order)
  include: boolean;
  quantity: string; // user text, thousandths allowed
  free: boolean;
  substituteDescription: string;
  substitutePrice: string;
}

function pickerFromBounds(rows: { lineId: string; description: string; boundMilli: bigint }[]): LinePick[] {
  return rows.map((row) => ({
    ...row,
    include: row.boundMilli > 0n,
    quantity: fmtQty(row.boundMilli.toString()),
    free: false,
    substituteDescription: '',
    substitutePrice: '',
  }));
}

function PickerRows({ picks, setPicks, withExtras }: {
  picks: LinePick[];
  setPicks: (next: LinePick[]) => void;
  withExtras: boolean; // free + substitution columns (conversion only)
}) {
  const update = (lineId: string, patch: Partial<LinePick>): void =>
    setPicks(picks.map((pick) => (pick.lineId === lineId ? { ...pick, ...patch } : pick)));
  return (
    <table>
      <thead>
        <tr>
          <th />
          <th>Line</th>
          <th className="n">Available</th>
          <th className="n">Quantity</th>
          {withExtras && <th>Free</th>}
          {withExtras && <th>Substitute (description / price)</th>}
        </tr>
      </thead>
      <tbody>
        {picks.map((pick) => (
          <tr key={pick.lineId}>
            <td>
              <input
                type="checkbox"
                aria-label={`include ${pick.description}`}
                checked={pick.include}
                disabled={pick.boundMilli === 0n}
                onChange={(event) => update(pick.lineId, { include: event.target.checked })}
              />
            </td>
            <td>{pick.description}</td>
            <td className="n">{fmtQty(pick.boundMilli.toString())}</td>
            <td className="n">
              <input
                aria-label={`quantity ${pick.description}`}
                size={6}
                value={pick.quantity}
                disabled={!pick.include}
                onChange={(event) => update(pick.lineId, { quantity: event.target.value })}
              />
            </td>
            {withExtras && (
              <td>
                <input
                  type="checkbox"
                  aria-label={`free ${pick.description}`}
                  checked={pick.free}
                  disabled={!pick.include}
                  onChange={(event) => update(pick.lineId, { free: event.target.checked })}
                />
              </td>
            )}
            {withExtras && (
              <td>
                <input
                  aria-label={`substitute description ${pick.description}`}
                  size={14}
                  placeholder="same item"
                  value={pick.substituteDescription}
                  disabled={!pick.include}
                  onChange={(event) => update(pick.lineId, { substituteDescription: event.target.value })}
                />{' '}
                <input
                  aria-label={`substitute price ${pick.description}`}
                  size={6}
                  placeholder="same price"
                  value={pick.substitutePrice}
                  disabled={!pick.include}
                  onChange={(event) => update(pick.lineId, { substitutePrice: event.target.value })}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DocumentDetail({ id }: { id: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<'convert' | 'order' | null>(null);
  const [closing, setClosing] = useState<string | null>(null); // lineId being closed

  const load = useCallback(async () => {
    const view = await get<DocumentWire>(`/documents/${id}`);
    const [links, fulfillment, closures, prepayments, settlement, coverage, readiness, parties] = await Promise.all([
      get<DocumentLinksWire>(`/documents/${id}/links`),
      get<FulfillmentLineWire[]>(`/documents/${id}/fulfillment`),
      get<ClosureWire[]>(`/documents/${id}/closures`),
      get<PrepaymentLineWire[]>(`/documents/${id}/prepayments`),
      view.type === 'invoice' || view.type === 'bill'
        ? get<SettlementWire>(`/documents/${id}/settlement`).catch(() => null)
        : Promise.resolve(null),
      view.type === 'sales_order' ? get<CoverageLineWire[]>(`/documents/${id}/purchase-coverage`) : Promise.resolve(null),
      view.type === 'purchase_order' ? get<ReadinessWire>(`/documents/${id}/readiness`) : Promise.resolve(null),
      get<PartyWire[]>('/parties'),
    ]);
    setLoaded({ view, links, fulfillment, closures, prepayments, settlement, coverage, readiness, parties });
  }, [id]);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    setOpenForm(null);
    setClosing(null);
    void load().catch((cause: Error) =>
      setError(cause instanceof ApiError ? `[${cause.code}] ${cause.message}` : cause.message),
    );
  }, [load]);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? `[${cause.code}] ${cause.message}` : String(cause));
    }
  };

  if (error !== null && loaded === null) return <p className="error">{error}</p>;
  if (loaded === null) return <p className="empty">Loading…</p>;
  const { view, links, fulfillment, closures, prepayments, settlement, coverage, readiness, parties } = loaded;

  const fulfillmentByLine = new Map(fulfillment.map((line) => [line.lineId, line]));
  const linksByLine = new Map(links.lines.map((line) => [line.lineId, line]));
  const prepaidByLine = new Map(prepayments.filter((line) => BigInt(line.prepaid) > 0n).map((line) => [line.lineId, line]));
  const coverageByLine = new Map((coverage ?? []).map((line) => [line.lineId, line]));
  const targets = (CONVERSION_TARGETS[view.type as DocumentType] ?? []) as readonly string[];
  const converts = view.status === 'sent' && targets.length > 0;
  const orders = view.status === 'sent' && view.type === 'sales_order';

  return (
    <div>
      <h2>
        {view.label} <span className="muted">{view.type}</span>{' '}
        <span className={view.status === 'void' ? 'badge bad' : 'badge ok'}>{view.status}</span>
        {readiness !== null && (
          <>
            {' '}
            <span className={readiness.ready ? 'badge ok' : 'badge bad'}>
              {readiness.ready ? 'ready to order' : 'below supplier minimums'}
            </span>
          </>
        )}
      </h2>
      <p className="muted">
        {view.current.date} · {view.current.customerName}
        {view.current.memo !== null ? ` · ${view.current.memo}` : ''}
      </p>
      {readiness !== null && readiness.shortfalls.length > 0 && (
        <ul className="muted">
          {readiness.shortfalls.map((shortfall) => <li key={shortfall.message}>{shortfall.message}</li>)}
        </ul>
      )}

      <div className="row">
        {view.status === 'draft' && <SendControls act={act} id={id} />}
        {view.status !== 'void' && (
          <button onClick={() => void act(async () => { await post(`/documents/${id}/void`, {}); })}>Void</button>
        )}
        {converts && (
          <button onClick={() => setOpenForm(openForm === 'convert' ? null : 'convert')}>Convert…</button>
        )}
        {orders && (
          <button onClick={() => setOpenForm(openForm === 'order' ? null : 'order')}>Order from supplier…</button>
        )}
      </div>
      {error !== null && <p className="error">{error}</p>}

      {openForm === 'convert' && (
        <ConvertForm
          targets={targets}
          picks={pickerFromBounds(
            view.current.lines.map((line) => ({
              lineId: line.lineId,
              description: line.description,
              boundMilli: BigInt(fulfillmentByLine.get(line.lineId)?.openMilli ?? line.quantityMilli),
            })),
          )}
          currency={view.currency}
          onSubmit={(body) =>
            act(async () => {
              const created = await post<DocumentWire>(`/documents/${id}/convert`, body);
              goTo(created.id);
            })
          }
        />
      )}
      {openForm === 'order' && (
        <OrderForm
          parties={parties}
          picks={pickerFromBounds(
            view.current.lines.map((line) => ({
              lineId: line.lineId,
              description: line.description,
              boundMilli: BigInt(coverageByLine.get(line.lineId)?.unorderedMilli ?? '0'),
            })),
          )}
          onSubmit={(partyId, date, number, lines) =>
            act(async () => {
              const created = await post<DocumentWire>('/documents', {
                type: 'purchase_order',
                date,
                partyId,
                ...(number !== '' ? { number } : {}),
                lines: lines.map((pick) => {
                  const source = view.current.lines.find((line) => line.lineId === pick.lineId)!;
                  return {
                    ...(source.itemId !== null ? { itemId: source.itemId } : {}),
                    description: source.description,
                    quantityMilli: pick.quantityMilli,
                    sourceDocumentId: id,
                    sourceLineId: pick.lineId,
                  };
                }),
              });
              goTo(created.id);
            })
          }
        />
      )}

      <h3>Lines &amp; links</h3>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th className="n">Qty</th>
            <th className="n">Unit</th>
            <th className="n">Amount</th>
            <th className="n">Open</th>
            <th>Links</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {view.current.lines.map((line, index) => {
            const state = fulfillmentByLine.get(line.lineId);
            const linked = linksByLine.get(line.lineId);
            const prepaid = prepaidByLine.get(line.lineId);
            const onOrder = coverageByLine.get(line.lineId);
            const open = state !== undefined ? BigInt(state.openMilli) : 0n;
            return (
              <tr key={line.lineId}>
                <td>
                  {line.description}
                  {line.free ? ' (free)' : ''}
                  {line.substituted ? ' (substituted)' : ''}
                  {prepaid !== undefined && (
                    <div className="muted">prepaid {fmtMoney(prepaid.prepaid, view.currency)}</div>
                  )}
                  {onOrder !== undefined && BigInt(onOrder.unorderedMilli) + BigInt(onOrder.draftOrderedMilli) + BigInt(onOrder.sentOrderedMilli) > 0n && (
                    <div className="muted">
                      on order: {fmtQty(onOrder.sentOrderedMilli)} sent, {fmtQty(onOrder.draftOrderedMilli)} draft,{' '}
                      {fmtQty(onOrder.unorderedMilli)} unordered
                    </div>
                  )}
                </td>
                <td className="n">{fmtQty(line.quantityMilli)}</td>
                <td className="n">{fmtMoney(line.unitPrice, view.currency)}</td>
                <td className="n">{fmtMoney(view.recordedLineTotals[index] ?? '0', view.currency)}</td>
                <td className="n">
                  {state !== undefined ? `${fmtQty(state.openMilli)} ${state.status}` : ''}
                </td>
                <td>
                  {linked?.upstream !== null && linked?.upstream !== undefined && (
                    <LinkChip endpoint={linked.upstream} prefix="←" />
                  )}
                  {linked?.downstream.map((consumer) => (
                    <LinkChip
                      key={`${consumer.documentId}|${consumer.lineId}`}
                      endpoint={consumer}
                      prefix="→"
                      quantity={consumer.quantityMilli}
                    />
                  ))}
                  {linked !== undefined && linked.upstream === null && linked.downstream.length === 0 && (
                    <span className="muted">unlinked</span>
                  )}
                </td>
                <td>
                  {view.status === 'sent' && open > 0n && (
                    <button onClick={() => setClosing(closing === line.lineId ? null : line.lineId)}>Close…</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {closing !== null && (
        <CloseLineForm
          lineId={closing}
          openMilli={BigInt(fulfillmentByLine.get(closing)?.openMilli ?? '0')}
          onSubmit={(body) =>
            act(async () => {
              await post(`/documents/${id}/close-line`, body);
              setClosing(null);
            })
          }
        />
      )}
      <p>
        Subtotal {fmtMoney(view.subtotal, view.currency)} · tax {fmtMoney(view.taxTotal, view.currency)} · total{' '}
        <strong>{fmtMoney(view.total, view.currency)}</strong>
        {settlement !== null && (
          <>
            {' '}· paid {fmtMoney(settlement.paid, view.currency)} · open{' '}
            <strong>{fmtMoney(settlement.open, view.currency)}</strong>
          </>
        )}
      </p>

      {closures.length > 0 && (
        <>
          <h3>Closed short</h3>
          <table>
            <thead>
              <tr><th>Line</th><th className="n">Qty</th><th>Kind</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {closures.map((closure) => (
                <tr key={closure.closureSeq}>
                  <td>{links.lines.find((line) => line.lineId === closure.lineId)?.description ?? closure.lineId}</td>
                  <td className="n">{fmtQty(closure.quantityMilli)}</td>
                  <td>{closure.kind}</td>
                  <td>{closure.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Family</h3>
      {links.family.nodes.length <= 1 ? (
        <p className="empty">No linked documents.</p>
      ) : (
        <>
          <div className="row">
            {links.family.nodes.map((node) => (
              <button
                key={node.documentId}
                className={`chip${node.documentId === id ? ' here' : ''}${node.status === 'void' ? ' void' : ''}`}
                disabled={node.documentId === id}
                onClick={() => goTo(node.documentId)}
              >
                {node.label} <span className="muted">{node.type}</span>
              </button>
            ))}
          </div>
          <table>
            <thead>
              <tr><th>From</th><th>To</th><th className="n">Qty</th><th>Kind</th></tr>
            </thead>
            <tbody>
              {links.family.edges.map((edge, index) => {
                const from = links.family.nodes.find((node) => node.documentId === edge.from)!;
                const to = links.family.nodes.find((node) => node.documentId === edge.to)!;
                return (
                  <tr key={index}>
                    <td>{from.number}</td>
                    <td>{to.number}</td>
                    <td className="n">{edge.fromLineId === null ? '' : fmtQty(edge.quantityMilli)}</td>
                    <td>{edge.kind}{edge.substituted ? ' (substituted)' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <p><a href="#/documents">← all documents</a></p>
    </div>
  );
}

function SendControls({ act, id }: { act: (action: () => Promise<void>) => Promise<void>; id: string }) {
  const [overrideDeposit, setOverrideDeposit] = useState(false);
  const [overrideMinimum, setOverrideMinimum] = useState(false);
  const [approvedBy, setApprovedBy] = useState('');
  return (
    <span className="row">
      <button
        onClick={() =>
          void act(async () => {
            await post(`/documents/${id}/send`, {
              ...(overrideDeposit ? { overrideDeposit: true } : {}),
              ...(overrideMinimum ? { overrideMinimum: true } : {}),
              ...(approvedBy.trim() !== '' ? { approvedBy: approvedBy.trim() } : {}),
            });
          })
        }
      >
        Send
      </button>
      <label>
        <input type="checkbox" checked={overrideDeposit} onChange={(event) => setOverrideDeposit(event.target.checked)} />{' '}
        override deposit
      </label>
      <label>
        <input type="checkbox" checked={overrideMinimum} onChange={(event) => setOverrideMinimum(event.target.checked)} />{' '}
        override minimum
      </label>
      <input placeholder="approved by" size={10} value={approvedBy} onChange={(event) => setApprovedBy(event.target.value)} />
    </span>
  );
}

function ConvertForm({ targets, picks: initial, currency, onSubmit }: {
  targets: readonly string[];
  picks: LinePick[];
  currency: string;
  onSubmit: (body: unknown) => Promise<void>;
}) {
  const [target, setTarget] = useState(targets[0]!);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [number, setNumber] = useState('');
  const [picks, setPicks] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    try {
      const lines = picks
        .filter((pick) => pick.include)
        .map((pick) => {
          const substitution = {
            ...(pick.substituteDescription.trim() !== '' ? { description: pick.substituteDescription.trim() } : {}),
            ...(pick.substitutePrice.trim() !== ''
              ? { unitPrice: parseMoney(pick.substitutePrice.trim(), currency).amount.toString() }
              : {}),
          };
          return {
            sourceLineId: pick.lineId,
            quantityMilli: parseQuantity(pick.quantity).toString(),
            ...(pick.free ? { free: true } : {}),
            ...(Object.keys(substitution).length > 0 ? { substitution } : {}),
          };
        });
      if (lines.length === 0) {
        setProblem('Pick at least one line to convert');
        return;
      }
      setProblem(null);
      void onSubmit({
        type: target,
        date,
        ...(number.trim() !== '' ? { number: number.trim() } : {}),
        lines,
      });
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div>
      <h3>Convert</h3>
      <div className="row">
        <label htmlFor="convert-target">To</label>
        <select id="convert-target" value={target} onChange={(event) => setTarget(event.target.value)}>
          {targets.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
        </select>
        <label htmlFor="convert-date">Date</label>
        <input id="convert-date" value={date} onChange={(event) => setDate(event.target.value)} size={10} />
        <input
          aria-label="document number"
          placeholder="number (blank = sequence)"
          size={16}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
        <button onClick={submit}>Create {target}</button>
      </div>
      {problem !== null && <p className="error">{problem}</p>}
      <PickerRows picks={picks} setPicks={setPicks} withExtras={true} />
    </div>
  );
}

function OrderForm({ parties, picks: initial, onSubmit }: {
  parties: PartyWire[];
  picks: LinePick[];
  onSubmit: (partyId: string, date: string, number: string, lines: { lineId: string; quantityMilli: string }[]) => Promise<void>;
}) {
  const [partyId, setPartyId] = useState(parties[0]?.id ?? '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [number, setNumber] = useState('');
  const [picks, setPicks] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    try {
      const lines = picks
        .filter((pick) => pick.include)
        .map((pick) => ({ lineId: pick.lineId, quantityMilli: parseQuantity(pick.quantity).toString() }));
      if (partyId === '') {
        setProblem('Create a supplier party first');
        return;
      }
      if (lines.length === 0) {
        setProblem('Pick at least one line to order');
        return;
      }
      setProblem(null);
      void onSubmit(partyId, date, number.trim(), lines);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div>
      <h3>Order from supplier</h3>
      <p className="muted">Creates a draft purchase order whose lines link back to this order (ADR 0011).</p>
      <div className="row">
        <label htmlFor="order-supplier">Supplier</label>
        <select id="order-supplier" value={partyId} onChange={(event) => setPartyId(event.target.value)}>
          {parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
        </select>
        <label htmlFor="order-date">Date</label>
        <input id="order-date" value={date} onChange={(event) => setDate(event.target.value)} size={10} />
        <input
          aria-label="document number"
          placeholder="number (blank = sequence)"
          size={16}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
        <button onClick={submit}>Create purchase order</button>
      </div>
      {problem !== null && <p className="error">{problem}</p>}
      <PickerRows picks={picks} setPicks={setPicks} withExtras={false} />
    </div>
  );
}

function CloseLineForm({ lineId, openMilli, onSubmit }: {
  lineId: string;
  openMilli: bigint;
  onSubmit: (body: unknown) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(fmtQty(openMilli.toString()));
  const [kind, setKind] = useState<'unfulfilled' | 'substituted'>('unfulfilled');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    try {
      setProblem(null);
      void onSubmit({
        lineId,
        kind,
        quantityMilli: parseQuantity(quantity).toString(),
        ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
        ...(approvedBy.trim() !== '' ? { approvedBy: approvedBy.trim() } : {}),
      });
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="row">
      <strong>Close line</strong>
      <label htmlFor="close-qty">Qty (open {fmtQty(openMilli.toString())})</label>
      <input id="close-qty" size={6} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
      <select aria-label="closure kind" value={kind} onChange={(event) => setKind(event.target.value as 'unfulfilled' | 'substituted')}>
        <option value="unfulfilled">unfulfilled</option>
        <option value="substituted">substituted</option>
      </select>
      <input placeholder="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
      <input placeholder="approved by" size={10} value={approvedBy} onChange={(event) => setApprovedBy(event.target.value)} />
      <button onClick={submit}>Close</button>
      {problem !== null && <span className="error">{problem}</span>}
    </div>
  );
}
