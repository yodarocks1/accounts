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
