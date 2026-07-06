import { parseArgs } from 'node:util';
import {
  formatMoney,
  formatQuantity,
  money,
  normalBalance,
  parseMoney,
  type Account,
  type DepositPolicy,
  type DocumentType,
  type ItemKind,
  type NewJournalLine,
} from '@accounts/core';
import { CompanyFile } from '@accounts/storage';
import { createApiServer } from '@accounts/server';

export const USAGE = `accounts — open-source, moddable double-entry books

Usage:
  accounts init <file> --name <company> [--currency USD]
  accounts account add <file> --name <name> --type <asset|liability|equity|income|expense> [--code <code>] [--currency USD] [--parent <code-or-id>]
  accounts account list <file>
  accounts post <file> --date YYYY-MM-DD [--memo <text>] --debit <account>:<amount> --credit <account>:<amount> [...more --debit/--credit]
  accounts reverse <file> <entry-id> --date YYYY-MM-DD [--memo <text>]
  accounts entries <file>
  accounts trial-balance <file> [--as-of YYYY-MM-DD]

Document layer:
  accounts item add <file> --name <name> --price <amount> [--cost <amount>] [--tax-code <code>] [--deposit-policy <never|always|when_out_of_stock|special_order>] [--kind <inventory|non_inventory|service>]
  accounts item stock <file> <item-id> [--as-of YYYY-MM-DD]
  accounts doc list <file> [--type <estimate|sales_order|invoice|credit_memo|purchase_order|bill|vendor_credit>]
  accounts doc show <file> <document-id>
  accounts doc send <file> <document-id> [--override-deposit] [--override-minimum] [--approved-by <who>]
  accounts statement <file> (--party <id> | --customer <name> | --acct <number>) [--as-of YYYY-MM-DD] [--supplier]
  accounts serve <file> [--port 3000]

Accounts in --debit/--credit are referenced by code or id; amounts are decimal
strings in the account's currency ("1500.00").`;

export class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function resolveAccount(file: CompanyFile, ref: string): Account {
  const account = file.findAccountByCode(ref) ?? file.getAccount(ref);
  if (!account) fail(`No account with code or id ${JSON.stringify(ref)}`);
  return account;
}

function parsePostingLines(file: CompanyFile, debits: string[], credits: string[]): NewJournalLine[] {
  const parse = (spec: string, side: 'debit' | 'credit'): NewJournalLine => {
    const at = spec.lastIndexOf(':');
    if (at <= 0 || at === spec.length - 1) {
      fail(`Expected <account>:<amount>, got ${JSON.stringify(spec)}`);
    }
    const account = resolveAccount(file, spec.slice(0, at));
    const value = parseMoney(spec.slice(at + 1), account.currency);
    if (value.amount <= 0n) fail(`Amounts must be positive: ${JSON.stringify(spec)}`);
    return { accountId: account.id, side, amount: value.amount, currency: account.currency };
  };
  return [
    ...debits.map((spec) => parse(spec, 'debit')),
    ...credits.map((spec) => parse(spec, 'credit')),
  ];
}

