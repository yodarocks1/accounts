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

const V3_SQL = `
-- ADR 0005: price history gains a kind (sale price vs item cost).
ALTER TABLE item_prices ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','cost'));

-- ADR 0005: stable line identity, conversion links, adjustments, free flags.
ALTER TABLE document_revision_lines ADD COLUMN line_id TEXT;
ALTER TABLE document_revision_lines ADD COLUMN source_line_id TEXT;
ALTER TABLE document_revision_lines ADD COLUMN adjustment INTEGER NOT NULL DEFAULT 0 CHECK (adjustment <= 0);
ALTER TABLE document_revision_lines ADD COLUMN free INTEGER NOT NULL DEFAULT 0 CHECK (free IN (0,1));
ALTER TABLE document_revision_lines ADD COLUMN substituted INTEGER NOT NULL DEFAULT 0 CHECK (substituted IN (0,1));

-- Backfill positional line identities for pre-v3 rows (same line_no keeps the
-- same identity across revisions). Immutability triggers are lifted for the
-- one-time backfill and restored immediately after.
DROP TRIGGER document_revision_lines_no_update;
UPDATE document_revision_lines SET line_id = document_id || '#' || line_no WHERE line_id IS NULL;
CREATE TRIGGER document_revision_lines_no_update BEFORE UPDATE ON document_revision_lines
BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;

-- ADR 0005: explicit line closures (unfulfilled / substituted), append-only.
CREATE TABLE document_line_closures (
  document_id    TEXT NOT NULL REFERENCES documents(id),
  closure_seq    INTEGER NOT NULL,
  line_id        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('unfulfilled','substituted')),
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  reason         TEXT,
  at             TEXT NOT NULL,
  PRIMARY KEY (document_id, closure_seq)
) STRICT;

CREATE TRIGGER document_line_closures_no_update BEFORE UPDATE ON document_line_closures
BEGIN SELECT RAISE(ABORT, 'line closures are immutable'); END;

CREATE TRIGGER document_line_closures_no_delete BEFORE DELETE ON document_line_closures
BEGIN SELECT RAISE(ABORT, 'line closures are immutable'); END;

CREATE INDEX idx_documents_source ON documents(source_document_id);
`;

const V4_SQL = `
-- ADR 0006: credit memos join the type enum and carry a settlement mode.
-- SQLite cannot alter CHECK constraints, so documents is rebuilt in place
-- (run with foreign keys off; CompanyFile verifies with foreign_key_check).
DROP TRIGGER documents_status_only_update;
DROP TRIGGER documents_no_delete;
DROP INDEX idx_documents_source;

CREATE TABLE documents_v4 (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('estimate','sales_order','invoice','credit_memo')),
  number                  TEXT NOT NULL CHECK (length(trim(number)) > 0),
  status                  TEXT NOT NULL CHECK (status IN ('draft','sent','void')),
  source_document_id      TEXT REFERENCES documents(id),
  inherited_corrections   INTEGER NOT NULL DEFAULT 0 CHECK (inherited_corrections IN (0,1)),
  inherited_substitutions INTEGER NOT NULL DEFAULT 0 CHECK (inherited_substitutions IN (0,1)),
  settlement              TEXT CHECK (settlement IN ('account','refund')),
  UNIQUE (type, number)
) STRICT;

INSERT INTO documents_v4 (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement)
  SELECT id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, NULL FROM documents;

DROP TABLE documents;
ALTER TABLE documents_v4 RENAME TO documents;

CREATE TRIGGER documents_status_only_update BEFORE UPDATE ON documents
WHEN NEW.id IS NOT OLD.id
  OR NEW.type IS NOT OLD.type
  OR NEW.number IS NOT OLD.number
  OR NEW.source_document_id IS NOT OLD.source_document_id
  OR NEW.inherited_corrections IS NOT OLD.inherited_corrections
  OR NEW.inherited_substitutions IS NOT OLD.inherited_substitutions
  OR NEW.settlement IS NOT OLD.settlement
BEGIN SELECT RAISE(ABORT, 'only document status may change'); END;

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are never deleted; void them'); END;

CREATE INDEX idx_documents_source ON documents(source_document_id);

-- ADR 0006: every transaction names its customer; PO and account are optional.
ALTER TABLE document_revisions RENAME COLUMN counterparty TO customer_name;
ALTER TABLE document_revisions ADD COLUMN account_number TEXT;
ALTER TABLE document_revisions ADD COLUMN po_number TEXT;

-- ADR 0006: links carry their own document context.
ALTER TABLE document_revision_lines ADD COLUMN source_document_id TEXT;
`;

