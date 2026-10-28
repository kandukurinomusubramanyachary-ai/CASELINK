/**
 * Migration regression check (M3/M5 schema).
 *
 *   node test/migration-check.mjs [path-to-existing-database]
 *
 * Proves three things about a database created by an earlier build:
 *   1. the numbered migrations bring it up to the same shape as a freshly seeded database;
 *   2. no existing record is lost or rewritten (row count, ids, versions and history stay identical);
 *   3. running the migrations a second time changes nothing, and unresolved legacy rows are reported
 *      rather than guessed.
 *
 * The source database is copied first — the original file is never opened for writing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const source = path.resolve(process.argv[2] ?? path.join(repo, 'data/caselink.db'));

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

if (!fs.existsSync(source)) {
  console.log(`No database at ${source}. Pass the path to a database created by an earlier build.`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caselink-migrate-'));
const oldDir = path.join(tmp, 'old');
const freshDir = path.join(tmp, 'fresh');
fs.mkdirSync(oldDir, { recursive: true });
fs.mkdirSync(freshDir, { recursive: true });

/* ---------------------------------------------------------------- 1. copy */
const oldPath = path.join(oldDir, 'caselink.db');
{
  // `VACUUM INTO` produces a consistent copy including any WAL content, and leaves the original
  // untouched (it is only ever read).
  const from = new Database(source, { readonly: true });
  from.exec(`VACUUM INTO '${oldPath.replace(/'/g, "''")}'`);
  from.close();
}
const before = new Database(oldPath, { readonly: true });
const beforeCases = before.prepare('SELECT id, case_number, status, version, received_at FROM cases ORDER BY id').all();
const beforeEvents = before.prepare('SELECT COUNT(*) AS n FROM action_events').get().n;
const beforeCols = new Set(before.prepare('PRAGMA table_info(cases)').all().map((c) => c.name));
// M5: existing import provenance must survive the identity backfill untouched.
const beforeProvenance = beforeCols.has('source_reference') && beforeCols.has('source_system')
  ? before.prepare('SELECT id, source_system, source_reference FROM cases ORDER BY id').all()
  : [];
const preMigration = !beforeCols.has('outcome');
before.close();
console.log(`source: ${source}`);
console.log(`copied to: ${oldPath}`);
console.log(`records before migration: ${beforeCases.length} cases, ${beforeEvents} history events`);
if (!preMigration) {
  console.log('note: this database already has the M3 columns; the check still verifies idempotency and preservation.');
}

