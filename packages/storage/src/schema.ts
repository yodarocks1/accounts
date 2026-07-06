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

const V11_SQL = `
-- Tier 2 (ADR 0009 part 2): rates gain expiry and revocation, so the
-- customer_rates CHECKs must change — SQLite requires a rebuild.
DROP TRIGGER customer_rates_no_update;
DROP TRIGGER customer_rates_no_delete;
DROP INDEX idx_customer_rates_item;

CREATE TABLE customer_rates_v11 (
  rate_seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          TEXT NOT NULL REFERENCES items(id),
  party_id         TEXT REFERENCES parties(id),
  customer_name    TEXT,
  account_number   TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('constant','formula','revoked')),
  unit_price       INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),
  base             TEXT CHECK (base IN ('sale','cost')),
  percent_milli    INTEGER NOT NULL DEFAULT 0,
  amount_minor     INTEGER NOT NULL DEFAULT 0,
  allow_below_cost INTEGER NOT NULL CHECK (allow_below_cost IN (0,1)),
  effective_from   TEXT NOT NULL,
  effective_to     TEXT,
  at               TEXT NOT NULL,
  CHECK (customer_name IS NOT NULL OR account_number IS NOT NULL OR party_id IS NOT NULL),
  CHECK ((kind = 'constant') = (unit_price IS NOT NULL)),
  CHECK ((kind = 'formula') = (base IS NOT NULL))
) STRICT;

INSERT INTO customer_rates_v11
    (rate_seq, item_id, party_id, customer_name, account_number, kind, unit_price, base, percent_milli, amount_minor, allow_below_cost, effective_from, effective_to, at)
  SELECT rate_seq, item_id, party_id, customer_name, account_number, kind, unit_price, base, percent_milli, amount_minor, allow_below_cost, effective_from, NULL, at
  FROM customer_rates;

DROP TABLE customer_rates;
ALTER TABLE customer_rates_v11 RENAME TO customer_rates;

CREATE INDEX idx_customer_rates_item ON customer_rates(item_id, effective_from);

CREATE TRIGGER customer_rates_no_update BEFORE UPDATE ON customer_rates
BEGIN SELECT RAISE(ABORT, 'customer rates are immutable; append a newer rate'); END;

CREATE TRIGGER customer_rates_no_delete BEFORE DELETE ON customer_rates
BEGIN SELECT RAISE(ABORT, 'customer rates are immutable; append a newer rate'); END;

-- Quantity price breaks: thresholds and/or exact multiples (box/pallet).
CREATE TABLE customer_rate_tiers (
  rate_seq                INTEGER NOT NULL REFERENCES customer_rates(rate_seq),
  tier_no                 INTEGER NOT NULL,
  min_quantity_milli      INTEGER CHECK (min_quantity_milli IS NULL OR min_quantity_milli > 0),
  multiple_quantity_milli INTEGER CHECK (multiple_quantity_milli IS NULL OR multiple_quantity_milli > 0),
  kind                    TEXT NOT NULL CHECK (kind IN ('constant','formula')),
  unit_price              INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),
  base                    TEXT CHECK (base IN ('sale','cost')),
  percent_milli           INTEGER NOT NULL DEFAULT 0,
  amount_minor            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rate_seq, tier_no),
  CHECK (min_quantity_milli IS NOT NULL OR multiple_quantity_milli IS NOT NULL),
  CHECK ((kind = 'constant') = (unit_price IS NOT NULL)),
  CHECK ((kind = 'formula') = (base IS NOT NULL))
) STRICT;

CREATE TRIGGER customer_rate_tiers_no_update BEFORE UPDATE ON customer_rate_tiers
BEGIN SELECT RAISE(ABORT, 'rate tiers are immutable; append a newer rate'); END;

CREATE TRIGGER customer_rate_tiers_no_delete BEFORE DELETE ON customer_rate_tiers
BEGIN SELECT RAISE(ABORT, 'rate tiers are immutable; append a newer rate'); END;
`;

