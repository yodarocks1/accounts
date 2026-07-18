import { useEffect, useState } from 'react';
import {
  get,
  type AgingSummaryWire,
  type BalanceSheetWire,
  type InventorySummaryWire,
  type PluginsWire,
  type ProfitAndLossWire,
  type ReportRowWire,
} from '../api';
import { fmtMoney, fmtQty } from '../format';

/** The React twin of the server-rendered dashboard: same reads, same numbers. */

interface Reports {
  sheet: BalanceSheetWire;
  pnl: ProfitAndLossWire;
  ar: AgingSummaryWire;
  ap: AgingSummaryWire;
  inventory: InventorySummaryWire;
  plugins: PluginsWire;
}

function AccountRows({ rows, totalLabel, total, currency }: {
  rows: ReportRowWire[];
  totalLabel: string;
  total: string;
  currency: string;
}) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.accountId}>
          <td>{row.code !== null ? `${row.code} ${row.name}` : row.name}</td>
          <td className="n">{fmtMoney(row.amount, currency)}</td>
        </tr>
      ))}
      <tr className="total">
        <td>{totalLabel}</td>
        <td className="n">{fmtMoney(total, currency)}</td>
      </tr>
    </>
  );
}

function AgingTable({ summary, currency }: { summary: AgingSummaryWire; currency: string }) {
  if (summary.rows.length === 0) return <p className="empty">Nothing open.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th />
          {summary.labels.map((label) => <th key={label} className="n">{label}</th>)}
          <th className="n">Total</th>
        </tr>
      </thead>
      <tbody>
        {summary.rows.map((row) => (
          <tr key={`${row.partyId ?? ''}|${row.name}`}>
            <td>{row.name}</td>
            {row.buckets.map((bucket) => <td key={bucket.label} className="n">{fmtMoney(bucket.amount, currency)}</td>)}
            <td className="n">{fmtMoney(row.total, currency)}</td>
          </tr>
        ))}
        <tr className="total">
          <td>TOTAL</td>
          {summary.totals.map((bucket) => <td key={bucket.label} className="n">{fmtMoney(bucket.amount, currency)}</td>)}
          <td className="n">{fmtMoney(summary.grandTotal, currency)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function DashboardView({ currency }: { currency: string }) {
  const [reports, setReports] = useState<Reports | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const asOf = new Date().toISOString().slice(0, 10);
    const yearStart = `${asOf.slice(0, 4)}-01-01`;
    void Promise.all([
      get<BalanceSheetWire>(`/reports/balance-sheet?asOf=${asOf}`),
      get<ProfitAndLossWire>(`/reports/pnl?from=${yearStart}&to=${asOf}`),
      get<AgingSummaryWire>(`/reports/ar-aging?asOf=${asOf}`),
      get<AgingSummaryWire>(`/reports/ap-aging?asOf=${asOf}`),
      get<InventorySummaryWire>(`/reports/inventory?asOf=${asOf}`),
      get<PluginsWire>('/plugins'),
    ]).then(
      ([sheet, pnl, ar, ap, inventory, plugins]) => setReports({ sheet, pnl, ar, ap, inventory, plugins }),
      (cause: Error) => setError(cause.message),
    );
  }, []);

  if (error !== null) return <p className="error">{error}</p>;
  if (reports === null) return <p className="empty">Loading…</p>;
  const { sheet, pnl, ar, ap, inventory, plugins } = reports;

  return (
    <div>
      <h2>
        Balance sheet{' '}
        {sheet.balanced
          ? <span className="badge ok">BALANCED</span>
          : <span className="badge bad">OUT OF BALANCE</span>}
      </h2>
      <table>
        <tbody>
          <tr><th>Assets</th><th /></tr>
          <AccountRows rows={sheet.assets} totalLabel="Total assets" total={sheet.totalAssets} currency={currency} />
          <tr><th>Liabilities</th><th /></tr>
          <AccountRows rows={sheet.liabilities} totalLabel="Total liabilities" total={sheet.totalLiabilities} currency={currency} />
          <tr><th>Equity</th><th /></tr>
          <AccountRows rows={sheet.equity} totalLabel="Total equity" total={sheet.totalEquity} currency={currency} />
        </tbody>
      </table>

      <h2>Profit &amp; loss <span className="muted">({pnl.from} → {pnl.to})</span></h2>
      <table>
        <tbody>
          <tr><th>Income</th><th /></tr>
          <AccountRows rows={pnl.income} totalLabel="Total income" total={pnl.totalIncome} currency={currency} />
          <tr><th>Expenses</th><th /></tr>
          <AccountRows rows={pnl.expense} totalLabel="Total expenses" total={pnl.totalExpense} currency={currency} />
          <tr className="total"><td>Net profit</td><td className="n">{fmtMoney(pnl.netProfit, currency)}</td></tr>
        </tbody>
      </table>

      <h2>A/R aging</h2>
      <AgingTable summary={ar} currency={currency} />

      <h2>A/P aging</h2>
      <AgingTable summary={ap} currency={currency} />

      <h2>Inventory</h2>
      {inventory.rows.length === 0 ? (
        <p className="empty">No inventory items.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Item</th><th className="n">On hand</th><th className="n">FIFO value</th></tr>
          </thead>
          <tbody>
            {inventory.rows.map((row) => (
              <tr key={row.itemId}>
                <td>{row.name}</td>
                <td className="n">{fmtQty(row.quantityMilli)}</td>
                <td className="n">{fmtMoney(row.valueMinor, currency)}</td>
              </tr>
            ))}
            <tr className="total"><td>TOTAL</td><td /><td className="n">{fmtMoney(inventory.totalValueMinor, currency)}</td></tr>
          </tbody>
        </table>
      )}

      <h2>Plugins</h2>
      {plugins.plugins.length === 0 ? (
        <p className="empty">No plugins attached.</p>
      ) : (
        <>
          <table>
            <thead><tr><th>Plugin</th><th>Version</th></tr></thead>
            <tbody>
              {plugins.plugins.map((manifest) => (
                <tr key={manifest.id}>
                  <td>{manifest.name} <span className="muted">({manifest.id})</span></td>
                  <td>{manifest.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plugins.reports.length > 0 && (
            <p className="muted">Contributed reports: {plugins.reports.join(', ')}</p>
          )}
        </>
      )}
    </div>
  );
}