function table(rows: string[][], align: ('left' | 'right')[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (align[i] === 'right' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function run(argv: string[]): string {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return USAGE;
    case 'init':
      return cmdInit(rest);
    case 'account':
      return cmdAccount(rest);
    case 'post':
      return cmdPost(rest);
    case 'reverse':
      return cmdReverse(rest);
    case 'entries':
      return cmdEntries(rest);
    case 'trial-balance':
      return cmdTrialBalance(rest);
    case 'item':
      return cmdItem(rest);
    case 'doc':
      return cmdDoc(rest);
    case 'statement':
      return cmdStatement(rest);
    case 'serve':
      return cmdServe(rest);
    default:
      fail(`Unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
  }
}

function requirePath(positionals: string[]): string {
  const path = positionals[0];
  if (!path) fail('Missing company file path');
  return path;
}

function cmdInit(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      currency: { type: 'string', default: 'USD' },
    },
  });
  const path = requirePath(positionals);
  if (!values.name) fail('init requires --name');
  const file = CompanyFile.create(path, { name: values.name, baseCurrency: values.currency! });
  try {
    return `Created company file ${path} for ${JSON.stringify(values.name)} (${values.currency})`;
  } finally {
    file.close();
  }
}

function cmdAccount(args: string[]): string {
  const [sub, ...rest] = args;
  if (sub === 'add') return cmdAccountAdd(rest);
  if (sub === 'list') return cmdAccountList(rest);
  fail(`Unknown subcommand: account ${sub ?? ''}\n\n${USAGE}`);
}

function cmdAccountAdd(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      type: { type: 'string' },
      code: { type: 'string' },
      currency: { type: 'string' },
      parent: { type: 'string' },
    },
  });
  const path = requirePath(positionals);
  if (!values.name || !values.type) fail('account add requires --name and --type');
  const file = CompanyFile.open(path);
  try {
    const account = file.createAccount({
      name: values.name,
      type: values.type as Account['type'],
      currency: values.currency ?? file.info().baseCurrency,
      ...(values.code !== undefined ? { code: values.code } : {}),
      ...(values.parent !== undefined ? { parentId: resolveAccount(file, values.parent).id } : {}),
    });
    return `Created ${account.type} account ${account.code ? `[${account.code}] ` : ''}${account.name} (${account.currency})`;
  } finally {
    file.close();
  }
}

function cmdAccountList(args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const accounts = file.listAccounts();
    if (accounts.length === 0) return 'No accounts yet.';
    const rows = [
      ['CODE', 'NAME', 'TYPE', 'CURRENCY', 'NORMAL'],
      ...accounts.map((account) => [
        account.code ?? '',
        account.name,
        account.type,
        account.currency,
        normalBalance(account.type),
      ]),
    ];
    return table(rows, ['left', 'left', 'left', 'left', 'left']);
  } finally {
    file.close();
  }
}

function cmdPost(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      memo: { type: 'string' },
      debit: { type: 'string', multiple: true, default: [] },
      credit: { type: 'string', multiple: true, default: [] },
    },
  });
  const path = requirePath(positionals);
  if (!values.date) fail('post requires --date');
  const file = CompanyFile.open(path);
  try {
    const lines = parsePostingLines(file, values.debit!, values.credit!);
    const entry = file.postEntry({
      date: values.date,
      lines,
      ...(values.memo !== undefined ? { memo: values.memo } : {}),
    });
    return `Posted entry ${entry.id} (#${entry.seq}) on ${entry.date} with ${entry.lines.length} lines`;
  } finally {
    file.close();
  }
}

function cmdReverse(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      memo: { type: 'string' },
    },
  });
  const path = requirePath(positionals);
  const entryId = positionals[1];
  if (!entryId) fail('reverse requires an entry id');
  if (!values.date) fail('reverse requires --date');
  const file = CompanyFile.open(path);
  try {
    const reversal = file.reverseEntry(entryId, values.date, values.memo);
    return `Posted reversal ${reversal.id} (#${reversal.seq}) of ${entryId}`;
  } finally {
    file.close();
  }
}

function cmdEntries(args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const accounts = file.accountsById();
    const entries = file.listEntries();
    if (entries.length === 0) return 'No entries yet.';
    const blocks = entries.map((entry) => {
      const header = `#${entry.seq}  ${entry.date}  ${entry.id}${entry.memo ? `  — ${entry.memo}` : ''}${entry.reversesEntryId ? `  (reverses ${entry.reversesEntryId})` : ''}`;
      const rows = entry.lines.map((line) => {
        const account = accounts.get(line.accountId);
        const label = account ? `${account.code ? `[${account.code}] ` : ''}${account.name}` : line.accountId;
        const amount = formatMoney(money(line.amount, line.currency));
        return line.side === 'debit'
          ? ['', label, amount, '']
          : ['', `    ${label}`, '', amount];
      });
      return `${header}\n${table([['', 'ACCOUNT', 'DEBIT', 'CREDIT'], ...rows], ['left', 'left', 'right', 'right'])}`;
    });
    return blocks.join('\n\n');
  } finally {
    file.close();
  }
}

function cmdTrialBalance(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'as-of': { type: 'string' } },
  });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const asOf = values['as-of'];
    const balance = file.trialBalance(asOf);
    const accounts = file.accountsById();
    if (balance.rows.length === 0) return 'No postings yet.';
    const rows = [
      ['CODE', 'ACCOUNT', 'CUR', 'DEBIT', 'CREDIT'],
      ...balance.rows.map((row) => {
        const account = accounts.get(row.accountId);
        const debitCell = row.net > 0n ? formatMoney(money(row.net, row.currency)) : '';
        const creditCell = row.net < 0n ? formatMoney(money(-row.net, row.currency)) : '';
        return [account?.code ?? '', account?.name ?? row.accountId, row.currency, debitCell, creditCell];
      }),
    ];
    const totals = [...balance.totals.entries()]
      .map(([currency, total]) => {
        const flag = total.debits === total.credits ? 'BALANCED' : '*** OUT OF BALANCE ***';
        return `${currency}: debits ${formatMoney(money(total.debits, currency))} / credits ${formatMoney(money(total.credits, currency))} — ${flag}`;
      })
      .join('\n');
    const heading = asOf ? `Trial balance as of ${asOf}` : 'Trial balance';
    return `${heading}\n${table(rows, ['left', 'left', 'left', 'right', 'right'])}\n\n${totals}`;
  } finally {
    file.close();
  }
}

