import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  LedgerError,
  computeTrialBalance,
  currencyExponent,
  deriveTags,
  resolveDocumentLines,
  resolveRevisionKind,
  validateNewEntry,
  validateRevisionContent,
  viewDocument,
  type Account,
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
  type NewAccount,
  type NewDocument,
  type NewItem,
  type NewJournalEntry,
  type TrialBalance,
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
      db.transaction(() => {
        for (const migration of MIGRATIONS.slice(fileVersion)) db.exec(migration);
        db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION));
      })();
    }
    return new CompanyFile(db, actor);
  }

  private static openDatabase(path: string, mustExist = false): Database.Database {
    const db = new Database(path, { fileMustExist: mustExist });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.defaultSafeIntegers(true); // INTEGER comes back as bigint, never float
    return db;
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
      this.insertPrice(item.id, input.unitPrice, input.effectiveFrom ?? '0000-01-01');
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

  /** Append a price record; never touches existing documents (ADR 0004). */
  setPrice(itemId: string, unitPrice: bigint, effectiveFrom: string): ItemPrice {
    if (!this.getItem(itemId)) {
      throw new LedgerError('UNKNOWN_ITEM', `No such item: ${itemId}`);
    }
    if (unitPrice < 0n) {
      throw new LedgerError('INVALID_DOCUMENT', 'Prices must not be negative');
    }
    let price!: ItemPrice;
    this.db.transaction(() => {
      price = this.insertPrice(itemId, unitPrice, effectiveFrom);
      this.audit('item.price_set', 'item', itemId, {
        unitPrice: unitPrice.toString(),
        effectiveFrom,
      });
    })();
    return price;
  }

  private insertPrice(itemId: string, unitPrice: bigint, effectiveFrom: string): ItemPrice {
    const next = this.db
      .prepare(`SELECT coalesce(max(price_seq), 0) + 1 AS seq FROM item_prices WHERE item_id = ?`)
      .get(itemId) as { seq: bigint };
    this.db
      .prepare(
        `INSERT INTO item_prices (item_id, price_seq, effective_from, unit_price) VALUES (?, ?, ?, ?)`,
      )
      .run(itemId, next.seq, effectiveFrom, unitPrice);
    return { itemId, priceSeq: Number(next.seq), effectiveFrom, unitPrice };
  }

  priceAt(itemId: string, date: string): bigint {
    const row = this.db
      .prepare(
        `SELECT unit_price AS unitPrice FROM item_prices
         WHERE item_id = ? AND effective_from <= ?
         ORDER BY effective_from DESC, price_seq DESC LIMIT 1`,
      )
      .get(itemId, date) as { unitPrice: bigint } | undefined;
    if (!row) {
      throw new LedgerError('UNKNOWN_ITEM', `Item ${itemId} has no price effective on ${date}`);
    }
    return row.unitPrice;
  }

  priceHistory(itemId: string): ItemPrice[] {
    const rows = this.db
      .prepare(
        `SELECT item_id AS itemId, price_seq AS priceSeq, effective_from AS effectiveFrom, unit_price AS unitPrice
         FROM item_prices WHERE item_id = ? ORDER BY price_seq`,
      )
      .all(itemId) as { itemId: string; priceSeq: bigint; effectiveFrom: string; unitPrice: bigint }[];
    return rows.map((row) => ({ ...row, priceSeq: Number(row.priceSeq) }));
  }

  // ── Documents (ADR 0004) ────────────────────────────────────────────────

  createDocument(input: NewDocument): DocumentView {
    if (!input.number.trim()) {
      throw new LedgerError('INVALID_DOCUMENT', 'Document number must not be empty');
    }
    let inherited: readonly DocumentTag[] = [];
    if (input.sourceDocumentId !== undefined) {
      const source = this.getDocumentRecord(input.sourceDocumentId);
      if (!source) {
        throw new LedgerError('UNKNOWN_DOCUMENT', `No such source document: ${input.sourceDocumentId}`);
      }
      inherited = deriveTags(source);
    }
    const lines = resolveDocumentLines(input.lines, input.date, this);
    validateRevisionContent({ date: input.date, lines });
    const id = randomUUID();
    this.db.transaction(() => {
      try {
        this.db
          .prepare(
            `INSERT INTO documents (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions)
             VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
          )
          .run(
            id,
            input.type,
            input.number.trim(),
            input.sourceDocumentId ?? null,
            inherited.includes('with corrections') ? 1 : 0,
            inherited.includes('with substitutions') ? 1 : 0,
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
        counterparty: input.counterparty ?? null,
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
    const lines =
      changes.lines !== undefined
        ? resolveDocumentLines(changes.lines, date, this)
        : [...previous.lines];
    validateRevisionContent({ date, lines });
    this.db.transaction(() => {
      this.insertRevision(id, {
        revisionNo: previous.revisionNo + 1,
        kind,
        at: new Date().toISOString(),
        reason: changes.reason ?? null,
        date,
        counterparty: changes.counterparty ?? previous.counterparty,
        memo: changes.memo ?? previous.memo,
        lines,
      });
      this.audit('document.revised', 'document', id, { kind, reason: changes.reason ?? null });
    })();
    return this.viewDocument(id);
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
      counterparty: string | null;
      memo: string | null;
    }
    const revisionRows = this.db
      .prepare(`SELECT * FROM document_revisions WHERE document_id = ? ORDER BY revision_no`)
      .all(id) as RevisionRow[];
    interface RevisionLineRow {
      revision_no: bigint;
      item_id: string | null;
      description: string;
      quantity_milli: bigint;
      unit_price: bigint;
      currency: string;
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
      inheritedTags,
      revisions: revisionRows.map((revision) => ({
        revisionNo: Number(revision.revision_no),
        kind: revision.kind,
        at: revision.at,
        reason: revision.reason,
        date: revision.date,
        counterparty: revision.counterparty,
        memo: revision.memo,
        lines: (linesByRevision.get(Number(revision.revision_no)) ?? []).map((line) => ({
          itemId: line.item_id,
          description: line.description,
          quantityMilli: line.quantity_milli,
          unitPrice: line.unit_price,
          currency: line.currency,
        })),
      })),
    };
  }

  viewDocument(id: string): DocumentView {
    return viewDocument(this.requireDocumentRecord(id));
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
        `INSERT INTO document_revisions (document_id, revision_no, kind, at, reason, date, counterparty, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        revision.revisionNo,
        revision.kind,
        revision.at,
        revision.reason,
        revision.date,
        revision.counterparty,
        revision.memo,
      );
    const insertLine = this.db.prepare(
      `INSERT INTO document_revision_lines (document_id, revision_no, line_no, item_id, description, quantity_milli, unit_price, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    revision.lines.forEach((line, index) => {
      insertLine.run(
        documentId,
        revision.revisionNo,
        index + 1,
        line.itemId,
        line.description,
        line.quantityMilli,
        line.unitPrice,
        line.currency,
      );
    });
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