const V12_SQL = `
-- Tier 3 (ADR 0010 part 1): sales tax. Rates are append-only history;
-- lines snapshot the code + percent effective on the document date.
CREATE TABLE tax_rates (
  tax_seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL CHECK (length(trim(code)) > 0),
  name           TEXT NOT NULL,
  percent_milli  INTEGER NOT NULL CHECK (percent_milli >= 0),
  effective_from TEXT NOT NULL,
  at             TEXT NOT NULL
) STRICT;

CREATE INDEX idx_tax_rates_code ON tax_rates(code, effective_from);

CREATE TRIGGER tax_rates_no_update BEFORE UPDATE ON tax_rates
BEGIN SELECT RAISE(ABORT, 'tax rates are immutable; append a newer rate'); END;

CREATE TRIGGER tax_rates_no_delete BEFORE DELETE ON tax_rates
BEGIN SELECT RAISE(ABORT, 'tax rates are immutable; append a newer rate'); END;

ALTER TABLE items ADD COLUMN tax_code TEXT;
ALTER TABLE items ADD COLUMN deposit_policy TEXT NOT NULL DEFAULT 'never'
  CHECK (deposit_policy IN ('never','always','when_out_of_stock'));
ALTER TABLE items ADD COLUMN in_stock INTEGER NOT NULL DEFAULT 1 CHECK (in_stock IN (0,1));

ALTER TABLE document_revision_lines ADD COLUMN tax_code TEXT;
ALTER TABLE document_revision_lines ADD COLUMN tax_percent_milli INTEGER NOT NULL DEFAULT 0
  CHECK (tax_percent_milli >= 0);

ALTER TABLE parties ADD COLUMN tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK (tax_exempt IN (0,1));

-- posting_accounts gains the sales_tax_payable role (CHECK rebuild).
CREATE TABLE posting_accounts_v12 (
  role       TEXT PRIMARY KEY CHECK (role IN ('accounts_receivable','sales_income','cash','sales_tax_payable')),
  account_id TEXT NOT NULL REFERENCES accounts(id)
) STRICT;
INSERT INTO posting_accounts_v12 SELECT role, account_id FROM posting_accounts;
DROP TABLE posting_accounts;
ALTER TABLE posting_accounts_v12 RENAME TO posting_accounts;
`;

const V13_SQL = `
-- Tier 3 (ADR 0010 part 2): per-kind auto-numbering sequences.
CREATE TABLE number_sequences (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('estimate','sales_order','invoice','credit_memo','payment')),
  prefix     TEXT NOT NULL,
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  width      INTEGER NOT NULL CHECK (width >= 1)
) STRICT;
`;

const V14_SQL = `
-- Tier 3 (ADR 0010 part 3): deposits/prepayments on sales orders.
ALTER TABLE document_revisions ADD COLUMN deposit_required_minor INTEGER
  CHECK (deposit_required_minor IS NULL OR deposit_required_minor >= 0);
ALTER TABLE credit_applications ADD COLUMN line_id TEXT;
`;

