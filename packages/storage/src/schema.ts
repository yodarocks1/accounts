/**
 * Company-file schema v1. Amounts are INTEGER minor units (ADR 0002); posted
 * journal rows are frozen by triggers, not just by application code (ADR 0003).
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE accounts (
  id        TEXT PRIMARY KEY,
  code      TEXT UNIQUE,
  name      TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type      TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  currency  TEXT NOT NULL CHECK (length(currency) = 3),
  parent_id TEXT REFERENCES accounts(id),
  archived  INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
) STRICT;

CREATE TABLE journal_entries (
  id                 TEXT PRIMARY KEY,
  seq                INTEGER NOT NULL UNIQUE,
  date               TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  memo               TEXT,
  reverses_entry_id  TEXT UNIQUE REFERENCES journal_entries(id)
) STRICT;

CREATE TABLE journal_lines (
  entry_id   TEXT NOT NULL REFERENCES journal_entries(id),
  line_no    INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  side       TEXT NOT NULL CHECK (side IN ('debit','credit')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  currency   TEXT NOT NULL CHECK (length(currency) = 3),
  memo       TEXT,
  PRIMARY KEY (entry_id, line_no)
) STRICT;

CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_entries_date ON journal_entries(date);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details   TEXT
) STRICT;

-- ADR 0003: the journal is append-only at the database level.
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are immutable'); END;

CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal entries are immutable'); END;

CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are immutable'); END;

CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal lines are immutable'); END;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
`;