function cmdItem(args: string[]): string {
  const [sub, ...rest] = args;
  if (sub === 'stock') return cmdItemStock(rest);
  if (sub !== 'add') fail(`Unknown subcommand: item ${sub ?? ''}\n\n${USAGE}`);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      price: { type: 'string' },
      cost: { type: 'string' },
      currency: { type: 'string' },
      'tax-code': { type: 'string' },
      'deposit-policy': { type: 'string' },
      kind: { type: 'string' },
    },
  });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    if (!values.name || !values.price) fail('item add requires --name and --price');
    const currency = values.currency ?? file.info().baseCurrency;
    const item = file.createItem({
      name: values.name,
      currency,
      unitPrice: parseMoney(values.price, currency).amount,
      ...(values.cost !== undefined ? { cost: parseMoney(values.cost, currency).amount } : {}),
      ...(values['tax-code'] !== undefined ? { taxCode: values['tax-code'] } : {}),
      ...(values['deposit-policy'] !== undefined
        ? { depositPolicy: values['deposit-policy'] as DepositPolicy }
        : {}),
      ...(values.kind !== undefined ? { kind: values.kind as ItemKind } : {}),
    });
    return `Created item ${item.name} (${item.id})`;
  } finally {
    file.close();
  }
}

function cmdItemStock(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'as-of': { type: 'string' } },
  });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const itemId = positionals[1];
    if (!itemId) fail('item stock requires an item id');
    const item = file.getItem(itemId);
    if (!item) fail(`No such item: ${itemId}`);
    if (item.kind !== 'inventory') return `${item.name}: ${item.kind.replace('_', '-')} (no tracked stock)`;
    const level = file.stockOnHand(itemId, values['as-of']);
    return `${item.name}: ${formatQuantity(level.goodMilli)} good, ${formatQuantity(level.damagedMilli)} damaged on hand`;
  } finally {
    file.close();
  }
}

function cmdDoc(args: string[]): string {
  const [sub, ...rest] = args;
  if (sub === 'list') return cmdDocList(rest);
  if (sub === 'show') return cmdDocShow(rest);
  if (sub === 'send') return cmdDocSend(rest);
  fail(`Unknown subcommand: doc ${sub ?? ''}\n\n${USAGE}`);
}

function cmdDocList(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { type: { type: 'string' } },
  });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const documents = file.listDocuments(values.type as DocumentType | undefined);
    if (documents.length === 0) return 'No documents yet.';
    const rows = [
      ['TYPE', 'NUMBER', 'STATUS', 'DATE', 'CUSTOMER', 'TOTAL', 'ID'],
      ...documents.map((view) => [
        view.type,
        view.label,
        view.status,
        view.current.date,
        view.current.customerName,
        formatMoney(money(view.total, view.currency)),
        view.id,
      ]),
    ];
    return table(rows, ['left', 'left', 'left', 'left', 'left', 'right', 'left']);
  } finally {
    file.close();
  }
}

function cmdDocShow(args: string[]): string {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const id = positionals[1];
    if (!id) fail('doc show requires a document id');
    const view = file.viewDocument(id);
    const current = view.current;
    const usd = (value: bigint) => formatMoney(money(value, view.currency));
    const header = [
      `${view.type.toUpperCase()} ${view.label}  [${view.status}]`,
      `Customer: ${current.customerName}${current.accountNumber ? `  (${current.accountNumber})` : ''}${current.poNumber ? `  PO ${current.poNumber}` : ''}`,
      `Date: ${current.date}${current.termsDays !== null ? `  Net ${current.termsDays}` : ''}`,
      ...(current.depositRequiredMinor !== null ? [`Deposit requested: ${usd(current.depositRequiredMinor)}`] : []),
    ];
    const lineRows = [
      ['QTY', 'DESCRIPTION', 'UNIT', 'TAX', 'AMOUNT'],
      ...current.lines.map((line) => [
        formatQuantity(line.quantityMilli),
        line.description + (line.free ? ' (FREE)' : ''),
        usd(line.unitPrice),
        line.taxCode ?? '',
        line.free ? usd(0n) : usd((line.quantityMilli * line.unitPrice) / 1000n + line.adjustment),
      ]),
    ];
    const totals = [
      `Subtotal: ${usd(view.subtotal)}`,
      ...(view.taxTotal > 0n ? [`Tax: ${usd(view.taxTotal)}`] : []),
      `Total: ${usd(view.total)}`,
    ];
    if ((view.type === 'invoice' || view.type === 'bill') && view.status === 'sent') {
      const settlement = file.invoiceSettlement(view.id);
      totals.push(`Paid: ${usd(settlement.paid)}  Open: ${usd(settlement.open)}  [${settlement.status}]`);
    }
    if (view.type === 'sales_order' && view.status === 'sent') {
      totals.push(`Deposit held: ${usd(file.depositHeld(view.id))}`);
    }
    if (view.type === 'purchase_order' && view.status === 'draft') {
      const readiness = file.purchaseOrderReadiness(view.id);
      totals.push(
        readiness.ready
          ? 'Ready to send (supplier minimums met)'
          : `NOT ready to send:\n${readiness.shortfalls.map((shortfall) => `  - ${shortfall.message}`).join('\n')}`,
      );
    }
    return [...header, '', table(lineRows, ['right', 'left', 'right', 'left', 'right']), '', ...totals].join('\n');
  } finally {
    file.close();
  }
}

