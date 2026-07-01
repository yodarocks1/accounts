import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  LedgerError,
  computeTrialBalance,
  currencyExponent,
  validateNewEntry,
  type Account,
  type JournalEntry,
  type NewAccount,
  type NewJournalEntry,
  type TrialBalance,
} from '@accounts/core';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

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
export class CompanyFile {
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
    db.exec(SCHEMA_SQL);
    const setMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`);
    db.transaction(() => {
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
    if (Number(row.value) > SCHEMA_VERSION) {
      db.close();
      throw new LedgerError('EMPTY_ENTRY', `Company file is schema v${row.value}; this build supports v${SCHEMA_VERSION}`);
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
