import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Circular by design: `migrations.ts` only touches `db` inside its functions, and this module calls it
// after the connection exists.
import { runMigrations } from './migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CASELINK_DATA_DIR ?? path.resolve(here, '../../data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'caselink.db');
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

/**
 * Column/table migrations for databases created by an earlier build. `schema.sql` describes a fresh
 * database; `migrations.ts` brings an existing one forward without deleting data. Runs synchronously
 * before any module issues a query.
 */
const migrationResult = runMigrations();
export const MIGRATION_STATE = migrationResult;

export const nowIso = (): string => new Date().toISOString();
export const uid = (): string => crypto.randomUUID();

export function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Readable, bureau-coded case number: PGRC-2026-00042 */
export function nextCaseNumber(bureau: string, receivedAt: string): string {
  const year = new Date(receivedAt).getUTCFullYear();
  const name = `${bureau}-${year}`;
  const row = db.prepare('SELECT value FROM sequences WHERE name = ?').get(name) as { value: number } | undefined;
  const next = (row?.value ?? 0) + 1;
  if (row) db.prepare('UPDATE sequences SET value = ? WHERE name = ?').run(next, name);
  else db.prepare('INSERT INTO sequences (name, value) VALUES (?, ?)').run(name, next);
  return `${bureau}-${year}-${String(next).padStart(5, '0')}`;
}

/** Transaction helper. Every mutation commits its case change + action event atomically. */
export function tx<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function audit(actorId: string | null, action: string, detail: string): void {
  db.prepare('INSERT INTO security_log (id, at, actor_id, action, detail) VALUES (?,?,?,?,?)').run(
    uid(),
    nowIso(),
    actorId,
    action,
    detail
  );
}

export function setting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function putSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