const V5_SQL = `
-- ADR 0007: customer special rates — append-only, effective-dated, one of
-- constant unit price or base×(100%+percent)+amount against sale/cost.
CREATE TABLE customer_rates (
  rate_seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          TEXT NOT NULL REFERENCES items(id),
  customer_name    TEXT,
  account_number   TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('constant','formula')),
  unit_price       INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),
  base             TEXT CHECK (base IN ('sale','cost')),
  percent_milli    INTEGER NOT NULL DEFAULT 0,
  amount_minor     INTEGER NOT NULL DEFAULT 0,
  allow_below_cost INTEGER NOT NULL CHECK (allow_below_cost IN (0,1)),
  effective_from   TEXT NOT NULL,
  at               TEXT NOT NULL,
  CHECK (customer_name IS NOT NULL OR account_number IS NOT NULL),
  CHECK ((kind = 'constant') = (unit_price IS NOT NULL)),
  CHECK ((kind = 'formula') = (base IS NOT NULL))
) STRICT;

CREATE INDEX idx_customer_rates_item ON customer_rates(item_id, effective_from);

CREATE TRIGGER customer_rates_no_update BEFORE UPDATE ON customer_rates
BEGIN SELECT RAISE(ABORT, 'customer rates are immutable; append a newer rate'); END;

CREATE TRIGGER customer_rates_no_delete BEFORE DELETE ON customer_rates
BEGIN SELECT RAISE(ABORT, 'customer rates are immutable; append a newer rate'); END;
`;

const V6_SQL = `
-- Tier 1: payments and credit application. Payments are immutable except for
-- voiding; applications are append-only and undone by reversal records.
CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  number         TEXT NOT NULL UNIQUE,
  date           TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  customer_name  TEXT NOT NULL CHECK (length(trim(customer_name)) > 0),
  account_number TEXT,
  po_number      TEXT,
  memo           TEXT,
  method         TEXT,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL CHECK (status IN ('received','void'))
) STRICT;

CREATE TRIGGER payments_status_only_update BEFORE UPDATE ON payments
WHEN NEW.id IS NOT OLD.id
  OR NEW.number IS NOT OLD.number
  OR NEW.date IS NOT OLD.date
  OR NEW.customer_name IS NOT OLD.customer_name
  OR NEW.account_number IS NOT OLD.account_number
  OR NEW.po_number IS NOT OLD.po_number
  OR NEW.memo IS NOT OLD.memo
  OR NEW.method IS NOT OLD.method
  OR NEW.amount IS NOT OLD.amount
BEGIN SELECT RAISE(ABORT, 'only payment status may change'); END;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are never deleted; void them'); END;

CREATE TABLE credit_applications (
  application_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind              TEXT NOT NULL CHECK (source_kind IN ('payment','credit_memo')),
  source_id                TEXT NOT NULL,
  invoice_id               TEXT NOT NULL REFERENCES documents(id),
  amount                   INTEGER NOT NULL CHECK (amount > 0),
  date                     TEXT NOT NULL,
  at                       TEXT NOT NULL,
  reverses_application_seq INTEGER UNIQUE REFERENCES credit_applications(application_seq)
) STRICT;

CREATE INDEX idx_credit_applications_invoice ON credit_applications(invoice_id);
CREATE INDEX idx_credit_applications_source ON credit_applications(source_kind, source_id);

CREATE TRIGGER credit_applications_no_update BEFORE UPDATE ON credit_applications
BEGIN SELECT RAISE(ABORT, 'applications are immutable; reverse them'); END;

CREATE TRIGGER credit_applications_no_delete BEFORE DELETE ON credit_applications
BEGIN SELECT RAISE(ABORT, 'applications are immutable; reverse them'); END;
`;

const V7_SQL = `
-- Tier 1: payment terms (Net N); due date is derived, never stored.
ALTER TABLE document_revisions ADD COLUMN terms_days INTEGER CHECK (terms_days IS NULL OR terms_days >= 0);
`;