const V15_SQL = `
-- ADR 0011: the purchase side. purchase_order joins the document-type and
-- sequence-kind enums; items gain the special_order deposit policy; supplier
-- info arrives as append-only, source-tagged snapshots. SQLite cannot alter
-- CHECK constraints, so the three constrained tables are rebuilt in place.
DROP TRIGGER documents_status_only_update;
DROP TRIGGER documents_no_delete;
DROP INDEX idx_documents_source;

CREATE TABLE documents_v15 (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('estimate','sales_order','invoice','credit_memo','purchase_order')),
  number                  TEXT NOT NULL CHECK (length(trim(number)) > 0),
  status                  TEXT NOT NULL CHECK (status IN ('draft','sent','void')),
  source_document_id      TEXT REFERENCES documents(id),
  inherited_corrections   INTEGER NOT NULL DEFAULT 0 CHECK (inherited_corrections IN (0,1)),
  inherited_substitutions INTEGER NOT NULL DEFAULT 0 CHECK (inherited_substitutions IN (0,1)),
  settlement              TEXT CHECK (settlement IN ('account','refund')),
  party_id                TEXT REFERENCES parties(id),
  UNIQUE (type, number)
) STRICT;

INSERT INTO documents_v15 (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id)
  SELECT id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id FROM documents;

DROP TABLE documents;
ALTER TABLE documents_v15 RENAME TO documents;

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

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are never deleted; void them'); END;

CREATE INDEX idx_documents_source ON documents(source_document_id);

-- items gains the special_order deposit policy (CHECK rebuild).
CREATE TABLE items_v15 (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  currency       TEXT NOT NULL CHECK (length(currency) = 3),
  tax_code       TEXT,
  deposit_policy TEXT NOT NULL DEFAULT 'never'
    CHECK (deposit_policy IN ('never','always','when_out_of_stock','special_order')),
  in_stock       INTEGER NOT NULL DEFAULT 1 CHECK (in_stock IN (0,1))
) STRICT;
INSERT INTO items_v15 SELECT id, name, currency, tax_code, deposit_policy, in_stock FROM items;
DROP TABLE items;
ALTER TABLE items_v15 RENAME TO items;

-- number_sequences gains the purchase_order kind (CHECK rebuild).
CREATE TABLE number_sequences_v15 (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('estimate','sales_order','invoice','credit_memo','purchase_order','payment')),
  prefix     TEXT NOT NULL,
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  width      INTEGER NOT NULL CHECK (width >= 1)
) STRICT;
INSERT INTO number_sequences_v15 SELECT kind, prefix, next_value, width FROM number_sequences;
DROP TABLE number_sequences;
ALTER TABLE number_sequences_v15 RENAME TO number_sequences;

-- Supplier info (ADR 0011 part 3): append-only snapshots with provenance.
CREATE TABLE supplier_info (
  info_seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id                     TEXT NOT NULL REFERENCES parties(id),
  source                       TEXT NOT NULL CHECK (length(trim(source)) > 0),
  as_of                        TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  at                           TEXT NOT NULL,
  currency                     TEXT NOT NULL CHECK (length(currency) = 3),
  minimum_order_minor          INTEGER CHECK (minimum_order_minor IS NULL OR minimum_order_minor >= 0),
  minimum_order_quantity_milli INTEGER CHECK (minimum_order_quantity_milli IS NULL OR minimum_order_quantity_milli >= 0),
  notes                        TEXT
) STRICT;

CREATE INDEX idx_supplier_info_party ON supplier_info(party_id, as_of);

CREATE TABLE supplier_info_shipping (
  info_seq         INTEGER NOT NULL REFERENCES supplier_info(info_seq),
  shipping_no      INTEGER NOT NULL,
  method           TEXT NOT NULL CHECK (length(trim(method)) > 0),
  cost_minor       INTEGER CHECK (cost_minor IS NULL OR cost_minor >= 0),
  free_above_minor INTEGER CHECK (free_above_minor IS NULL OR free_above_minor >= 0),
  min_days         INTEGER CHECK (min_days IS NULL OR min_days >= 0),
  max_days         INTEGER CHECK (max_days IS NULL OR max_days >= 0),
  PRIMARY KEY (info_seq, shipping_no)
) STRICT;

CREATE TABLE supplier_info_items (
  info_seq                INTEGER NOT NULL REFERENCES supplier_info(info_seq),
  item_id                 TEXT NOT NULL REFERENCES items(id),
  unit_cost               INTEGER NOT NULL CHECK (unit_cost >= 0),
  supplier_sku            TEXT,
  in_stock                INTEGER CHECK (in_stock IS NULL OR in_stock IN (0,1)),
  min_quantity_milli      INTEGER CHECK (min_quantity_milli IS NULL OR min_quantity_milli > 0),
  multiple_quantity_milli INTEGER CHECK (multiple_quantity_milli IS NULL OR multiple_quantity_milli > 0),
  lead_days               INTEGER CHECK (lead_days IS NULL OR lead_days >= 0),
  PRIMARY KEY (info_seq, item_id)
) STRICT;

CREATE TRIGGER supplier_info_no_update BEFORE UPDATE ON supplier_info
BEGIN SELECT RAISE(ABORT, 'supplier info is immutable; record a newer snapshot'); END;

CREATE TRIGGER supplier_info_no_delete BEFORE DELETE ON supplier_info
BEGIN SELECT RAISE(ABORT, 'supplier info is immutable; record a newer snapshot'); END;

CREATE TRIGGER supplier_info_shipping_no_update BEFORE UPDATE ON supplier_info_shipping
BEGIN SELECT RAISE(ABORT, 'supplier info is immutable; record a newer snapshot'); END;

CREATE TRIGGER supplier_info_shipping_no_delete BEFORE DELETE ON supplier_info_shipping
BEGIN SELECT RAISE(ABORT, 'supplier info is immutable; record a newer snapshot'); END;

CREATE TRIGGER supplier_info_items_no_update BEFORE UPDATE ON supplier_info_items
BEGIN SELECT RAISE(ABORT, 'supplier info is immutable; record a newer snapshot'); END;

CREATE TRIGGER supplier_info_items_no_delete BEFORE DELETE ON supplier_info_items
BEGIN SELECT RAISE(ABORT, 'supplier info is immutable; record a newer snapshot'); END;
`;

