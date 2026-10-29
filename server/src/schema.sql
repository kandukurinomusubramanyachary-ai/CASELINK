-- CaseLink (SIH26264) relational schema.
-- Targets PostgreSQL semantics; executed here on SQLite via better-sqlite3.
-- Text ISO-8601 UTC timestamps, text UUID primary keys (portable across both engines).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bureaus (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('bureau_officer','bureau_lead','supervisor','reviewer','admin')),
  bureau        TEXT REFERENCES bureaus(code),          -- NULL for supervisor/admin
  region        TEXT,                                    -- NULL = national scope
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS institutions (
  id           TEXT PRIMARY KEY,
  permanent_id TEXT NOT NULL UNIQUE,          -- AICTE Permanent ID (synthetic in demo)
  name         TEXT NOT NULL,
  region       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS institution_aliases (
  id             TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  alias          TEXT NOT NULL,
  source         TEXT NOT NULL,
  reviewed_by    TEXT REFERENCES users(id),
  reviewed_at    TEXT NOT NULL,
  UNIQUE (institution_id, alias)
);

CREATE TABLE IF NOT EXISTS deadline_policies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  calendar_days INTEGER NOT NULL,
  basis         TEXT NOT NULL,                -- calendar_days | business_days
  is_demo       INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS import_batches (
  id            TEXT PRIMARY KEY,
  bureau        TEXT NOT NULL,
  source_system TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('previewed','committed','discarded')),
  total         INTEGER NOT NULL DEFAULT 0,
  accepted      INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  rows_json     TEXT NOT NULL,
  input_hash    TEXT,
  policy_snapshot_json TEXT,
  result_json   TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  id                     TEXT PRIMARY KEY,
  case_number            TEXT NOT NULL UNIQUE,
  institution_id         TEXT REFERENCES institutions(id),
  intake_institution_text TEXT,
  triage_state           TEXT NOT NULL DEFAULT 'resolved' CHECK (triage_state IN ('resolved','unresolved')),
  received_at            TEXT NOT NULL,        -- UTC
  imported_at            TEXT,
  source_channel         TEXT NOT NULL,        -- Email | Letter | Portal export | Phone note | CSV import | Walk-in
  source_reference       TEXT,
  source_system          TEXT,                 -- M5: source system per imported case (part of dedupe identity)
  source_identity        TEXT,                 -- M5: normalised (source system | bureau | reference)
  category               TEXT NOT NULL,
  complaint_summary      TEXT NOT NULL,
  bureau                 TEXT NOT NULL REFERENCES bureaus(code),
  assigned_officer_id    TEXT REFERENCES users(id),
  status                 TEXT NOT NULL CHECK (status IN ('Received','Assigned','Under review','Awaiting response','Disposed','Closed')),
  next_action            TEXT,
  next_action_due_at     TEXT,
  expected_disposal_at   TEXT,
  deadline_policy_id     TEXT REFERENCES deadline_policies(id),
  response_due_at        TEXT,
  response_from_role     TEXT,
  complainant_contact    TEXT,                 -- restricted field
  version                INTEGER NOT NULL DEFAULT 1,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  disposed_at            TEXT,
  closed_at              TEXT,
  reopened_at            TEXT,
  outcome                TEXT,                  -- M3: structured disposition outcome
  decision_reference     TEXT,                  -- M3: required decision / outcome reference
  escalation_open        INTEGER NOT NULL DEFAULT 0,
  escalation_reason      TEXT,
  escalation_supervisor_id TEXT REFERENCES users(id),
  escalation_opened_at   TEXT,
  import_batch_id        TEXT REFERENCES import_batches(id)
);

CREATE INDEX IF NOT EXISTS cases_institution_idx ON cases(institution_id);
CREATE INDEX IF NOT EXISTS cases_bureau_status_idx ON cases(bureau, status);
CREATE INDEX IF NOT EXISTS cases_received_idx ON cases(received_at);
-- M6: the case list filters and orders in SQL, so the columns it filters on are indexed.
CREATE INDEX IF NOT EXISTS cases_status_idx ON cases(status);
CREATE INDEX IF NOT EXISTS cases_assigned_idx ON cases(assigned_officer_id);
CREATE INDEX IF NOT EXISTS cases_expected_disposal_idx ON cases(expected_disposal_at);
CREATE INDEX IF NOT EXISTS cases_updated_idx ON cases(updated_at);
-- Migration 8 installs cases_import_identity after legacy provenance columns have been added.
-- Do not recreate the old (channel, bureau, reference) index on subsequent application boots.