const V8_SQL = `
-- Tier 1: ledger posting. Role → account mapping is mutable config
-- (audited at the app level); posting links are append-only.
CREATE TABLE posting_accounts (
  role       TEXT PRIMARY KEY CHECK (role IN ('accounts_receivable','sales_income','cash')),
  account_id TEXT NOT NULL REFERENCES accounts(id)
) STRICT;

CREATE TABLE postings (
  posting_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('document','payment')),
  source_id   TEXT NOT NULL,
  entry_id    TEXT NOT NULL REFERENCES journal_entries(id),
  kind        TEXT NOT NULL CHECK (kind IN ('post','reversal')),
  at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_postings_source ON postings(source_kind, source_id);

CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings
BEGIN SELECT RAISE(ABORT, 'postings are immutable'); END;

CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings
BEGIN SELECT RAISE(ABORT, 'postings are immutable'); END;
`;

const V9_SQL = `
-- Tier 1: parties — the durable customer record (ADR 0008 part 4).
-- Names live in append-only history; documents snapshot names at the time.
CREATE TABLE parties (
  id             TEXT PRIMARY KEY,
  account_number TEXT UNIQUE,
  terms_days     INTEGER CHECK (terms_days IS NULL OR terms_days >= 0),
  created_at     TEXT NOT NULL
) STRICT;

CREATE TRIGGER parties_no_delete BEFORE DELETE ON parties
BEGIN SELECT RAISE(ABORT, 'parties are never deleted'); END;

CREATE TABLE party_names (
  party_id TEXT NOT NULL REFERENCES parties(id),
  name_seq INTEGER NOT NULL,
  name     TEXT NOT NULL CHECK (length(trim(name)) > 0),
  at       TEXT NOT NULL,
  PRIMARY KEY (party_id, name_seq)
) STRICT;

CREATE TRIGGER party_names_no_update BEFORE UPDATE ON party_names
BEGIN SELECT RAISE(ABORT, 'party name history is immutable'); END;

CREATE TRIGGER party_names_no_delete BEFORE DELETE ON party_names
BEGIN SELECT RAISE(ABORT, 'party name history is immutable'); END;

ALTER TABLE documents ADD COLUMN party_id TEXT REFERENCES parties(id);
ALTER TABLE payments ADD COLUMN party_id TEXT REFERENCES parties(id);
ALTER TABLE customer_rates ADD COLUMN party_id TEXT REFERENCES parties(id);

-- Freeze the new identity columns alongside the existing ones.
DROP TRIGGER documents_status_only_update;
CREATE TRIGGER documents_status_only_update BEFORE UPDATE ON documents
WHEN NEW.id IS NOT OLD.id
  OR NEW.type IS NOT OLD.type
  OR NEW.number IS NOT OLD.number
  OR NEW.source_document_id IS NOT OLD.source_document_id
  OR NEW.inherited_corrections IS NOT OLD.inherited_corrections
  OR NEW.inherited_substitutions IS NOT OLD.inherited_substitutions
  OR NEW.settlement IS NOT OLD.settlement
  OR NEW.party_id IS NOT OLD.party_id
BEGIN SELECT RAISE(ABORT, 'only document status may change'); END;

DROP TRIGGER payments_status_only_update;
CREATE TRIGGER payments_status_only_update BEFORE UPDATE ON payments
WHEN NEW.id IS NOT OLD.id
  OR NEW.number IS NOT OLD.number
  OR NEW.date IS NOT OLD.date
  OR NEW.customer_name IS NOT OLD.customer_name
  OR NEW.account_number IS NOT OLD.account_number
  OR NEW.po_number IS NOT OLD.po_number
  OR NEW.memo IS NOT OLD.memo
  OR NEW.method IS NOT OLD.method
  OR NEW.amount IS NOT OLD.amount
  OR NEW.party_id IS NOT OLD.party_id
BEGIN SELECT RAISE(ABORT, 'only payment status may change'); END;
`;

const V10_SQL = `
-- Tier 2: return conditions live on credit-memo lines (ADR 0009 part 1).
ALTER TABLE document_revision_lines ADD COLUMN return_condition TEXT
  CHECK (return_condition IS NULL OR return_condition IN ('unopened','opened','damaged'));
`;

/** MIGRATIONS[n] takes a file from version n to n+1. */
export const MIGRATIONS: readonly string[] = [V1_SQL, V2_SQL, V3_SQL, V4_SQL, V5_SQL, V6_SQL, V7_SQL, V8_SQL, V9_SQL, V10_SQL];

export const SCHEMA_VERSION = MIGRATIONS.length;