const V16_SQL = `
-- ADR 0012: vendor bills and accounts payable. bill joins the document-type
-- and sequence-kind enums; posting roles gain accounts_payable and
-- purchases_expense; payments gain a direction (in = customer receipt,
-- out = supplier disbursement). CHECK changes rebuild tables as usual.
DROP TRIGGER documents_status_only_update;
DROP TRIGGER documents_no_delete;
DROP INDEX idx_documents_source;

CREATE TABLE documents_v16 (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('estimate','sales_order','invoice','credit_memo','purchase_order','bill')),
  number                  TEXT NOT NULL CHECK (length(trim(number)) > 0),
  status                  TEXT NOT NULL CHECK (status IN ('draft','sent','void')),
  source_document_id      TEXT REFERENCES documents(id),
  inherited_corrections   INTEGER NOT NULL DEFAULT 0 CHECK (inherited_corrections IN (0,1)),
  inherited_substitutions INTEGER NOT NULL DEFAULT 0 CHECK (inherited_substitutions IN (0,1)),
  settlement              TEXT CHECK (settlement IN ('account','refund')),
  party_id                TEXT REFERENCES parties(id),
  UNIQUE (type, number)
) STRICT;

INSERT INTO documents_v16 (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id)
  SELECT id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id FROM documents;

DROP TABLE documents;
ALTER TABLE documents_v16 RENAME TO documents;

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

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are never deleted; void them'); END;

CREATE INDEX idx_documents_source ON documents(source_document_id);

CREATE TABLE number_sequences_v16 (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('estimate','sales_order','invoice','credit_memo','purchase_order','bill','payment')),
  prefix     TEXT NOT NULL,
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  width      INTEGER NOT NULL CHECK (width >= 1)
) STRICT;
INSERT INTO number_sequences_v16 SELECT kind, prefix, next_value, width FROM number_sequences;
DROP TABLE number_sequences;
ALTER TABLE number_sequences_v16 RENAME TO number_sequences;

CREATE TABLE posting_accounts_v16 (
  role       TEXT PRIMARY KEY CHECK (role IN ('accounts_receivable','sales_income','cash','sales_tax_payable','accounts_payable','purchases_expense')),
  account_id TEXT NOT NULL REFERENCES accounts(id)
) STRICT;
INSERT INTO posting_accounts_v16 SELECT role, account_id FROM posting_accounts;
DROP TABLE posting_accounts;
ALTER TABLE posting_accounts_v16 RENAME TO posting_accounts;

-- Payment direction, frozen alongside every other payment field.
ALTER TABLE payments ADD COLUMN direction TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out'));

DROP TRIGGER payments_status_only_update;
CREATE TRIGGER payments_status_only_update BEFORE UPDATE ON payments
WHEN NEW.id IS NOT OLD.id
  OR NEW.number IS NOT OLD.number
  OR NEW.direction IS NOT OLD.direction
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

const V17_SQL = `
-- ADR 0013: completing the transaction set. vendor_credit joins the
-- document-type and sequence-kind enums; credit_applications gain the
-- vendor_credit source kind, a nullable target (refunds pay out unapplied
-- credit with no target document), and a refund flag; postings can now be
-- keyed by a refund's application seq so reversals unwind them.
DROP TRIGGER documents_status_only_update;
DROP TRIGGER documents_no_delete;
DROP INDEX idx_documents_source;

