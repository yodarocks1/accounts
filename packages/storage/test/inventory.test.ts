import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-inventory-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('inventory persists (ADR 0014)', () => {
  it('documents drive the stock ledger; levels derive and survive reopen', () => {
    const piece = file.createItem({ name: 'Piece', currency: 'USD', unitPrice: 300n, cost: 100n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc' });

    const bill = file.createDocument({
      type: 'bill', number: 'BILL-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 24_000n, lineId: 'L1' }],
    });
    file.sendDocument(bill.id);
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-02', customerName: 'Acme LLC',
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 10_000n }],
    });
    file.sendDocument(invoice.id);
    expect(file.stockOnHand(piece.id).goodMilli).toBe(14_000n);
    expect(file.getItem(piece.id)!.inStock).toBe(true);

    // Correction delta + void restore, then reopen and recheck.
    file.changeDocument(bill.id, {
      kind: 'correction', reason: 'short shipped',
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 20_000n, lineId: 'L1' }],
    });
    file.voidDocument(invoice.id);
    file.close();
    file = CompanyFile.open(books);
    expect(file.stockOnHand(piece.id).goodMilli).toBe(20_000n);
    expect(file.stockMovements(piece.id).map((movement) => movement.kind)).toEqual([
      'document', 'document', 'correction', 'void',
    ]);
  });

  it('damage, dispositions, gates, and DB-level immutability', () => {
    const food = file.createItem({
      name: 'Perishable', currency: 'USD', unitPrice: 700n, kind: 'inventory',
      dispositions: ['recycle', 'trash'],
    });
    file.adjustStock(food.id, 5000n, { reason: 'initial count' });
    file.markDamaged(food.id, 2000n, { reason: 'freezer failure' });
    expect(() => file.disposeStock(food.id, 1000n, 'restock')).toThrowError(/does not allow the "restock"/);
    file.setApprovalPolicy(['stock_write_off']);
    expect(() => file.disposeStock(food.id, 1000n, 'trash')).toThrowError(/requires an approver/);
    file.disposeStock(food.id, 2000n, 'trash', { approvedBy: 'owner' });
    expect(file.stockOnHand(food.id)).toEqual({ goodMilli: 3000n, damagedMilli: 0n });
    // Reopen: dispositions round-trip; raw SQL cannot rewrite the ledger.
    file.close();
    file = CompanyFile.open(books);
    expect(file.getItem(food.id)!.dispositions).toEqual(['recycle', 'trash']);
    file.close();
    const raw = new Database(books);
    expect(() => raw.prepare(`UPDATE stock_movements SET quantity_milli = 999`).run()).toThrowError(/immutable/);
    expect(() => raw.prepare(`DELETE FROM stock_movements`).run()).toThrowError(/immutable/);
    raw.close();
    file = CompanyFile.open(books);
  });

  it('BOMs derive additive costs and build/break moves stock', () => {
    const piece = file.createItem({ name: 'Piece', currency: 'USD', unitPrice: 300n, cost: 100n, kind: 'inventory' });
    const labor = file.createItem({ name: 'Labor', currency: 'USD', unitPrice: 6000n, cost: 2000n, kind: 'service' });
    const box = file.createItem({ name: 'Box of 12', currency: 'USD', unitPrice: 3000n, kind: 'inventory' });
    file.setBom({
      itemId: box.id, assemblyCostMinor: 30n,
      components: [
        { componentItemId: piece.id, quantityMilli: 12_000n },
        { componentItemId: labor.id, quantityMilli: 250n },
      ],
    });
    expect(file.costAt(box.id, '2026-07-01')).toBe(1730n);
    // Cycles rejected; cost snapshots on documents use the derived value.
    expect(() =>
      file.setBom({ itemId: piece.id, components: [{ componentItemId: box.id, quantityMilli: 1n }] }),
    ).toThrowError(/contain itself/);

    file.adjustStock(piece.id, 30_000n, { reason: 'initial count' });
    file.buildAssembly(box.id, 2000n);
    expect(file.stockOnHand(box.id).goodMilli).toBe(2000n);
    expect(file.stockOnHand(piece.id).goodMilli).toBe(6000n);
    file.breakAssembly(box.id, 1000n);
    expect(file.stockOnHand(piece.id).goodMilli).toBe(18_000n);
    expect(() => file.buildAssembly(box.id, 2000n)).toThrowError(/Building needs/);

    // Reopen: BOM versions round-trip.
    file.close();
    file = CompanyFile.open(books);
    expect(file.bomAt(box.id, '2026-07-01')!.components).toHaveLength(2);
  });

  it('service items reject stock; when_out_of_stock reacts to derived levels', () => {
    const labor = file.createItem({ name: 'Labor', currency: 'USD', unitPrice: 6000n, kind: 'service' });
    expect(() => file.adjustStock(labor.id, 1000n)).toThrowError(/no tracked stock/);
    expect(() => file.setItemStock(labor.id, false)).toThrowError(/no stock/);

    const gadget = file.createItem({
      name: 'Gadget', currency: 'USD', unitPrice: 4000n, kind: 'inventory', depositPolicy: 'when_out_of_stock',
    });
    const order = file.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: gadget.id, description: 'Gadget', quantityMilli: 1000n }],
    });
    expect(() => file.sendDocument(order.id)).toThrowError(/require a deposit/);
    file.adjustStock(gadget.id, 1000n, { reason: 'initial count' });
    file.sendDocument(order.id);
  });
});
