import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '@accounts/storage';
import { run } from '../src/cli.js';

let dir: string;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-cli-'));
  books = join(dir, 'books.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setUpCompany() {
  run(['init', books, '--name', 'Demo Co', '--currency', 'USD']);
  run(['account', 'add', books, '--name', 'Cash', '--type', 'asset', '--code', '1000']);
  run(['account', 'add', books, '--name', 'Sales', '--type', 'income', '--code', '4000']);
  run(['account', 'add', books, '--name', 'Rent', '--type', 'expense', '--code', '6000']);
}

describe('accounts CLI', () => {
  it('walks the Phase 0 exit-criteria flow end to end', () => {
    setUpCompany();

    expect(run(['account', 'list', books])).toContain('Cash');

    const posted = run([
      'post', books,
      '--date', '2026-07-01',
      '--memo', 'Consulting invoice paid',
      '--debit', '1000:1500.00',
      '--credit', '4000:1500.00',
    ]);
    expect(posted).toMatch(/Posted entry .+ \(#1\)/);

    run([
      'post', books,
      '--date', '2026-07-02',
      '--memo', 'Office rent',
      '--debit', '6000:800.00',
      '--credit', '1000:800.00',
    ]);

    const balance = run(['trial-balance', books]);
    expect(balance).toContain('BALANCED');
    expect(balance).toMatch(/Cash.*USD\s+700\.00/);
    expect(balance).toMatch(/Sales.*USD\s+1500\.00/);
    expect(balance).toMatch(/Rent.*USD\s+800\.00/);
    expect(balance).not.toContain('OUT OF BALANCE');
  });

  it('rejects an unbalanced posting with a clear error', () => {
    setUpCompany();
    expect(() =>
      run(['post', books, '--date', '2026-07-01', '--debit', '1000:100.00', '--credit', '4000:90.00']),
    ).toThrowError(/differ by 1000 minor units/);
  });

  it('rejects amounts with excess precision', () => {
    setUpCompany();
    expect(() =>
      run(['post', books, '--date', '2026-07-01', '--debit', '1000:0.001', '--credit', '4000:0.001']),
    ).toThrowError(/decimal place/);
  });

  it('reverses an entry by id and returns the books to balance', () => {
    setUpCompany();
    const output = run(['post', books, '--date', '2026-07-01', '--debit', '6000:50.00', '--credit', '1000:50.00']);
    const entryId = /Posted entry (\S+)/.exec(output)![1]!;
    expect(run(['reverse', books, entryId, '--date', '2026-07-02'])).toContain('reversal');
    const entries = run(['entries', books]);
    expect(entries).toContain(`(reverses ${entryId})`);
  });

  it('supports as-of trial balances', () => {
    setUpCompany();
    run(['post', books, '--date', '2026-01-15', '--debit', '1000:100.00', '--credit', '4000:100.00']);
    run(['post', books, '--date', '2026-06-15', '--debit', '1000:900.00', '--credit', '4000:900.00']);
    const early = run(['trial-balance', books, '--as-of', '2026-03-31']);
    expect(early).toMatch(/Cash\s+USD\s+100\.00/);
    const full = run(['trial-balance', books]);
    expect(full).toMatch(/Cash\s+USD\s+1000\.00/);
  });

  it('errors helpfully on unknown accounts and commands', () => {
    setUpCompany();
    expect(() =>
      run(['post', books, '--date', '2026-07-01', '--debit', '9999:1.00', '--credit', '4000:1.00']),
    ).toThrowError(/No account with code or id "9999"/);
    expect(() => run(['frobnicate'])).toThrowError(/Unknown command/);
  });

  it('prints usage with no arguments', () => {
    expect(run([])).toContain('Usage:');
  });
});

describe('reports (ADR 0017)', () => {
  it('renders P&L, balance sheet, and aging from a posted book', () => {
    setUpCompany();
    run(['post', books, '--date', '2026-07-01', '--memo', 'Sale', '--debit', '1000:500.00', '--credit', '4000:500.00']);
    run(['post', books, '--date', '2026-07-02', '--memo', 'Rent', '--debit', '6000:200.00', '--credit', '1000:200.00']);

    const pnl = run(['report', 'pnl', books, '--from', '2026-07-01', '--to', '2026-07-31']);
    expect(pnl).toContain('Net profit: 300.00');

    const sheet = run(['report', 'balance-sheet', books, '--as-of', '2026-07-31']);
    expect(sheet).toContain('BALANCED');
    expect(sheet).toContain('Retained earnings');

    // Aging needs a document-layer invoice.
    const file = CompanyFile.open(books);
    const item = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-05-01', customerName: 'Slowpay LLC', termsDays: 30,
      lines: [{ itemId: item.id, description: 'Widget', quantityMilli: 4000n }],
    });
    file.sendDocument(invoice.id);
    file.close();
    const aging = run(['report', 'ar-aging', books, '--as-of', '2026-07-31']);
    expect(aging).toContain('Slowpay LLC');
    expect(aging).toContain('PAST DUE');
  });
});

describe('document commands (Tier 3)', () => {
  it('item add, doc list/show/send, statement', () => {
    run(['init', books, '--name', 'Demo Co']);
    const itemOut = run(['item', 'add', books, '--name', 'Widget', '--price', '25.00', '--cost', '10.00']);
    const itemId = /\(([-0-9a-f]+)\)$/.exec(itemOut)![1]!;

    // Create a document through the library (creation stays API/REST-side).
    const file = CompanyFile.open(books);
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-01', customerName: 'Acme LLC', termsDays: 30,
      lines: [{ itemId, description: 'Widget', quantityMilli: 4000n }],
    });
    file.close();

    expect(run(['doc', 'list', books])).toContain('INV-1');
    const shown = run(['doc', 'show', books, invoice.id]);
    expect(shown).toContain('INVOICE INV-1');
    expect(shown).toContain('Net 30');
    expect(shown).toContain('Total: 100.00');

    expect(run(['doc', 'send', books, invoice.id])).toContain('Sent INV-1');
    const statement = run(['statement', books, '--customer', 'Acme LLC', '--as-of', '2026-09-15']);
    expect(statement).toContain('INV-1');
    expect(statement).toContain('past due');
    expect(statement).toContain('Balance due: 100.00');
  });
});
