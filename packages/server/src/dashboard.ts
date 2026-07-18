import { formatMoney, formatQuantity, money } from '@accounts/core';
import type { AgingSummary, ReportAccountRow } from '@accounts/core';
import type { CompanyFile } from '@accounts/storage';

/**
 * Read-only HTML dashboard served at GET / by `accounts serve`. Rendered
 * server-side from the same derived reports the JSON API exposes — no
 * client script, no dependencies, nothing stored. This is deliberately the
 * whole "web UI" of the spike: a visual demo inside the no-UI-app cut line.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.3rem 0.75rem 0.3rem 0; border-bottom: 1px solid #eee; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-top: 2px solid #1a1a1a; border-bottom: none; font-weight: 600; }
  .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; vertical-align: middle; }
  .badge.ok { background: #e6f4ea; color: #137333; }
  .badge.bad { background: #fce8e6; color: #c5221f; }
  .muted { color: #666; }
  .empty { color: #666; font-style: italic; }
`;

interface RenderContext {
  readonly currency: string;
}

const amount = (context: RenderContext, minor: bigint): string => formatMoney(money(minor, context.currency));

function accountRows(context: RenderContext, rows: readonly ReportAccountRow[], totalLabel: string, total: bigint): string {
  const body = rows
    .map((row) => `<tr><td>${escapeHtml(row.code !== null ? `${row.code} ${row.name}` : row.name)}</td><td class="n">${amount(context, row.amount)}</td></tr>`)
    .join('');
  return `${body}<tr class="total"><td>${escapeHtml(totalLabel)}</td><td class="n">${amount(context, total)}</td></tr>`;
}

function agingTable(context: RenderContext, summary: AgingSummary): string {
  if (summary.rows.length === 0) return `<p class="empty">Nothing open.</p>`;
  const headers = ['', ...summary.labels, 'Total']
    .map((label, index) => `<th${index === 0 ? '' : ' class="n"'}>${escapeHtml(label)}</th>`)
    .join('');
  const rows = summary.rows
    .map((row) => {
      const cells = row.buckets.map((bucket) => `<td class="n">${amount(context, bucket.amount)}</td>`).join('');
      return `<tr><td>${escapeHtml(row.name)}</td>${cells}<td class="n">${amount(context, row.total)}</td></tr>`;
    })
    .join('');
  const totals = summary.totals.map((bucket) => `<td class="n">${amount(context, bucket.amount)}</td>`).join('');
  return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}<tr class="total"><td>TOTAL</td>${totals}<td class="n">${amount(context, summary.grandTotal)}</td></tr></tbody></table>`;
}

/** Render the whole dashboard for one company file; pure read, no writes. */
export function renderDashboard(file: CompanyFile, params: URLSearchParams): string {
  const info = file.info();
  const context: RenderContext = { currency: info.baseCurrency };
  const asOf = params.get('asOf') ?? new Date().toISOString().slice(0, 10);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  const sheet = file.balanceSheet(asOf);
  const pnl = file.profitAndLoss(yearStart, asOf);
  const ar = file.arAging(asOf);
  const ap = file.apAging(asOf);
  const inventory = file.inventorySummary(asOf);
  const plugins = file.plugins();
  const pluginReports = file.pluginReportNames();

  const documents = file
    .listDocuments()
    .sort((a, b) => (a.current.date === b.current.date ? (a.number < b.number ? 1 : -1) : a.current.date < b.current.date ? 1 : -1))
    .slice(0, 10);

  const badge = sheet.balanced
    ? `<span class="badge ok">BALANCED</span>`
    : `<span class="badge bad">OUT OF BALANCE</span>`;

  const documentRows =
    documents.length === 0
      ? `<p class="empty">No documents yet.</p>`
      : `<table><thead><tr><th>Number</th><th>Type</th><th>Status</th><th>Date</th><th>Party</th><th class="n">Total</th></tr></thead><tbody>${documents
          .map(
            (view) =>
              `<tr><td>${escapeHtml(view.label)}</td><td>${escapeHtml(view.type)}</td><td>${escapeHtml(view.status)}</td><td>${escapeHtml(view.current.date)}</td><td>${escapeHtml(view.current.customerName)}</td><td class="n">${amount(context, view.total)}</td></tr>`,
          )
          .join('')}</tbody></table>`;

  const inventoryRows =
    inventory.rows.length === 0
      ? `<p class="empty">No inventory items.</p>`
      : `<table><thead><tr><th>Item</th><th class="n">On hand</th><th class="n">FIFO value</th></tr></thead><tbody>${inventory.rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.name)}</td><td class="n">${formatQuantity(row.quantityMilli)}</td><td class="n">${amount(context, row.valueMinor)}</td></tr>`,
          )
          .join('')}<tr class="total"><td>TOTAL</td><td></td><td class="n">${amount(context, inventory.totalValueMinor)}</td></tr></tbody></table>`;

  const pluginRows =
    plugins.length === 0
      ? `<p class="empty">No plugins attached.</p>`
      : `<table><thead><tr><th>Plugin</th><th>Version</th></tr></thead><tbody>${plugins
          .map((manifest) => `<tr><td>${escapeHtml(manifest.name)} <span class="muted">(${escapeHtml(manifest.id)})</span></td><td>${escapeHtml(manifest.version)}</td></tr>`)
          .join('')}</tbody></table>${
          pluginReports.length > 0
            ? `<p class="muted">Contributed reports: ${pluginReports.map((name) => `<code>/reports/${escapeHtml(name)}</code>`).join(', ')}</p>`
            : ''
        }`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(info.name)} — Accounts</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(info.name)} ${badge}</h1>
<p class="muted">As of ${escapeHtml(asOf)} · base currency ${escapeHtml(info.baseCurrency)} · read-only view of the JSON API</p>

<h2>Balance sheet</h2>
<table><tbody>
<tr><th>Assets</th><th></th></tr>
${accountRows(context, sheet.assets, 'Total assets', sheet.totalAssets)}
<tr><th>Liabilities</th><th></th></tr>
${accountRows(context, sheet.liabilities, 'Total liabilities', sheet.totalLiabilities)}
<tr><th>Equity</th><th></th></tr>
${accountRows(context, sheet.equity, 'Total equity', sheet.totalEquity)}
</tbody></table>

<h2>Profit &amp; loss <span class="muted">(${escapeHtml(pnl.from)} → ${escapeHtml(pnl.to)})</span></h2>
<table><tbody>
<tr><th>Income</th><th></th></tr>
${accountRows(context, pnl.income, 'Total income', pnl.totalIncome)}
<tr><th>Expenses</th><th></th></tr>
${accountRows(context, pnl.expense, 'Total expenses', pnl.totalExpense)}
<tr class="total"><td>Net profit</td><td class="n">${amount(context, pnl.netProfit)}</td></tr>
</tbody></table>

<h2>A/R aging</h2>
${agingTable(context, ar)}

<h2>A/P aging</h2>
${agingTable(context, ap)}

<h2>Inventory</h2>
${inventoryRows}

<h2>Recent documents</h2>
${documentRows}

<h2>Plugins</h2>
${pluginRows}
</body>
</html>
`;
}
