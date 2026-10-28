/**
 * CLI: apply pending migrations to the database in CASELINK_DATA_DIR and print what happened.
 *
 *   CASELINK_DATA_DIR=/path/to/data npx tsx server/src/migrate.ts
 *
 * Importing `db.js` executes `schema.sql` (fresh databases) and then the numbered migrations
 * (existing databases), so this command is safe to run repeatedly and never deletes records.
 */
import { DB_PATH, MIGRATION_STATE } from './db.js';
import { reportMigrationGaps } from './migrations.js';

const { applied, alreadyAt } = MIGRATION_STATE;
console.log(`database: ${DB_PATH}`);
console.log(`already at version: ${alreadyAt}`);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'applied: none (already current)');

const gaps = reportMigrationGaps();
if (gaps.length === 0) {
  console.log('unresolved legacy records: none');
} else {
  console.log(`unresolved legacy records: ${gaps.length}`);
  for (const gap of gaps) console.log(`  - ${gap.subject}: ${gap.detail}`);
}
