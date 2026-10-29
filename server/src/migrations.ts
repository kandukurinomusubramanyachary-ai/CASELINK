/**
 * Explicit, repeatable schema migrations.
 *
 * The prototype started from a single `schema.sql` executed with `CREATE TABLE IF NOT EXISTS`, which
 * cannot add columns to an existing database. Milestones M3 and M5 need new columns and tables, so they
 * arrive as numbered migrations recorded in `schema_migrations`. Migrations are applied at boot (and by
 * the seed script) and are idempotent: re-running them changes nothing.
 *
 * Rules followed here:
 *  - never delete or recreate a table that holds user records;
 *  - never guess a value: legacy rows that cannot be derived are left NULL and reported;
 *  - every migration runs inside a transaction;
 *  - `schema.sql` stays the authoritative description of a *fresh* database, and both paths must agree.
 */
import { db } from './db.js';
import { importIdentity } from './csv.js';

/**
 * Local timestamp helper: this module is imported *by* `db.js` while that module is still
 * initialising, so it must not use `db.js` exports that are declared after the connection.
 */
const nowIso = (): string => new Date().toISOString();

export interface Migration {
  version: number;
  name: string;
  up: () => void;
}

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function addColumnIfMissing(table: string, column: string, definition: string): void {
  if (!columns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'm3_lifecycle_outcomes_and_import_source',
    up: () => {
      // Structured, durable disposition outcome and decision reference (M3).
      addColumnIfMissing('cases', 'outcome', 'TEXT');
      addColumnIfMissing('cases', 'decision_reference', 'TEXT');
      // Import provenance identity (M5): the source system is part of the dedupe identity.
      addColumnIfMissing('cases', 'source_system', 'TEXT');
      addColumnIfMissing('cases', 'source_identity', 'TEXT');

      db.exec(`CREATE TABLE IF NOT EXISTS dispositions (
        id                  TEXT PRIMARY KEY,
        case_id             TEXT NOT NULL REFERENCES cases(id),
        outcome             TEXT NOT NULL,
        decision_reference  TEXT NOT NULL,
        note                TEXT,
        actor_id            TEXT NOT NULL REFERENCES users(id),
        at                  TEXT NOT NULL,
        version_after       INTEGER NOT NULL,
        reopened_at         TEXT
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS dispositions_case_idx ON dispositions(case_id, at)');

      // Backfill import provenance from the batch that created the case. Rows whose batch is missing
      // keep NULL and are reported by `reportMigrationGaps()` rather than being guessed.
      db.exec(`UPDATE cases
                  SET source_system = (SELECT b.source_system FROM import_batches b WHERE b.id = cases.import_batch_id)
                WHERE source_system IS NULL AND import_batch_id IS NOT NULL`);
      db.exec(`UPDATE cases
                  SET source_identity = lower(trim(source_system)) || '|' || bureau || '|' || lower(trim(source_reference))
                WHERE source_channel = 'CSV import' AND source_reference IS NOT NULL
                  AND source_system IS NOT NULL AND source_identity IS NULL`);

      // Legacy imported rows that predate source-system capture are surfaced, not silently merged.
      db.exec(`CREATE TABLE IF NOT EXISTS migration_notes (
        id        TEXT PRIMARY KEY,
        version   INTEGER NOT NULL,
        at        TEXT NOT NULL,
        subject   TEXT NOT NULL,
        detail    TEXT NOT NULL
      )`);
      const ambiguous = db
        .prepare(
          `SELECT id, case_number FROM cases
            WHERE source_channel = 'CSV import' AND source_reference IS NOT NULL AND source_system IS NULL`
        )
        .all() as { id: string; case_number: string }[];
      for (const row of ambiguous) {
        const exists = db.prepare('SELECT 1 FROM migration_notes WHERE subject = ?').get(row.id);
        if (!exists) {
          db.prepare('INSERT INTO migration_notes (id, version, at, subject, detail) VALUES (?,?,?,?,?)').run(
            `note-${row.id}`,
            1,
            nowIso(),
            row.id,
            `Imported case ${row.case_number} has no recorded source system; its dedupe identity is reported as unresolved instead of being guessed.`
          );
        }
      }
    },
  },
  {
    version: 2,
    name: 'm3_flag_legacy_dispositions',
    up: () => {
      // Cases disposed or closed before structured outcomes existed. Nothing is inferred: each one is
      // flagged once in `migration_notes`, and reports surface the count separately.
      db.exec(`CREATE TABLE IF NOT EXISTS migration_notes (
        id        TEXT PRIMARY KEY,
        version   INTEGER NOT NULL,
        at        TEXT NOT NULL,
        subject   TEXT NOT NULL,
        detail    TEXT NOT NULL
      )`);
      const legacy = db
        .prepare(
          `SELECT c.id, c.case_number, c.status FROM cases c
            WHERE c.status IN ('Disposed','Closed')
              AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.case_id = c.id)`
        )
        .all() as { id: string; case_number: string; status: string }[];
      for (const row of legacy) {
        if (db.prepare('SELECT 1 FROM migration_notes WHERE subject = ?').get(row.id)) continue;
        db.prepare('INSERT INTO migration_notes (id, version, at, subject, detail) VALUES (?,?,?,?,?)').run(
          `note-legacy-disposal-${row.id}`,
          2,
          nowIso(),
          row.id,
          `Case ${row.case_number} is ${row.status} from before structured outcomes; its outcome and decision reference were not recorded and have not been invented.`
        );
      }
    },
  },
  {
    version: 3,
    name: 'm4_idempotency_request_fingerprint',
    up: () => {
      // Idempotent replays must present the same payload; the fingerprint is what proves it.
      addColumnIfMissing('idempotency_keys', 'request_hash', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'm5_import_batch_identity_and_snapshot',
    up: () => {
      // Preview/commit binding (M5): the normalised input fingerprint, the deadline-policy snapshot the
      // officer saw, and the recorded outcome so a retried commit is answered from what actually happened.
      addColumnIfMissing('import_batches', 'input_hash', 'TEXT');
      addColumnIfMissing('import_batches', 'policy_snapshot_json', 'TEXT');
      addColumnIfMissing('import_batches', 'result_json', 'TEXT');
      // Identity backfill for rows imported before the identity existed: derived only from data that is
      // already stored, and left NULL when it cannot be derived.
      db.exec(`UPDATE cases
                  SET source_identity = lower(trim(source_system)) || '|' || bureau || '|' || lower(trim(source_reference))
                WHERE source_identity IS NULL AND source_channel = 'CSV import'
                  AND source_system IS NOT NULL AND source_reference IS NOT NULL`);
    },
  },
  {
    version: 5,
    name: 'm6_case_list_indexes',
    up: () => {
      // The list endpoint filters and paginates in SQL (M6); these keep it flat as the table grows.
      db.exec('CREATE INDEX IF NOT EXISTS cases_status_idx ON cases(status)');
      db.exec('CREATE INDEX IF NOT EXISTS cases_assigned_idx ON cases(assigned_officer_id)');
      db.exec('CREATE INDEX IF NOT EXISTS cases_expected_disposal_idx ON cases(expected_disposal_at)');
      db.exec('CREATE INDEX IF NOT EXISTS cases_updated_idx ON cases(updated_at)');
    },
  },
  {
    version: 6,
    name: 'm7_relationship_history_pairing_and_notification_detail',
    up: () => {
      // A relationship decision writes one history event into *each* of the two cases. The event must
      // remember the other case, so its free-text remarks can be withheld from a reader who can open
      // this case but not the paired one (M7/A02).
      addColumnIfMissing('action_events', 'paired_case_id', 'TEXT');
      // Legacy relationship events are paired from data that is already stored: the relationship id in
      // `after_json`, or the paired case number for a dismissal. Nothing is invented.
      const legacy = db
        .prepare(
          `SELECT id, case_id, action_type, after_json FROM action_events
            WHERE paired_case_id IS NULL AND action_type IN
              ('relationship_confirmed','relationship_dismissed','relationship_revoked')`
        )
        .all() as { id: string; case_id: string; action_type: string; after_json: string | null }[];
      const pairOf = db.prepare('SELECT case_a_id, case_b_id FROM relationships WHERE id = ?');
      const byNumber = db.prepare('SELECT id FROM cases WHERE case_number = ?');
      const setPair = db.prepare('UPDATE action_events SET paired_case_id = ? WHERE id = ?');
      const unresolved: string[] = [];
      for (const event of legacy) {
        let paired: string | null = null;
        let after: Record<string, unknown> = {};
        try {
          after = event.after_json ? (JSON.parse(event.after_json) as Record<string, unknown>) : {};
        } catch {
          after = {};
        }
        const relationshipId = typeof after.relationshipId === 'string' ? after.relationshipId : null;
        if (relationshipId) {
          const row = pairOf.get(relationshipId) as { case_a_id: string; case_b_id: string } | undefined;
          if (row) paired = row.case_a_id === event.case_id ? row.case_b_id : row.case_a_id;
        }
        if (!paired && typeof after.pairedWith === 'string') {
          const row = byNumber.get(after.pairedWith) as { id: string } | undefined;
          if (row) paired = row.id;
        }
        if (paired) setPair.run(paired, event.id);
        else unresolved.push(event.id);
      }
      // Notifications keep their text, but a safe structured detail is stored so a reader without
      // content access is shown the coordination facts rather than the stored free text (M7/A12).
      addColumnIfMissing('notifications', 'detail_json', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS action_events_pair_idx ON action_events(paired_case_id)');
      if (unresolved.length) {
        db.prepare('INSERT INTO migration_notes (id, version, at, subject, detail) VALUES (?,?,?,?,?)').run(
          `note-${Math.random().toString(36).slice(2, 10)}`,
          6,
          nowIso(),
          'relationship history without a resolvable pair',
          `${unresolved.length} legacy relationship history event(s) could not be paired with the other case ` +
            `(relationship id or paired case number missing). Their remarks are withheld until the pair can be resolved, ` +
            `and the case itself is unchanged.`
        );
      }
    },
  },
  {
    version: 7,
    name: 'm7_attachment_publication_state',
    up: () => {
      // Evidence publication is a two-step protocol: the row is written as 'publishing', the file is
      // renamed into place, and only then does the row become 'ready'. A row that is not 'ready' is
      // never listed or downloadable, so a failed publication cannot be reported as a saved file
      // (M7/A05). Existing rows were published by the old code and are 'ready'.
      addColumnIfMissing('attachments', 'state', "TEXT NOT NULL DEFAULT 'ready'");
      db.exec('CREATE INDEX IF NOT EXISTS attachments_state_idx ON attachments(state)');
      const interrupted = db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE state <> 'ready'`).get() as { n: number };
      if (interrupted.n > 0) {
        db.prepare('INSERT INTO migration_notes (id, version, at, subject, detail) VALUES (?,?,?,?,?)').run(
          `note-${Math.random().toString(36).slice(2, 10)}`,
          7,
          nowIso(),
          'interrupted evidence publication',
          `${interrupted.n} attachment row(s) were left in a non-published state by an interrupted upload. ` +
            'They are not offered for download and are reconciled at the next start.'
        );
      }
    },
  },
  {
    version: 8,
    name: 'submission_canonical_import_identity',
    up: () => {
      // The old index omitted source_system and rejected valid imports from a second register.
      // This runs after the provenance columns exist, including on pre-M3 databases.
      db.exec('DROP INDEX IF EXISTS cases_import_dedupe');
      const rows = db.prepare(`SELECT id, source_system, bureau, source_reference, source_identity
        FROM cases WHERE source_channel = 'CSV import' ORDER BY id`).all() as {
        id: string; source_system: string | null; bureau: string; source_reference: string | null; source_identity: string | null;
      }[];
      const seen = new Set<string>();
      for (const row of rows) {
        const identity = row.source_identity ?? importIdentity(row.source_system ?? '', row.bureau, row.source_reference ?? '');
        if (identity && seen.has(identity)) {
          // Preserve every legacy record. One canonical row reserves the identity; ambiguous extras
          // remain explicitly unresolved and appear in the migration report for manual reconciliation.
          db.prepare('UPDATE cases SET source_identity = NULL WHERE id = ?').run(row.id);
          db.prepare('INSERT INTO migration_notes (id,version,at,subject,detail) VALUES (?,?,?,?,?)').run(
            `note-import-collision-${row.id}`, 8, nowIso(), row.id,
            'Legacy imported records share a normalized identity. This record was preserved without an identity; reconcile the provenance manually.'
          );
        } else if (identity) {
          seen.add(identity);
          db.prepare('UPDATE cases SET source_identity = ? WHERE id = ?').run(identity, row.id);
        }
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cases_import_identity ON cases(source_identity) WHERE source_identity IS NOT NULL');
    },
  },
  {
    version: 9,
    name: 'm2_supervisor_review_handoff',
    up: () => {
      db.exec('CREATE TABLE IF NOT EXISTS m2_review_handoffs (' +
        'id TEXT PRIMARY KEY, suggestion_id TEXT NOT NULL REFERENCES suggestions(id), ' +
        'sent_by TEXT NOT NULL REFERENCES users(id), supervisor_id TEXT NOT NULL REFERENCES users(id), ' +
        'reason TEXT NOT NULL, sent_at TEXT NOT NULL, UNIQUE(suggestion_id, supervisor_id))');
      db.exec('CREATE INDEX IF NOT EXISTS m2_handoffs_supervisor_idx ON m2_review_handoffs(supervisor_id, sent_at)');
    },
  },
  {
    version: 10,
    name: 'm3_supervisor_review_ledger',
    up: () => {
      db.exec(`CREATE TABLE IF NOT EXISTS m3_reviews (
        id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL UNIQUE REFERENCES m2_review_handoffs(id),
        state TEXT NOT NULL CHECK (state IN ('pending','needs_review','awaiting_evidence','accepted')),
        note TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        accepted_at TEXT
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS m3_review_events (
        id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL REFERENCES m2_review_handoffs(id),
        actor_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        at TEXT NOT NULL,
        version_after INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS m3_review_events_by_handoff ON m3_review_events(handoff_id, at)');
    },
  },

  {
    version: 11,
    name: 'm4_versioned_relationship_decisions',
    up: () => {
      db.exec("CREATE TABLE IF NOT EXISTS m4_drafts ("+
        "handoff_id TEXT PRIMARY KEY REFERENCES m2_review_handoffs(id),"+
        "actor_id TEXT NOT NULL REFERENCES users(id),"+
        "decision TEXT NOT NULL CHECK(decision IN ('Same','Related','Separate')),"+
        "reason_category TEXT NOT NULL,reason TEXT NOT NULL,"+
        "version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS m4_decisions ("+
        "id TEXT PRIMARY KEY,handoff_id TEXT NOT NULL REFERENCES m2_review_handoffs(id),"+
        "suggestion_id TEXT NOT NULL REFERENCES suggestions(id),pair_key TEXT NOT NULL,"+
        "decision TEXT NOT NULL CHECK(decision IN ('Same','Related','Separate')),"+
        "reason_category TEXT NOT NULL,reason TEXT NOT NULL,"+
        "relationship_id TEXT REFERENCES relationships(id),"+
        "reviewer_id TEXT NOT NULL REFERENCES users(id),"+
        "state TEXT NOT NULL CHECK(state IN ('confirmed','reversed')),"+
        "version INTEGER NOT NULL DEFAULT 1,decided_at TEXT NOT NULL,"+
        "reversed_by TEXT REFERENCES users(id),reversed_at TEXT,reversed_reason TEXT)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS m4_one_active_pair "+
        "ON m4_decisions(pair_key) WHERE state='confirmed'");
      db.exec("CREATE INDEX IF NOT EXISTS m4_decisions_by_handoff "+
        "ON m4_decisions(handoff_id,decided_at)");
      db.exec("CREATE TABLE IF NOT EXISTS m4_decision_events ("+
        "id TEXT PRIMARY KEY,handoff_id TEXT NOT NULL REFERENCES m2_review_handoffs(id),"+
        "decision_id TEXT REFERENCES m4_decisions(id),"+
        "actor_id TEXT NOT NULL REFERENCES users(id),"+
        "action TEXT NOT NULL,reason TEXT NOT NULL,"+
        "from_state TEXT NOT NULL,to_state TEXT NOT NULL,"+
        "at TEXT NOT NULL,version_after INTEGER NOT NULL)");
      db.exec("CREATE INDEX IF NOT EXISTS m4_events_handoff "+
        "ON m4_decision_events(handoff_id,at)");
      db.exec("CREATE TRIGGER IF NOT EXISTS m4_events_no_update "+
        "BEFORE UPDATE ON m4_decision_events BEGIN "+
        "SELECT RAISE(ABORT,'m4 audit events are immutable'); END");
      db.exec("CREATE TRIGGER IF NOT EXISTS m4_events_no_delete "+
        "BEFORE DELETE ON m4_decision_events BEGIN "+
        "SELECT RAISE(ABORT,'m4 audit events are immutable'); END");
      db.exec("CREATE TABLE IF NOT EXISTS m4_idempotency ("+
        "id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),"+
        "scope TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,"+
        "response_json TEXT NOT NULL,created_at TEXT NOT NULL,"+
        "UNIQUE(actor_id,scope,key))");
    },
  },

];

/** Apply every migration whose version is not yet recorded. Safe to call repeatedly. */
export function runMigrations(): { applied: number[]; alreadyAt: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const current = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(
        migration.version,
        migration.name,
        nowIso()
      );
    })();
    applied.push(migration.version);
  }
  return { applied, alreadyAt: current };
}

/** Rows a migration deliberately left unresolved, for the operator report. */
export function reportMigrationGaps(): { subject: string; detail: string }[] {
  try {
    return db.prepare('SELECT subject, detail FROM migration_notes ORDER BY at').all() as {
      subject: string;
      detail: string;
    }[];
  } catch {
    return [];
  }
}