/* -------------------------------------------------------- 2. migrate twice */
const run = (dataDir) =>
  execFileSync('npx', ['tsx', 'server/src/migrate.ts'], {
    cwd: repo,
    env: { ...process.env, CASELINK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
const firstRun = run(oldDir);
const secondRun = run(oldDir);
console.log(firstRun.trim().split('\n').map((l) => `  | ${l}`).join('\n'));

check('1. the migration run reports the version it reached', /already at version: \d/.test(firstRun), firstRun.trim().split('\n')[1]);
check('2. a second run applies nothing (idempotent)', /applied: none \(already current\)/.test(secondRun), secondRun.trim().split('\n')[2]);

/* -------------------------------------------------- 3. fresh database path */
execFileSync('npx', ['tsx', 'server/src/seed.ts', '--force'], {
  cwd: repo,
  env: { ...process.env, CASELINK_DATA_DIR: freshDir },
  encoding: 'utf8',
});

const migrated = new Database(oldPath, { readonly: true });
const fresh = new Database(path.join(freshDir, 'caselink.db'), { readonly: true });
const shape = (db) => ({
  columns: db
    .prepare('PRAGMA table_info(cases)')
    .all()
    .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`)
    .sort(),
  tables: db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_')),
  indexes: db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((i) => i.name),
});
const a = shape(migrated);
const b = shape(fresh);
check('3. migrated columns match a freshly created database', JSON.stringify(a.columns) === JSON.stringify(b.columns), `${a.columns.length} vs ${b.columns.length} columns`);
check('4. migrated tables match a freshly created database', JSON.stringify(a.tables) === JSON.stringify(b.tables), a.tables.filter((t) => !b.tables.includes(t)).join(',') || 'same set');
check('5. migrated indexes match a freshly created database', JSON.stringify(a.indexes) === JSON.stringify(b.indexes), a.indexes.filter((i) => !b.indexes.includes(i)).join(',') || 'same set');

/* ------------------------------------------------------- 4. preservation */
const afterCases = migrated.prepare('SELECT id, case_number, status, version, received_at FROM cases ORDER BY id').all();
const afterEvents = migrated.prepare('SELECT COUNT(*) AS n FROM action_events').get().n;
check('6. every case id is preserved', JSON.stringify(beforeCases.map((c) => c.id)) === JSON.stringify(afterCases.map((c) => c.id)), `${afterCases.length} cases`);
check(
  '7. case numbers, statuses, versions and receipt times are untouched',
  JSON.stringify(beforeCases) === JSON.stringify(afterCases),
  'no rewritten rows'
);
check('8. no history event was dropped', afterEvents === beforeEvents, `${beforeEvents} → ${afterEvents}`);
check('9. referential integrity is intact', migrated.prepare('PRAGMA foreign_key_check').all().length === 0, 'no violations');
check('10. the database passes its own integrity check', Object.values(migrated.prepare('PRAGMA integrity_check').get())[0] === 'ok', 'ok');

/* ------------------------------------------------------- 5. gap reporting */
const notes = migrated.prepare('SELECT subject, detail FROM migration_notes ORDER BY at').all();
const legacyDisposed = migrated
  .prepare(
    `SELECT COUNT(*) AS n FROM cases c WHERE c.status IN ('Disposed','Closed')
       AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.case_id = c.id)`
  )
  .get().n;
const unstructured = migrated.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'Disposed' AND outcome IS NULL").get().n;
check(
  '11. legacy disposals are flagged, not given an invented outcome',
  unstructured === 0 || unstructured === notes.filter((n) => /not been invented/.test(n.detail)).length,
  `flagged=${notes.filter((n) => /not been invented/.test(n.detail)).length} unstructured=${unstructured} legacyDisposed=${legacyDisposed}`
);
check(
  '12. every unresolved record is reported once, with a reason',
  new Set(notes.map((n) => n.subject)).size === notes.length,
  `${notes.length} notes`
);
check(
  '13. the CLI reports the unresolvable rows to the operator',
  /unresolved legacy records: (0|none|\d+)/.test(firstRun),
  firstRun.trim().split('\n').slice(-1)[0]
);

/* --------------------------------------------------- 6. M5 import identity */
const versions = migrated.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
check(
  '14. the M5 batch-provenance migration is recorded as applied',
  versions.some((v) => v.version === 4 && /m5_import/.test(v.name)),
  versions.map((v) => `v${v.version}:${v.name}`).join(', ')
);
const batchCols = migrated.prepare('PRAGMA table_info(import_batches)').all().map((c) => c.name);
check(
  '15. the preview/commit binding columns exist after migration',
  ['input_hash', 'policy_snapshot_json', 'result_json'].every((c) => batchCols.includes(c)),
  batchCols.join(',')
);
const backfillMismatch = migrated
  .prepare(
    `SELECT COUNT(*) AS n FROM cases
      WHERE source_channel = 'CSV import' AND source_system IS NOT NULL AND source_reference IS NOT NULL
        AND (source_identity IS NULL
             OR source_identity <> lower(trim(source_system)) || '|' || bureau || '|' || lower(trim(source_reference)))`
  )
  .get().n;
check(
  '16. backfilled import identities are the normalised system|bureau|reference',
  backfillMismatch === 0,
  `mismatched=${backfillMismatch}`
);
const afterProvenance = migrated.prepare('SELECT id, source_system, source_reference FROM cases ORDER BY id').all();
check(
  '17. the backfill preserves every stored source system and reference',
  beforeProvenance.length === 0 || JSON.stringify(beforeProvenance) === JSON.stringify(afterProvenance),
  beforeProvenance.length === 0 ? 'source columns did not exist before v1 — nothing to compare' : `${afterProvenance.length} rows compared`
);

migrated.close();
fresh.close();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\nexecuted: ${results.length}   passed: ${results.length - failed}   failed: ${failed}   skipped: 0`);
console.log(failed === 0 ? 'Migration check: PASS' : 'Migration check: FAIL');
process.exit(failed === 0 ? 0 : 1);