CREATE TABLE IF NOT EXISTS dispositions (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES cases(id),
  outcome             TEXT NOT NULL,
  decision_reference  TEXT NOT NULL,
  note                TEXT,
  actor_id            TEXT NOT NULL REFERENCES users(id),
  at                  TEXT NOT NULL,
  version_after       INTEGER NOT NULL,
  reopened_at         TEXT
);
CREATE INDEX IF NOT EXISTS dispositions_case_idx ON dispositions(case_id, at);

CREATE TABLE IF NOT EXISTS case_grants (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES cases(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL,
  note       TEXT,
  revoked_at TEXT,
  UNIQUE (case_id, user_id)
);

CREATE TABLE IF NOT EXISTS action_events (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  actor_id      TEXT NOT NULL REFERENCES users(id),
  actor_bureau  TEXT,
  at            TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  remarks       TEXT,
  next_step     TEXT,
  before_json   TEXT,
  after_json    TEXT,
  version_after INTEGER NOT NULL,
  paired_case_id TEXT
);

CREATE INDEX IF NOT EXISTS action_events_case_idx ON action_events(case_id, at);

CREATE TABLE IF NOT EXISTS transfers (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  from_bureau   TEXT NOT NULL,
  to_bureau     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  requested_by  TEXT NOT NULL REFERENCES users(id),
  requested_at  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','accepted','rejected')),
  decided_by    TEXT REFERENCES users(id),
  decided_at    TEXT,
  decision_note TEXT,
  idempotency_key TEXT
);

CREATE TABLE IF NOT EXISTS relationships (
  id             TEXT PRIMARY KEY,
  case_a_id      TEXT NOT NULL REFERENCES cases(id),
  case_b_id      TEXT NOT NULL REFERENCES cases(id),
  type           TEXT NOT NULL CHECK (type IN ('Related issue','Duplicate report','Separate issues')),
  reason         TEXT NOT NULL,
  reviewer_id    TEXT NOT NULL REFERENCES users(id),
  reviewer_role  TEXT NOT NULL,
  evidence_json  TEXT NOT NULL,
  rule_version   TEXT NOT NULL,
  decided_at     TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('active','revoked')),
  revoked_by     TEXT REFERENCES users(id),
  revoked_at     TEXT,
  revoked_reason TEXT,
  suggestion_id  TEXT
);

CREATE INDEX IF NOT EXISTS relationships_pair_idx ON relationships(case_a_id, case_b_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id            TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  case_a_id     TEXT NOT NULL REFERENCES cases(id),
  case_b_id     TEXT NOT NULL REFERENCES cases(id),
  kind          TEXT NOT NULL CHECK (kind IN ('Duplicate report','Related issue')),
  reasons_json  TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  rule_version  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','dismissed','outdated','accepted')),
  dedupe_key    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  decided_by    TEXT REFERENCES users(id),
  decided_at    TEXT,
  decision_reason TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('Institution overlap','Deadline','Escalation')),
  institution_id  TEXT REFERENCES institutions(id),
  dedupe_key      TEXT NOT NULL UNIQUE,
  case_ids_json   TEXT NOT NULL,
  bureaus_json    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('open','acknowledged','closed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  -- Structured, non-quoting facts (case number, category, bureau, deadline…) used to render a safe
  -- body for a reader who may see the coordination metadata but not the complaint content (M7/A12).
  detail_json     TEXT,
  created_at      TEXT NOT NULL,
  read_at         TEXT,
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  uploaded_at   TEXT NOT NULL,
  -- Publication protocol (M7): a row is only downloadable once its bytes are readable on disk.
  state         TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  scope         TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  request_hash  TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (key, user_id, scope)
);

CREATE TABLE IF NOT EXISTS security_log (
  id       TEXT PRIMARY KEY,
  at       TEXT NOT NULL,
  actor_id TEXT,
  action   TEXT NOT NULL,
  detail   TEXT
);

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_notes (
  id      TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  at      TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pending background work, committed in the same transaction as the business mutation.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','done','failed')) DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  run_after    TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_pending_idx ON jobs(state, run_after);
