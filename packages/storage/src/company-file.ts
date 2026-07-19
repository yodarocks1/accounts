import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  LedgerError,
  appliedFromSource,
  appliedToInvoice,
  buildConversionLines,
  buildReturnLine,
  computeDocumentLinks,
  computeFulfillment,
  computeRateReview,
  computeRateSuggestions,
  computeStatement,
  computeTrialBalance,
  computeAgingSummary,
  bankDedupeKey,
  matchBankTransactions,
  parseBankCsv,
  type BankMatchSuggestion,
  type BankTransaction,
  PluginHost,
  type PluginManifest,
  computeBalanceSheet,
  computeProfitAndLoss,
  type AgingSummary,
  type BalanceSheet,
  type InventorySummary,
  type ProfitAndLoss,
  currencyExponent,
  defaultAllowBelowCost,
  deriveTags,
  planChargeCorrection,
  planPosting,
  resolveRateForQuantity,
  revisionGrandTotal,
  customerLineTotal,
  revisionTax,
  revisionTotal,
  settle,
  validateApplication,
  resolveDocumentLines,
  resolveRevisionKind,
  validateConversion,
  validateLineConsumption,
  validateNewEntry,
  validateReturnQuantities,
  validateTermsDays,
  validateRevisionContent,
  viewDocument,
  type Account,
  type ConversionSpec,
  type DocumentChanges,
  type DocumentLine,
  type DocumentRecord,
  type DocumentRevision,
  type DocumentTag,
  type DocumentLinks,
  type DocumentType,
  type DocumentView,
  type Item,
  type ItemCatalog,
  type ItemPrice,
  type JournalEntry,
  type LineClosure,
  type LineFulfillment,
  type NewAccount,
  type NewDocument,
  type NewItem,
  type NewJournalEntry,
  type NewLineClosure,
  type NewReturn,
  type PriceKind,
  type PostingRole,
  type CustomerQuery,
  type CustomerRate,
  type RateTier,
  type RateReviewEntry,
  type Party,
  type NewParty,
  type PartyName,
  type ReturnPolicy,
  type ReturnCondition,
  type ApprovalAction,
  type TaxRate,
  type NewTaxRate,
  type DepositPolicy,
  type SequenceKind,
  type NumberSequence,
  type NewNumberSequence,
  formatSequenceNumber,
  isPurchaseType,
  appliedToLine,
  buildSupplierInfo,
  computePurchaseCoverage,
  computePurchaseReadiness,
  depositRequiringLines,
  lineGrossTotal,
  resolveDepositRequest,
  specialOrderDepositFloor,
  purchaseDepositFloor,
  type NewSupplierInfo,
  type PurchaseCoverageLine,
  type PurchaseReadiness,
  type ShippingEstimate,
  type SupplierInfo,
  type SupplierItemTerm,
  type NewCustomerRate,
  type SpecialRateSuggestion,
  type AgingRule,
  type Statement,
  type NewCashTransaction,
  type TrialBalance,
  componentNeed,
  diffStockEffects,
  valueInventory,
  planDocumentPosting,
  DISPOSITIONS,
  ITEM_KINDS,
  stockEffects,
  type ItemValuation,
  type DocumentPostingKind,
  type DocumentPostingAmounts,
  type Disposition,
  type ItemBom,
  type ItemKind,
  type NewItemBom,
  type StockCondition,
  type StockEffect,
  type StockLevel,
  type StockMovement,
  type StockMovementKind,
  divRoundHalf,
  QUANTITY_SCALE,
  type Payment,
  type NewPayment,
  type CreditApplication,
  type NewApplication,
  type InvoiceSettlement,
} from '@accounts/core';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export interface CompanyInfo {
  name: string;
  baseCurrency: string;
}

interface AccountRow {
  id: string;
  code: string | null;
  name: string;
  type: Account['type'];
  currency: string;
  parent_id: string | null;
  archived: bigint;
}

interface EntryRow {
  id: string;
  seq: bigint;
  date: string;
  memo: string | null;
  reverses_entry_id: string | null;
}

interface LineRow {
  entry_id: string;
  line_no: bigint;
  account_id: string;
  side: 'debit' | 'credit';
  amount: bigint;
  currency: string;
  memo: string | null;
}

/**
 * One business = one SQLite file (PLAN.md §3.3). All writes are transactional,
 * audit-logged, and validated through @accounts/core before touching disk; the
 * schema's triggers make posted history immutable even against raw SQL.
 */
export class CompanyFile implements ItemCatalog {
  private constructor(
    private readonly db: Database.Database,
    private readonly actor: string,
  ) {}

