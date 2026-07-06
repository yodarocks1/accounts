import { describe, expect, it } from 'vitest';
import { DocumentBook } from '../src/index.js';

function setUp() {
  const book = new DocumentBook();
  const piece = book.createItem({
    name: 'Piece', currency: 'USD', unitPrice: 300n, cost: 100n, kind: 'inventory',
  });
  const untracked = book.createItem({ name: 'Untracked', currency: 'USD', unitPrice: 500n });
  const labor = book.createItem({ name: 'Assembly labor', currency: 'USD', unitPrice: 6000n, cost: 2000n, kind: 'service' });
  return { book, piece, untracked, labor };
}

describe('item kinds (ADR 0014)', () => {
  it('service and inventory items reject the manual stock flag; non_inventory keeps it', () => {
    const { book, piece, untracked, labor } = setUp();
    expect(() => book.setItemStock(piece.id, false)).toThrowError(/record an adjustment instead/);
    expect(() => book.setItemStock(labor.id, false)).toThrowError(/no stock/);
    expect(book.setItemStock(untracked.id, false).inStock).toBe(false);
    // Services always read as in stock; inventory derives from on-hand (0 ⇒ out).
    expect(book.getItem(labor.id)!.inStock).toBe(true);
    expect(book.getItem(piece.id)!.inStock).toBe(false);
    book.adjustStock(piece.id, 5000n, { reason: 'initial count' });
    expect(book.getItem(piece.id)!.inStock).toBe(true);
  });
});

describe('stock ledger (ADR 0014)', () => {
  it('documents move stock on send, void, and quantity corrections', () => {
    const { book, piece } = setUp();
    const supplier = book.createParty({ name: 'Supplier Inc' });

    // Bill approval brings stock in.
    const bill = book.createDocument({
      type: 'bill', number: 'BILL-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 24_000n, lineId: 'L1' }],
    });
    expect(book.stockOnHand(piece.id).goodMilli).toBe(0n); // drafts move nothing
    book.sendDocument(bill.id);
    expect(book.stockOnHand(piece.id).goodMilli).toBe(24_000n);

    // Invoice send takes it out.
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-02', customerName: 'Acme LLC',
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 10_000n, lineId: 'S1' }],
    });
    book.sendDocument(invoice.id);
    expect(book.stockOnHand(piece.id).goodMilli).toBe(14_000n);

    // A correction that reduces the billed quantity writes the delta.
    book.changeDocument(bill.id, {
      kind: 'correction', reason: 'short shipped',
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 20_000n, lineId: 'L1' }],
    });
    expect(book.stockOnHand(piece.id).goodMilli).toBe(10_000n);

    // Returns land by condition: unopened → good, damaged → damaged.
    const memo = book.createDocument({
      type: 'credit_memo', number: 'CM-1', date: '2026-07-03', customerName: 'Acme LLC',
      lines: [
        { itemId: piece.id, description: 'Return (unopened)', quantityMilli: 2000n, unitPrice: 300n, returnCondition: 'unopened', sourceDocumentId: invoice.id, sourceLineId: 'S1' },
        { itemId: piece.id, description: 'Return (damaged)', quantityMilli: 1000n, unitPrice: 300n, returnCondition: 'damaged', sourceDocumentId: invoice.id, sourceLineId: 'S1' },
      ],
    });
    book.sendDocument(memo.id);
    expect(book.stockOnHand(piece.id)).toEqual({ goodMilli: 12_000n, damagedMilli: 1000n });

    // Voiding the invoice puts the sale back (as-of dating still works:
    // the correction carries the bill's own date, so 07-01 reads 20000).
    book.voidDocument(invoice.id);
    expect(book.stockOnHand(piece.id).goodMilli).toBe(22_000n);
    expect(book.stockOnHand(piece.id, '2026-07-01').goodMilli).toBe(20_000n);
  });

  it('sales may oversell (negative on-hand is a recorded fact)', () => {
    const { book, piece } = setUp();
    const invoice = book.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: piece.id, description: 'Piece', quantityMilli: 3000n }],
    });
    book.sendDocument(invoice.id);
    expect(book.stockOnHand(piece.id).goodMilli).toBe(-3000n);
  });

  it('adjustments, damage, and dispositions respect bounds, policy, and gates', () => {
    const { book, piece } = setUp();
    const food = book.createItem({
      name: 'Perishable', currency: 'USD', unitPrice: 700n, kind: 'inventory',
      dispositions: ['recycle', 'trash'], // never resold
    });
    book.adjustStock(piece.id, 10_000n, { reason: 'initial count' });
    book.adjustStock(food.id, 5000n, { reason: 'initial count' });

    // Damage is bounded by good on-hand.
    expect(() => book.markDamaged(piece.id, 11_000n)).toThrowError(/INSUFFICIENT|good on hand/);
    book.markDamaged(piece.id, 3000n, { reason: 'forklift' });
    expect(book.stockOnHand(piece.id)).toEqual({ goodMilli: 7000n, damagedMilli: 3000n });

    // Restock puts it back; recycle/trash write it off.
    book.disposeStock(piece.id, 1000n, 'restock');
    book.disposeStock(piece.id, 1000n, 'trash');
    expect(book.stockOnHand(piece.id)).toEqual({ goodMilli: 8000n, damagedMilli: 1000n });
    expect(() => book.disposeStock(piece.id, 5000n, 'trash')).toThrowError(/damaged on hand/);

    // Per-item disposition policy: food cannot be restocked.
    book.markDamaged(food.id, 2000n);
    expect(() => book.disposeStock(food.id, 1000n, 'restock')).toThrowError(/does not allow the "restock"/);
    book.disposeStock(food.id, 2000n, 'recycle');

    // Write-offs are approvable: negative adjustments and recycle/trash.
    book.setApprovalPolicy(['stock_write_off']);
    expect(() => book.adjustStock(piece.id, -1000n, { reason: 'shrinkage' })).toThrowError(/requires an approver/);
    book.adjustStock(piece.id, -1000n, { reason: 'shrinkage', approvedBy: 'owner' });
    expect(() => book.disposeStock(piece.id, 1000n, 'trash')).toThrowError(/requires an approver/);
    book.disposeStock(piece.id, 1000n, 'restock'); // restock is not a write-off
  });
});