function cmdDocSend(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'override-deposit': { type: 'boolean' },
      'override-minimum': { type: 'boolean' },
      'approved-by': { type: 'string' },
    },
  });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const id = positionals[1];
    if (!id) fail('doc send requires a document id');
    const view = file.sendDocument(id, {
      ...(values['override-deposit'] !== undefined ? { overrideDeposit: values['override-deposit'] } : {}),
      ...(values['override-minimum'] !== undefined ? { overrideMinimum: values['override-minimum'] } : {}),
      ...(values['approved-by'] !== undefined ? { approvedBy: values['approved-by'] } : {}),
    });
    const suggestions = file.suggestSpecialRates(id);
    const ask = suggestions.map(
      (suggestion) =>
        `ASK: keep ${suggestion.itemName} at ${formatMoney(money(suggestion.givenPrice, view.currency))} for ${suggestion.customerName}? (list ${formatMoney(money(suggestion.catalogPrice, view.currency))})`,
    );
    return [`Sent ${view.label}`, ...ask].join('\n');
  } finally {
    file.close();
  }
}

function cmdStatement(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      party: { type: 'string' },
      customer: { type: 'string' },
      acct: { type: 'string' },
      'as-of': { type: 'string' },
      supplier: { type: 'boolean' },
    },
  });
  const file = CompanyFile.open(requirePath(positionals));
  try {
    const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10);
    const query = {
      ...(values.customer !== undefined ? { customerName: values.customer } : {}),
      ...(values.acct !== undefined ? { accountNumber: values.acct } : {}),
    };
    const statement = values.supplier
      ? values.party
        ? file.supplierStatementForParty(values.party, asOf)
        : file.supplierStatement(query, asOf)
      : values.party
        ? file.statementForParty(values.party, asOf)
        : file.statement(query, asOf);
    const usd = (value: bigint) => formatMoney(money(value, file.info().baseCurrency));
    const out: string[] = [`${values.supplier ? 'SUPPLIER STATEMENT' : 'STATEMENT'} as of ${statement.asOf}`];
    for (const invoice of statement.invoices) {
      out.push(
        `  ${invoice.date}  ${invoice.label.padEnd(24)} ${usd(invoice.originalTotal).padStart(10)}  [${invoice.ageLabel}]${invoice.dueDate ? `  due ${invoice.dueDate}` : ''}`,
      );
      for (const correction of invoice.corrections) {
        out.push(`              └─ correction: ${usd(correction.total)}${correction.reason ? `  (${correction.reason})` : ''}`);
      }
      if (invoice.paidAmount > 0n) out.push(`              paid ${usd(invoice.paidAmount)}, open ${usd(invoice.openAmount)}`);
    }
    for (const credit of statement.credits) {
      out.push(`  ${credit.date}  ${credit.label.padEnd(24)} −${usd(credit.total)}  (${credit.kind}, ${credit.settlement})`);
    }
    for (const payment of statement.payments) {
      out.push(`  ${payment.date}  ${payment.number.padEnd(24)} −${usd(payment.amount)}  (payment${payment.method ? `, ${payment.method}` : ''})`);
    }
    out.push(`  Balance due: ${usd(statement.balance)}`);
    return out.join('\n');
  } finally {
    file.close();
  }
}

function cmdServe(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string' } },
  });
  const path = requirePath(positionals);
  const file = CompanyFile.open(path);
  const port = Number(values.port ?? 3000);
  const server = createApiServer(file);
  server.listen(port);
  // The server owns the process from here; close on SIGINT.
  process.on('SIGINT', () => {
    server.close(() => {
      file.close();
      process.exit(0);
    });
  });
  return `Serving ${path} on http://127.0.0.1:${port} (Ctrl-C to stop)`;
}