CREATE TABLE documents_v17 (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('estimate','sales_order','invoice','credit_memo','purchase_order','bill','vendor_credit')),
  number                  TEXT NOT NULL CHECK (length(trim(number)) > 0),
  status                  TEXT NOT NULL CHECK (status IN ('draft','sent','void')),
  source_document_id      TEXT REFERENCES documents(id),
  inherited_corrections   INTEGER NOT NULL DEFAULT 0 CHECK (inherited_corrections IN (0,1)),
  inherited_substitutions INTEGER NOT NULL DEFAULT 0 CHECK (inherited_substitutions IN (0,1)),
  settlement              TEXT CHECK (settlement IN ('account','refund')),
  party_id                TEXT REFERENCES parties(id),
  UNIQUE (type, number)
) STRICT;

INSERT INTO documents_v17 (id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id)
  SELECT id, type, number, status, source_document_id, inherited_corrections, inherited_substitutions, settlement, party_id FROM documents;

DROP TABLE documents;
ALTER TABLE documents_v17 RENAME TO documents;

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

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are never deleted; void them'); END;

CREATE INDEX idx_documents_source ON documents(source_document_id);

CREATE TABLE number_sequences_v17 (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('estimate','sales_order','invoice','credit_memo','purchase_order','bill','vendor_credit','payment')),
  prefix     TEXT NOT NULL,
  next_value INTEGER NOT NULL CHECK (next_value >= 1),
  width      INTEGER NOT NULL CHECK (width >= 1)
) STRICT;
INSERT INTO number_sequences_v17 SELECT kind, prefix, next_value, width FROM number_sequences;
DROP TABLE number_sequences;
ALTER TABLE number_sequences_v17 RENAME TO number_sequences;

DROP TRIGGER credit_applications_no_update;
DROP TRIGGER credit_applications_no_delete;
DROP INDEX idx_credit_applications_invoice;
DROP INDEX idx_credit_applications_source;

CREATE TABLE credit_applications_v17 (
  application_seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind              TEXT NOT NULL CHECK (source_kind IN ('payment','credit_memo','vendor_credit')),
  source_id                TEXT NOT NULL,
  invoice_id               TEXT REFERENCES documents(id),
  line_id                  TEXT,
  refund                   INTEGER NOT NULL DEFAULT 0 CHECK (refund IN (0,1)),
  amount                   INTEGER NOT NULL CHECK (amount > 0),
  date                     TEXT NOT NULL,
  at                       TEXT NOT NULL,
  reverses_application_seq INTEGER UNIQUE REFERENCES credit_applications(application_seq),
  CHECK (refund = 1 OR invoice_id IS NOT NULL)
) STRICT;

INSERT INTO credit_applications_v17
    (application_seq, source_kind, source_id, invoice_id, line_id, refund, amount, date, at, reverses_application_seq)
  SELECT application_seq, source_kind, source_id, invoice_id, line_id, 0, amount, date, at, reverses_application_seq
  FROM credit_applications;

DROP TABLE credit_applications;
ALTER TABLE credit_applications_v17 RENAME TO credit_applications;

CREATE INDEX idx_credit_applications_invoice ON credit_applications(invoice_id);
CREATE INDEX idx_credit_applications_source ON credit_applications(source_kind, source_id);

CREATE TRIGGER credit_applications_no_update BEFORE UPDATE ON credit_applications
BEGIN SELECT RAISE(ABORT, 'applications are immutable; reverse them'); END;

CREATE TRIGGER credit_applications_no_delete BEFORE DELETE ON credit_applications
BEGIN SELECT RAISE(ABORT, 'applications are immutable; reverse them'); END;

