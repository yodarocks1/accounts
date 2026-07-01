import { parseArgs } from 'node:util';
import {
  formatMoney,
  money,
  normalBalance,
  parseMoney,
  type Account,
  type NewJournalLine,
} from '@accounts/core';
import { CompanyFile } from '@accounts/storage';

export const USAGE = `accounts — open-source, moddable double-entry books

Usage:
  accounts init <file> --name <company> [--currency USD]
  accounts account add <file> --name <name> --type <asset|liability|equity|income|expense> [--code <code>] [--currency USD] [--parent <code-or-id>]
  accounts account list <file>
  accounts post <file> --date YYYY-MM-DD [--memo <text>] --debit <account>:<amount> --credit <account>:<amount> [...more --debit/--credit]
  accounts reverse <file> <entry-id> --date YYYY-MM-DD [--memo <text>]
  accounts entries <file>
  accounts trial-balance <file> [--as-of YYYY-MM-DD]

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
