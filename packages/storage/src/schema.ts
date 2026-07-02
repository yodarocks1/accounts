/**
 * Company-file schema. Amounts are INTEGER minor units (ADR 0002); posted
 * journal rows, document revisions, and price history are frozen by triggers,
 * not just by application code (ADR 0003, ADR 0004).
 *
 * MIGRATIONS[n] upgrades a file from schema version n to n+1; opening a file
 * applies any pending migrations.
 */
const V1_SQL = `
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

const V2_SQL = `
CREATE TABLE items (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL CHECK (length(trim(name)) > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3)
) STRICT;

-- ADR 0004: price history is append-only; documents snapshot prices.
CREATE TABLE item_prices (
  item_id        TEXT NOT NULL REFERENCES items(id),
  price_seq      INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (item_id, price_seq)
) STRICT;

CREATE TRIGGER item_prices_no_update BEFORE UPDATE ON item_prices
BEGIN SELECT RAISE(ABORT, 'price history is immutable'); END;

CREATE TRIGGER item_prices_no_delete BEFORE DELETE ON item_prices
BEGIN SELECT RAISE(ABORT, 'price history is immutable'); END;

CREATE TABLE documents (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('estimate','sales_order','invoice')),
  number                  TEXT NOT NULL CHECK (length(trim(number)) > 0),
  status                  TEXT NOT NULL CHECK (status IN ('draft','sent','void')),
  source_document_id      TEXT REFERENCES documents(id),
  inherited_corrections   INTEGER NOT NULL DEFAULT 0 CHECK (inherited_corrections IN (0,1)),
  inherited_substitutions INTEGER NOT NULL DEFAULT 0 CHECK (inherited_substitutions IN (0,1)),
  UNIQUE (type, number)
) STRICT;

-- Identity and provenance are frozen; only status may transition.
CREATE TRIGGER documents_status_only_update BEFORE UPDATE ON documents
WHEN NEW.id IS NOT OLD.id
  OR NEW.type IS NOT OLD.type
  OR NEW.number IS NOT OLD.number
  OR NEW.source_document_id IS NOT OLD.source_document_id
  OR NEW.inherited_corrections IS NOT OLD.inherited_corrections
  OR NEW.inherited_substitutions IS NOT OLD.inherited_substitutions
BEGIN SELECT RAISE(ABORT, 'only document status may change'); END;

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are never deleted; void them'); END;

-- ADR 0004: every content change is a new immutable revision.
CREATE TABLE document_revisions (
  document_id  TEXT NOT NULL REFERENCES documents(id),
  revision_no  INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('initial','edit','correction','substitution')),
  at           TEXT NOT NULL,
  reason       TEXT,
  date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  counterparty TEXT,
  memo         TEXT,
  PRIMARY KEY (document_id, revision_no)
) STRICT;

CREATE TRIGGER document_revisions_no_update BEFORE UPDATE ON document_revisions
BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;

CREATE TRIGGER document_revisions_no_delete BEFORE DELETE ON document_revisions
BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;

CREATE TABLE document_revision_lines (
  document_id    TEXT NOT NULL,
  revision_no    INTEGER NOT NULL,
  line_no        INTEGER NOT NULL,
  item_id        TEXT REFERENCES items(id),
  description    TEXT NOT NULL CHECK (length(trim(description)) > 0),
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
  currency       TEXT NOT NULL CHECK (length(currency) = 3),
  PRIMARY KEY (document_id, revision_no, line_no),
  FOREIGN KEY (document_id, revision_no) REFERENCES document_revisions(document_id, revision_no)
) STRICT;

CREATE TRIGGER document_revision_lines_no_update BEFORE UPDATE ON document_revision_lines
BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;

CREATE TRIGGER document_revision_lines_no_delete BEFORE DELETE ON document_revision_lines
BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;
`;

/** MIGRATIONS[n] takes a file from version n to n+1. */
export const MIGRATIONS: readonly string[] = [V1_SQL, V2_SQL];

export const SCHEMA_VERSION = MIGRATIONS.length;