-- Postings can be keyed by a refund's application seq (ADR 0013).
DROP TRIGGER postings_no_update;
DROP TRIGGER postings_no_delete;
DROP INDEX idx_postings_source;

CREATE TABLE postings_v17 (
  posting_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('document','payment','refund')),
  source_id   TEXT NOT NULL,
  entry_id    TEXT NOT NULL REFERENCES journal_entries(id),
  kind        TEXT NOT NULL CHECK (kind IN ('post','reversal')),
  at          TEXT NOT NULL
) STRICT;
INSERT INTO postings_v17 SELECT posting_seq, source_kind, source_id, entry_id, kind, at FROM postings;
DROP TABLE postings;
ALTER TABLE postings_v17 RENAME TO postings;

CREATE INDEX idx_postings_source ON postings(source_kind, source_id);

CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings
BEGIN SELECT RAISE(ABORT, 'postings are immutable'); END;

CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings
BEGIN SELECT RAISE(ABORT, 'postings are immutable'); END;
`;

const V18_SQL = `
-- ADR 0014: inventory. Items gain a kind and a damaged-stock disposition
-- policy; stock is an append-only movement log (levels are always derived);
-- bills of materials are append-only, effective-dated versions.
ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'non_inventory'
  CHECK (kind IN ('inventory','non_inventory','service'));
-- JSON array of allowed dispositions; NULL = all of restock/recycle/trash.
ALTER TABLE items ADD COLUMN dispositions TEXT;

CREATE TABLE stock_movements (
  movement_seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        TEXT NOT NULL REFERENCES items(id),
  kind           TEXT NOT NULL CHECK (kind IN ('adjustment','document','correction','void','damage','disposal','build')),
  condition      TEXT NOT NULL CHECK (condition IN ('good','damaged')),
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli != 0),
  date           TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  at             TEXT NOT NULL,
  reason         TEXT,
  source_id      TEXT,
  disposition    TEXT CHECK (disposition IS NULL OR disposition IN ('restock','recycle','trash'))
) STRICT;

CREATE INDEX idx_stock_movements_item ON stock_movements(item_id, date);

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;

CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;

CREATE TABLE item_boms (
  bom_seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id             TEXT NOT NULL REFERENCES items(id),
  effective_from      TEXT NOT NULL,
  assembly_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (assembly_cost_minor >= 0),
  at                  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_item_boms_item ON item_boms(item_id, effective_from);

CREATE TABLE item_bom_components (
  bom_seq           INTEGER NOT NULL REFERENCES item_boms(bom_seq),
  component_no      INTEGER NOT NULL,
  component_item_id TEXT NOT NULL REFERENCES items(id),
  quantity_milli    INTEGER NOT NULL CHECK (quantity_milli > 0),
  PRIMARY KEY (bom_seq, component_no)
) STRICT;

CREATE TRIGGER item_boms_no_update BEFORE UPDATE ON item_boms
BEGIN SELECT RAISE(ABORT, 'bills of materials are immutable; append a newer version'); END;

CREATE TRIGGER item_boms_no_delete BEFORE DELETE ON item_boms
BEGIN SELECT RAISE(ABORT, 'bills of materials are immutable; append a newer version'); END;

CREATE TRIGGER item_bom_components_no_update BEFORE UPDATE ON item_bom_components
BEGIN SELECT RAISE(ABORT, 'bills of materials are immutable; append a newer version'); END;

CREATE TRIGGER item_bom_components_no_delete BEFORE DELETE ON item_bom_components
BEGIN SELECT RAISE(ABORT, 'bills of materials are immutable; append a newer version'); END;
`;

/** MIGRATIONS[n] takes a file from version n to n+1. */
export const MIGRATIONS: readonly string[] = [V1_SQL, V2_SQL, V3_SQL, V4_SQL, V5_SQL, V6_SQL, V7_SQL, V8_SQL, V9_SQL, V10_SQL, V11_SQL, V12_SQL, V13_SQL, V14_SQL, V15_SQL, V16_SQL, V17_SQL, V18_SQL];

export const SCHEMA_VERSION = MIGRATIONS.length;
