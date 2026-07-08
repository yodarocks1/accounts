import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-poprepay-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('purchase prepayments persist (ADR 0016)', () => {
  it('supplier prepayment percent round-trips and gates PO send', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc', accountNumber: 'S-1' });
    file.recordSupplierInfo({
      partyId: supplier.id, asOf: '2026-01-01', currency: 'USD',
      prepaymentPercentMilli: 50_000n,
      items: [{ itemId: widget.id, unitCost: 1000n }],
    });
    file.close();
    file = CompanyFile.open(books);
    expect(file.supplierInfo(supplier.id)!.prepaymentPercentMilli).toBe(50_000n);

    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-1', date: '2026-07-01', partyId: supplier.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }],
    });
    expect(() => file.sendDocument(po.id)).toThrowError(/must cover at least 5000/);

    const ok = file.createDocument({
      type: 'purchase_order', number: 'PO-2', date: '2026-07-01', partyId: supplier.id,
      deposit: { percentMilli: 50_000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }],
    });
    file.sendDocument(ok.id);
    expect(file.viewDocument(ok.id).status).toBe('sent');
  });

  it('deposit is held on the PO, transfers to the bill through a receipt, and survives reopen', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, cost: 1000n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc', accountNumber: 'S-1' });
    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-3', date: '2026-07-01', partyId: supplier.id,
      deposit: { amountMinor: 3000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }],
    });
    file.sendDocument(po.id);
    file.recordPayment({
      number: 'PMT-1', direction: 'out', date: '2026-07-02', partyId: supplier.id, amount: 3000n,
      applications: [{ invoiceId: po.id, amount: 3000n }],
    });
    expect(file.depositHeld(po.id)).toBe(3000n);

    const receipt = file.convertDocument(po.id, { type: 'receipt', number: 'RCT-1', date: '2026-07-05' });
    file.sendDocument(receipt.id);
    const bill = file.convertDocument(receipt.id, { type: 'bill', number: 'BILL-1', date: '2026-07-10' });
    file.sendDocument(bill.id);

    file.close();
    file = CompanyFile.open(books);
    expect(file.depositHeld(po.id)).toBe(0n);
    expect(file.invoiceSettlement(bill.id)).toMatchObject({ paid: 3000n, open: 7000n, status: 'partial' });
  });

  it('inbound payments cannot deposit against a purchase order', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, kind: 'inventory' });
    const supplier = file.createParty({ name: 'Supplier Inc', accountNumber: 'S-1' });
    const po = file.createDocument({
      type: 'purchase_order', number: 'PO-4', date: '2026-07-01', partyId: supplier.id,
      deposit: { amountMinor: 1000n },
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 10_000n, unitPrice: 1000n }],
    });
    file.sendDocument(po.id);
    const inbound = file.recordPayment({ number: 'PMT-2', date: '2026-07-02', partyId: supplier.id, amount: 1000n });
    expect(() =>
      file.applyCredit({ sourceKind: 'payment', sourceId: inbound.id, invoiceId: po.id, amount: 1000n }),
    ).toThrowError(/settled by outbound payments/);
  });
});
