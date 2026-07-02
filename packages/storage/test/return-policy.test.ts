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

    // Charge corrections are gated too (on a normally priced invoice — the
    // below-cost one floors at its own price and can't go lower, per ADR 0005).
    const normal = file.createDocument({
      type: 'invoice', number: 'INV-4', date: '2026-06-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }],
    });
    file.sendDocument(normal.id);
    expect(() => file.chargeCorrection(normal.id, 2000n)).toThrowError(/requires an approver/);
    file.chargeCorrection(normal.id, 2000n, 'fix', 'owner');
  });
});

describe('price breaks and rate hygiene persist (Tier 2)', () => {
  it('tiers (threshold + exact multiples), expiry, revocation, and review survive reopening', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n });
    file.setCustomerRate({
      itemId: widget.id, ...acme,
      rate: { kind: 'constant', unitPrice: 2400n },
      tiers: [
        { minQuantityMilli: 50_000n, rate: { kind: 'constant', unitPrice: 2200n } },
        { multipleQuantityMilli: 12_000n, rate: { kind: 'constant', unitPrice: 2000n } }, // full boxes of 12
      ],
      effectiveTo: '2026-12-31',
    });

    file.close();
    file = CompanyFile.open(books);

    const priced = (quantityMilli: bigint, number: string, date = '2026-07-01') =>
      file.createDocument({
        type: 'invoice', number, date, ...acme,
        lines: [{ itemId: widget.id, description: 'Widget', quantityMilli }],
      }).current.lines[0]!.unitPrice;

    expect(priced(5_000n, 'INV-B1')).toBe(2400n);   // loose
    expect(priced(24_000n, 'INV-B2')).toBe(2000n);  // 2 full boxes
    expect(priced(25_000n, 'INV-B3')).toBe(2400n);  // broken box
    expect(priced(60_000n, 'INV-B4')).toBe(2000n);  // boxes beat the 50+ tier
    expect(priced(5_000n, 'INV-B5', '2027-01-15')).toBe(2500n); // expired → catalog

    // Revocation ends pricing explicitly.
    file.setCustomerRate({ itemId: widget.id, ...acme, rate: { kind: 'revoked' }, effectiveFrom: '2026-08-01' });
    expect(priced(24_000n, 'INV-B6', '2026-08-02')).toBe(2500n);

    const review = file.rateReview('2026-08-02');
    expect(review).toHaveLength(1);
    expect(review[0]!.active).toBe(false); // the revocation is the standing record
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
