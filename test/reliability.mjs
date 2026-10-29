/** Submission-blocker regressions. Only temporary, synthetic databases are opened. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { countRequiredSkips } from './required-checks.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caselink-reliability-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const dir = name => path.join(root, name);
const run = (file, data, args = [], env = {}) => spawnSync(process.execPath, ['--import', 'tsx', file, ...args], {
  cwd: repo, env: { ...process.env, CASELINK_DATA_DIR: data, ...env }, encoding: 'utf8', timeout: 30_000,
});
function seed(data) {
  const result = run('server/src/seed.ts', data, ['--force']);
  assert.equal(result.status, 0, result.stderr);
}
async function server(t, data, demo = false) {
  let output = '';
  const port = await new Promise(resolve => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1', () => { const selected = listener.address().port; listener.close(() => resolve(selected)); });
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: repo, env: { ...process.env, CASELINK_DATA_DIR: data, CASELINK_DEMO: String(demo), CASELINK_TEST_HOOKS: 'false', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  };
  t.after(stop);
  const deadline = Date.now() + 15_000;
  while (!/listening on http:\/\/0\.0\.0\.0:\d+/.test(output)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const base = `http://127.0.0.1:${port}`;
  const api = async (url, token, body, extra = {}) => {
    const response = await fetch(`${base}/api${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (username = 'm.nair') => {
    const result = await api('/auth/login', null, { username, password: 'caselink-demo' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.token;
  };
  return { base, api, login, stop, logs: () => output };
}

test('release gate rejects explicit, disguised, TAP and summary-only skipped checks', () => {
  const skippedOutputs = [
    'SKIP  T01 — fixture unavailable',
    'ok 1 - relationship review # SKIP fixture unavailable',
    'PASS  reviewer acknowledgement — no notification fixture — skipped',
    '# tests 2\n# pass 1\n# skipped 1',
    'executed: 2   passed: 1   failed: 0   skipped: 1',
    '1 skipped (not counted as passes):',
  ];
  for (const output of skippedOutputs) assert.ok(countRequiredSkips(output) > 0, output);
  const legitimateOutputs = [
    'PASS import commit — accepted=1 rejected=0 skipped=2',
    'PASS import response — {"accepted":1,"skipped":2}',
    '# tests 1\n# pass 1\n# skipped 0',
    'executed: 1   passed: 1   failed: 0   skipped: 0',
  ];
  for (const output of legitimateOutputs) assert.equal(countRequiredSkips(output), 0, output);
});

test('normal boot creates no fixture accounts and bootstrap uses unique credentials', async t => {
  const data = dir('empty');
  const { api } = await server(t, data);
  const db = new Database(path.join(data, 'caselink.db'));
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cases').get().n, 0);
  assert.equal((await api('/auth/login', null, { username: 'admin', password: 'caselink-demo' })).status, 401);
  const bad = run('server/src/bootstrap-admin.ts', data, [], { CASELINK_ADMIN_USERNAME: 'operator', CASELINK_ADMIN_PASSWORD: 'caselink-demo' });
  assert.notEqual(bad.status, 0);
  const password = 'synthetic-test-only-unique-password-8264';
  const good = run('server/src/bootstrap-admin.ts', data, [], { CASELINK_ADMIN_USERNAME: 'operator', CASELINK_ADMIN_PASSWORD: password });
  assert.equal(good.status, 0, good.stderr);
  assert.equal((await api('/auth/login', null, { username: 'operator', password })).status, 200);
  assert.notEqual(run('server/src/bootstrap-admin.ts', data, [], { CASELINK_ADMIN_USERNAME: 'second', CASELINK_ADMIN_PASSWORD: password }).status, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});

test('setup exits successfully without starting a service or seeding a custom data directory', () => {
  const data = dir('setup-only');
  const setup = spawnSync('bash', ['start.sh', '--setup-only'], {
    cwd: repo, env: { ...process.env, CASELINK_DATA_DIR: data, CASELINK_DEMO: 'true' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /setup complete/);
  assert.equal(fs.existsSync(path.join(data, 'caselink.db')), false);
});

for (const version of [6, 7]) test(`populated v${version} warning migration preserves data and is repeatable`, () => {
  const data = dir(`migration-${version}`);
  seed(data);
  const db = new Database(path.join(data, 'caselink.db'));
  const c = db.prepare('SELECT * FROM cases LIMIT 1').get();
  const before = db.prepare('SELECT id, version FROM cases ORDER BY id').all();
  db.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(version);
  if (version === 6) db.prepare(`INSERT INTO action_events (id,case_id,actor_id,at,action_type,remarks,version_after)
    VALUES ('legacy-unpaired',?,?,?,'relationship_confirmed','PRIVATE_SYNTHETIC_LEGACY',?)`).run(c.id, c.created_by, new Date().toISOString(), c.version);
  else db.prepare(`INSERT INTO attachments (id,case_id,original_name,mime,size,sha256,stored_name,uploaded_by,uploaded_at,state)
    VALUES ('legacy-publishing',?,'synthetic.png','image/png',1,'synthetic','unpublished.png',?,?,'publishing')`).run(c.id, c.created_by, new Date().toISOString());
  db.close();
  const result = run('server/src/migrate.ts', data);
  assert.equal(result.status, 0, result.stderr);
  const after = new Database(path.join(data, 'caselink.db'));
  assert.deepEqual(after.prepare('SELECT id, version FROM cases ORDER BY id').all(), before);
  const note = after.prepare('SELECT at, subject FROM migration_notes WHERE version = ?').get(version);
  assert.ok(note?.subject && Number.isFinite(Date.parse(note.at)));
  const notes = after.prepare('SELECT COUNT(*) n FROM migration_notes').get().n;
  after.close();
  assert.equal(run('server/src/migrate.ts', data).status, 0);
  const again = new Database(path.join(data, 'caselink.db'));
  assert.equal(again.prepare('SELECT COUNT(*) n FROM migration_notes').get().n, notes);
  again.close();
});

test('legacy identity collisions keep both records and flag ambiguous provenance', () => {
  const data = dir('legacy-collision'); seed(data);
  const db = new Database(path.join(data, 'caselink.db'));
  const ids = db.prepare('SELECT id FROM cases ORDER BY id LIMIT 2').all().map(row => row.id);
  const beforeCount = db.prepare('SELECT COUNT(*) n FROM cases').get().n;
  db.exec('DROP INDEX cases_import_identity');
  db.exec(`CREATE UNIQUE INDEX cases_import_dedupe ON cases(source_channel,bureau,source_reference)
    WHERE source_reference IS NOT NULL AND source_channel='CSV import'`);
  for (let i = 0; i < 2; i++) db.prepare(`UPDATE cases SET source_channel='CSV import',bureau='PGRC',source_system='Synthetic register',
    source_identity=NULL,source_reference=? WHERE id=?`).run(i ? 'ref-8264' : ' REF-8264 ', ids[i]);
  db.prepare('DELETE FROM schema_migrations WHERE version>=8').run(); db.close();
  const migrated = run('server/src/migrate.ts', data);
  assert.equal(migrated.status, 0, migrated.stderr);
  const after = new Database(path.join(data, 'caselink.db'));
  assert.equal(after.prepare('SELECT COUNT(*) n FROM cases').get().n, beforeCount);
  assert.equal(after.prepare('SELECT COUNT(*) n FROM cases WHERE id IN (?,?) AND source_identity IS NOT NULL').get(...ids).n, 1);
  assert.equal(after.prepare('SELECT COUNT(*) n FROM migration_notes WHERE version=8').get().n, 1);
  assert.equal(after.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='cases_import_dedupe'").get().n, 0);
  after.close();
  assert.equal(run('server/src/migrate.ts', data).status, 0);
});

test('cross-system imports succeed; normalized repeats remain duplicates', async t => {
  const data = dir('imports'); seed(data);
  const { api, login } = await server(t, data);
  const token = await login();
  const header = 'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact';
  const preview = system => api('/import/preview', token, { sourceSystem: system, csvText: `${header}\nAICTE-DEMO-1001,,2026-09-12,${system},SAME-8264,Fee / refund,Synthetic refund complaint for regression,,,` });
  for (const system of ['Synthetic system A', 'Synthetic system B']) {
    const p = await preview(system);
    assert.equal(p.status, 200); assert.equal(p.data.rows[0].status, 'valid');
    const result = await api(`/import/${p.data.batchId}/commit`, token, {});
    assert.equal(result.data.accepted, 1, JSON.stringify(result.data));
  }
  const repeat = await preview(' SYNTHETIC SYSTEM A ');
  assert.equal(repeat.data.rows[0].status, 'duplicate');
  const db = new Database(path.join(data, 'caselink.db')); t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cases WHERE source_reference='SAME-8264'").get().n, 2);
  assert.throws(() => db.prepare(`UPDATE cases SET source_identity=(SELECT source_identity FROM cases WHERE source_reference='SAME-8264' ORDER BY id LIMIT 1)
    WHERE source_reference='SAME-8264'`).run(), /UNIQUE/);
});

test('outage jobs stay pending, resume after recovery, and malformed jobs stay observable', async t => {
  const data = dir('worker'); seed(data);
  const { api, login, stop } = await server(t, data);
  const lead = await login(), admin = await login('admin');
  const db = new Database(path.join(data, 'caselink.db')); t.after(() => db.close());
  assert.equal((await api('/system/matching-mode', admin, { mode: 'unavailable' })).status, 200);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await api('/cases', lead, { institutionId: 'inst-a', receivedAt: new Date().toISOString(), sourceChannel: 'Email', category: 'Fee / refund', complaintSummary: 'Synthetic identical refund dispute tracking regression 8264', sourceReference: `OUTAGE-${i}` });
    assert.equal(r.status, 201, JSON.stringify(r.data)); ids.push(r.data.id);
  }
  const count = () => db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='recompute_suggestions' AND state='pending'").get().n;
  assert.ok(count() >= 1, 'Matching work must survive the outage');
  await api('/system/worker/tick', admin, {});
  assert.ok(count() >= 1);
  assert.equal((await api('/system/matching-mode', admin, { mode: 'rule-based' })).status, 200);
  await api('/system/worker/tick', admin, {});
  assert.equal(count(), 0);
  assert.ok(db.prepare('SELECT 1 FROM suggestions WHERE case_a_id IN (?,?) AND case_b_id IN (?,?)').get(...ids, ...ids));
  db.prepare(`INSERT INTO jobs (id,kind,payload_json,created_at,run_after) VALUES ('bad-job','recompute_suggestions','{',?,?)`).run(new Date().toISOString(), new Date().toISOString());
  await api('/system/worker/tick', admin, {});
  let status = await api('/system/status', admin);
  assert.ok(status.data.worker.lastError);
  assert.equal(status.data.worker.retryingJobs, 1);
  assert.ok(status.data.worker.oldestPendingAt);
  await api('/system/worker/tick', admin, {});
  assert.ok((await api('/system/status', admin)).data.worker.lastError, 'A later scan must not hide unresolved failures');
  db.prepare("UPDATE jobs SET attempts=4, run_after=? WHERE id='bad-job'").run(new Date().toISOString());
  await api('/system/worker/tick', admin, {});
  assert.equal((await api('/system/status', admin)).data.worker.failedJobs, 1);
  assert.equal((await api('/system/status')).status, 401);
  await stop();
  const restarted = await server(t, data);
  const newAdmin = await restarted.login('admin');
  assert.equal((await restarted.api('/system/status', newAdmin)).data.worker.failedJobs, 1);
});

test('a paused matching backlog does not starve overlap jobs or consume retry attempts', async t => {
  const data = dir('backlog'); seed(data);
  const { api, login } = await server(t, data);
  const admin = await login('admin');
  const db = new Database(path.join(data, 'caselink.db')); t.after(() => db.close());
  await api('/system/matching-mode', admin, { mode: 'unavailable' });
  const old = new Date(Date.now() - 60_000).toISOString();
  const insert = db.prepare('INSERT INTO jobs (id,kind,payload_json,created_at,run_after) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 205; i++) insert.run(`paused-${i}`, 'recompute_suggestions', '{"institutionId":"inst-a"}', old, old);
  insert.run('overlap-after-backlog', 'recompute_overlap', '{"institutionId":"inst-a"}', old, new Date().toISOString());
  await api('/system/worker/tick', admin, {});
  assert.equal(db.prepare("SELECT state FROM jobs WHERE id='overlap-after-backlog'").get().state, 'done');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE id LIKE 'paused-%' AND state='pending' AND attempts=0").get().n, 205);
});

test('relationship revocation uses projected case versions and still rejects stale decisions', async t => {
  const data = dir('relationship-versions'); seed(data);
  const { api, login } = await server(t, data);
  const token = await login();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const c = await api('/cases', token, { institutionId: 'inst-a', receivedAt: new Date().toISOString(), sourceChannel: 'Email',
      category: 'Fee / refund', complaintSummary: 'Synthetic identical refund grievance for relationship version regression 8264' });
    assert.equal(c.status, 201); ids.push(c.data.id);
  }
  const coordination = await api('/coordination', token);
  const suggestion = coordination.data.overlaps.flatMap(alert => alert.suggestions).find(s => ids.includes(s.caseA.id) && ids.includes(s.caseB.id));
  assert.ok(suggestion, 'Synthetic pair must be offered for review');
  const decided = await api(`/suggestions/${suggestion.id}/decision`, token, { decision: 'Related issue', reason: 'Synthetic same-incident decision for regression',
    caseAVersion: suggestion.caseA.version, caseBVersion: suggestion.caseB.version });
  assert.equal(decided.status, 200);
  const relationship = (await api('/relationships', token)).data.relationships.find(r => ids.includes(r.caseA.id) && ids.includes(r.caseB.id));
  assert.ok(relationship?.canRevoke);
  assert.equal(typeof relationship.caseA.version, 'number');
  assert.equal(typeof relationship.caseB.version, 'number');
  assert.equal((await api(`/relationships/${relationship.id}/revoke`, token, { reason: 'Synthetic stale revocation request',
    caseAVersion: suggestion.caseA.version, caseBVersion: suggestion.caseB.version })).status, 409);
  assert.equal((await api(`/relationships/${relationship.id}/revoke`, token, { reason: 'Synthetic reviewed revocation request',
    caseAVersion: relationship.caseA.version, caseBVersion: relationship.caseB.version })).status, 200);
});

test('unpaired relationship history is private in both detail and search', async t => {
  const data = dir('privacy'); seed(data);
  const { api, login } = await server(t, data);
  const token = await login('p.rao');
  const db = new Database(path.join(data, 'caselink.db')); t.after(() => db.close());
  const c = db.prepare("SELECT c.* FROM cases c JOIN institutions i ON i.id=c.institution_id WHERE c.bureau='PGRC' AND i.region='South' LIMIT 1").get();
  const marker = 'SYNTHETIC_PRIVATE_UNRESOLVED_8264';
  db.prepare(`INSERT INTO action_events (id,case_id,actor_id,at,action_type,remarks,after_json,version_after)
    VALUES ('unpaired-secret',?,?,?,'relationship_confirmed',?,?,?)`).run(c.id, 'u-officer-pgrc', new Date().toISOString(), marker, JSON.stringify({ secret: marker }), c.version);
  const detail = await api(`/cases/${c.id}`, token);
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.data).includes(marker));
  assert.equal((await api(`/search?q=${marker}`, token)).data.results.length, 0);
  assert.equal((await api('/search?q=unpaired-secret', token)).data.results.length, 0);
});

test('cross-site writes, oversized credentials and login guessing are rejected', async t => {
  const data = dir('auth'); seed(data);
  const { api, login, base, logs } = await server(t, data);
  const token = await login();
  const body = { username: 'm.nair', password: 'caselink-demo' };
  const session = await api('/auth/login', null, body, { Origin: base });
  assert.equal(session.status, 200);
  assert.match(session.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal((await api('/auth/login', null, body, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await api('/auth/logout', token, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await api('/auth/login', null, { username: 'a'.repeat(500), password: 'b'.repeat(500) })).status, 422);
  const malformed = await fetch(`${base}/api/session`, { headers: { Cookie: 'caselink_session=%ZZ' } });
  assert.equal(malformed.status, 200);
  assert.equal((await malformed.json()).authenticated, false);
  const privateMarker = 'PRIVATE_MALFORMED_COMPLAINT_8264';
  const invalidJson = await fetch(`${base}/api/cases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"complaintSummary":"${privateMarker}",`,
  });
  assert.equal(invalidJson.status, 400);
  assert.ok(!(await invalidJson.text()).includes(privateMarker));
  assert.ok(!logs().includes(privateMarker));
  let blocked;
  for (let i = 0; i < 25; i++) {
    blocked = await api('/auth/login', null, { username: 'm.nair', password: 'wrong-synthetic-password' });
    if (blocked.status === 429) break;
  }
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});