  static create(path: string, info: CompanyInfo, actor = 'local'): CompanyFile {
    currencyExponent(info.baseCurrency);
    if (!info.name.trim()) {
      throw new LedgerError('EMPTY_ENTRY', 'Company name must not be empty');
    }
    const db = CompanyFile.openDatabase(path);
    const existing = db.prepare(`SELECT count(*) AS n FROM sqlite_master`).get() as { n: bigint };
    if (existing.n > 0n) {
      db.close();
      throw new LedgerError('EMPTY_ENTRY', `Refusing to initialize non-empty database: ${path}`);
    }
    db.transaction(() => {
      for (const migration of MIGRATIONS) db.exec(migration);
      const setMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`);
      setMeta.run('schema_version', String(SCHEMA_VERSION));
      setMeta.run('company_name', info.name.trim());
      setMeta.run('base_currency', info.baseCurrency);
      setMeta.run('created_at', new Date().toISOString());
    })();
    CompanyFile.enableForeignKeys(db);
    const file = new CompanyFile(db, actor);
    file.audit('company.created', 'company', 'company', { name: info.name.trim() });
    return file;
  }

  static open(path: string, actor = 'local'): CompanyFile {
    const db = CompanyFile.openDatabase(path, true);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.close();
      throw new LedgerError('EMPTY_ENTRY', `Not a company file: ${path}`);
    }
    const fileVersion = Number(row.value);
    if (fileVersion > SCHEMA_VERSION) {
      db.close();
      throw new LedgerError('EMPTY_ENTRY', `Company file is schema v${row.value}; this build supports v${SCHEMA_VERSION}`);
    }
    if (fileVersion < SCHEMA_VERSION) {
      // ADR 0009 part 4: snapshot the file before touching it. VACUUM INTO
      // produces a consistent copy even under WAL.
      let backupPath = `${path}.v${fileVersion}.backup`;
      if (existsSync(backupPath)) backupPath = `${path}.v${fileVersion}.${Date.now()}.backup`;
      db.prepare(`VACUUM INTO ?`).run(backupPath);
      // Migrations run with foreign keys off (table rebuilds require it);
      // integrity is verified afterwards, before FKs come back on.
      db.transaction(() => {
        for (const migration of MIGRATIONS.slice(fileVersion)) db.exec(migration);
        db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION));
      })();
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        db.close();
        throw new LedgerError('EMPTY_ENTRY', `Migration left ${violations.length} foreign-key violations; file untouched copy recommended`);
      }
    }
    CompanyFile.enableForeignKeys(db);
    return new CompanyFile(db, actor);
  }

  private static openDatabase(path: string, mustExist = false): Database.Database {
    const db = new Database(path, { fileMustExist: mustExist });
    db.pragma('journal_mode = WAL');
    // Off until after migrations: table rebuilds (v4) must move rows freely.
    // enableForeignKeys() turns enforcement on before any business writes.
    db.pragma('foreign_keys = OFF');
    db.defaultSafeIntegers(true); // INTEGER comes back as bigint, never float
    return db;
  }

  private static enableForeignKeys(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
  }

  close(): void {
    this.db.close();
  }

  info(): CompanyInfo {
    const get = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
    return {
      name: (get.get('company_name') as { value: string }).value,
      baseCurrency: (get.get('base_currency') as { value: string }).value,
    };
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  createAccount(input: NewAccount): Account {
    currencyExponent(input.currency);
    if (!input.name.trim()) {
      throw new LedgerError('UNKNOWN_ACCOUNT', 'Account name must not be empty');
    }
    if (input.parentId !== undefined && !this.getAccount(input.parentId)) {
      throw new LedgerError('UNKNOWN_ACCOUNT', `No such parent account: ${input.parentId}`);
    }
    const account: Account = {
      id: randomUUID(),
      code: input.code ?? null,
      name: input.name.trim(),
      type: input.type,
      currency: input.currency,
      parentId: input.parentId ?? null,
      archived: false,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO accounts (id, code, name, type, currency, parent_id, archived)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(account.id, account.code, account.name, account.type, account.currency, account.parentId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: accounts.code')) {
        throw new LedgerError('DUPLICATE_ACCOUNT_CODE', `Account code already in use: ${account.code}`);
      }
      throw error;
    }
    this.audit('account.created', 'account', account.id, { name: account.name, type: account.type });
    return account;
  }

  getAccount(id: string): Account | undefined {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  findAccountByCode(code: string): Account | undefined {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE code = ?`).get(code) as AccountRow | undefined;
    return row ? toAccount(row) : undefined;
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare(`SELECT * FROM accounts ORDER BY code IS NULL, code, name`).all() as AccountRow[];
    return rows.map(toAccount);
  }

  accountsById(): Map<string, Account> {
    return new Map(this.listAccounts().map((account) => [account.id, account]));
  }

  // ── Journal ─────────────────────────────────────────────────────────────

  postEntry(input: NewJournalEntry): JournalEntry {
    const accounts = this.accountsById();
    if (input.reversesEntryId !== undefined) {
      const target = this.db
        .prepare(`SELECT id FROM journal_entries WHERE id = ?`)
        .get(input.reversesEntryId);
      if (!target) {
        throw new LedgerError('UNKNOWN_ENTRY', `No such entry: ${input.reversesEntryId}`);
      }
      const existing = this.db
        .prepare(`SELECT id FROM journal_entries WHERE reverses_entry_id = ?`)
        .get(input.reversesEntryId);
      if (existing) {
        throw new LedgerError('ALREADY_REVERSED', `Entry already reversed: ${input.reversesEntryId}`);
      }
    }
    validateNewEntry(input, accounts);

    const id = randomUUID();
    const insertEntry = this.db.prepare(
      `INSERT INTO journal_entries (id, seq, date, memo, reverses_entry_id)
       VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM journal_entries), ?, ?, ?)`,
    );
    const insertLine = this.db.prepare(
      `INSERT INTO journal_lines (entry_id, line_no, account_id, side, amount, currency, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insertEntry.run(id, input.date, input.memo ?? null, input.reversesEntryId ?? null);
      input.lines.forEach((line, index) => {
        insertLine.run(id, index + 1, line.accountId, line.side, line.amount, line.currency, line.memo ?? null);
      });
      this.audit('journal.posted', 'journal_entry', id, {
        date: input.date,
        lines: input.lines.length,
        reverses: input.reversesEntryId ?? null,
      });
    })();
    return this.getEntry(id)!;
  }

  reverseEntry(entryId: string, date: string, memo?: string): JournalEntry {
    const original = this.getEntry(entryId);
    if (!original) {
      throw new LedgerError('UNKNOWN_ENTRY', `No such entry: ${entryId}`);
    }
    return this.postEntry({
      date,
      memo: memo ?? `Reversal of ${entryId}`,
      reversesEntryId: entryId,
      lines: original.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side === 'debit' ? 'credit' : 'debit',
        amount: line.amount,
        currency: line.currency,
      })),
    });
  }

  getEntry(id: string): JournalEntry | undefined {
    const entry = this.db.prepare(`SELECT * FROM journal_entries WHERE id = ?`).get(id) as EntryRow | undefined;
    if (!entry) return undefined;
    const lines = this.db
      .prepare(`SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no`)
      .all(id) as LineRow[];
    return toEntry(entry, lines);
  }

  listEntries(): JournalEntry[] {
    const entries = this.db.prepare(`SELECT * FROM journal_entries ORDER BY seq`).all() as EntryRow[];
    const lines = this.db
      .prepare(`SELECT * FROM journal_lines ORDER BY entry_id, line_no`)
      .all() as LineRow[];
    const byEntry = new Map<string, LineRow[]>();
    for (const line of lines) {
      const bucket = byEntry.get(line.entry_id);
      if (bucket) bucket.push(line);
      else byEntry.set(line.entry_id, [line]);
    }
    return entries.map((entry) => toEntry(entry, byEntry.get(entry.id) ?? []));
  }

  /**
   * SQL-side trial balance. The test suite cross-checks this against
   * @accounts/core's computeTrialBalance over the same data.
   */
  trialBalance(asOf?: string): TrialBalance {
    return computeTrialBalance(this.listEntriesUpTo(asOf), this.accountsById(), asOf);
  }

  /** Income vs expense over a period (ADR 0017); pure read, never stored. */
  profitAndLoss(from: string, to: string): ProfitAndLoss {
    return computeProfitAndLoss(this.listEntries(), this.accountsById(), from, to);
  }

  /** Assets vs liabilities + equity (incl. derived retained earnings) (ADR 0017). */
  balanceSheet(asOf: string): BalanceSheet {
    return computeBalanceSheet(this.listEntries(), this.accountsById(), asOf);
  }

  /** Who owes us, bucketed by age across the whole book (ADR 0017). */
  arAging(asOf: string): AgingSummary {
    return this.agingSummary(asOf, 'customer');
  }

  /** Whom we owe, bucketed by age across the whole book (ADR 0017). */
  apAging(asOf: string): AgingSummary {
    return this.agingSummary(asOf, 'supplier');
  }

  private agingSummary(asOf: string, side: 'customer' | 'supplier'): AgingSummary {
    const types = side === 'supplier' ? ['bill', 'vendor_credit'] : ['invoice', 'credit_memo'];
    const records = types.flatMap((type) => this.listDocumentRecords(type as DocumentType));
    return computeAgingSummary(records, this.listPayments(), this.listApplications(), asOf, side);
  }

  /** Per-item FIFO quantity and value for every tracked item (ADR 0017). */
  inventorySummary(asOf?: string): InventorySummary {
    const rows = this.listItems()
      .filter((item) => item.kind === 'inventory')
      .map((item) => {
        const valuation = this.itemValuation(item.id, asOf);
        return { itemId: item.id, name: item.name, quantityMilli: valuation.quantityMilli, valueMinor: valuation.valueMinor };
      });
    return { asOf: asOf ?? null, rows, totalValueMinor: rows.reduce((sum, row) => sum + row.valueMinor, 0n) };
  }

  /** Per-account debit/credit sums computed by SQLite, for cross-checking. */
  trialBalanceSql(asOf?: string): { accountId: string; debits: bigint; credits: bigint }[] {
    const rows = this.db
      .prepare(
        `SELECT l.account_id AS accountId,
                coalesce(sum(CASE WHEN l.side = 'debit' THEN l.amount END), 0) AS debits,
                coalesce(sum(CASE WHEN l.side = 'credit' THEN l.amount END), 0) AS credits
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         WHERE ? IS NULL OR e.date <= ?
         GROUP BY l.account_id`,
      )
      .all(asOf ?? null, asOf ?? null) as { accountId: string; debits: bigint; credits: bigint }[];
    return rows;
  }

  private listEntriesUpTo(asOf?: string): JournalEntry[] {
    if (asOf === undefined) return this.listEntries();
    return this.listEntries().filter((entry) => entry.date <= asOf);
  }

  // ── Parties (Tier 1, ADR 0008 part 4) ───────────────────────────────────

  createParty(input: NewParty): Party {
    if (!input.name.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Party name must not be empty');
    }
    const party: Party = {
      id: randomUUID(),
      name: input.name.trim(),
      accountNumber: input.accountNumber ?? null,
      termsDays: validateTermsDays(input.termsDays) ?? null,
      taxExempt: input.taxExempt ?? false,
      createdAt: new Date().toISOString(),
    };
    this.db.transaction(() => {
      try {
        this.db
          .prepare(`INSERT INTO parties (id, account_number, terms_days, tax_exempt, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(party.id, party.accountNumber, party.termsDays, party.taxExempt ? 1 : 0, party.createdAt);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: parties.account_number')) {
          throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Account number already in use: ${party.accountNumber}`);
        }
        throw error;
      }
      this.db
        .prepare(`INSERT INTO party_names (party_id, name_seq, name, at) VALUES (?, 1, ?, ?)`)
        .run(party.id, party.name, party.createdAt);
      this.audit('party.created', 'party', party.id, { name: party.name, accountNumber: party.accountNumber });
    })();
    return party;
  }

  /** Renames are events: history is kept, documents keep their snapshots. */
  renameParty(id: string, name: string): Party {
    const party = this.requireParty(id);
    if (!name.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Party name must not be empty');
    }
    this.db.transaction(() => {
      const next = this.db
        .prepare(`SELECT coalesce(max(name_seq), 0) + 1 AS seq FROM party_names WHERE party_id = ?`)
        .get(id) as { seq: bigint };
      this.db
        .prepare(`INSERT INTO party_names (party_id, name_seq, name, at) VALUES (?, ?, ?, ?)`)
        .run(id, next.seq, name.trim(), new Date().toISOString());
      this.audit('party.renamed', 'party', id, { from: party.name, to: name.trim() });
    })();
    return { ...party, name: name.trim() };
  }

  getParty(id: string): Party | undefined {
    const row = this.db
      .prepare(
        `SELECT p.id, p.account_number AS accountNumber, p.terms_days AS termsDays, p.tax_exempt AS taxExempt, p.created_at AS createdAt,
                (SELECT name FROM party_names WHERE party_id = p.id ORDER BY name_seq DESC LIMIT 1) AS name
         FROM parties p WHERE p.id = ?`,
      )
      .get(id) as { id: string; accountNumber: string | null; termsDays: bigint | null; taxExempt: bigint; createdAt: string; name: string } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      accountNumber: row.accountNumber,
      termsDays: row.termsDays === null ? null : Number(row.termsDays),
      taxExempt: row.taxExempt === 1n,
      createdAt: row.createdAt,
    };
  }

  /** All parties, name order — the supplier/customer picker's read (ADR 0021). */
  listParties(): Party[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.account_number AS accountNumber, p.terms_days AS termsDays, p.tax_exempt AS taxExempt, p.created_at AS createdAt,
                (SELECT name FROM party_names WHERE party_id = p.id ORDER BY name_seq DESC LIMIT 1) AS name
         FROM parties p ORDER BY name`,
      )
      .all() as { id: string; accountNumber: string | null; termsDays: bigint | null; taxExempt: bigint; createdAt: string; name: string }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      accountNumber: row.accountNumber,
      termsDays: row.termsDays === null ? null : Number(row.termsDays),
      taxExempt: row.taxExempt === 1n,
      createdAt: row.createdAt,
    }));
  }

  partyNameHistory(id: string): PartyName[] {
    const rows = this.db
      .prepare(`SELECT name_seq AS nameSeq, name, at FROM party_names WHERE party_id = ? ORDER BY name_seq`)
      .all(id) as { nameSeq: bigint; name: string; at: string }[];
    return rows.map((row) => ({ ...row, nameSeq: Number(row.nameSeq) }));
  }

  findPartyByAccountNumber(accountNumber: string): Party | undefined {
    const row = this.db.prepare(`SELECT id FROM parties WHERE account_number = ?`).get(accountNumber) as
      | { id: string }
      | undefined;
    return row ? this.getParty(row.id) : undefined;
  }

  private requireParty(id: string): Party {
    const party = this.getParty(id);
    if (!party) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such party: ${id}`);
    }
    return party;
  }

  /** Effective customer fields: explicit values win, party supplies defaults. */
  private resolveCustomer(input: {
    partyId?: string;
    customerName?: string;
    accountNumber?: string;
    termsDays?: number;
    taxExempt?: boolean;
  }): {
    partyId: string | null;
    customerName: string;
    accountNumber?: string;
    termsDays?: number;
    taxExempt: boolean;
  } {
    const party = input.partyId !== undefined ? this.requireParty(input.partyId) : undefined;
    const customerName = input.customerName ?? party?.name;
    if (customerName === undefined || !customerName.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Every transaction must carry a customer name (ADR 0006)');
    }
    const accountNumber = input.accountNumber ?? party?.accountNumber ?? undefined;
    const termsDays = validateTermsDays(input.termsDays) ?? party?.termsDays ?? undefined;
    return {
      partyId: party?.id ?? null,
      customerName: customerName.trim(),
      ...(accountNumber !== undefined ? { accountNumber } : {}),
      ...(termsDays !== undefined ? { termsDays } : {}),
      taxExempt: input.taxExempt ?? party?.taxExempt ?? false,
    };
  }

  /** Statement resolved through the party's identity, with free-text fallback. */
  statementForParty(partyId: string, asOf: string, rules?: readonly AgingRule[]): Statement {
    const party = this.requireParty(partyId);
    return this.statement(
      {
        partyId,
        customerName: party.name,
        ...(party.accountNumber !== null ? { accountNumber: party.accountNumber } : {}),
      },
      asOf,
      rules,
    );
  }

  // ── Items & price history (ADR 0004) ────────────────────────────────────

  createItem(input: NewItem): Item {
    currencyExponent(input.currency);
    if (!input.name.trim()) {
      throw new LedgerError('UNKNOWN_ITEM', 'Item name must not be empty');
    }
    const kind = input.kind ?? 'non_inventory';
    if (!ITEM_KINDS.includes(kind)) {
      throw new LedgerError('INVALID_DOCUMENT', `Invalid item kind: ${String(kind)}`);
    }
    for (const disposition of input.dispositions ?? []) {
      if (!DISPOSITIONS.includes(disposition)) {
        throw new LedgerError('INVALID_DOCUMENT', `Invalid disposition: ${String(disposition)}`);
      }
    }
    const item: Item = {
      id: randomUUID(),
      name: input.name.trim(),
      currency: input.currency,
      taxCode: input.taxCode ?? null,
      depositPolicy: input.depositPolicy ?? 'never',
      kind,
      dispositions: input.dispositions ?? [...DISPOSITIONS],
      inStock: input.inStock ?? true,
    };
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO items (id, name, currency, tax_code, deposit_policy, in_stock, kind, dispositions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          item.id,
          item.name,
          item.currency,
          item.taxCode,
          item.depositPolicy,
          item.inStock ? 1 : 0,
          item.kind,
          input.dispositions !== undefined ? JSON.stringify(input.dispositions) : null,
        );
      this.insertPrice(item.id, 'sale', input.unitPrice, input.effectiveFrom ?? '0000-01-01');
      if (input.cost !== undefined) {
        this.insertPrice(item.id, 'cost', input.cost, input.effectiveFrom ?? '0000-01-01');
      }
      this.audit('item.created', 'item', item.id, { name: item.name, currency: item.currency });
    })();
    return item;
  }

  getItem(id: string): Item | undefined {
    interface ItemRow {
      id: string;
      name: string;
      currency: string;
      tax_code: string | null;
      deposit_policy: DepositPolicy;
      in_stock: bigint;
      kind: ItemKind;
      dispositions: string | null;
    }
    const row = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    if (!row) return undefined;
    // inStock: manual for non_inventory, derived for inventory, true for services.
    const inStock =
      row.kind === 'inventory'
        ? this.stockOnHand(id).goodMilli > 0n
        : row.kind === 'service' || row.in_stock === 1n;
    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      taxCode: row.tax_code,
      depositPolicy: row.deposit_policy,
      kind: row.kind,
      dispositions: row.dispositions !== null ? (JSON.parse(row.dispositions) as Disposition[]) : [...DISPOSITIONS],
      inStock,
    };
  }

  listItems(): Item[] {
    const rows = this.db.prepare(`SELECT id FROM items ORDER BY name`).all() as { id: string }[];
    return rows.map((row) => this.getItem(row.id)!);
  }

  /** Manual stock flag for non_inventory items (ADR 0010 part 3 / ADR 0014). */
  setItemStock(itemId: string, inStock: boolean): Item {
    const item = this.getItem(itemId);
    if (!item) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (item.kind === 'inventory') {
      throw new LedgerError('INVALID_DOCUMENT', 'Stock of inventory items is tracked; record an adjustment instead');
    }
    if (item.kind === 'service') {
      throw new LedgerError('INVALID_DOCUMENT', 'Service items have no stock');
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE items SET in_stock = ? WHERE id = ?`).run(inStock ? 1 : 0, itemId);
      this.audit('item.stock_set', 'item', itemId, { inStock });
    })();
    return this.getItem(itemId)!;
  }

  // ── Auto-numbering (ADR 0010 part 2) ─────────────────────────────────────

  setNumberSequence(kind: SequenceKind, input: NewNumberSequence): NumberSequence {
    const sequence: NumberSequence = {
      kind,
      prefix: input.prefix,
      next: input.next ?? 1,
      width: input.width ?? 4,
    };
    if (!Number.isInteger(sequence.next) || sequence.next < 1 || !Number.isInteger(sequence.width) || sequence.width < 1) {
      throw new LedgerError('INVALID_DOCUMENT', 'Sequence next/width must be positive integers');
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO number_sequences (kind, prefix, next_value, width) VALUES (?, ?, ?, ?)
           ON CONFLICT(kind) DO UPDATE SET prefix = excluded.prefix, next_value = excluded.next_value, width = excluded.width`,
        )
        .run(kind, sequence.prefix, sequence.next, sequence.width);
      this.audit('sequence.set', 'number_sequence', kind, { prefix: sequence.prefix, next: sequence.next, width: sequence.width });
    })();
    return sequence;
  }

  numberSequence(kind: SequenceKind): NumberSequence | undefined {
    const row = this.db
      .prepare(`SELECT prefix, next_value AS next, width FROM number_sequences WHERE kind = ?`)
      .get(kind) as { prefix: string; next: bigint; width: bigint } | undefined;
    if (!row) return undefined;
    return { kind, prefix: row.prefix, next: Number(row.next), width: Number(row.width) };
  }

  /** Draw and consume the next number (call inside the insert transaction). */
  private drawNumber(kind: SequenceKind): string {
    const sequence = this.numberSequence(kind);
    if (!sequence) {
      throw new LedgerError('INVALID_DOCUMENT', `No number provided and no sequence configured for ${kind}`);
    }
    this.db.prepare(`UPDATE number_sequences SET next_value = next_value + 1 WHERE kind = ?`).run(kind);
    return formatSequenceNumber(sequence, sequence.next);
  }

  // ── Tax rates (ADR 0010) ─────────────────────────────────────────────────

  /** Append a tax rate; existing documents keep their snapshots. */
  setTaxRate(input: NewTaxRate): TaxRate {
    if (!input.code.trim()) {
      throw new LedgerError('UNKNOWN_TAX_CODE', 'Tax code must not be empty');
    }
    if (input.percentMilli < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Tax rates must not be negative');
    }
    const rate = {
      code: input.code.trim(),
      name: input.name ?? input.code.trim(),
      percentMilli: input.percentMilli,
      effectiveFrom: input.effectiveFrom ?? '0000-01-01',
      at: new Date().toISOString(),
    };
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(`INSERT INTO tax_rates (code, name, percent_milli, effective_from, at) VALUES (?, ?, ?, ?, ?)`)
        .run(rate.code, rate.name, rate.percentMilli, rate.effectiveFrom, rate.at);
      seq = Number(result.lastInsertRowid);
      this.audit('tax.rate_set', 'tax_rate', rate.code, {
        percentMilli: rate.percentMilli.toString(),
        effectiveFrom: rate.effectiveFrom,
      });
    })();
    return { taxSeq: seq, ...rate };
  }

  taxRateAt(code: string, date: string): bigint | undefined {
    const row = this.db
      .prepare(
        `SELECT percent_milli AS percentMilli FROM tax_rates
         WHERE code = ? AND effective_from <= ?
         ORDER BY effective_from DESC, tax_seq DESC LIMIT 1`,
      )
      .get(code, date) as { percentMilli: bigint } | undefined;
    return row?.percentMilli;
  }

  listTaxRates(): TaxRate[] {
    interface TaxRow {
      tax_seq: bigint;
      code: string;
      name: string;
      percent_milli: bigint;
      effective_from: string;
      at: string;
    }
    const rows = this.db.prepare(`SELECT * FROM tax_rates ORDER BY tax_seq`).all() as TaxRow[];
    return rows.map((row) => ({
      taxSeq: Number(row.tax_seq),
      code: row.code,
      name: row.name,
      percentMilli: row.percent_milli,
      effectiveFrom: row.effective_from,
      at: row.at,
    }));
  }

  /** Append a sales-price record; never touches existing documents (ADR 0004). */
  setPrice(itemId: string, unitPrice: bigint, effectiveFrom: string): ItemPrice {
    return this.appendPrice(itemId, 'sale', unitPrice, effectiveFrom);
  }

  /** Append a cost record (same append-only rules as sales prices, ADR 0005). */
  setCost(itemId: string, unitCost: bigint, effectiveFrom: string): ItemPrice {
    return this.appendPrice(itemId, 'cost', unitCost, effectiveFrom);
  }

  private appendPrice(
    itemId: string,
    kind: PriceKind,
    unitPrice: bigint,
    effectiveFrom: string,
  ): ItemPrice {
    if (!this.getItem(itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Prices must not be negative');
    }
    let price!: ItemPrice;
    this.db.transaction(() => {
      price = this.insertPrice(itemId, kind, unitPrice, effectiveFrom);
      this.audit('item.price_set', 'item', itemId, {
        kind,
        unitPrice: unitPrice.toString(),
        effectiveFrom,
      });
    })();
    return price;
  }

  private insertPrice(
    itemId: string,
    kind: PriceKind,
    unitPrice: bigint,
    effectiveFrom: string,
  ): ItemPrice {
    const next = this.db
      .prepare(`SELECT coalesce(max(price_seq), 0) + 1 AS seq FROM item_prices WHERE item_id = ?`)
      .get(itemId) as { seq: bigint };
    this.db
      .prepare(
        `INSERT INTO item_prices (item_id, price_seq, kind, effective_from, unit_price) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(itemId, next.seq, kind, effectiveFrom, unitPrice);
    return { itemId, kind, priceSeq: Number(next.seq), effectiveFrom, unitPrice };
  }

  priceAt(itemId: string, date: string): bigint {
    const price = this.lookupPrice(itemId, 'sale', date);
    if (price === undefined) {
      throw new LedgerError('UNKNOWN_ITEM', `Item ${itemId} has no price effective on ${date}`);
    }
    return price;
  }

  costAt(itemId: string, date: string): bigint | undefined {
    return this.costAtInternal(itemId, date, new Set());
  }

  /** Explicit cost wins; else additive BOM derivation, recursive (ADR 0014). */
  private costAtInternal(itemId: string, date: string, visiting: Set<string>): bigint | undefined {
    const own = this.lookupPrice(itemId, 'cost', date);
    if (own !== undefined) return own;
    const bom = this.bomAt(itemId, date);
    if (!bom) return undefined;
    if (visiting.has(itemId)) {
      throw new LedgerError('BOM_CYCLE', `Bill of materials for ${itemId} contains itself`);
    }
    visiting.add(itemId);
    let total = bom.assemblyCostMinor;
    for (const component of bom.components) {
      const unit = this.costAtInternal(component.componentItemId, date, visiting);
      if (unit === undefined) return undefined;
      total += divRoundHalf(component.quantityMilli * unit, QUANTITY_SCALE);
    }
    visiting.delete(itemId);
    return total;
  }

  private lookupPrice(itemId: string, kind: PriceKind, date: string): bigint | undefined {
    const row = this.db
      .prepare(
        `SELECT unit_price AS unitPrice FROM item_prices
         WHERE item_id = ? AND kind = ? AND effective_from <= ?
         ORDER BY effective_from DESC, price_seq DESC LIMIT 1`,
      )
      .get(itemId, kind, date) as { unitPrice: bigint } | undefined;
    return row?.unitPrice;
  }

  priceHistory(itemId: string): ItemPrice[] {
    const rows = this.db
      .prepare(
        `SELECT item_id AS itemId, kind, price_seq AS priceSeq, effective_from AS effectiveFrom, unit_price AS unitPrice
         FROM item_prices WHERE item_id = ? ORDER BY price_seq`,
      )
      .all(itemId) as { itemId: string; kind: PriceKind; priceSeq: bigint; effectiveFrom: string; unitPrice: bigint }[];
    return rows.map((row) => ({ ...row, priceSeq: Number(row.priceSeq) }));
  }

  // ── Customer special rates (ADR 0007) ───────────────────────────────────

  /** Persist a standing special rate — the "yes" answer to a suggestion. */
  setCustomerRate(input: NewCustomerRate): CustomerRate {
    if (!this.getItem(input.itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${input.itemId}`);
    }
    if (input.customerName === undefined && input.accountNumber === undefined && input.partyId === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'A rate needs a party, customer name, or account number');
    }
    const rateParty = input.partyId !== undefined ? this.requireParty(input.partyId) : undefined;
    const effectiveFrom = input.effectiveFrom ?? '0000-01-01';
    const evalDate = input.effectiveFrom ?? '9999-12-31';
    const salePrice = this.priceAt(input.itemId, evalDate);
    const cost = this.costAt(input.itemId, evalDate);
    const specs = [input.rate, ...(input.tiers ?? []).map((tier) => tier.rate)];
    for (const spec of specs) {
      if (spec.kind === 'formula' && spec.base === 'cost' && cost === undefined) {
        throw new LedgerError('INVALID_DOCUMENT', 'Cost-based rate requires cost history for the item');
      }
      if (spec.kind === 'constant' && spec.unitPrice < 0n) {
        throw new LedgerError('INVALID_DOCUMENT', 'Rates must not be negative');
      }
    }
    if (input.rate.kind === 'revoked' && (input.tiers?.length ?? 0) > 0) {
      throw new LedgerError('INVALID_DOCUMENT', 'A revocation cannot carry tiers');
    }
    const tiers: RateTier[] = (input.tiers ?? []).map((tier, index) => {
      if (tier.minQuantityMilli === undefined && tier.multipleQuantityMilli === undefined) {
        throw new LedgerError('INVALID_DOCUMENT', 'A tier needs a minimum quantity and/or an exact multiple');
      }
      if ((tier.minQuantityMilli ?? 1n) <= 0n || (tier.multipleQuantityMilli ?? 1n) <= 0n) {
        throw new LedgerError('INVALID_QUANTITY', 'Tier quantities must be positive');
      }
      return {
        tierNo: index + 1,
        minQuantityMilli: tier.minQuantityMilli ?? null,
        multipleQuantityMilli: tier.multipleQuantityMilli ?? null,
        kind: tier.rate.kind,
        unitPrice: tier.rate.kind === 'constant' ? tier.rate.unitPrice : null,
        base: tier.rate.kind === 'formula' ? tier.rate.base : null,
        percentMilli: tier.rate.kind === 'formula' ? (tier.rate.percentMilli ?? 0n) : 0n,
        amountMinor: tier.rate.kind === 'formula' ? (tier.rate.amountMinor ?? 0n) : 0n,
      };
    });
    const rate: CustomerRate = {
      rateSeq: 0, // assigned below
      itemId: input.itemId,
      partyId: rateParty?.id ?? null,
      // Snapshot of the party's identity at grant time; matching is party-first.
      customerName: input.customerName ?? rateParty?.name ?? null,
      accountNumber: input.accountNumber ?? rateParty?.accountNumber ?? null,
      kind: input.rate.kind,
      unitPrice: input.rate.kind === 'constant' ? input.rate.unitPrice : null,
      base: input.rate.kind === 'formula' ? input.rate.base : null,
      percentMilli: input.rate.kind === 'formula' ? (input.rate.percentMilli ?? 0n) : 0n,
      amountMinor: input.rate.kind === 'formula' ? (input.rate.amountMinor ?? 0n) : 0n,
      allowBelowCost: input.allowBelowCost ?? defaultAllowBelowCost(salePrice, cost),
      effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      tiers,
      at: new Date().toISOString(),
    };
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO customer_rates
             (item_id, party_id, customer_name, account_number, kind, unit_price, base, percent_milli, amount_minor, allow_below_cost, effective_from, effective_to, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rate.itemId,
          rate.partyId,
          rate.customerName,
          rate.accountNumber,
          rate.kind,
          rate.unitPrice,
          rate.base,
          rate.percentMilli,
          rate.amountMinor,
          rate.allowBelowCost ? 1 : 0,
          rate.effectiveFrom,
          rate.effectiveTo,
          rate.at,
        );
      seq = Number(result.lastInsertRowid);
      const insertTier = this.db.prepare(
        `INSERT INTO customer_rate_tiers (rate_seq, tier_no, min_quantity_milli, multiple_quantity_milli, kind, unit_price, base, percent_milli, amount_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const tier of tiers) {
        insertTier.run(seq, tier.tierNo, tier.minQuantityMilli, tier.multipleQuantityMilli, tier.kind, tier.unitPrice, tier.base, tier.percentMilli, tier.amountMinor);
      }
      this.audit('customer_rate.set', 'customer_rate', String(seq), {
        itemId: rate.itemId,
        customerName: rate.customerName,
        accountNumber: rate.accountNumber,
        kind: rate.kind,
        allowBelowCost: rate.allowBelowCost,
        effectiveFrom: rate.effectiveFrom,
      });
    })();
    return { ...rate, rateSeq: seq };
  }

  /** Latest rate for (item, customer) effective on `date`; later records win. */
  customerRateAt(itemId: string, customer: CustomerQuery, date: string): CustomerRate | undefined {
    interface RateRow {
      rate_seq: bigint;
      item_id: string;
      party_id: string | null;
      customer_name: string | null;
      account_number: string | null;
      kind: CustomerRate['kind'];
      unit_price: bigint | null;
      base: CustomerRate['base'];
      percent_milli: bigint;
      amount_minor: bigint;
      allow_below_cost: bigint;
      effective_from: string;
      effective_to: string | null;
      at: string;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM customer_rates
         WHERE item_id = ? AND effective_from <= ?
           AND ((party_id IS NOT NULL AND party_id = ?)
             OR (party_id IS NULL AND account_number IS NOT NULL AND account_number = ?)
             OR (party_id IS NULL AND account_number IS NULL AND customer_name = ?))
         ORDER BY effective_from DESC, rate_seq DESC LIMIT 1`,
      )
      .get(itemId, date, customer.partyId ?? null, customer.accountNumber ?? null, customer.customerName ?? null) as
      | RateRow
      | undefined;
    if (!row) return undefined;
    // Expiry ends special pricing; a revocation record ends it explicitly.
    if (row.effective_to !== null && date > row.effective_to) return undefined;
    if (row.kind === 'revoked') return undefined;
    return {
      rateSeq: Number(row.rate_seq),
      itemId: row.item_id,
      partyId: row.party_id,
      customerName: row.customer_name,
      accountNumber: row.account_number,
      kind: row.kind,
      unitPrice: row.unit_price,
      base: row.base,
      percentMilli: row.percent_milli,
      amountMinor: row.amount_minor,
      allowBelowCost: row.allow_below_cost === 1n,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      tiers: this.rateTiers(Number(row.rate_seq)),
      at: row.at,
    };
  }

  private rateTiers(rateSeq: number): RateTier[] {
    interface TierRow {
      tier_no: bigint;
      min_quantity_milli: bigint | null;
      multiple_quantity_milli: bigint | null;
      kind: RateTier['kind'];
      unit_price: bigint | null;
      base: RateTier['base'];
      percent_milli: bigint;
      amount_minor: bigint;
    }
    const rows = this.db
      .prepare(`SELECT * FROM customer_rate_tiers WHERE rate_seq = ? ORDER BY tier_no`)
      .all(rateSeq) as TierRow[];
    return rows.map((row) => ({
      tierNo: Number(row.tier_no),
      minQuantityMilli: row.min_quantity_milli,
      multipleQuantityMilli: row.multiple_quantity_milli,
      kind: row.kind,
      unitPrice: row.unit_price,
      base: row.base,
      percentMilli: row.percent_milli,
      amountMinor: row.amount_minor,
    }));
  }

  customerPriceAt(
    itemId: string,
    customer: CustomerQuery,
    date: string,
    quantityMilli: bigint = 1000n,
  ): bigint | undefined {
    const rate = this.customerRateAt(itemId, customer, date);
    if (!rate) return undefined;
    return resolveRateForQuantity(rate, quantityMilli, this.priceAt(itemId, date), this.costAt(itemId, date));
  }

  /** "Who has special pricing and is it still sane" (ADR 0009). */
  rateReview(asOf: string): RateReviewEntry[] {
    interface AllRateRow {
      rate_seq: bigint;
      item_id: string;
      party_id: string | null;
      customer_name: string | null;
      account_number: string | null;
      kind: CustomerRate['kind'];
      unit_price: bigint | null;
      base: CustomerRate['base'];
      percent_milli: bigint;
      amount_minor: bigint;
      allow_below_cost: bigint;
      effective_from: string;
      effective_to: string | null;
      at: string;
    }
    const rows = this.db.prepare(`SELECT * FROM customer_rates ORDER BY rate_seq`).all() as AllRateRow[];
    const rates: CustomerRate[] = rows.map((row) => ({
      rateSeq: Number(row.rate_seq),
      itemId: row.item_id,
      partyId: row.party_id,
      customerName: row.customer_name,
      accountNumber: row.account_number,
      kind: row.kind,
      unitPrice: row.unit_price,
      base: row.base,
      percentMilli: row.percent_milli,
      amountMinor: row.amount_minor,
      allowBelowCost: row.allow_below_cost === 1n,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      tiers: this.rateTiers(Number(row.rate_seq)),
      at: row.at,
    }));
    return computeRateReview(rates, this, asOf);
  }

  /** "Should this special rate persist?" questions for a document (call after send). */
  suggestSpecialRates(documentId: string): SpecialRateSuggestion[] {
    return computeRateSuggestions(this.requireDocumentRecord(documentId), this);
  }

  // ── Policies (Tier 2, ADR 0009) ─────────────────────────────────────────

  setReturnPolicy(policy: ReturnPolicy): void {
    const serialized = JSON.stringify(policy, (_key, value) =>
      typeof value === 'bigint' ? `${value.toString()}n` : value,
    );
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('return_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(serialized);
      this.audit('policy.return_set', 'policy', 'return', { policy: serialized });
    })();
  }

  returnPolicy(): ReturnPolicy {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'return_policy'`).get() as
      | { value: string }
      | undefined;
    if (!row) return {};
    return JSON.parse(row.value, (_key, value) =>
      typeof value === 'string' && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value,
    ) as ReturnPolicy;
  }

  setApprovalPolicy(actions: readonly ApprovalAction[]): void {
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('approval_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(JSON.stringify(actions));
      this.audit('policy.approval_set', 'policy', 'approval', { actions });
    })();
  }

  approvalPolicy(): Set<ApprovalAction> {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'approval_policy'`).get() as
      | { value: string }
      | undefined;
    return new Set(row ? (JSON.parse(row.value) as ApprovalAction[]) : []);
  }

  private requireApproval(action: ApprovalAction, approvedBy: string | undefined): void {
    if (this.approvalPolicy().has(action) && approvedBy === undefined) {
      throw new LedgerError('APPROVAL_REQUIRED', `Action "${action}" requires an approver (approvedBy)`);
    }
  }

  /** Non-free sales lines priced under the item's cost are gated (ADR 0009). */
  private requireBelowCostApproval(
    type: DocumentType,
    date: string,
    lines: readonly DocumentLine[],
    approvedBy: string | undefined,
  ): void {
    if (type === 'credit_memo' || isPurchaseType(type)) return;
    for (const line of lines) {
      if (line.free || line.itemId === null) continue;
      const cost = this.costAt(line.itemId, date);
      if (cost !== undefined && line.unitPrice < cost) {
        this.requireApproval('below_cost_sale', approvedBy);
        return;
      }
    }
  }

  /** Cumulative quantity already credited against a line by this credit type (SQL). */
  private priorReturnedMilli(documentId: string, lineId: string, creditType: DocumentType = 'credit_memo'): bigint {
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(l.quantity_milli), 0) AS total
         FROM documents d
         JOIN document_revision_lines l ON l.document_id = d.id
           AND l.revision_no = (SELECT max(revision_no) FROM document_revisions WHERE document_id = d.id)
         WHERE d.type = ? AND d.status != 'void'
           AND l.source_document_id = ? AND l.source_line_id = ?`,
      )
      .get(creditType, documentId, lineId) as { total: bigint };
    return row.total;
  }

  private sourceLineFor(documentId: string, lineId: string): DocumentLine | undefined {
    const record = this.getDocumentRecord(documentId);
    if (!record) return undefined;
    const current = record.revisions[record.revisions.length - 1]!;
    return current.lines.find((line) => line.lineId === lineId);
  }

  // ── Documents (ADR 0004) ────────────────────────────────────────────────

  createDocument(input: NewDocument): DocumentView {
    if (input.number !== undefined && !input.number.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Document number must not be empty');
    }
    if (input.settlement !== undefined && input.type !== 'credit_memo' && input.type !== 'vendor_credit') {
      throw new LedgerError('INVALID_DOCUMENT', 'Only credit memos and vendor credits take a settlement mode');
    }
    const purchase = isPurchaseType(input.type);
    const customer = this.resolveCustomer(input);
    const lines = resolveDocumentLines(
      input.lines,
      input.date,
      this,
      undefined,
      {
        customerName: customer.customerName,
        ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
        ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
      },
      customer.taxExempt,
      purchase,
    );
    let inherited: readonly DocumentTag[] = [];
    if (input.sourceDocumentId !== undefined) {
      const source = this.getDocumentRecord(input.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${input.sourceDocumentId}`);
      }
      validateConversion(source, input.type, lines, this.fulfillment(source.id));
      inherited = deriveTags(source, this.lineClosures(source.id));
    }
    validateRevisionContent({ date: input.date, lines, customerName: customer.customerName });
    this.requireBelowCostApproval(input.type, input.date, lines, input.approvedBy);
    if (input.type === 'credit_memo' || input.type === 'vendor_credit') {
      validateReturnQuantities(
        lines,
        (documentId, lineId) => this.sourceLineFor(documentId, lineId),
        (documentId, lineId) => this.priorReturnedMilli(documentId, lineId, input.type),
      );
    }
    if (input.type === 'purchase_order') {
      this.validatePurchaseLinks(lines);
    }
    const id = randomUUID();
    this.db.transaction(() => {
      const number = input.number?.trim() ?? this.drawNumber(input.type);
      try {
        this.db
          .prepare(
            `INSERT INTO documents (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.type,
            number,
            input.sourceDocumentId ?? null,
            inherited.includes('with corrections') ? 1 : 0,
            inherited.includes('with substitutions') ? 1 : 0,
            input.type === 'credit_memo' || input.type === 'vendor_credit'
              ? (input.settlement ?? 'account')
              : null,
            customer.partyId,
          );
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: documents.type, documents.number')) {
          throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Number already in use: ${number}`);
        }
        throw error;
      }
      this.insertRevision(id, {
        revisionNo: 1,
        kind: 'initial',
        at: new Date().toISOString(),
        reason: null,
        date: input.date,
        customerName: customer.customerName,
        accountNumber: customer.accountNumber ?? null,
        poNumber: input.poNumber ?? null,
        termsDays: customer.termsDays ?? null,
        depositRequiredMinor: resolveDepositRequest(input.type, input.deposit, lines),
        memo: input.memo ?? null,
        lines,
      });
      this.audit('document.created', 'document', id, { type: input.type, number });
    })();
    this.emitDocumentEvent('document.created', id);
    return this.viewDocument(id);
  }

  /** Change a document per the ADR 0004 edit policy; always a new revision. */
  changeDocument(id: string, changes: DocumentChanges): DocumentView {
    const document = this.requireDocumentRecord(id);
    const kind = resolveRevisionKind(document.type, document.status, changes.kind);
    const previous = document.revisions[document.revisions.length - 1]!;
    const date = changes.date ?? previous.date;
    const customerName = changes.customerName ?? previous.customerName;
    const accountNumber = changes.accountNumber ?? previous.accountNumber;
    const lines =
      changes.lines !== undefined
        ? resolveDocumentLines(
            changes.lines,
            date,
            this,
            previous.lines,
            {
              customerName,
              ...(accountNumber !== null ? { accountNumber } : {}),
              ...(document.partyId !== null ? { partyId: document.partyId } : {}),
            },
            false,
            isPurchaseType(document.type),
          )
        : [...previous.lines];
    validateRevisionContent({ date, lines, customerName });
    // ADR 0006: never orphan downstream links or over-consume a shrunk line.
    validateLineConsumption(lines, this.fulfillment(id));
    // ADR 0010 part 3: prepaid lines cannot vanish or shrink below their prepayment.
    if (document.type === 'sales_order') {
      for (const entry of this.linePrepayments(id)) {
        if (entry.prepaid === 0n) continue;
        const stillThere = lines.find((line) => line.lineId === entry.lineId);
        if (!stillThere) {
          throw new LedgerError('LINE_LINKED', `Line ${entry.lineId} has ${entry.prepaid} prepaid and cannot be removed`);
        }
        if (lineGrossTotal(stillThere) < entry.prepaid) {
          throw new LedgerError('LINE_LINKED', `Line ${entry.lineId} cannot shrink below its ${entry.prepaid} prepayment`);
        }
      }
      // ADR 0011 part 5: lines on order with a supplier cannot vanish or
      // shrink below the linked quantity — a PO must not point at nothing.
      for (const entry of this.purchaseCoverage(id)) {
        const ordered = entry.draftOrderedMilli + entry.sentOrderedMilli;
        if (ordered === 0n) continue;
        const stillThere = lines.find((line) => line.lineId === entry.lineId);
        if (!stillThere) {
          throw new LedgerError(
            'LINE_LINKED',
            `Line ${entry.lineId} has ${ordered} (milli) on purchase orders and cannot be removed`,
          );
        }
        if (stillThere.quantityMilli < ordered) {
          throw new LedgerError(
            'LINE_LINKED',
            `Line ${entry.lineId} cannot shrink below the ${ordered} (milli) on purchase orders`,
          );
        }
      }
    }
    if (document.type === 'purchase_order' && changes.lines !== undefined) {
      this.validatePurchaseLinks(lines, id);
    }
    this.requireBelowCostApproval(document.type, date, lines, changes.approvedBy);
    if ((document.type === 'credit_memo' || document.type === 'vendor_credit') && changes.lines !== undefined) {
      validateReturnQuantities(
        lines,
        (documentId, lineId) => this.sourceLineFor(documentId, lineId),
        (documentId, lineId) =>
          this.priorReturnedMilli(documentId, lineId, document.type) -
          previous.lines
            .filter((line) => line.sourceDocumentId === documentId && line.sourceLineId === lineId)
            .reduce((sum, line) => sum + line.quantityMilli, 0n),
      );
    }
    this.db.transaction(() => {
      this.insertRevision(id, {
        revisionNo: previous.revisionNo + 1,
        kind,
        at: new Date().toISOString(),
        reason: changes.reason ?? null,
        date,
        customerName,
        accountNumber: changes.accountNumber ?? previous.accountNumber,
        poNumber: changes.poNumber ?? previous.poNumber,
        termsDays: validateTermsDays(changes.termsDays) ?? previous.termsDays,
        depositRequiredMinor:
          changes.deposit !== undefined
            ? resolveDepositRequest(document.type, changes.deposit, lines)
            : previous.depositRequiredMinor,
        memo: changes.memo ?? previous.memo,
        lines,
      });
      this.audit('document.revised', 'document', id, { kind, reason: changes.reason ?? null });
      if (document.status === 'sent') {
        // ADR 0014: quantity-changing corrections keep stock consistent.
        const getItem = (itemId: string) => this.getItem(itemId);
        const sourceTypeOf = (documentId: string) => this.getDocumentRecord(documentId)?.type;
        this.applyStockEffects(
          diffStockEffects(
            stockEffects(document.type, previous.lines, getItem, sourceTypeOf),
            stockEffects(document.type, lines, getItem, sourceTypeOf),
          ),
          'correction',
          date,
          id,
        );
      }
      this.repostDocumentIfPosted(id);
    })();
    return this.viewDocument(id);
  }

  /**
   * "We accidentally charged the wrong amount": reduce a sent invoice's
   * customer total to `actualTotal`, pro rata with cost floors (ADR 0005).
   */
  chargeCorrection(id: string, actualTotal: bigint, reason?: string, approvedBy?: string): DocumentView {
    this.requireApproval('charge_correction', approvedBy);
    const document = this.requireDocumentRecord(id);
    const kind = resolveRevisionKind(document.type, document.status, 'correction');
    const lines = planChargeCorrection(document, actualTotal, this);
    const previous = document.revisions[document.revisions.length - 1]!;
    this.db.transaction(() => {
      this.insertRevision(id, {
        revisionNo: previous.revisionNo + 1,
        kind,
        at: new Date().toISOString(),
        reason: reason ?? `Charged amount corrected to ${actualTotal}`,
        date: previous.date,
        customerName: previous.customerName,
        accountNumber: previous.accountNumber,
        poNumber: previous.poNumber,
        termsDays: previous.termsDays,
        depositRequiredMinor: previous.depositRequiredMinor,
        memo: previous.memo,
        lines,
      });
      this.audit('document.charge_corrected', 'document', id, {
        actualTotal: actualTotal.toString(),
        reason: reason ?? null,
      });
      this.repostDocumentIfPosted(id);
    })();
    return this.viewDocument(id);
  }

  /** Convert a sent document (partially) into a new linked document (ADR 0005). */
  convertDocument(sourceId: string, spec: ConversionSpec): DocumentView {
    const source = this.requireDocumentRecord(sourceId);
    const lines = buildConversionLines(source, this.fulfillment(sourceId), spec.lines);
    const previous = source.revisions[source.revisions.length - 1]!;
    return this.createDocument({
      type: spec.type,
      ...(spec.number !== undefined ? { number: spec.number } : {}),
      date: spec.date,
      lines,
      sourceDocumentId: sourceId,
      ...(source.partyId !== null ? { partyId: source.partyId } : {}),
      customerName: spec.customerName ?? previous.customerName,
      ...((spec.accountNumber ?? previous.accountNumber) !== null
        ? { accountNumber: (spec.accountNumber ?? previous.accountNumber)! }
        : {}),
      ...((spec.poNumber ?? previous.poNumber) !== null
        ? { poNumber: (spec.poNumber ?? previous.poNumber)! }
        : {}),
      ...((spec.termsDays ?? previous.termsDays) !== null
        ? { termsDays: (spec.termsDays ?? previous.termsDays)! }
        : {}),
      ...(spec.memo !== undefined ? { memo: spec.memo } : {}),
    });
  }

  /**
   * Record a return: each item credited at the price this customer last paid,
   * with line-level links back to that purchase (ADR 0006).
   */
  createReturn(input: NewReturn): DocumentView {
    const customer = this.resolveCustomer(input);
    const query: CustomerQuery = {
      customerName: customer.customerName,
      ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
      ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
    };
    if (input.overrideWindow === true) {
      this.requireApproval('return_window_override', input.approvedBy);
    }
    const invoices = this.listDocumentRecords('invoice');
    const policy = this.returnPolicy();
    const lines = input.items.map((item) =>
      buildReturnLine(item, query, input.date, invoices, this, policy, input.overrideWindow ?? false),
    );
    return this.createDocument({
      type: 'credit_memo',
      ...(input.number !== undefined ? { number: input.number } : {}),
      date: input.date,
      lines,
      customerName: customer.customerName,
      ...(customer.accountNumber !== undefined ? { accountNumber: customer.accountNumber } : {}),
      ...(customer.partyId !== null ? { partyId: customer.partyId } : {}),
      ...(input.poNumber !== undefined ? { poNumber: input.poNumber } : {}),
      ...(input.settlement !== undefined ? { settlement: input.settlement } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
    });
  }

  /** Compute a customer statement as of a date (ADR 0006). */
  statement(query: CustomerQuery, asOf: string, rules?: readonly AgingRule[]): Statement {
    const pairs = ['invoice', 'credit_memo'].flatMap((type) =>
      this.listDocumentRecords(type as DocumentType).map((record) => ({
        record,
        closures: this.lineClosures(record.id),
      })),
    );
    return computeStatement(pairs, this.listPayments(), this.listApplications(), query, asOf, rules);
  }

  /** What we owe a supplier, aged like a customer statement (ADR 0013). */
  supplierStatement(query: CustomerQuery, asOf: string, rules?: readonly AgingRule[]): Statement {
    const pairs = ['bill', 'vendor_credit'].flatMap((type) =>
      this.listDocumentRecords(type as DocumentType).map((record) => ({
        record,
        closures: this.lineClosures(record.id),
      })),
    );
    return computeStatement(pairs, this.listPayments(), this.listApplications(), query, asOf, rules, 'supplier');
  }

  supplierStatementForParty(partyId: string, asOf: string, rules?: readonly AgingRule[]): Statement {
    const party = this.requireParty(partyId);
    return this.supplierStatement(
      {
        partyId,
        customerName: party.name,
        ...(party.accountNumber !== null ? { accountNumber: party.accountNumber } : {}),
      },
      asOf,
      rules,
    );
  }

  /** Cash sale (ADR 0013): invoice at Net 0, sent, and paid in full, atomically. */
  recordSalesReceipt(input: NewCashTransaction): { document: DocumentView; payment: Payment | null } {
    return this.recordCashTransaction('invoice', 'in', input);
  }

  /** Cash expense (ADR 0013): bill approved and paid in one motion. */
  recordExpense(input: NewCashTransaction): { document: DocumentView; payment: Payment | null } {
    return this.recordCashTransaction('bill', 'out', input);
  }

  private recordCashTransaction(
    type: 'invoice' | 'bill',
    direction: 'in' | 'out',
    input: NewCashTransaction,
  ): { document: DocumentView; payment: Payment | null } {
    let document!: DocumentView;
    let payment: Payment | null = null;
    this.db.transaction(() => {
      const view = this.createDocument({
        type,
        date: input.date,
        lines: input.lines,
        termsDays: 0,
        ...(input.number !== undefined ? { number: input.number } : {}),
        ...(input.customerName !== undefined ? { customerName: input.customerName } : {}),
        ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
        ...(input.partyId !== undefined ? { partyId: input.partyId } : {}),
        ...(input.poNumber !== undefined ? { poNumber: input.poNumber } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.taxExempt !== undefined ? { taxExempt: input.taxExempt } : {}),
        ...(input.approvedBy !== undefined ? { approvedBy: input.approvedBy } : {}),
      });
      this.sendDocument(view.id);
      if (view.total > 0n) {
        payment = this.recordPayment({
          direction,
          date: input.date,
          customerName: view.current.customerName,
          ...(view.current.accountNumber !== null ? { accountNumber: view.current.accountNumber } : {}),
          ...(input.partyId !== undefined ? { partyId: input.partyId } : {}),
          ...(input.paymentNumber !== undefined ? { number: input.paymentNumber } : {}),
          ...(input.method !== undefined ? { method: input.method } : {}),
          amount: view.total,
          applications: [{ invoiceId: view.id, amount: view.total }],
        });
      }
      document = this.viewDocument(view.id);
    })();
    return { document, payment };
  }

  private listDocumentRecords(type: DocumentType): DocumentRecord[] {
    const rows = this.db.prepare(`SELECT id FROM documents WHERE type = ?`).all(type) as { id: string }[];
    return rows.map((row) => this.getDocumentRecord(row.id)!);
  }

  /** Explicitly close (part of) a line without fulfilling it (ADR 0005). */
  closeLine(documentId: string, input: NewLineClosure): LineClosure {
    this.requireApproval('close_line', input.approvedBy);
    const document = this.requireDocumentRecord(documentId);
    if (document.status !== 'sent') {
      throw new LedgerError('INVALID_STATUS', 'Only lines of sent documents can be closed');
    }
    const fulfillment = this.fulfillment(documentId);
    const line = fulfillment.find((entry) => entry.lineId === input.lineId);
    if (!line) {
      throw new LedgerError('UNKNOWN_LINE', `No such line: ${input.lineId}`);
    }
    const quantityMilli = input.quantityMilli ?? line.openMilli;
    if (quantityMilli <= 0n || quantityMilli > line.openMilli) {
      throw new LedgerError(
        'LINE_OVERDRAWN',
        `Cannot close ${quantityMilli} (milli); line has ${line.openMilli} open`,
      );
    }
    const closure: LineClosure = {
      closureSeq: 0, // assigned below
      lineId: input.lineId,
      kind: input.kind,
      quantityMilli,
      reason: input.reason ?? null,
      at: new Date().toISOString(),
    };
    let seq = 0;
    this.db.transaction(() => {
      const next = this.db
        .prepare(`SELECT coalesce(max(closure_seq), 0) + 1 AS seq FROM document_line_closures WHERE document_id = ?`)
        .get(documentId) as { seq: bigint };
      seq = Number(next.seq);
      this.db
        .prepare(
          `INSERT INTO document_line_closures (document_id, closure_seq, line_id, kind, quantity_milli, reason, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(documentId, seq, closure.lineId, closure.kind, closure.quantityMilli, closure.reason, closure.at);
      this.audit('document.line_closed', 'document', documentId, {
        lineId: closure.lineId,
        kind: closure.kind,
        quantityMilli: closure.quantityMilli.toString(),
        reason: closure.reason,
      });
    })();
    return { ...closure, closureSeq: seq };
  }

  /** Per-line open/converted/closed state, derived from links and closures. */
  fulfillment(documentId: string): LineFulfillment[] {
    const document = this.requireDocumentRecord(documentId);
    const rows = this.db
      .prepare(
        `SELECT l.source_line_id AS lineId, sum(l.quantity_milli) AS converted
         FROM documents d
         JOIN document_revision_lines l ON l.document_id = d.id
           AND l.revision_no = (SELECT max(revision_no) FROM document_revisions WHERE document_id = d.id)
         WHERE d.source_document_id = ? AND d.status != 'void' AND l.source_line_id IS NOT NULL
         GROUP BY l.source_line_id`,
      )
      .all(documentId) as { lineId: string; converted: bigint }[];
    const converted = new Map(rows.map((row) => [row.lineId, row.converted]));
    return computeFulfillment(document, converted, this.lineClosures(documentId));
  }

  /** The link graph around one document (ADR 0021); shared with the core engine. */
  documentLinks(id: string): DocumentLinks {
    return computeDocumentLinks(this.listDocuments(), id);
  }

  lineClosures(documentId: string): LineClosure[] {
    const rows = this.db
      .prepare(
        `SELECT closure_seq AS closureSeq, line_id AS lineId, kind, quantity_milli AS quantityMilli, reason, at
         FROM document_line_closures WHERE document_id = ? ORDER BY closure_seq`,
      )
      .all(documentId) as {
      closureSeq: bigint;
      lineId: string;
      kind: LineClosure['kind'];
      quantityMilli: bigint;
      reason: string | null;
      at: string;
    }[];
    return rows.map((row) => ({ ...row, closureSeq: Number(row.closureSeq) }));
  }

  sendDocument(
    id: string,
    options?: { overrideDeposit?: boolean; overrideMinimum?: boolean; approvedBy?: string },
  ): DocumentView {
    const document = this.requireDocumentRecord(id);
    if (document.status !== 'draft') {
      throw new LedgerError('INVALID_STATUS', `Only draft documents can be sent (is ${document.status})`);
    }
    const current = document.revisions[document.revisions.length - 1]!;
    if (document.type === 'sales_order') {
      const requiring = depositRequiringLines(current.lines, (itemId) => this.getItem(itemId));
      if (requiring.length > 0 && (current.depositRequiredMinor ?? 0n) <= 0n) {
        if (options?.overrideDeposit === true) {
          this.requireApproval('deposit_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'DEPOSIT_REQUIRED',
            `These items require a deposit before sending: ${requiring.map((line) => line.description).join(', ')} (pass overrideDeposit to send anyway)`,
          );
        }
      }
      // ADR 0011 part 6: special-order items must be prepaid in full — the
      // deposit request has to cover their gross amount before sending.
      const floor = specialOrderDepositFloor(current.lines, (itemId) => this.getItem(itemId));
      if (floor > 0n && (current.depositRequiredMinor ?? 0n) < floor) {
        if (options?.overrideDeposit === true) {
          this.requireApproval('deposit_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'DEPOSIT_REQUIRED',
            `Special-order items must be prepaid: the deposit request must cover at least ${floor}, not ${current.depositRequiredMinor ?? 0n} (pass overrideDeposit to send anyway)`,
          );
        }
      }
    }
    if (document.type === 'purchase_order') {
      const readiness = this.purchaseOrderReadiness(id);
      if (!readiness.ready) {
        if (options?.overrideMinimum === true) {
          this.requireApproval('minimum_order_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'MINIMUM_NOT_MET',
            `Purchase order does not meet the supplier's terms: ${readiness.shortfalls
              .map((shortfall) => shortfall.message)
              .join('; ')} (pass overrideMinimum to send anyway)`,
          );
        }
      }
      // ADR 0016: special-order items and supplier prepayment terms require a
      // deposit committed before the order is submitted to the supplier.
      const info = document.partyId !== null ? this.supplierInfoAt(document.partyId, current.date) : undefined;
      const floor = purchaseDepositFloor(
        current.lines,
        (itemId) => this.getItem(itemId),
        info?.prepaymentPercentMilli ?? null,
      );
      if (floor > 0n && (current.depositRequiredMinor ?? 0n) < floor) {
        if (options?.overrideDeposit === true) {
          this.requireApproval('deposit_override', options.approvedBy);
        } else {
          throw new LedgerError(
            'DEPOSIT_REQUIRED',
            `Supplier requires prepayment: the deposit request must cover at least ${floor}, not ${current.depositRequiredMinor ?? 0n} (pass overrideDeposit to send anyway)`,
          );
        }
      }
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE documents SET status = 'sent' WHERE id = ?`).run(id);
      this.audit('document.sent', 'document', id, {});
      // ADR 0014: sending/approving moves stock for inventory items.
      this.applyStockEffects(
        stockEffects(
          document.type,
          current.lines,
          (itemId) => this.getItem(itemId),
          (documentId) => this.getDocumentRecord(documentId)?.type,
        ),
        'document',
        current.date,
        id,
      );
      this.postDocumentIfConfigured(this.requireDocumentRecord(id));
      if (document.type === 'invoice') {
        const source = document.sourceDocumentId !== null ? this.getDocumentRecord(document.sourceDocumentId) : undefined;
        if (source?.type === 'sales_order') this.transferDeposits(id, source);
      }
      if (document.type === 'bill') {
        // ADR 0016: deposits ride from the originating PO onto the bill,
        // resolving through a receipt in the three-way flow (ADR 0015).
        const po = this.originatingPurchaseOrder(this.requireDocumentRecord(id));
        if (po) this.transferDeposits(id, po);
      }
    })();
    this.emitDocumentEvent('document.sent', id);
    return this.viewDocument(id);
  }

  /** Total deposit money held against a sales order (ADR 0010 part 3). */
  depositHeld(documentId: string): bigint {
    this.requireDocumentRecord(documentId);
    return appliedToInvoice(this.listApplications(), documentId, (kind, id) => this.isSourceActive(kind, id));
  }

  /** Per-line prepayments on a sales order (ADR 0010 part 3). */
  linePrepayments(documentId: string): { lineId: string; description: string; prepaid: bigint; lineGross: bigint }[] {
    const document = this.requireDocumentRecord(documentId);
    const current = document.revisions[document.revisions.length - 1]!;
    const applications = this.listApplications();
    return current.lines.map((line) => ({
      lineId: line.lineId,
      description: line.description,
      prepaid: appliedToLine(applications, documentId, line.lineId, (kind, id) => this.isSourceActive(kind, id)),
      lineGross: lineGrossTotal(line),
    }));
  }

  /**
   * Move deposits held on the source sales order onto a just-sent invoice
   * (ADR 0010 part 3): line prepayments whose line converted here first,
   * then document-level deposits, oldest first; remainders stay held.
   */
  private originatingPurchaseOrder(bill: DocumentRecord): DocumentRecord | undefined {
    let source = bill.sourceDocumentId !== null ? this.getDocumentRecord(bill.sourceDocumentId) : undefined;
    if (source?.type === 'receipt') {
      source = source.sourceDocumentId !== null ? this.getDocumentRecord(source.sourceDocumentId) : undefined;
    }
    return source?.type === 'purchase_order' ? source : undefined;
  }

  private transferDeposits(invoiceId: string, source: DocumentRecord): void {
    const invoice = this.requireDocumentRecord(invoiceId);
    const invoiceCurrent = invoice.revisions[invoice.revisions.length - 1]!;
    const convertedLineIds = new Set(
      invoiceCurrent.lines
        .map((line) => line.sourceLineId)
        .filter((lineId): lineId is string => lineId !== null),
    );
    const applications = this.listApplications();
    const held = applications
      .filter(
        (application) =>
          application.invoiceId === source.id &&
          application.reversesApplicationSeq === null &&
          !applications.some((other) => other.reversesApplicationSeq === application.applicationSeq) &&
          this.isSourceActive(application.sourceKind, application.sourceId),
      )
      .sort((a, b) => {
        const aLinked = a.lineId !== null && convertedLineIds.has(a.lineId) ? 0 : a.lineId === null ? 1 : 2;
        const bLinked = b.lineId !== null && convertedLineIds.has(b.lineId) ? 0 : b.lineId === null ? 1 : 2;
        return aLinked === bLinked ? a.applicationSeq - b.applicationSeq : aLinked - bLinked;
      });
    for (const application of held) {
      if (application.lineId !== null && !convertedLineIds.has(application.lineId)) continue;
      const open = this.invoiceSettlement(invoiceId).open;
      if (open === 0n) break;
      const move = application.amountMinor < open ? application.amountMinor : open;
      this.reverseApplication(application.applicationSeq);
      this.applyCreditInternal({
        sourceKind: application.sourceKind,
        sourceId: application.sourceId,
        invoiceId,
        amount: move,
      });
      if (move < application.amountMinor) {
        this.applyCreditInternal({
          sourceKind: application.sourceKind,
          sourceId: application.sourceId,
          invoiceId: source.id,
          amount: application.amountMinor - move,
          ...(application.lineId !== null ? { lineId: application.lineId } : {}),
        });
      }
    }
  }

  voidDocument(id: string, approvedBy?: string): DocumentView {
    this.requireApproval('void_document', approvedBy);
    const document = this.requireDocumentRecord(id);
    if (document.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Document is already void');
    }
    const voidCurrent = document.revisions[document.revisions.length - 1]!;
    const wasSent = document.status === 'sent';
    this.db.transaction(() => {
      this.db.prepare(`UPDATE documents SET status = 'void' WHERE id = ?`).run(id);
      this.audit('document.voided', 'document', id, {});
      if (wasSent) {
        // ADR 0014: voiding a sent document puts its stock back.
        const effects = stockEffects(
          document.type,
          voidCurrent.lines,
          (itemId) => this.getItem(itemId),
          (documentId) => this.getDocumentRecord(documentId)?.type,
        );
        this.applyStockEffects(
          effects.map((effect) => ({ ...effect, deltaMilli: -effect.deltaMilli })),
          'void',
          voidCurrent.date,
          id,
        );
      }
      this.reversePostingIfActive('document', id, voidCurrent.date, `Reversal: ${document.number} voided`);
    })();
    this.emitDocumentEvent('document.voided', id);
    return this.viewDocument(id);
  }

  getDocumentRecord(id: string): DocumentRecord | undefined {
    interface DocumentRow {
      id: string;
      type: DocumentType;
      number: string;
      status: DocumentRecord['status'];
      source_document_id: string | null;
      inherited_corrections: bigint;
      inherited_substitutions: bigint;
      settlement: DocumentRecord['settlement'];
      party_id: string | null;
    }
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as
      | DocumentRow
      | undefined;
    if (!row) return undefined;
    interface RevisionRow {
      revision_no: bigint;
      kind: DocumentRevision['kind'];
      at: string;
      reason: string | null;
      date: string;
      customer_name: string | null;
      account_number: string | null;
      po_number: string | null;
      terms_days: bigint | null;
      deposit_required_minor: bigint | null;
      memo: string | null;
    }
    const revisionRows = this.db
      .prepare(`SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision_no`)
      .all(id) as RevisionRow[];
    interface RevisionLineRow {
      revision_no: bigint;
      line_no: bigint;
      line_id: string | null;
      item_id: string | null;
      description: string;
      quantity_milli: bigint;
      unit_price: bigint;
      currency: string;
      adjustment: bigint;
      free: bigint;
      substituted: bigint;
      source_document_id: string | null;
      source_line_id: string | null;
      return_condition: ReturnCondition | null;
      tax_code: string | null;
      tax_percent_milli: bigint;
    }
    const lineRows = this.db
      .prepare(`SELECT * FROM document_revision_lines WHERE document_id = ? ORDER BY revision_no, line_no`)
      .all(id) as RevisionLineRow[];
    const linesByRevision = new Map<number, RevisionLineRow[]>();
    for (const line of lineRows) {
      const key = Number(line.revision_no);
      const bucket = linesByRevision.get(key);
      if (bucket) bucket.push(line);
      else linesByRevision.set(key, [line]);
    }
    const inheritedTags: DocumentTag[] = [];
    if (row.inherited_corrections === 1n) inheritedTags.push('with corrections');
    if (row.inherited_substitutions === 1n) inheritedTags.push('with substitutions');
    return {
      id: row.id,
      type: row.type,
      number: row.number,
      status: row.status,
      sourceDocumentId: row.source_document_id,
      partyId: row.party_id,
      settlement: row.settlement,
      inheritedTags,
      revisions: revisionRows.map((revision) => ({
        revisionNo: Number(revision.revision_no),
        kind: revision.kind,
        at: revision.at,
        reason: revision.reason,
        date: revision.date,
        customerName: revision.customer_name ?? '',
        accountNumber: revision.account_number,
        poNumber: revision.po_number,
        termsDays: revision.terms_days === null ? null : Number(revision.terms_days),
        depositRequiredMinor: revision.deposit_required_minor,
        memo: revision.memo,
        lines: (linesByRevision.get(Number(revision.revision_no)) ?? []).map((line) => ({
          lineId: line.line_id ?? `${row.id}#${line.line_no}`,
          itemId: line.item_id,
          description: line.description,
          quantityMilli: line.quantity_milli,
          unitPrice: line.unit_price,
          currency: line.currency,
          adjustment: line.adjustment,
          free: line.free === 1n,
          substituted: line.substituted === 1n,
          sourceDocumentId: line.source_document_id ?? (line.source_line_id !== null ? row.source_document_id : null),
          sourceLineId: line.source_line_id,
          returnCondition: line.return_condition,
          taxCode: line.tax_code,
          taxPercentMilli: line.tax_percent_milli,
        })),
      })),
    };
  }

  viewDocument(id: string): DocumentView {
    return viewDocument(this.requireDocumentRecord(id), this.lineClosures(id));
  }

  documentHistory(id: string): readonly DocumentRevision[] {
    return this.requireDocumentRecord(id).revisions;
  }

  listDocuments(type?: DocumentType): DocumentView[] {
    const rows = (
      type === undefined
        ? this.db.prepare(`SELECT id FROM documents ORDER BY type, number`).all()
        : this.db.prepare(`SELECT id FROM documents WHERE type = ? ORDER BY number`).all(type)
    ) as { id: string }[];
    return rows.map((row) => this.viewDocument(row.id));
  }

  private requireDocumentRecord(id: string): DocumentRecord {
    const document = this.getDocumentRecord(id);
    if (!document) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such document: ${id}`);
    }
    return document;
  }

  private insertRevision(documentId: string, revision: DocumentRevision): void {
    this.db
      .prepare(
        `INSERT INTO document_revisions (document_id, revision_no, kind, at, reason, date, customer_name, account_number, po_number, terms_days, deposit_required_minor, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        revision.revisionNo,
        revision.kind,
        revision.at,
        revision.reason,
        revision.date,
        revision.customerName,
        revision.accountNumber,
        revision.poNumber,
        revision.termsDays,
        revision.depositRequiredMinor,
        revision.memo,
      );
    const insertLine = this.db.prepare(
      `INSERT INTO document_revision_lines
         (document_id, revision_no, line_no, line_id, item_id, description, quantity_milli, unit_price, currency, adjustment, free, substituted, source_document_id, source_line_id, return_condition, tax_code, tax_percent_milli)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    revision.lines.forEach((line, index) => {
      insertLine.run(
        documentId,
        revision.revisionNo,
        index + 1,
        line.lineId,
        line.itemId,
        line.description,
        line.quantityMilli,
        line.unitPrice,
        line.currency,
        line.adjustment,
        line.free ? 1 : 0,
        line.substituted ? 1 : 0,
        line.sourceDocumentId,
        line.sourceLineId,
        line.returnCondition,
        line.taxCode,
        line.taxPercentMilli,
      );
    });
  }

  // ── Inventory (ADR 0014) ─────────────────────────────────────────────────

  /** Derived on-hand levels, as-of any date; never stored (ADR 0014). */
  stockOnHand(itemId: string, asOf?: string): StockLevel {
    if (!this.db.prepare(`SELECT 1 FROM items WHERE id = ?`).get(itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(CASE WHEN condition = 'good' THEN quantity_milli END), 0) AS good,
                coalesce(sum(CASE WHEN condition = 'damaged' THEN quantity_milli END), 0) AS damaged
         FROM stock_movements WHERE item_id = ? AND (? IS NULL OR date <= ?)`,
      )
      .get(itemId, asOf ?? null, asOf ?? null) as { good: bigint; damaged: bigint };
    return { goodMilli: row.good, damagedMilli: row.damaged };
  }

  stockMovements(itemId: string): StockMovement[] {
    interface MovementRow {
      movement_seq: bigint;
      item_id: string;
      kind: StockMovementKind;
      condition: StockCondition;
      quantity_milli: bigint;
      date: string;
      at: string;
      reason: string | null;
      source_id: string | null;
      disposition: Disposition | null;
      value_minor: bigint | null;
    }
    const rows = this.db
      .prepare(`SELECT * FROM stock_movements WHERE item_id = ? ORDER BY movement_seq`)
      .all(itemId) as MovementRow[];
    return rows.map((row) => ({
      movementSeq: Number(row.movement_seq),
      itemId: row.item_id,
      kind: row.kind,
      condition: row.condition,
      quantityMilli: row.quantity_milli,
      date: row.date,
      at: row.at,
      reason: row.reason,
      sourceId: row.source_id,
      disposition: row.disposition,
      valueMinor: row.value_minor,
    }));
  }

  /** FIFO valuation, derived from the movement ledger (ADR 0015). */
  itemValuation(itemId: string, asOf?: string): ItemValuation {
    if (!this.db.prepare(`SELECT 1 FROM items WHERE id = ?`).get(itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    const movements = this.stockMovements(itemId).filter((movement) => asOf === undefined || movement.date <= asOf);
    return valueInventory(movements, (date) => this.costAt(itemId, date));
  }

  private requireInventoryItem(itemId: string): Item {
    const item = this.getItem(itemId);
    if (!item) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (item.kind !== 'inventory') {
      throw new LedgerError('INVALID_DOCUMENT', `${item.name} is ${item.kind.replace('_', '-')}; it has no tracked stock`);
    }
    return item;
  }

  private insertMovement(
    itemId: string,
    kind: StockMovementKind,
    condition: StockCondition,
    quantityMilli: bigint,
    date: string,
    options?: { reason?: string; sourceId?: string; disposition?: Disposition; valueMinor?: bigint },
  ): void {
    this.db
      .prepare(
        `INSERT INTO stock_movements (item_id, kind, condition, quantity_milli, date, at, reason, source_id, disposition, value_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        kind,
        condition,
        quantityMilli,
        date,
        new Date().toISOString(),
        options?.reason ?? null,
        options?.sourceId ?? null,
        options?.disposition ?? null,
        options?.valueMinor ?? null,
      );
  }

  private applyStockEffects(effects: readonly StockEffect[], kind: StockMovementKind, date: string, sourceId: string): void {
    for (const effect of effects) {
      this.insertMovement(effect.itemId, kind, effect.condition, effect.deltaMilli, date, {
        sourceId,
        ...(effect.valueMinor !== undefined ? { valueMinor: effect.valueMinor } : {}),
      });
    }
  }

  /** Manual signed count; negative = shrinkage write-off (approvable). */
  adjustStock(
    itemId: string,
    quantityMilli: bigint,
    options?: { reason?: string; date?: string; condition?: StockCondition; approvedBy?: string },
  ): StockLevel {
    this.requireInventoryItem(itemId);
    if (quantityMilli === 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Adjustments must move a nonzero quantity');
    }
    if (quantityMilli < 0n) {
      this.requireApproval('stock_write_off', options?.approvedBy);
    }
    this.db.transaction(() => {
      this.insertMovement(itemId, 'adjustment', options?.condition ?? 'good', quantityMilli, options?.date ?? new Date().toISOString().slice(0, 10), {
        ...(options?.reason !== undefined ? { reason: options.reason } : {}),
      });
      this.audit('stock.adjusted', 'item', itemId, { quantityMilli: quantityMilli.toString(), reason: options?.reason ?? null });
    })();
    return this.stockOnHand(itemId);
  }

  /** Move good stock into the damaged bucket (ADR 0014 part 2). */
  markDamaged(itemId: string, quantityMilli: bigint, options?: { reason?: string; date?: string }): StockLevel {
    this.requireInventoryItem(itemId);
    if (quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Damaged quantities must be positive');
    }
    const onHand = this.stockOnHand(itemId);
    if (quantityMilli > onHand.goodMilli) {
      throw new LedgerError('INSUFFICIENT_STOCK', `Cannot damage ${quantityMilli} (milli); ${onHand.goodMilli} good on hand`);
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const reason = options?.reason !== undefined ? { reason: options.reason } : {};
    this.db.transaction(() => {
      this.insertMovement(itemId, 'damage', 'good', -quantityMilli, date, reason);
      this.insertMovement(itemId, 'damage', 'damaged', quantityMilli, date, reason);
      this.audit('stock.damaged', 'item', itemId, { quantityMilli: quantityMilli.toString(), reason: options?.reason ?? null });
    })();
    return this.stockOnHand(itemId);
  }

  /** Resolve damaged stock per the item's policy (ADR 0014 part 2). */
  disposeStock(
    itemId: string,
    quantityMilli: bigint,
    disposition: Disposition,
    options?: { reason?: string; date?: string; approvedBy?: string },
  ): StockLevel {
    const item = this.requireInventoryItem(itemId);
    if (!item.dispositions.includes(disposition)) {
      throw new LedgerError('INVALID_DOCUMENT', `${item.name} does not allow the "${disposition}" disposition`);
    }
    if (quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Disposal quantities must be positive');
    }
    const onHand = this.stockOnHand(itemId);
    if (quantityMilli > onHand.damagedMilli) {
      throw new LedgerError('INSUFFICIENT_STOCK', `Cannot dispose ${quantityMilli} (milli); ${onHand.damagedMilli} damaged on hand`);
    }
    if (disposition !== 'restock') {
      this.requireApproval('stock_write_off', options?.approvedBy);
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const extra = { disposition, ...(options?.reason !== undefined ? { reason: options.reason } : {}) };
    this.db.transaction(() => {
      this.insertMovement(itemId, 'disposal', 'damaged', -quantityMilli, date, extra);
      if (disposition === 'restock') {
        this.insertMovement(itemId, 'disposal', 'good', quantityMilli, date, extra);
      }
      this.audit('stock.disposed', 'item', itemId, { quantityMilli: quantityMilli.toString(), disposition });
    })();
    return this.stockOnHand(itemId);
  }

  // ── Bills of materials (ADR 0014 part 3) ─────────────────────────────────

  /** Append a BOM version; earlier documents keep their cost snapshots. */
  setBom(input: NewItemBom): ItemBom {
    if (!this.getItem(input.itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${input.itemId}`);
    }
    if (input.components.length === 0) {
      throw new LedgerError('INVALID_DOCUMENT', 'A bill of materials needs at least one component');
    }
    if ((input.assemblyCostMinor ?? 0n) < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Assembly cost must not be negative');
    }
    const seen = new Set<string>();
    for (const component of input.components) {
      if (!this.getItem(component.componentItemId)) {
        throw new LedgerError('UNKNOWN_ITEM', `No such item: ${component.componentItemId}`);
      }
      if (component.componentItemId === input.itemId || seen.has(component.componentItemId)) {
        throw new LedgerError('INVALID_DOCUMENT', `Duplicate or self component: ${component.componentItemId}`);
      }
      seen.add(component.componentItemId);
      if (component.quantityMilli <= 0n) {
        throw new LedgerError('INVALID_QUANTITY', 'Component quantities must be positive');
      }
    }
    const bom: ItemBom = {
      bomSeq: 0, // assigned below
      itemId: input.itemId,
      effectiveFrom: input.effectiveFrom ?? '0000-01-01',
      assemblyCostMinor: input.assemblyCostMinor ?? 0n,
      components: input.components.map((component) => ({ ...component })),
      at: new Date().toISOString(),
    };
    // Reject cycles up front (ADR 0014 part 3).
    const walk = (itemId: string, path: Set<string>): void => {
      const next = itemId === input.itemId ? bom : this.bomAt(itemId, '9999-12-31');
      if (!next) return;
      for (const component of next.components) {
        if (component.componentItemId === input.itemId || path.has(component.componentItemId)) {
          throw new LedgerError('BOM_CYCLE', `Adding this bill of materials would make ${input.itemId} contain itself`);
        }
        walk(component.componentItemId, new Set([...path, component.componentItemId]));
      }
    };
    walk(input.itemId, new Set());
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(`INSERT INTO item_boms (item_id, effective_from, assembly_cost_minor, at) VALUES (?, ?, ?, ?)`)
        .run(bom.itemId, bom.effectiveFrom, bom.assemblyCostMinor, bom.at);
      seq = Number(result.lastInsertRowid);
      const insertComponent = this.db.prepare(
        `INSERT INTO item_bom_components (bom_seq, component_no, component_item_id, quantity_milli) VALUES (?, ?, ?, ?)`,
      );
      bom.components.forEach((component, index) => {
        insertComponent.run(seq, index + 1, component.componentItemId, component.quantityMilli);
      });
      this.audit('item.bom_set', 'item', bom.itemId, { components: bom.components.length, effectiveFrom: bom.effectiveFrom });
    })();
    return { ...bom, bomSeq: seq };
  }

  /** The BOM version effective on `date`, if any. */
  bomAt(itemId: string, date: string): ItemBom | undefined {
    const row = this.db
      .prepare(
        `SELECT bom_seq AS bomSeq, effective_from AS effectiveFrom, assembly_cost_minor AS assemblyCostMinor, at
         FROM item_boms WHERE item_id = ? AND effective_from <= ?
         ORDER BY effective_from DESC, bom_seq DESC LIMIT 1`,
      )
      .get(itemId, date) as { bomSeq: bigint; effectiveFrom: string; assemblyCostMinor: bigint; at: string } | undefined;
    if (!row) return undefined;
    const components = (
      this.db
        .prepare(`SELECT component_item_id AS componentItemId, quantity_milli AS quantityMilli FROM item_bom_components WHERE bom_seq = ? ORDER BY component_no`)
        .all(Number(row.bomSeq)) as { componentItemId: string; quantityMilli: bigint }[]
    ).map((component) => ({ ...component }));
    return {
      bomSeq: Number(row.bomSeq),
      itemId,
      effectiveFrom: row.effectiveFrom,
      assemblyCostMinor: row.assemblyCostMinor,
      components,
      at: row.at,
    };
  }

  /** Consume components, produce the assembly (ADR 0014 part 3). */
  buildAssembly(itemId: string, quantityMilli: bigint, options?: { date?: string; reason?: string }): StockLevel {
    return this.moveAssembly(itemId, quantityMilli, 1n, options);
  }

  /** The exact inverse: a full box becomes its pieces again. */
  breakAssembly(itemId: string, quantityMilli: bigint, options?: { date?: string; reason?: string }): StockLevel {
    return this.moveAssembly(itemId, quantityMilli, -1n, options);
  }

  private moveAssembly(
    itemId: string,
    quantityMilli: bigint,
    sign: 1n | -1n,
    options?: { date?: string; reason?: string },
  ): StockLevel {
    const item = this.requireInventoryItem(itemId);
    if (quantityMilli <= 0n) {
      throw new LedgerError('INVALID_QUANTITY', 'Assembly quantities must be positive');
    }
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const bom = this.bomAt(itemId, date);
    if (!bom) {
      throw new LedgerError('INVALID_DOCUMENT', `${item.name} has no bill of materials`);
    }
    if (sign === -1n && this.stockOnHand(itemId).goodMilli < quantityMilli) {
      throw new LedgerError('INSUFFICIENT_STOCK', `Cannot break ${quantityMilli} (milli); only ${this.stockOnHand(itemId).goodMilli} on hand`);
    }
    const inventoryComponents = bom.components.filter(
      (component) => this.getItem(component.componentItemId)?.kind === 'inventory',
    );
    if (sign === 1n) {
      for (const component of inventoryComponents) {
        const need = componentNeed(component, quantityMilli);
        const onHand = this.stockOnHand(component.componentItemId).goodMilli;
        if (onHand < need) {
          throw new LedgerError(
            'INSUFFICIENT_STOCK',
            `Building needs ${need} (milli) of ${component.componentItemId}; ${onHand} on hand`,
          );
        }
      }
    }
    const reason = options?.reason !== undefined ? { reason: options.reason } : {};
    this.db.transaction(() => {
      for (const component of inventoryComponents) {
        this.insertMovement(component.componentItemId, 'build', 'good', -sign * componentNeed(component, quantityMilli), date, reason);
      }
      this.insertMovement(itemId, 'build', 'good', sign * quantityMilli, date, reason);
      this.audit(sign === 1n ? 'stock.assembled' : 'stock.disassembled', 'item', itemId, {
        quantityMilli: quantityMilli.toString(),
      });
    })();
    return this.stockOnHand(itemId);
  }

  // ── Purchase side (ADR 0011) ─────────────────────────────────────────────

  /** Record a supplier-info snapshot (append-only; `source` = 'manual' or a plugin id). */
  recordSupplierInfo(input: NewSupplierInfo): SupplierInfo {
    this.requireParty(input.partyId);
    for (const term of input.items ?? []) {
      if (!this.getItem(term.itemId)) {
        throw new LedgerError('UNKNOWN_ITEM', `No such item: ${term.itemId}`);
      }
    }
    const info = buildSupplierInfo(input, 0, new Date().toISOString());
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO supplier_info (party_id, source, as_of, at, currency, minimum_order_minor, minimum_order_quantity_milli, prepayment_percent_milli, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          info.partyId,
          info.source,
          info.asOf,
          info.at,
          info.currency,
          info.minimumOrderMinor,
          info.minimumOrderQuantityMilli,
          info.prepaymentPercentMilli,
          info.notes,
        );
      seq = Number(result.lastInsertRowid);
      const insertShipping = this.db.prepare(
        `INSERT INTO supplier_info_shipping (info_seq, shipping_no, method, cost_minor, free_above_minor, min_days, max_days)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      info.shipping.forEach((estimate, index) => {
        insertShipping.run(seq, index + 1, estimate.method, estimate.costMinor, estimate.freeAboveMinor, estimate.minDays, estimate.maxDays);
      });
      const insertItem = this.db.prepare(
        `INSERT INTO supplier_info_items (info_seq, item_id, unit_cost, supplier_sku, in_stock, min_quantity_milli, multiple_quantity_milli, lead_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const term of info.items) {
        insertItem.run(
          seq,
          term.itemId,
          term.unitCost,
          term.supplierSku,
          term.inStock === null ? null : term.inStock ? 1 : 0,
          term.minQuantityMilli,
          term.multipleQuantityMilli,
          term.leadDays,
        );
      }
      this.audit('supplier.info_recorded', 'supplier_info', String(seq), {
        partyId: info.partyId,
        source: info.source,
        asOf: info.asOf,
        items: info.items.length,
      });
    })();
    return { ...info, infoSeq: seq };
  }

  /** Newest supplier snapshot observed on or before `date`. */
  supplierInfoAt(partyId: string, date: string): SupplierInfo | undefined {
    const row = this.db
      .prepare(
        `SELECT info_seq AS seq FROM supplier_info
         WHERE party_id = ? AND as_of <= ?
         ORDER BY as_of DESC, info_seq DESC LIMIT 1`,
      )
      .get(partyId, date) as { seq: bigint } | undefined;
    return row ? this.getSupplierInfo(Number(row.seq)) : undefined;
  }

  /** The latest supplier snapshot regardless of date. */
  supplierInfo(partyId: string): SupplierInfo | undefined {
    const row = this.db
      .prepare(`SELECT info_seq AS seq FROM supplier_info WHERE party_id = ? ORDER BY info_seq DESC LIMIT 1`)
      .get(partyId) as { seq: bigint } | undefined;
    return row ? this.getSupplierInfo(Number(row.seq)) : undefined;
  }

  supplierInfoHistory(partyId: string): SupplierInfo[] {
    const rows = this.db
      .prepare(`SELECT info_seq AS seq FROM supplier_info WHERE party_id = ? ORDER BY info_seq`)
      .all(partyId) as { seq: bigint }[];
    return rows.map((row) => this.getSupplierInfo(Number(row.seq))!);
  }

  /** The supplier's quoted unit cost effective on `date` (ItemCatalog seam). */
  supplierCostAt(partyId: string, itemId: string, date: string): bigint | undefined {
    return this.supplierInfoAt(partyId, date)?.items.find((term) => term.itemId === itemId)?.unitCost;
  }

  private getSupplierInfo(infoSeq: number): SupplierInfo | undefined {
    interface InfoRow {
      info_seq: bigint;
      party_id: string;
      source: string;
      as_of: string;
      at: string;
      currency: string;
      minimum_order_minor: bigint | null;
      prepayment_percent_milli: bigint | null;
      minimum_order_quantity_milli: bigint | null;
      notes: string | null;
    }
    const row = this.db.prepare(`SELECT * FROM supplier_info WHERE info_seq = ?`).get(infoSeq) as
      | InfoRow
      | undefined;
    if (!row) return undefined;
    interface ShippingRow {
      method: string;
      cost_minor: bigint | null;
      free_above_minor: bigint | null;
      min_days: bigint | null;
      max_days: bigint | null;
    }
    const shipping: ShippingEstimate[] = (
      this.db
        .prepare(`SELECT * FROM supplier_info_shipping WHERE info_seq = ? ORDER BY shipping_no`)
        .all(infoSeq) as ShippingRow[]
    ).map((estimate) => ({
      method: estimate.method,
      costMinor: estimate.cost_minor,
      freeAboveMinor: estimate.free_above_minor,
      minDays: estimate.min_days === null ? null : Number(estimate.min_days),
      maxDays: estimate.max_days === null ? null : Number(estimate.max_days),
    }));
    interface TermRow {
      item_id: string;
      unit_cost: bigint;
      supplier_sku: string | null;
      in_stock: bigint | null;
      min_quantity_milli: bigint | null;
      multiple_quantity_milli: bigint | null;
      lead_days: bigint | null;
    }
    const items: SupplierItemTerm[] = (
      this.db
        .prepare(`SELECT * FROM supplier_info_items WHERE info_seq = ? ORDER BY rowid`)
        .all(infoSeq) as TermRow[]
    ).map((term) => ({
      itemId: term.item_id,
      unitCost: term.unit_cost,
      supplierSku: term.supplier_sku,
      inStock: term.in_stock === null ? null : term.in_stock === 1n,
      minQuantityMilli: term.min_quantity_milli,
      multipleQuantityMilli: term.multiple_quantity_milli,
      leadDays: term.lead_days === null ? null : Number(term.lead_days),
    }));
    return {
      infoSeq: Number(row.info_seq),
      partyId: row.party_id,
      source: row.source,
      asOf: row.as_of,
      at: row.at,
      currency: row.currency,
      minimumOrderMinor: row.minimum_order_minor,
      prepaymentPercentMilli: row.prepayment_percent_milli,
      minimumOrderQuantityMilli: row.minimum_order_quantity_milli,
      shipping,
      items,
      notes: row.notes,
    };
  }

  /** Cumulative quantity of a sales-order line already on other purchase orders. */
  private priorLinkedMilli(salesOrderId: string, lineId: string, excludeDocumentId?: string): bigint {
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(l.quantity_milli), 0) AS total
         FROM documents d
         JOIN document_revision_lines l ON l.document_id = d.id
           AND l.revision_no = (SELECT max(revision_no) FROM document_revisions WHERE document_id = d.id)
         WHERE d.type = 'purchase_order' AND d.status != 'void' AND d.id IS NOT ?
           AND l.source_document_id = ? AND l.source_line_id = ?`,
      )
      .get(excludeDocumentId ?? null, salesOrderId, lineId) as { total: bigint };
    return row.total;
  }

  /**
   * ADR 0011 part 5: PO line links must target existing sales-order lines,
   * and the cumulative linked quantity across non-void purchase orders may
   * not exceed what the sales order promises.
   */
  private validatePurchaseLinks(lines: readonly DocumentLine[], excludeDocumentId?: string): void {
    const consumed = new Map<string, bigint>();
    for (const line of lines) {
      if (line.sourceDocumentId === null || line.sourceLineId === null) continue;
      const source = this.getDocumentRecord(line.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${line.sourceDocumentId}`);
      }
      if (source.type !== 'sales_order') {
        throw new LedgerError('INVALID_DOCUMENT', 'Purchase-order lines may only link to sales-order lines');
      }
      const current = source.revisions[source.revisions.length - 1]!;
      if (!current.lines.some((candidate) => candidate.lineId === line.sourceLineId)) {
        throw new LedgerError('UNKNOWN_LINE', `Sales order ${source.number} has no line ${line.sourceLineId}`);
      }
      const key = `${line.sourceDocumentId}#${line.sourceLineId}`;
      consumed.set(key, (consumed.get(key) ?? 0n) + line.quantityMilli);
    }
    for (const [key, quantity] of consumed) {
      const [documentId, lineId] = key.split('#') as [string, string];
      const source = this.getDocumentRecord(documentId)!;
      const sourceLine = source.revisions[source.revisions.length - 1]!.lines.find(
        (candidate) => candidate.lineId === lineId,
      )!;
      const total = this.priorLinkedMilli(documentId, lineId, excludeDocumentId) + quantity;
      if (total > sourceLine.quantityMilli) {
        throw new LedgerError(
          'LINE_OVERDRAWN',
          `Ordering ${total} (milli) of "${sourceLine.description}" exceeds the ${sourceLine.quantityMilli} on the sales order; order overage as an unlinked line`,
        );
      }
    }
  }

  /** How much of each sales-order line is on order with suppliers (ADR 0011). */
  purchaseCoverage(salesOrderId: string): PurchaseCoverageLine[] {
    const record = this.requireDocumentRecord(salesOrderId);
    if (record.type !== 'sales_order') {
      throw new LedgerError('INVALID_DOCUMENT', 'Purchase coverage applies to sales orders');
    }
    const rows = this.db
      .prepare(
        `SELECT l.source_line_id AS lineId, d.status AS status, sum(l.quantity_milli) AS total
         FROM documents d
         JOIN document_revision_lines l ON l.document_id = d.id
           AND l.revision_no = (SELECT max(revision_no) FROM document_revisions WHERE document_id = d.id)
         WHERE d.type = 'purchase_order' AND d.status != 'void'
           AND l.source_document_id = ? AND l.source_line_id IS NOT NULL
         GROUP BY l.source_line_id, d.status`,
      )
      .all(salesOrderId) as { lineId: string; status: 'draft' | 'sent'; total: bigint }[];
    const linked = new Map<string, { draftMilli: bigint; sentMilli: bigint }>();
    for (const row of rows) {
      const entry = linked.get(row.lineId) ?? { draftMilli: 0n, sentMilli: 0n };
      if (row.status === 'sent') entry.sentMilli += row.total;
      else entry.draftMilli += row.total;
      linked.set(row.lineId, entry);
    }
    const current = record.revisions[record.revisions.length - 1]!;
    return computePurchaseCoverage(current.lines, linked);
  }

  /** Readiness of a purchase order against the supplier's terms (ADR 0011 part 7). */
  purchaseOrderReadiness(id: string): PurchaseReadiness {
    const document = this.requireDocumentRecord(id);
    if (document.type !== 'purchase_order') {
      throw new LedgerError('INVALID_DOCUMENT', 'Readiness applies to purchase orders');
    }
    const current = document.revisions[document.revisions.length - 1]!;
    const info =
      document.partyId !== null ? this.supplierInfoAt(document.partyId, current.date) : undefined;
    return computePurchaseReadiness(current.lines, info);
  }

  // ── Payments & credit application (Tier 1, ADR 0008) ────────────────────

  /** Record money received; optionally apply it to invoices immediately. */
  recordPayment(input: NewPayment): Payment {
    if (input.amount <= 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Payment amounts must be positive');
    }
    const customer = this.resolveCustomer(input);
    const payment: Payment = {
      id: randomUUID(),
      number: input.number ?? '', // resolved inside the transaction
      direction: input.direction ?? 'in',
      date: input.date,
      partyId: customer.partyId,
      customerName: customer.customerName,
      accountNumber: customer.accountNumber ?? null,
      poNumber: input.poNumber ?? null,
      memo: input.memo ?? null,
      method: input.method ?? null,
      amountMinor: input.amount,
      status: 'received',
    };
    let resolvedNumber = payment.number;
    this.db.transaction(() => {
      resolvedNumber = input.number ?? this.drawNumber('payment');
      try {
        this.db
          .prepare(
            `INSERT INTO payments (id, number, direction, date, party_id, customer_name, account_number, po_number, memo, method, amount, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
          )
          .run(
            payment.id,
            resolvedNumber,
            payment.direction,
            payment.date,
            payment.partyId,
            payment.customerName,
            payment.accountNumber,
            payment.poNumber,
            payment.memo,
            payment.method,
            payment.amountMinor,
          );
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: payments.number')) {
          throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Payment number already in use: ${resolvedNumber}`);
        }
        throw error;
      }
      this.audit('payment.recorded', 'payment', payment.id, {
        number: resolvedNumber,
        amount: payment.amountMinor.toString(),
        customerName: payment.customerName,
      });
      for (const application of input.applications ?? []) {
        this.applyCreditInternal(
          { sourceKind: 'payment', sourceId: payment.id, ...application },
          input.date,
        );
      }
      const plan = planPosting(
        payment.direction === 'out' ? 'disbursement' : 'payment',
        payment.amountMinor,
        this.info().baseCurrency,
        payment.date,
        this.postingAccounts(),
        `Payment ${resolvedNumber} (${payment.direction === 'out' ? 'to' : 'from'} ${payment.customerName})`,
      );
      if (plan) {
        const entry = this.postEntry(plan);
        this.recordPosting('payment', payment.id, entry.id, 'post');
      }
    })();
    return { ...payment, number: resolvedNumber };
  }

  getPayment(id: string): Payment | undefined {
    interface PaymentRow {
      id: string;
      number: string;
      direction: Payment['direction'];
      date: string;
      party_id: string | null;
      customer_name: string;
      account_number: string | null;
      po_number: string | null;
      memo: string | null;
      method: string | null;
      amount: bigint;
      status: Payment['status'];
    }
    const row = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as PaymentRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      number: row.number,
      direction: row.direction,
      date: row.date,
      partyId: row.party_id,
      customerName: row.customer_name,
      accountNumber: row.account_number,
      poNumber: row.po_number,
      memo: row.memo,
      method: row.method,
      amountMinor: row.amount,
      status: row.status,
    };
  }

  listPayments(): Payment[] {
    const rows = this.db.prepare(`SELECT id FROM payments ORDER BY date, number`).all() as { id: string }[];
    return rows.map((row) => this.getPayment(row.id)!);
  }

  voidPayment(id: string): Payment {
    const payment = this.getPayment(id);
    if (!payment) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such payment: ${id}`);
    }
    if (payment.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Payment is already void');
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE payments SET status = 'void' WHERE id = ?`).run(id);
      this.audit('payment.voided', 'payment', id, {});
      this.reversePostingIfActive('payment', id, payment.date, `Reversal: payment ${payment.number} voided`);
    })();
    return { ...payment, status: 'void' };
  }

  listApplications(): CreditApplication[] {
    interface ApplicationRow {
      application_seq: bigint;
      source_kind: CreditApplication['sourceKind'];
      source_id: string;
      invoice_id: string | null;
      line_id: string | null;
      refund: bigint;
      amount: bigint;
      date: string;
      at: string;
      reverses_application_seq: bigint | null;
    }
    const rows = this.db
      .prepare(`SELECT * FROM credit_applications ORDER BY application_seq`)
      .all() as ApplicationRow[];
    return rows.map((row) => ({
      applicationSeq: Number(row.application_seq),
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      invoiceId: row.invoice_id,
      lineId: row.line_id,
      refund: row.refund === 1n,
      amountMinor: row.amount,
      date: row.date,
      at: row.at,
      reversesApplicationSeq:
        row.reverses_application_seq === null ? null : Number(row.reverses_application_seq),
    }));
  }

  /** Apply credit from a payment or account credit memo against an invoice. */
  applyCredit(
    input: { sourceKind: CreditApplication['sourceKind']; sourceId: string } & NewApplication,
    date?: string,
  ): CreditApplication {
    let application!: CreditApplication;
    this.db.transaction(() => {
      application = this.applyCreditInternal(input, date);
    })();
    return application;
  }

  private applyCreditInternal(
    input: { sourceKind: CreditApplication['sourceKind']; sourceId: string } & NewApplication,
    date?: string,
  ): CreditApplication {
    const source = this.sourceState(input.sourceKind, input.sourceId);
    const invoice = this.requireDocumentRecord(input.invoiceId);
    const applications = this.listApplications();
    const remaining =
      source.total - appliedFromSource(applications, input.sourceKind, input.sourceId);
    const settlement = this.invoiceSettlement(input.invoiceId);
    validateApplication(input.amount, remaining, invoice, settlement.open, source);
    // Line-level prepayments are a sales-order-only concept (ADR 0010 part 3).
    if (input.lineId !== undefined) {
      if (invoice.type !== 'sales_order') {
        throw new LedgerError('INVALID_DOCUMENT', 'Line-level prepayments apply only to sales orders');
      }
      const current = invoice.revisions[invoice.revisions.length - 1]!;
      const line = current.lines.find((candidate) => candidate.lineId === input.lineId);
      if (!line) {
        throw new LedgerError('UNKNOWN_LINE', `No such line: ${input.lineId}`);
      }
      const lineOpen =
        lineGrossTotal(line) -
        appliedToLine(applications, invoice.id, input.lineId, (kind, id) => this.isSourceActive(kind, id));
      if (input.amount > lineOpen) {
        throw new LedgerError(
          'INVALID_ALLOCATION',
          `Prepaying ${input.amount} exceeds the line's remaining ${lineOpen}`,
        );
      }
    }
    const effectiveDate = date ?? invoice.revisions[invoice.revisions.length - 1]!.date;
    const at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO credit_applications (source_kind, source_id, invoice_id, line_id, refund, amount, date, at, reverses_application_seq)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL)`,
      )
      .run(input.sourceKind, input.sourceId, input.invoiceId, input.lineId ?? null, input.amount, effectiveDate, at);
    const seq = Number(result.lastInsertRowid);
    this.audit('credit.applied', 'credit_application', String(seq), {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      invoiceId: input.invoiceId,
      amount: input.amount.toString(),
    });
    return {
      applicationSeq: seq,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      invoiceId: input.invoiceId,
      lineId: input.lineId ?? null,
      refund: false,
      amountMinor: input.amount,
      date: effectiveDate,
      at,
      reversesApplicationSeq: null,
    };
  }

  /**
   * Pay out (part of) a credit source's unapplied balance (ADR 0013).
   * Posts by the source's direction (refund_out / refund_in) when the
   * roles are mapped; reversing the refund reverses the posting too.
   */
  refundCredit(input: {
    sourceKind: CreditApplication['sourceKind'];
    sourceId: string;
    amount: bigint;
    date?: string;
    approvedBy?: string;
  }): CreditApplication {
    this.requireApproval('refund_credit', input.approvedBy);
    const source = this.sourceState(input.sourceKind, input.sourceId);
    if (input.amount <= 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Refund amounts must be positive');
    }
    const remaining =
      source.total - appliedFromSource(this.listApplications(), input.sourceKind, input.sourceId);
    if (input.amount > remaining) {
      throw new LedgerError(
        'INVALID_ALLOCATION',
        `Refunding ${input.amount} exceeds the source's unapplied ${remaining}`,
      );
    }
    const at = new Date().toISOString();
    const date = input.date ?? at.slice(0, 10);
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO credit_applications (source_kind, source_id, invoice_id, line_id, refund, amount, date, at, reverses_application_seq)
           VALUES (?, ?, NULL, NULL, 1, ?, ?, ?, NULL)`,
        )
        .run(input.sourceKind, input.sourceId, input.amount, date, at);
      seq = Number(result.lastInsertRowid);
      this.audit('credit.refunded', 'credit_application', String(seq), {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        amount: input.amount.toString(),
      });
      const plan = planPosting(
        source.direction === 'out' ? 'refund_in' : 'refund_out',
        input.amount,
        this.info().baseCurrency,
        date,
        this.postingAccounts(),
        `Refund of ${input.sourceKind} credit (${source.customerName})`,
      );
      if (plan) {
        const entry = this.postEntry(plan);
        this.recordPosting('refund', String(seq), entry.id, 'post');
      }
    })();
    return {
      applicationSeq: seq,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      invoiceId: null,
      lineId: null,
      refund: true,
      amountMinor: input.amount,
      date,
      at,
      reversesApplicationSeq: null,
    };
  }

  /** Undo an application (appends a reversal record; nothing is edited). */
  reverseApplication(applicationSeq: number): CreditApplication {
    const applications = this.listApplications();
    const target = applications.find((application) => application.applicationSeq === applicationSeq);
    if (!target || target.reversesApplicationSeq !== null) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such application: ${applicationSeq}`);
    }
    if (applications.some((application) => application.reversesApplicationSeq === applicationSeq)) {
      throw new LedgerError('ALREADY_REVERSED', `Application already reversed: ${applicationSeq}`);
    }
    const at = new Date().toISOString();
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO credit_applications (source_kind, source_id, invoice_id, line_id, refund, amount, date, at, reverses_application_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(target.sourceKind, target.sourceId, target.invoiceId, target.lineId, target.refund ? 1 : 0, target.amountMinor, target.date, at, applicationSeq);
      seq = Number(result.lastInsertRowid);
      this.audit('credit.application_reversed', 'credit_application', String(seq), {
        reverses: applicationSeq,
      });
      if (target.refund) {
        this.reversePostingIfActive('refund', String(applicationSeq), target.date, `Reversal: refund #${applicationSeq} undone`);
      }
    })();
    return { ...target, applicationSeq: seq, at, reversesApplicationSeq: applicationSeq };
  }

  private isSourceActive(kind: CreditApplication['sourceKind'], id: string): boolean {
    if (kind === 'payment') {
      return this.getPayment(id)?.status === 'received';
    }
    const record = this.getDocumentRecord(id);
    return record?.type === kind && record.status === 'sent' && record.settlement === 'account';
  }

  private sourceState(kind: CreditApplication['sourceKind'], id: string): {
    customerName: string;
    accountNumber: string | null;
    direction: 'in' | 'out';
    total: bigint;
  } {
    if (kind === 'payment') {
      const payment = this.getPayment(id);
      if (!payment) throw new LedgerError('UNKNOWN_DOCUMENT', `No such payment: ${id}`);
      if (payment.status !== 'received') {
        throw new LedgerError('INVALID_STATUS', 'Void payments cannot be applied');
      }
      return {
        customerName: payment.customerName,
        accountNumber: payment.accountNumber,
        direction: payment.direction,
        total: payment.amountMinor,
      };
    }
    const label = kind === 'vendor_credit' ? 'vendor credit' : 'credit memo';
    const record = this.getDocumentRecord(id);
    if (!record || record.type !== kind) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such ${label}: ${id}`);
    }
    if (record.status !== 'sent') {
      throw new LedgerError('INVALID_STATUS', `Only sent ${label}s can be applied`);
    }
    if (record.settlement !== 'account') {
      throw new LedgerError('INVALID_DOCUMENT', `Refund ${label}s were paid out and cannot be applied`);
    }
    const current = record.revisions[record.revisions.length - 1]!;
    // A vendor credit reduces what we owe: outbound credit (ADR 0013).
    return {
      customerName: current.customerName,
      accountNumber: current.accountNumber,
      direction: kind === 'vendor_credit' ? 'out' : 'in',
      total: revisionGrandTotal(current),
    };
  }

  /** Derived paid/open state of an invoice — never stored (Tier 1). */
  invoiceSettlement(invoiceId: string, asOf?: string): InvoiceSettlement {
    const invoice = this.requireDocumentRecord(invoiceId);
    const current = invoice.revisions[invoice.revisions.length - 1]!;
    const paid = appliedToInvoice(
      this.listApplications(),
      invoiceId,
      (kind, id) => this.isSourceActive(kind, id),
      asOf,
    );
    return settle(revisionGrandTotal(current), paid);
  }

  // ── Ledger posting (Tier 1, ADR 0008 part 3) ────────────────────────────

  /** Map a posting role to a ledger account; posting activates once mapped. */
  setPostingAccount(role: PostingRole, accountId: string): void {
    if (!this.getAccount(accountId)) {
      throw new LedgerError('UNKNOWN_ACCOUNT', `No such account: ${accountId}`);
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO posting_accounts (role, account_id) VALUES (?, ?)
           ON CONFLICT(role) DO UPDATE SET account_id = excluded.account_id`,
        )
        .run(role, accountId);
      this.audit('posting.account_set', 'posting_account', role, { accountId });
    })();
  }

  postingAccounts(): Partial<Record<PostingRole, string>> {
    const rows = this.db
      .prepare(`SELECT role, account_id AS accountId FROM posting_accounts`)
      .all() as { role: PostingRole; accountId: string }[];
    return Object.fromEntries(rows.map((row) => [row.role, row.accountId]));
  }

  listPostings(sourceKind?: 'document' | 'payment' | 'refund', sourceId?: string): {
    postingSeq: number;
    sourceKind: 'document' | 'payment' | 'refund';
    sourceId: string;
    entryId: string;
    kind: 'post' | 'reversal';
    at: string;
  }[] {
    interface PostingRow {
      posting_seq: bigint;
      source_kind: 'document' | 'payment' | 'refund';
      source_id: string;
      entry_id: string;
      kind: 'post' | 'reversal';
      at: string;
    }
    const rows = (
      sourceKind !== undefined && sourceId !== undefined
        ? this.db
            .prepare(`SELECT * FROM postings WHERE source_kind = ? AND source_id = ? ORDER BY posting_seq`)
            .all(sourceKind, sourceId)
        : this.db.prepare(`SELECT * FROM postings ORDER BY posting_seq`).all()
    ) as PostingRow[];
    return rows.map((row) => ({
      postingSeq: Number(row.posting_seq),
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      entryId: row.entry_id,
      kind: row.kind,
      at: row.at,
    }));
  }

  private activePostingEntry(sourceKind: 'document' | 'payment' | 'refund', sourceId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT entry_id AS entryId, kind FROM postings
         WHERE source_kind = ? AND source_id = ? ORDER BY posting_seq DESC LIMIT 1`,
      )
      .get(sourceKind, sourceId) as { entryId: string; kind: 'post' | 'reversal' } | undefined;
    return row?.kind === 'post' ? row.entryId : undefined;
  }

  private recordPosting(
    sourceKind: 'document' | 'payment' | 'refund',
    sourceId: string,
    entryId: string,
    kind: 'post' | 'reversal',
  ): void {
    this.db
      .prepare(`INSERT INTO postings (source_kind, source_id, entry_id, kind, at) VALUES (?, ?, ?, ?, ?)`)
      .run(sourceKind, sourceId, entryId, kind, new Date().toISOString());
    this.audit('ledger.posted', 'posting', sourceId, { sourceKind, entryId, kind });
  }

  /**
   * Post a sent document with inventory accounting (ADR 0015). COGS and
   * inventory values come from the FIFO engine over the (already-written)
   * movement ledger; with the inventory roles unmapped, this degrades to the
   * pre-inventory revenue/purchases behavior.
   */
  private postDocumentIfConfigured(record: DocumentRecord): void {
    let kind: DocumentPostingKind;
    if (record.type === 'invoice') kind = 'invoice';
    else if (record.type === 'bill') kind = 'bill';
    else if (record.type === 'receipt') kind = 'receipt';
    else if (record.type === 'credit_memo') {
      kind = record.settlement === 'refund' ? 'credit_refund' : 'credit_account';
    } else if (record.type === 'vendor_credit') {
      kind = record.settlement === 'refund' ? 'vendor_credit_refund' : 'vendor_credit_account';
    } else return;
    const current = record.revisions[record.revisions.length - 1]!;
    const amounts: DocumentPostingAmounts = {
      net: revisionTotal(current),
      tax: revisionTax(current),
      inventory: this.documentInventoryValue(record),
    };
    if (record.type === 'bill') {
      const grni = this.billGrniValue(record);
      amounts.grni = grni;
      amounts.inventory += grni; // direct-billed value + GRNI-cleared portion
    }
    const plan = planDocumentPosting(
      kind,
      amounts,
      current.lines[0]!.currency,
      current.date,
      this.postingAccounts(),
      `${record.number} (${current.customerName})`,
    );
    if (!plan) return;
    const entry = this.postEntry(plan);
    this.recordPosting('document', record.id, entry.id, 'post');
  }

  /** Absolute net FIFO inventory value this document moved (ADR 0015). */
  private documentInventoryValue(record: DocumentRecord): bigint {
    const current = record.revisions[record.revisions.length - 1]!;
    const items = new Set<string>();
    for (const line of current.lines) {
      if (line.itemId !== null) items.add(line.itemId);
    }
    let net = 0n;
    for (const itemId of items) {
      if (this.getItem(itemId)?.kind !== 'inventory') continue;
      net += this.itemValuation(itemId).costBySource.get(record.id) ?? 0n;
    }
    return net < 0n ? -net : net;
  }

  /** Value of a bill's inventory lines already received via a receipt (GRNI). */
  private billGrniValue(record: DocumentRecord): bigint {
    const current = record.revisions[record.revisions.length - 1]!;
    let grni = 0n;
    for (const line of current.lines) {
      if (line.itemId === null || this.getItem(line.itemId)?.kind !== 'inventory') continue;
      if (line.sourceDocumentId !== null && this.getDocumentRecord(line.sourceDocumentId)?.type === 'receipt') {
        grni += customerLineTotal(line);
      }
    }
    return grni;
  }

  private reversePostingIfActive(
    sourceKind: 'document' | 'payment' | 'refund',
    sourceId: string,
    date: string,
    memo: string,
  ): void {
    const entryId = this.activePostingEntry(sourceKind, sourceId);
    if (entryId === undefined) return;
    const reversal = this.reverseEntry(entryId, date, memo);
    this.recordPosting(sourceKind, sourceId, reversal.id, 'reversal');
  }

  /**
   * Corrections on sent, posted documents reverse the original entry and post
   * the corrected one in the same transaction (ADR 0004 / ADR 0008).
   */
  private repostDocumentIfPosted(id: string): void {
    const record = this.requireDocumentRecord(id);
    if (record.status !== 'sent') return;
    if (this.activePostingEntry('document', id) === undefined) return;
    const current = record.revisions[record.revisions.length - 1]!;
    this.reversePostingIfActive('document', id, current.date, `Reversal: ${record.number} corrected`);
    this.postDocumentIfConfigured(record);
  }

  // ── Bank import & reconciliation (ADR 0019) ──────────────────────────────

  /** Idempotent per source: overlapping exports skip already-imported rows. */
  importBankTransactions(source: string, csvText: string): { imported: number; skipped: number } {
    if (!source.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Bank import needs a source name');
    }
    const rows = parseBankCsv(csvText, this.info().baseCurrency);
    let imported = 0;
    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO bank_transactions (source, date, amount, description, reference, dedupe_key, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, dedupe_key) DO NOTHING`,
      );
      for (const row of rows) {
        const result = insert.run(
          source.trim(),
          row.date,
          row.amountMinor,
          row.description,
          row.reference ?? null,
          bankDedupeKey(row),
          new Date().toISOString(),
        );
        if (result.changes > 0) imported += 1;
      }
      this.audit('bank.imported', 'bank_source', source.trim(), { rows: rows.length, imported });
    })();
    return { imported, skipped: rows.length - imported };
  }

  listBankTransactions(source?: string): BankTransaction[] {
    interface Row {
      bank_seq: bigint;
      source: string;
      date: string;
      amount: bigint;
      description: string;
      reference: string | null;
      dedupe_key: string;
      imported_at: string;
    }
    const rows = (
      source !== undefined
        ? this.db.prepare(`SELECT * FROM bank_transactions WHERE source = ? ORDER BY bank_seq`).all(source)
        : this.db.prepare(`SELECT * FROM bank_transactions ORDER BY bank_seq`).all()
    ) as Row[];
    return rows.map((row) => ({
      bankSeq: Number(row.bank_seq),
      source: row.source,
      date: row.date,
      amountMinor: row.amount,
      description: row.description,
      reference: row.reference,
      dedupeKey: row.dedupe_key,
      importedAt: row.imported_at,
    }));
  }

  /** Active (non-reversed) marks: bankSeq → paymentId. */
  private activeReconciliations(): Map<number, { reconSeq: number; paymentId: string }> {
    interface Row { recon_seq: bigint; bank_seq: bigint; payment_id: string; reverses_recon_seq: bigint | null }
    const rows = this.db.prepare(`SELECT * FROM bank_reconciliations ORDER BY recon_seq`).all() as Row[];
    const reversed = new Set(rows.map((row) => row.reverses_recon_seq).filter((seq): seq is bigint => seq !== null).map(Number));
    const active = new Map<number, { reconSeq: number; paymentId: string }>();
    for (const row of rows) {
      if (row.reverses_recon_seq !== null || reversed.has(Number(row.recon_seq))) continue;
      active.set(Number(row.bank_seq), { reconSeq: Number(row.recon_seq), paymentId: row.payment_id });
    }
    return active;
  }

  /**
   * Active (unreversed) reconciliation marks, one per bank line. Added for
   * the web UI (ADR 0020) — the first read a real client needed that the
   * API's own tests never did.
   */
  bankReconciliations(): { bankSeq: number; reconSeq: number; paymentId: string }[] {
    return [...this.activeReconciliations().entries()].map(([bankSeq, entry]) => ({ bankSeq, ...entry }));
  }

  /** Pure suggestions: nothing is written until the user confirms a match. */
  bankMatchSuggestions(source?: string, windowDays = 3): BankMatchSuggestion[] {
    const active = this.activeReconciliations();
    const reconciledPayments = new Set([...active.values()].map((entry) => entry.paymentId));
    return matchBankTransactions(
      this.listBankTransactions(source),
      this.listPayments(),
      (bankSeq) => active.has(bankSeq),
      reconciledPayments,
      windowDays,
    );
  }

  /** Confirm a match; amount and direction are re-validated at write time. */
  reconcileBankTransaction(bankSeq: number, paymentId: string): { reconSeq: number } {
    const transaction = this.listBankTransactions().find((row) => row.bankSeq === bankSeq);
    if (!transaction) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such bank transaction: ${bankSeq}`);
    }
    const payment = this.getPayment(paymentId);
    if (!payment || payment.status !== 'received') {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No received payment: ${paymentId}`);
    }
    const active = this.activeReconciliations();
    if (active.has(bankSeq)) {
      throw new LedgerError('ALREADY_RECONCILED', `Bank transaction ${bankSeq} is already reconciled`);
    }
    if ([...active.values()].some((entry) => entry.paymentId === paymentId)) {
      throw new LedgerError('ALREADY_RECONCILED', `Payment ${payment.number} is already reconciled`);
    }
    const direction = transaction.amountMinor > 0n ? 'in' : 'out';
    const magnitude = transaction.amountMinor > 0n ? transaction.amountMinor : -transaction.amountMinor;
    if (payment.direction !== direction || payment.amountMinor !== magnitude) {
      throw new LedgerError(
        'INVALID_ALLOCATION',
        `Bank line ${bankSeq} (${transaction.amountMinor}) does not match payment ${payment.number} (${payment.direction} ${payment.amountMinor})`,
      );
    }
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(`INSERT INTO bank_reconciliations (bank_seq, payment_id, at, reverses_recon_seq) VALUES (?, ?, ?, NULL)`)
        .run(bankSeq, paymentId, new Date().toISOString());
      seq = Number(result.lastInsertRowid);
      this.audit('bank.reconciled', 'bank_transaction', String(bankSeq), { paymentId, reconSeq: seq });
    })();
    return { reconSeq: seq };
  }

  /** Undo a mark by appending a reversal — never a delete (ADR 0019). */
  unreconcileBankTransaction(reconSeq: number): { reconSeq: number } {
    interface Row { recon_seq: bigint; bank_seq: bigint; payment_id: string; reverses_recon_seq: bigint | null }
    const target = this.db.prepare(`SELECT * FROM bank_reconciliations WHERE recon_seq = ?`).get(reconSeq) as Row | undefined;
    if (!target || target.reverses_recon_seq !== null) {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such reconciliation: ${reconSeq}`);
    }
    if (this.db.prepare(`SELECT 1 FROM bank_reconciliations WHERE reverses_recon_seq = ?`).get(reconSeq)) {
      throw new LedgerError('ALREADY_REVERSED', `Reconciliation already reversed: ${reconSeq}`);
    }
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(`INSERT INTO bank_reconciliations (bank_seq, payment_id, at, reverses_recon_seq) VALUES (?, ?, ?, ?)`)
        .run(target.bank_seq, target.payment_id, new Date().toISOString(), reconSeq);
      seq = Number(result.lastInsertRowid);
      this.audit('bank.unreconciled', 'bank_transaction', String(Number(target.bank_seq)), { reverses: reconSeq });
    })();
    return { reconSeq: seq };
  }

  // ── Plugin host binding (ADR 0018) ───────────────────────────────────────

  private pluginHost: PluginHost<CompanyFile> | undefined;

  /** Bind an activated host; hook failures are audited, never thrown. */
  attachPlugins(host: PluginHost<CompanyFile>): void {
    this.pluginHost = host;
    host.onError = (pluginId, error) => {
      this.audit('plugin.error', 'plugin', pluginId, {
        message: error instanceof Error ? error.message : String(error),
      });
    };
  }

  plugins(): readonly PluginManifest[] {
    return this.pluginHost?.list() ?? [];
  }

  private emitDocumentEvent(event: 'document.created' | 'document.sent' | 'document.voided', id: string): void {
    this.pluginHost?.emit(event, this.viewDocument(id));
  }

  /** Pull fresh terms from the party's connector; recorded with plugin provenance. */
  async refreshSupplierInfo(partyId: string): Promise<SupplierInfo> {
    const entry = this.pluginHost?.connectorFor(partyId);
    if (!entry?.connector.fetchSupplierInfo) {
      throw new LedgerError('PLUGIN_ERROR', `No supplier connector can quote party ${partyId}`);
    }
    const quote = await entry.connector.fetchSupplierInfo();
    return this.recordSupplierInfo({ ...quote, partyId, source: entry.pluginId });
  }

  /**
   * Send a purchase order (every ADR 0011/0016 gate applies), then deliver it
   * through the party's connector when one exists. Manual send otherwise.
   * Submitting an already-sent order skips the send and retries delivery —
   * a connector failure never strands the order sent-but-undeliverable.
   */
  async submitPurchaseOrder(
    id: string,
    options?: { overrideDeposit?: boolean; overrideMinimum?: boolean; approvedBy?: string },
  ): Promise<{ view: DocumentView; reference: string | null }> {
    const record = this.requireDocumentRecord(id);
    if (record.type !== 'purchase_order') {
      throw new LedgerError('INVALID_DOCUMENT', 'Only purchase orders can be submitted');
    }
    if (record.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Void purchase orders cannot be submitted');
    }
    const view = record.status === 'draft' ? this.sendDocument(id, options) : this.viewDocument(id);
    const entry = record.partyId !== null ? this.pluginHost?.connectorFor(record.partyId) : undefined;
    if (!entry?.connector.submitPurchaseOrder) {
      return { view, reference: null };
    }
    const result = await entry.connector.submitPurchaseOrder(view);
    const reference = result.reference ?? null;
    this.audit('po.submitted', 'document', id, { pluginId: entry.pluginId, reference });
    return { view, reference };
  }

  pluginReportNames(): string[] {
    return this.pluginHost?.reportNames() ?? [];
  }

  runPluginReport(name: string, params: Readonly<Record<string, string>> = {}): unknown {
    if (!this.pluginHost) {
      throw new LedgerError('UNKNOWN_REPORT', 'No plugin host attached');
    }
    return this.pluginHost.runReport(name, this, params);
  }

  // ── Audit ───────────────────────────────────────────────────────────────

  private audit(action: string, entity: string, entityId: string, details: unknown): void {
    this.db
      .prepare(`INSERT INTO audit_log (actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)`)
      .run(this.actor, action, entity, entityId, JSON.stringify(details));
  }

  auditLog(): { at: string; actor: string; action: string; entity: string; entityId: string; details: string | null }[] {
    const rows = this.db
      .prepare(`SELECT at, actor, action, entity, entity_id AS entityId, details FROM audit_log ORDER BY id`)
      .all() as { at: string; actor: string; action: string; entity: string; entityId: string; details: string | null }[];
    return rows;
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    currency: row.currency,
    parentId: row.parent_id,
    archived: row.archived === 1n,
  };
}

function toEntry(entry: EntryRow, lines: LineRow[]): JournalEntry {
  return {
    id: entry.id,
    seq: Number(entry.seq),
    date: entry.date,
    memo: entry.memo,
    reversesEntryId: entry.reverses_entry_id,
    lines: lines.map((line) => ({
      accountId: line.account_id,
      side: line.side,
      amount: line.amount,
      currency: line.currency,
      memo: line.memo,
    })),
  };
}
