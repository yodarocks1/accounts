import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  LedgerError,
  appliedFromSource,
  appliedToInvoice,
  buildConversionLines,
  buildReturnLine,
  computeFulfillment,
  computeRateSuggestions,
  computeStatement,
  computeTrialBalance,
  currencyExponent,
  defaultAllowBelowCost,
  deriveTags,
  planChargeCorrection,
  resolveRatePrice,
  revisionTotal,
  settle,
  validateApplication,
  resolveDocumentLines,
  resolveRevisionKind,
  validateConversion,
  validateLineConsumption,
  validateNewEntry,
  validateTermsDays,
  validateRevisionContent,
  viewDocument,
  type Account,
  type ConversionSpec,
  type DocumentChanges,
  type DocumentRecord,
  type DocumentRevision,
  type DocumentTag,
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
  type CustomerQuery,
  type CustomerRate,
  type NewCustomerRate,
  type SpecialRateSuggestion,
  type AgingRule,
  type Statement,
  type TrialBalance,
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

  // ── Items & price history (ADR 0004) ────────────────────────────────────

  createItem(input: NewItem): Item {
    currencyExponent(input.currency);
    if (!input.name.trim()) {
      throw new LedgerError('UNKNOWN_ITEM', 'Item name must not be empty');
    }
    const item: Item = { id: randomUUID(), name: input.name.trim(), currency: input.currency };
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO items (id, name, currency) VALUES (?, ?, ?)`)
        .run(item.id, item.name, item.currency);
      this.insertPrice(item.id, 'sale', input.unitPrice, input.effectiveFrom ?? '0000-01-01');
      if (input.cost !== undefined) {
        this.insertPrice(item.id, 'cost', input.cost, input.effectiveFrom ?? '0000-01-01');
      }
      this.audit('item.created', 'item', item.id, { name: item.name, currency: item.currency });
    })();
    return item;
  }

  getItem(id: string): Item | undefined {
    const row = this.db.prepare(`SELECT id, name, currency FROM items WHERE id = ?`).get(id) as
      | Item
      | undefined;
    return row;
  }

  listItems(): Item[] {
    return this.db.prepare(`SELECT id, name, currency FROM items ORDER BY name`).all() as Item[];
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
    return this.lookupPrice(itemId, 'cost', date);
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
    if (input.customerName === undefined && input.accountNumber === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'A rate needs a customer name or account number');
    }
    const effectiveFrom = input.effectiveFrom ?? '0000-01-01';
    const evalDate = input.effectiveFrom ?? '9999-12-31';
    const salePrice = this.priceAt(input.itemId, evalDate);
    const cost = this.costAt(input.itemId, evalDate);
    if (input.rate.kind === 'formula' && input.rate.base === 'cost' && cost === undefined) {
      throw new LedgerError('INVALID_DOCUMENT', 'Cost-based rate requires cost history for the item');
    }
    if (input.rate.kind === 'constant' && input.rate.unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Rates must not be negative');
    }
    const rate: CustomerRate = {
      rateSeq: 0, // assigned below
      itemId: input.itemId,
      customerName: input.customerName ?? null,
      accountNumber: input.accountNumber ?? null,
      kind: input.rate.kind,
      unitPrice: input.rate.kind === 'constant' ? input.rate.unitPrice : null,
      base: input.rate.kind === 'formula' ? input.rate.base : null,
      percentMilli: input.rate.kind === 'formula' ? (input.rate.percentMilli ?? 0n) : 0n,
      amountMinor: input.rate.kind === 'formula' ? (input.rate.amountMinor ?? 0n) : 0n,
      allowBelowCost: input.allowBelowCost ?? defaultAllowBelowCost(salePrice, cost),
      effectiveFrom,
      at: new Date().toISOString(),
    };
    let seq = 0;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO customer_rates
             (item_id, customer_name, account_number, kind, unit_price, base, percent_milli, amount_minor, allow_below_cost, effective_from, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rate.itemId,
          rate.customerName,
          rate.accountNumber,
          rate.kind,
          rate.unitPrice,
          rate.base,
          rate.percentMilli,
          rate.amountMinor,
          rate.allowBelowCost ? 1 : 0,
          rate.effectiveFrom,
          rate.at,
        );
      seq = Number(result.lastInsertRowid);
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
      customer_name: string | null;
      account_number: string | null;
      kind: CustomerRate['kind'];
      unit_price: bigint | null;
      base: CustomerRate['base'];
      percent_milli: bigint;
      amount_minor: bigint;
      allow_below_cost: bigint;
      effective_from: string;
      at: string;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM customer_rates
         WHERE item_id = ? AND effective_from <= ?
           AND ((account_number IS NOT NULL AND account_number = ?)
             OR (account_number IS NULL AND customer_name = ?))
         ORDER BY effective_from DESC, rate_seq DESC LIMIT 1`,
      )
      .get(itemId, date, customer.accountNumber ?? null, customer.customerName ?? null) as
      | RateRow
      | undefined;
    if (!row) return undefined;
    return {
      rateSeq: Number(row.rate_seq),
      itemId: row.item_id,
      customerName: row.customer_name,
      accountNumber: row.account_number,
      kind: row.kind,
      unitPrice: row.unit_price,
      base: row.base,
      percentMilli: row.percent_milli,
      amountMinor: row.amount_minor,
      allowBelowCost: row.allow_below_cost === 1n,
      effectiveFrom: row.effective_from,
      at: row.at,
    };
  }

  customerPriceAt(itemId: string, customer: CustomerQuery, date: string): bigint | undefined {
    const rate = this.customerRateAt(itemId, customer, date);
    if (!rate) return undefined;
    return resolveRatePrice(rate, this.priceAt(itemId, date), this.costAt(itemId, date));
  }

  /** "Should this special rate persist?" questions for a document (call after send). */
  suggestSpecialRates(documentId: string): SpecialRateSuggestion[] {
    return computeRateSuggestions(this.requireDocumentRecord(documentId), this);
  }

  // ── Documents (ADR 0004) ────────────────────────────────────────────────

  createDocument(input: NewDocument): DocumentView {
    if (!input.number.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Document number must not be empty');
    }
    if (input.settlement !== undefined && input.type !== 'credit_memo') {
      throw new LedgerError('INVALID_DOCUMENT', 'Only credit memos take a settlement mode');
    }
    const lines = resolveDocumentLines(input.lines, input.date, this, undefined, {
      customerName: input.customerName,
      ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
    });
    let inherited: readonly DocumentTag[] = [];
    if (input.sourceDocumentId !== undefined) {
      const source = this.getDocumentRecord(input.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${input.sourceDocumentId}`);
      }
      validateConversion(source, input.type, lines, this.fulfillment(source.id));
      inherited = deriveTags(source, this.lineClosures(source.id));
    }
    validateRevisionContent({ date: input.date, lines, customerName: input.customerName });
    const id = randomUUID();
    this.db.transaction(() => {
      try {
        this.db
          .prepare(
            `INSERT INTO documents (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.type,
            input.number.trim(),
            input.sourceDocumentId ?? null,
            inherited.includes('with corrections') ? 1 : 0,
            inherited.includes('with substitutions') ? 1 : 0,
            input.type === 'credit_memo' ? (input.settlement ?? 'account') : null,
          );
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: documents.type, documents.number')) {
          throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Number already in use: ${input.number}`);
        }
        throw error;
      }
      this.insertRevision(id, {
        revisionNo: 1,
        kind: 'initial',
        at: new Date().toISOString(),
        reason: null,
        date: input.date,
        customerName: input.customerName.trim(),
        accountNumber: input.accountNumber ?? null,
        poNumber: input.poNumber ?? null,
        termsDays: validateTermsDays(input.termsDays) ?? null,
        memo: input.memo ?? null,
        lines,
      });
      this.audit('document.created', 'document', id, { type: input.type, number: input.number });
    })();
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
        ? resolveDocumentLines(changes.lines, date, this, previous.lines, {
            customerName,
            ...(accountNumber !== null ? { accountNumber } : {}),
          })
        : [...previous.lines];
    validateRevisionContent({ date, lines, customerName });
    // ADR 0006: never orphan downstream links or over-consume a shrunk line.
    validateLineConsumption(lines, this.fulfillment(id));
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
        memo: changes.memo ?? previous.memo,
        lines,
      });
      this.audit('document.revised', 'document', id, { kind, reason: changes.reason ?? null });
    })();
    return this.viewDocument(id);
  }

  /**
   * "We accidentally charged the wrong amount": reduce a sent invoice's
   * customer total to `actualTotal`, pro rata with cost floors (ADR 0005).
   */
  chargeCorrection(id: string, actualTotal: bigint, reason?: string): DocumentView {
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
        memo: previous.memo,
        lines,
      });
      this.audit('document.charge_corrected', 'document', id, {
        actualTotal: actualTotal.toString(),
        reason: reason ?? null,
      });
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
      number: spec.number,
      date: spec.date,
      lines,
      sourceDocumentId: sourceId,
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
    const query: CustomerQuery = {
      customerName: input.customerName,
      ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
    };
    const invoices = this.listDocumentRecords('invoice');
    const lines = input.items.map((item) => buildReturnLine(item, query, input.date, invoices, this));
    return this.createDocument({
      type: 'credit_memo',
      number: input.number,
      date: input.date,
      lines,
      customerName: input.customerName,
      ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
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

  private listDocumentRecords(type: DocumentType): DocumentRecord[] {
    const rows = this.db.prepare(`SELECT id FROM documents WHERE type = ?`).all(type) as { id: string }[];
    return rows.map((row) => this.getDocumentRecord(row.id)!);
  }

  /** Explicitly close (part of) a line without fulfilling it (ADR 0005). */
  closeLine(documentId: string, input: NewLineClosure): LineClosure {
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

  sendDocument(id: string): DocumentView {
    const document = this.requireDocumentRecord(id);
    if (document.status !== 'draft') {
      throw new LedgerError('INVALID_STATUS', `Only draft documents can be sent (is ${document.status})`);
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE documents SET status = 'sent' WHERE id = ?`).run(id);
      this.audit('document.sent', 'document', id, {});
    })();
    return this.viewDocument(id);
  }

  voidDocument(id: string): DocumentView {
    const document = this.requireDocumentRecord(id);
    if (document.status === 'void') {
      throw new LedgerError('INVALID_STATUS', 'Document is already void');
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE documents SET status = 'void' WHERE id = ?`).run(id);
      this.audit('document.voided', 'document', id, {});
    })();
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
        `INSERT INTO document_revisions (document_id, revision_no, kind, at, reason, date, customer_name, account_number, po_number, terms_days, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        revision.memo,
      );
    const insertLine = this.db.prepare(
      `INSERT INTO document_revision_lines
         (document_id, revision_no, line_no, line_id, item_id, description, quantity_milli, unit_price, currency, adjustment, free, substituted, source_document_id, source_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    });
  }

  // ── Payments & credit application (Tier 1, ADR 0008) ────────────────────

  /** Record money received; optionally apply it to invoices immediately. */
  recordPayment(input: NewPayment): Payment {
    if (input.amount <= 0n) {
      throw new LedgerError('INVALID_ALLOCATION', 'Payment amounts must be positive');
    }
    if (!input.customerName.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Every transaction must carry a customer name (ADR 0006)');
    }
    const payment: Payment = {
      id: randomUUID(),
      number: input.number,
      date: input.date,
      customerName: input.customerName.trim(),
      accountNumber: input.accountNumber ?? null,
      poNumber: input.poNumber ?? null,
      memo: input.memo ?? null,
      method: input.method ?? null,
      amountMinor: input.amount,
      status: 'received',
    };
    this.db.transaction(() => {
      try {
        this.db
          .prepare(
            `INSERT INTO payments (id, number, date, customer_name, account_number, po_number, memo, method, amount, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
          )
          .run(
            payment.id,
            payment.number,
            payment.date,
            payment.customerName,
            payment.accountNumber,
            payment.poNumber,
            payment.memo,
            payment.method,
            payment.amountMinor,
          );
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: payments.number')) {
          throw new LedgerError('DUPLICATE_DOCUMENT_NUMBER', `Payment number already in use: ${input.number}`);
        }
        throw error;
      }
      this.audit('payment.recorded', 'payment', payment.id, {
        number: payment.number,
        amount: payment.amountMinor.toString(),
        customerName: payment.customerName,
      });
      for (const application of input.applications ?? []) {
        this.applyCreditInternal(
          { sourceKind: 'payment', sourceId: payment.id, ...application },
          input.date,
        );
      }
    })();
    return payment;
  }

  getPayment(id: string): Payment | undefined {
    interface PaymentRow {
      id: string;
      number: string;
      date: string;
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
      date: row.date,
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
    })();
    return { ...payment, status: 'void' };
  }

  listApplications(): CreditApplication[] {
    interface ApplicationRow {
      application_seq: bigint;
      source_kind: CreditApplication['sourceKind'];
      source_id: string;
      invoice_id: string;
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
    const effectiveDate = date ?? invoice.revisions[invoice.revisions.length - 1]!.date;
    const at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO credit_applications (source_kind, source_id, invoice_id, amount, date, at, reverses_application_seq)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(input.sourceKind, input.sourceId, input.invoiceId, input.amount, effectiveDate, at);
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
      amountMinor: input.amount,
      date: effectiveDate,
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
          `INSERT INTO credit_applications (source_kind, source_id, invoice_id, amount, date, at, reverses_application_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(target.sourceKind, target.sourceId, target.invoiceId, target.amountMinor, target.date, at, applicationSeq);
      seq = Number(result.lastInsertRowid);
      this.audit('credit.application_reversed', 'credit_application', String(seq), {
        reverses: applicationSeq,
      });
    })();
    return { ...target, applicationSeq: seq, at, reversesApplicationSeq: applicationSeq };
  }

  private isSourceActive(kind: CreditApplication['sourceKind'], id: string): boolean {
    if (kind === 'payment') {
      return this.getPayment(id)?.status === 'received';
    }
    const record = this.getDocumentRecord(id);
    return record?.type === 'credit_memo' && record.status === 'sent' && record.settlement === 'account';
  }

  private sourceState(kind: CreditApplication['sourceKind'], id: string): {
    customerName: string;
    accountNumber: string | null;
    total: bigint;
  } {
    if (kind === 'payment') {
      const payment = this.getPayment(id);
      if (!payment) throw new LedgerError('UNKNOWN_DOCUMENT', `No such payment: ${id}`);
      if (payment.status !== 'received') {
        throw new LedgerError('INVALID_STATUS', 'Void payments cannot be applied');
      }
      return { customerName: payment.customerName, accountNumber: payment.accountNumber, total: payment.amountMinor };
    }
    const record = this.getDocumentRecord(id);
    if (!record || record.type !== 'credit_memo') {
      throw new LedgerError('UNKNOWN_DOCUMENT', `No such credit memo: ${id}`);
    }
    if (record.status !== 'sent') {
      throw new LedgerError('INVALID_STATUS', 'Only sent credit memos can be applied');
    }
    if (record.settlement !== 'account') {
      throw new LedgerError('INVALID_DOCUMENT', 'Refund credit memos were paid out and cannot be applied');
    }
    const current = record.revisions[record.revisions.length - 1]!;
    return {
      customerName: current.customerName,
      accountNumber: current.accountNumber,
      total: revisionTotal(current),
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
    return settle(revisionTotal(current), paid);
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
