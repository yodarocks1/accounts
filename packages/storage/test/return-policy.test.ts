import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CompanyFile } from '../src/index.js';
import { MIGRATIONS } from '../src/schema.js';

let dir: string;
let file: CompanyFile;
let books: string;

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-rp-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('return policy persists (Tier 2)', () => {
  it('conditions, fees, window, and the quantity guard survive reopening', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    file.setReturnPolicy({
      windowDays: 30,
      fees: { unopened: { percentMilli: 5_000n }, damaged: { percentMilli: 25_000n, amountMinor: 500n } },
    });

    const sale = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-06-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 3000n }],
    });
    file.sendDocument(sale.id);

    file.close();
    file = CompanyFile.open(books);
    expect(file.returnPolicy().windowDays).toBe(30);
    expect(file.returnPolicy().fees!.unopened!.percentMilli).toBe(5_000n);

    const credit = file.createReturn({
      number: 'CR-1', date: '2026-06-10', ...acme,
      items: [
        { itemId: widget.id, quantityMilli: 1000n },
        { itemId: widget.id, quantityMilli: 1000n, condition: 'damaged' },
      ],
    });
    expect(credit.current.lines[0]!.returnCondition).toBe('unopened');
    expect(credit.current.lines[0]!.adjustment).toBe(-125n);
    expect(credit.current.lines[1]!.adjustment).toBe(-1125n);

    // Quantity guard across separate credit memos (SQL-computed).
    expect(() =>
      file.createReturn({ number: 'CR-2', date: '2026-06-11', ...acme,
        items: [{ itemId: widget.id, quantityMilli: 2000n }] }),
    ).toThrowError(/exceeds the 3000 purchased/);

    // Window: too-old purchases need an approved override once gated.
    file.setApprovalPolicy(['return_window_override']);
    expect(() =>
      file.createReturn({ number: 'CR-3', date: '2026-08-15', ...acme,
        items: [{ itemId: widget.id, quantityMilli: 1000n }] }),
    ).toThrowError(/return window/);
    expect(() =>
      file.createReturn({ number: 'CR-3', date: '2026-08-15', ...acme, overrideWindow: true,
        items: [{ itemId: widget.id, quantityMilli: 1000n }] }),
    ).toThrowError(/requires an approver/);
    const late = file.createReturn({ number: 'CR-3', date: '2026-08-15', ...acme,
      overrideWindow: true, approvedBy: 'manager',
      items: [{ itemId: widget.id, quantityMilli: 1000n }] });
    expect(late.total).toBe(2500n - 125n);
  });

  it('approval gates persist and below-cost sales are caught', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    file.setApprovalPolicy(['charge_correction', 'below_cost_sale']);
    file.close();
    file = CompanyFile.open(books);

    expect(() =>
      file.createDocument({
        type: 'invoice', number: 'INV-2', date: '2026-06-01', ...acme,
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 500n }],
      }),
    ).toThrowError(/requires an approver/);

    const approved = file.createDocument({
      type: 'invoice', number: 'INV-3', date: '2026-06-01', ...acme, approvedBy: 'owner',
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n, unitPrice: 500n }],
    });
    file.sendDocument(approved.id);
    expect(() => file.chargeCorrection(approved.id, 400n)).toThrowError(/requires an approver/);
    file.chargeCorrection(approved.id, 400n, 'fix', 'owner');
  });
});

describe('pre-migration backup (Tier 2)', () => {
  it('snapshots the file before applying migrations', () => {
    // Build a v1-era file, then open it (triggers full migration + backup).
    const oldPath = join(dir, 'legacy.sqlite');
    const old = new Database(oldPath);
    old.exec(MIGRATIONS[0]!);
    old.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run();
    old.prepare(`INSERT INTO meta (key, value) VALUES ('company_name', 'Legacy Co')`).run();
    old.prepare(`INSERT INTO meta (key, value) VALUES ('base_currency', 'USD')`).run();
    old.close();

    const upgraded = CompanyFile.open(oldPath);
    upgraded.close();

    const backups = readdirSync(dir).filter((name) => name.startsWith('legacy.sqlite.v1') && name.endsWith('.backup'));
    expect(backups).toHaveLength(1);
    // The backup is a valid pre-migration snapshot.
    const backup = new Database(join(dir, backups[0]!), { readonly: true });
    const version = backup.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(version.value).toBe('1');
    backup.close();
  });
});
