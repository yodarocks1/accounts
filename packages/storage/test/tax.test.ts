import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyFile } from '../src/index.js';

let dir: string;
let file: CompanyFile;
let books: string;

const acme = { customerName: 'Acme LLC', accountNumber: 'A-100' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-tax-'));
  books = join(dir, 'books.sqlite');
  file = CompanyFile.create(books, { name: 'Test Co', baseCurrency: 'USD' });
});

afterEach(() => {
  file.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('auto-numbering persists (Tier 3)', () => {
  it('draws transactional numbers per kind and survives reopening', () => {
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n });
    const lines = [{ itemId: widget.id, description: 'Widget', quantityMilli: 1000n }];
    file.setNumberSequence('invoice', { prefix: 'INV-', next: 100, width: 5 });
    file.setNumberSequence('payment', { prefix: 'PMT-' });

    expect(file.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines }).number).toBe('INV-00100');
    expect(file.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines }).number).toBe('INV-00101');
    expect(file.recordPayment({ date: '2026-07-02', ...acme, amount: 100n }).number).toBe('PMT-0001');

    file.close();
    file = CompanyFile.open(books);
    expect(file.numberSequence('invoice')!.next).toBe(102);
    expect(file.createDocument({ type: 'invoice', date: '2026-07-01', ...acme, lines }).number).toBe('INV-00102');

    expect(() =>
      file.createDocument({ type: 'estimate', date: '2026-07-01', ...acme, lines }),
    ).toThrowError(/no sequence configured/);
  });
});

describe('sales tax persists (Tier 3)', () => {
  it('snapshots rates onto lines, taxes settlements, and posts the split', () => {
    file.setTaxRate({ code: 'TX', name: 'State tax', percentMilli: 8_250n });
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, taxCode: 'TX' });

    const ar = file.createAccount({ name: 'AR', type: 'asset', currency: 'USD', code: '1100' });
    const income = file.createAccount({ name: 'Sales', type: 'income', currency: 'USD', code: '4000' });
    const taxPayable = file.createAccount({ name: 'Sales Tax Payable', type: 'liability', currency: 'USD', code: '2200' });
    file.setPostingAccount('accounts_receivable', ar.id);
    file.setPostingAccount('sales_income', income.id);
    file.setPostingAccount('sales_tax_payable', taxPayable.id);

    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-1', date: '2026-07-01', ...acme,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(invoice.subtotal).toBe(10000n);
    expect(invoice.taxTotal).toBe(825n);
    expect(invoice.total).toBe(10825n);
    file.sendDocument(invoice.id);

    // Posting split: AR gross, income net, tax payable liability.
    const net = (code: string) => {
      const account = file.findAccountByCode(code)!;
      return file.trialBalance().rows.find((row) => row.accountId === account.id)?.net ?? 0n;
    };
    expect(net('1100')).toBe(10825n);
    expect(net('4000')).toBe(-10000n);
    expect(net('2200')).toBe(-825n);

    // Retroactive rate change: stored snapshot untouched.
    file.setTaxRate({ code: 'TX', percentMilli: 9_999n, effectiveFrom: '2026-01-01' });
    file.close();
    file = CompanyFile.open(books);
    const reloaded = file.viewDocument(invoice.id);
    expect(reloaded.taxTotal).toBe(825n);
    expect(reloaded.current.lines[0]!.taxPercentMilli).toBe(8250n);
    expect(file.invoiceSettlement(invoice.id).open).toBe(10825n);
  });

  it('tax-exempt parties suppress tax end to end', () => {
    file.setTaxRate({ code: 'TX', percentMilli: 8_250n });
    const widget = file.createItem({ name: 'Widget', currency: 'USD', unitPrice: 2500n, taxCode: 'TX' });
    const school = file.createParty({ name: 'District School', accountNumber: 'GOV-1', taxExempt: true });
    const invoice = file.createDocument({
      type: 'invoice', number: 'INV-2', date: '2026-07-01', partyId: school.id,
      lines: [{ itemId: widget.id, description: 'Widget', quantityMilli: 4000n }],
    });
    expect(invoice.taxTotal).toBe(0n);
    expect(invoice.total).toBe(10000n);
  });
});

describe('deposits persist (Tier 3)', () => {
  it('line-level prepayments, gates, and invoice transfer survive reopening', () => {
    const custom = file.createItem({ name: 'Custom job', currency: 'USD', unitPrice: 50_000n, depositPolicy: 'always' });
    const order = file.createDocument({
      type: 'sales_order', number: 'SO-D1', date: '2026-07-01', ...acme,
      deposit: { percentMilli: 30_000n }, // 30% of 500.00 = 150.00
      lines: [{ itemId: custom.id, description: 'Custom job', quantityMilli: 1000n, lineId: 'L1' }],
    });
    expect(order.current.depositRequiredMinor).toBe(15_000n);
    file.sendDocument(order.id);

    // Sending without a deposit request is gated by the item policy.
    const bare = file.createDocument({
      type: 'sales_order', number: 'SO-D2', date: '2026-07-01', ...acme,
      lines: [{ itemId: custom.id, description: 'Custom job', quantityMilli: 1000n }],
    });
    expect(() => file.sendDocument(bare.id)).toThrowError(/require a deposit before sending/);
    file.sendDocument(bare.id, { overrideDeposit: true });

    const payment = file.recordPayment({ number: 'PMT-D1', date: '2026-07-02', ...acme, amount: 20_000n });
    file.applyCredit({ sourceKind: 'payment', sourceId: payment.id, invoiceId: order.id, amount: 20_000n, lineId: 'L1' });

    file.close();
    file = CompanyFile.open(books);
    expect(file.depositHeld(order.id)).toBe(20_000n);
    expect(file.linePrepayments(order.id)[0]!.prepaid).toBe(20_000n);

    // Prepaid line cannot shrink below the prepayment.
    expect(() =>
      file.changeDocument(order.id, {
        kind: 'correction',
        lines: [{ itemId: custom.id, description: 'Custom job', quantityMilli: 300n, lineId: 'L1' }],
      }),
    ).toThrowError(/cannot shrink below/);

    // Convert and send: the prepayment transfers to the invoice.
    const invoice = file.convertDocument(order.id, { type: 'invoice', number: 'INV-D1', date: '2026-07-05' });
    file.sendDocument(invoice.id);
    expect(file.invoiceSettlement(invoice.id).paid).toBe(20_000n);
    expect(file.depositHeld(order.id)).toBe(0n);
  });
});