describe('assemblies (ADR 0014)', () => {
  it('derives additive costs through nested BOMs, plus assembly cost', () => {
    const { book, piece, labor } = setUp();
    // A box is 12 pieces + 0.25 labor hours + 0.30 packaging cost.
    const box = book.createItem({ name: 'Box of 12', currency: 'USD', unitPrice: 3000n, kind: 'inventory' });
    book.setBom({
      itemId: box.id, assemblyCostMinor: 30n,
      components: [
        { componentItemId: piece.id, quantityMilli: 12_000n },
        { componentItemId: labor.id, quantityMilli: 250n },
      ],
    });
    // 12 × 1.00 + 0.25 × 20.00 + 0.30 = 17.30
    expect(book.costAt(box.id, '2026-07-01')).toBe(1730n);

    // Nested: a pallet of 4 boxes; recursion adds up.
    const pallet = book.createItem({ name: 'Pallet', currency: 'USD', unitPrice: 15_000n, kind: 'inventory' });
    book.setBom({ itemId: pallet.id, components: [{ componentItemId: box.id, quantityMilli: 4000n }] });
    expect(book.costAt(pallet.id, '2026-07-01')).toBe(6920n);

    // A piece cost change flows through everything…
    book.setCost(piece.id, 150n, '2026-08-01');
    expect(book.costAt(box.id, '2026-08-01')).toBe(2330n);
    expect(book.costAt(box.id, '2026-07-01')).toBe(1730n); // history intact

    // …but an explicit cost on the assembly overrides derivation.
    book.setCost(box.id, 2000n, '2026-08-01');
    expect(book.costAt(box.id, '2026-08-15')).toBe(2000n);

    // Cycles are rejected.
    expect(() =>
      book.setBom({ itemId: piece.id, components: [{ componentItemId: pallet.id, quantityMilli: 1n }] }),
    ).toThrowError(/contain itself/);
  });

  it('build consumes components and break returns them, bounded by stock', () => {
    const { book, piece, labor } = setUp();
    const box = book.createItem({ name: 'Box of 12', currency: 'USD', unitPrice: 3000n, kind: 'inventory' });
    book.setBom({
      itemId: box.id,
      components: [
        { componentItemId: piece.id, quantityMilli: 12_000n },
        { componentItemId: labor.id, quantityMilli: 250n }, // services move no stock
      ],
    });
    book.adjustStock(piece.id, 30_000n, { reason: 'initial count' });

    expect(() => book.buildAssembly(box.id, 3000n)).toThrowError(/needs 36000/);
    book.buildAssembly(box.id, 2000n);
    expect(book.stockOnHand(box.id).goodMilli).toBe(2000n);
    expect(book.stockOnHand(piece.id).goodMilli).toBe(6000n);

    // Break one box back into pieces to sell singles.
    book.breakAssembly(box.id, 1000n);
    expect(book.stockOnHand(box.id).goodMilli).toBe(1000n);
    expect(book.stockOnHand(piece.id).goodMilli).toBe(18_000n);
    expect(() => book.breakAssembly(box.id, 5000n)).toThrowError(/only 1000/);
  });

  it('derived costs feed the existing pricing machinery (free items, below-cost)', () => {
    const { book, piece } = setUp();
    const box = book.createItem({ name: 'Box', currency: 'USD', unitPrice: 3000n, kind: 'inventory' });
    book.setBom({ itemId: box.id, components: [{ componentItemId: piece.id, quantityMilli: 12_000n }] });
    // Below-cost gate sees the derived 12.00 cost.
    book.setApprovalPolicy(['below_cost_sale']);
    expect(() =>
      book.createDocument({
        type: 'invoice', number: 'INV-9', date: '2026-07-01', customerName: 'Acme LLC',
        lines: [{ itemId: box.id, description: 'Box', quantityMilli: 1000n, unitPrice: 1100n }],
      }),
    ).toThrowError(/requires an approver/);
  });

  it('when_out_of_stock deposits now react to real levels', () => {
    const { book } = setUp();
    const gadget = book.createItem({
      name: 'Gadget', currency: 'USD', unitPrice: 4000n, kind: 'inventory', depositPolicy: 'when_out_of_stock',
    });
    const order = book.createDocument({
      type: 'sales_order', number: 'SO-1', date: '2026-07-01', customerName: 'Acme LLC',
      lines: [{ itemId: gadget.id, description: 'Gadget', quantityMilli: 1000n }],
    });
    // Zero on hand ⇒ deposit required.
    expect(() => book.sendDocument(order.id)).toThrowError(/require a deposit/);
    book.adjustStock(gadget.id, 1000n, { reason: 'initial count' });
    book.sendDocument(order.id);
  });
});
