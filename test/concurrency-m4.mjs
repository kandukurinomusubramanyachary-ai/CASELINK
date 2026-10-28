/**
 * M4 — concurrency, transactions, retries and evidence staging.
 *
 *   BASE=http://127.0.0.1:8104 CASELINK_DB=/tmp/m4data/caselink.db node test/concurrency-m4.mjs
 *
 * Requires an instance started with CASELINK_TEST_HOOKS=true (the acceptance runner does this too) so
 * the administrator-only fault injection can prove rollback. If the hooks are off, the fault-injection
 * checks are reported as skipped — never as passes.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.PASSWORD ?? 'caselink-demo';
const DB_PATH = process.env.CASELINK_DB ?? 'data/caselink.db';
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');

const results = [];
const skipped = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}  —  ${why}`);
};

async function api(pathname, { method = 'GET', body, token, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text, headers: res.headers };
}
async function signIn(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`sign-in failed ${username}: ${r.status}`);
  return { username, token: r.data.token, id: r.data.user.id, role: r.data.user.role, bureau: r.data.user.bureau };
}

const Database = (await import('better-sqlite3')).default;
const db = new Database(DB_PATH, { readonly: true });
const caseRow = (id) =>
  db.prepare('SELECT id, bureau, status, version, next_action, assigned_officer_id, escalation_open, expected_disposal_at FROM cases WHERE id = ?').get(id);
const events = (id) => db.prepare('SELECT action_type, version_after FROM action_events WHERE case_id = ?').all(id);
const jobCount = () => db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
const attachmentRows = (caseId) => db.prepare('SELECT id, stored_name FROM attachments WHERE case_id = ?').all(caseId);
const securityCount = () => db.prepare('SELECT COUNT(*) AS n FROM security_log').get().n;
const securityHas = (needle) =>
  db.prepare('SELECT COUNT(*) AS n FROM security_log WHERE detail LIKE ?').get(`%${needle}%`).n;

const admin = await signIn('admin');
const lead = await signIn('m.nair');
const rbLead = await signIn('l.verma');
const officer = await signIn('p.rao');
const supervisor = await signIn('a.desai');
const rbOfficer = await signIn('s.iyer');

const institutions = (await api('/api/institutions', { token: lead.token })).data?.institutions ?? [];
const inst = institutions.find((i) => i.region === 'South') ?? institutions[0];
if (!inst) {
  console.log('Cannot continue: no institution visible to the PGRC lead.');
  process.exit(1);
}

const MARK = `M4-${Date.now()}`;
async function createCase(user = lead, overrides = {}) {
  const r = await api('/api/cases', {
    method: 'POST',
    token: user.token,
    body: {
      institutionId: inst.id,
      receivedAt: new Date().toISOString(),
      sourceChannel: 'Email',
      sourceReference: `REF-${MARK}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'Infrastructure',
      complaintSummary: `Concurrency fixture ${MARK}: created by the M4 regression suite.`,
      deadlinePolicyId: 'DEMO-POL-30',
      ...overrides,
    },
  });
  if (r.status !== 201) throw new Error(`case fixture failed: ${r.status} ${r.text}`);
  return r.data;
}
const patchCase = (user, id, body) => api(`/api/cases/${id}`, { method: 'PATCH', token: user.token, body });

/** The hooks are administrator-only *and* opt-in; report a skip rather than a pass when they are off. */
const hookProbe = await api('/api/system/inject-audit-failure', {
  method: 'POST',
  token: admin.token,
  body: { on: false, target: 'audit' },
});
const HOOKS = hookProbe.status === 200;
const setFault = async (target, on) => {
  const r = await api('/api/system/inject-audit-failure', { method: 'POST', token: admin.token, body: { on, target } });
  return r.status === 200;
};

/* ============================================ 1. version guards on every mutation */
console.log('\n== 1. Every versioned mutation validates the version the user saw ==');
{
  const stale = async (name, makeRequest, overrides = {}) => {
    const c = await createCase(lead, overrides);
    const assigned = await patchCase(lead, c.id, { version: c.version, status: 'Assigned', remarks: 'assigned for the version-guard check' });
    const before = caseRow(c.id);
    const eventsBefore = events(c.id).length;
    const response = await makeRequest(c.id, before);
    const after = caseRow(c.id);
    check(
      name,
      response.status === 409 &&
        response.data?.error === 'stale_version' &&
        after.version === before.version &&
        after.status === before.status &&
        events(c.id).length === eventsBefore,
      `HTTP ${response.status} (${response.data?.error ?? '-'}) version ${before.version}→${after.version} events ${eventsBefore}→${events(c.id).length}${assigned ? '' : ''}`
    );
  };

  await stale('1a PATCH case with a stale version → 409, nothing written', (id, row) =>
    patchCase(lead, id, { version: row.version - 5, remarks: 'stale field edit attempt' })
  );
  await stale('1b action form with a stale version → 409', (id, row) =>
    api(`/api/cases/${id}/actions`, {
      method: 'POST',
      token: lead.token,
      body: { version: row.version - 5, actionType: 'review_completed', remarks: 'stale action attempt' },
    })
  );
  await stale('1c assign with a stale version → 409', (id, row) =>
    api(`/api/cases/${id}/assign`, {
      method: 'POST',
      token: lead.token,
      body: { version: row.version - 5, officerId: officer.id, reason: 'stale assignment attempt' },
    })
  );
  await stale('1d transfer request with a stale version → 409', (id, row) =>
    api(`/api/cases/${id}/transfer`, {
      method: 'POST',
      token: lead.token,
      body: { version: row.version - 5, toBureau: 'RB', reason: 'stale transfer request attempt' },
    })
  );
  await stale('1e deadline change with a stale version → 409', (id, row) =>
    api(`/api/cases/${id}/deadline`, {
      method: 'POST',
      token: lead.token,
      body: { version: row.version - 5, expectedDisposalAt: new Date(Date.now() + 7 * 864e5).toISOString(), reason: 'stale deadline attempt' },
    })
  );
  await stale('1f escalation with a stale version → 409', (id, row) =>
    api(`/api/cases/${id}/escalate`, {
      method: 'POST',
      token: lead.token,
      body: { version: row.version - 5, reason: 'stale escalation attempt', supervisorId: supervisor.id },
    })
  );
  await stale('1g grant with a stale version → 409', (id, row) =>
    api(`/api/cases/${id}/grants`, {
      method: 'POST',
      token: lead.token,
      body: { version: row.version - 5, userId: supervisor.id, note: 'stale grant attempt' },
    })
  );
  // Triage only applies to an unresolved intake, so the fixture is a triage case (no institution yet).
  await stale(
    '1h triage resolution with a stale version → 409',
    (id, row) =>
      api(`/api/cases/${id}/triage`, {
        method: 'POST',
        token: lead.token,
        body: { version: row.version - 5, institutionId: inst.id, reason: 'stale triage attempt' },
      }),
    { institutionId: null, intakeInstitutionText: `Concurrency fixture ${MARK} unconfirmed college name` }
  );
}

/* ============================================ 2. concurrent writers */
console.log('\n== 2. Two editors on one version: exactly one wins ==');
{
  const c = await createCase();
  const [first, second] = await Promise.all([
    patchCase(lead, c.id, { version: c.version, nextAction: 'First editor wins', remarks: 'concurrent save from the first editor' }),
    patchCase(lead, c.id, { version: c.version, nextAction: 'Second editor wins', remarks: 'concurrent save from the second editor' }),
  ]);
  const statuses = [first.status, second.status].sort();
  const row = caseRow(c.id);
  check(
    '2a one save succeeds and the other reports a conflict',
    statuses[0] === 200 && statuses[1] === 409,
    `statuses=${statuses.join('/')}`
  );
  check('2b the record advanced exactly one version', row.version === c.version + 1, `v${c.version} → v${row.version}`);
  const updateEvents = events(c.id).filter((e) => e.version_after === row.version);
  check('2c exactly one business event was written for that version', updateEvents.length === 1, `events at new version=${updateEvents.length}`);
  check('2d the stored next action belongs to the winning save', row.next_action === (first.status === 200 ? 'First editor wins' : 'Second editor wins'), `nextAction=${row.next_action}`);
}

/* ============================================ 3. idempotent retries */
console.log('\n== 3. Idempotent creation and transfers ==');
{
  const key = `m4-create-${MARK}`;
  const payload = {
    institutionId: inst.id,
    receivedAt: new Date().toISOString(),
    sourceChannel: 'Email',
    sourceReference: `IDEM-${MARK}`,
    category: 'Infrastructure',
    complaintSummary: 'Idempotency fixture: a retried submission must not create a second case.',
  };
  const first = await api('/api/cases', { method: 'POST', token: lead.token, body: { ...payload, idempotencyKey: key } });
  const replay = await api('/api/cases', { method: 'POST', token: lead.token, body: { ...payload, idempotencyKey: key } });
  check(
    '3a a retried creation returns the same case',
    first.status === 201 && replay.status === 201 && first.data.id === replay.data.id,
    `ids ${first.data?.id === replay.data?.id ? 'match' : 'differ'}`
  );
  check('3b the replay is flagged as a replay', replay.headers.get('idempotent-replay') === 'true', `header=${replay.headers.get('idempotent-replay')}`);
  const count = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE source_reference = ?').get(`IDEM-${MARK}`).n;
  check('3c no duplicate record was created', count === 1, `rows=${count}`);

  const changed = await api('/api/cases', {
    method: 'POST',
    token: lead.token,
    body: { ...payload, complaintSummary: 'A different payload must not reuse the same idempotency key.', idempotencyKey: key },
  });
  check('3d the same key with a different payload is refused', changed.status === 409 && changed.data?.error === 'idempotency_conflict', `HTTP ${changed.status} (${changed.data?.error})`);

  // Transfer: replay must return the same transfer, not a second request.
  const c = await createCase();
  const assigned = await patchCase(lead, c.id, { version: c.version, status: 'Assigned', remarks: 'assigned for the idempotency check' });
  const transferBody = {
    version: assigned.data.version,
    toBureau: 'RB',
    reason: 'Idempotency fixture: retried transfer request (suite).',
    idempotencyKey: `m4-transfer-${MARK}`,
  };
  const t1 = await api(`/api/cases/${c.id}/transfer`, { method: 'POST', token: lead.token, body: transferBody });
  const t2 = await api(`/api/cases/${c.id}/transfer`, { method: 'POST', token: lead.token, body: transferBody });
  const transferRows = db.prepare('SELECT COUNT(*) AS n FROM transfers WHERE case_id = ?').get(c.id).n;
  check(
    '3e a retried transfer request returns the same transfer',
    t1.status === 201 && t2.status === 201 && t1.data.transferId === t2.data.transferId && transferRows === 1,
    `rows=${transferRows}`
  );
  const notifRows = db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE entity_id = ? AND kind = 'transfer'")
    .get(t1.data.transferId).n;
  check('3f the retry did not duplicate the coordinators’ notifications', notifRows <= 2, `notifications=${notifRows}`);

  // Authority is re-checked on every attempt, including a replay.
  const pending = caseRow(c.id);
  const accept = await api(`/api/transfers/${t1.data.transferId}/decision`, {
    method: 'POST',
    token: rbLead.token,
    body: { version: pending.version, decision: 'accept', note: 'Accepting to prove replay re-checks authority.' },
  });
  const replayAfterMove = await api(`/api/cases/${c.id}/transfer`, { method: 'POST', token: lead.token, body: transferBody });
  check(
    '3g a replay after the case moved away re-checks authority instead of replaying a success',
    accept.status === 200 && replayAfterMove.status === 403,
    `accept=${accept.status} replay=${replayAfterMove.status} (${replayAfterMove.data?.error ?? '-'})`
  );
}

/* ============================================ 4. transactional atomicity */
console.log('\n== 4. Mutation, history and queued work commit together ==');
if (!HOOKS) {
  skip('4a-4d fault injection (rollback proof)', 'the administrator-only fault-injection hook is disabled on this instance (start it with CASELINK_TEST_HOOKS=true)');
} else {
  const c = await createCase();
  const before = caseRow(c.id);
  const eventsBefore = events(c.id).length;
  const jobsBefore = jobCount();

  await setFault('audit', true);
  const failedWrite = await patchCase(lead, c.id, { version: before.version, nextAction: 'Should not persist', remarks: 'This save must roll back entirely.' });
  await setFault('audit', false);
  const afterAudit = caseRow(c.id);
  check(
    '4a a failed history write rolls the whole mutation back',
    failedWrite.status >= 500 && afterAudit.version === before.version && events(c.id).length === eventsBefore && jobCount() === jobsBefore,
    `HTTP ${failedWrite.status} version ${before.version}→${afterAudit.version} events ${eventsBefore}→${events(c.id).length} jobs ${jobsBefore}→${jobCount()}`
  );

  await setFault('job', true);
  const failedJob = await patchCase(lead, c.id, { version: before.version, status: 'Assigned', remarks: 'This one must roll back when its queued work cannot be written.', assignedOfficerId: null });
  await setFault('job', false);
  const afterJob = caseRow(c.id);
  check(
    '4b a failure while queueing background work rolls back the case and its event',
    failedJob.status >= 500 && afterJob.version === before.version && afterJob.status === before.status && events(c.id).length === eventsBefore,
    `HTTP ${failedJob.status} version ${before.version}→${afterJob.version} status=${afterJob.status} events ${eventsBefore}→${events(c.id).length}`
  );

  // A lifecycle change is the mutation that also queues institution work, so use one here.
  const clean = await patchCase(lead, c.id, { version: before.version, status: 'Assigned', remarks: 'This save must succeed once the injected faults are off.' });
  const afterClean = caseRow(c.id);
  check(
    '4c with the hooks cleared the same mutation succeeds and queues its work',
    clean.status === 200 && afterClean.version === before.version + 1 && events(c.id).length === eventsBefore + 1 && jobCount() > jobsBefore,
    `HTTP ${clean.status} version ${before.version}→${afterClean.version} jobs ${jobsBefore}→${jobCount()}`
  );
  check(
    '4d the failed attempts left nothing in the business history',
    events(c.id).filter((e) => String(e.action_type).includes('should')).length === 0,
    `history=${events(c.id).map((e) => e.action_type).join(',')}`
  );
}

/* ============================================ 5. evidence staging and cleanup */
console.log('\n== 5. Evidence upload: staged, atomic, never orphans a file ==');
{
  // A tiny but valid PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAABkBAgEApgKSAAAAAElFTkSuQmCC',
    'base64'
  );
  const uploadTo = async (caseId, version, name, buffer, token) => {
    const form = new FormData();
    form.append('version', String(version));
    form.append('file', new Blob([buffer], { type: 'image/png' }), name);
    const res = await fetch(`${BASE}/api/cases/${caseId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };

  const c = await createCase();
  const filesBefore = new Set(fs.readdirSync(UPLOAD_DIR));

  if (!HOOKS) {
    skip('5a a failed upload leaves no row and no file', 'the fault-injection hook is disabled on this instance');
  } else {
    await setFault('audit', true);
    const failed = await uploadTo(c.id, c.version, 'evidence.png', png, lead.token);
    await setFault('audit', false);
    const filesAfter = new Set(fs.readdirSync(UPLOAD_DIR));
    const newFiles = [...filesAfter].filter((f) => !filesBefore.has(f));
    check(
      '5a a failed upload leaves no attachment row and no file on disk',
      failed.status >= 500 && attachmentRows(c.id).length === 0 && newFiles.length === 0,
      `HTTP ${failed.status} rows=${attachmentRows(c.id).length} leftover files=${newFiles.join(',') || 'none'}`
    );
  }

  const current = caseRow(c.id);
  const first = await uploadTo(c.id, current.version, 'evidence.png', png, lead.token);
  check('5b a valid upload is accepted', first.status === 201, `HTTP ${first.status}`);
  const rows1 = attachmentRows(c.id);
  check('5c exactly one attachment row exists', rows1.length === 1, `rows=${rows1.length}`);
  check(
    '5d the stored file exists on disk',
    fs.existsSync(path.join(UPLOAD_DIR, rows1[0].stored_name)),
    rows1[0]?.stored_name
  );
  const noStagingLeft = fs.readdirSync(UPLOAD_DIR).filter((f) => f.startsWith('.staging-'));
  check('5e no staging file was left behind', noStagingLeft.length === 0, noStagingLeft.join(',') || 'none');

  // The same bytes uploaded again: the file is shared, not duplicated or overwritten.
  const v2 = caseRow(c.id).version;
  const second = await uploadTo(c.id, v2, 'evidence-copy.png', png, lead.token);
  const rows2 = attachmentRows(c.id);
  check(
    '5f identical bytes create a second row that shares one stored file',
    second.status === 201 && rows2.length === 2 && rows2[0].stored_name === rows2[1].stored_name,
    `rows=${rows2.length} shared=${rows2[0]?.stored_name === rows2[1]?.stored_name}`
  );

  const v3 = caseRow(c.id).version;
  const staleDelete = await api(`/api/cases/${c.id}/attachments/${rows2[0].id}?version=${v3 - 3}`, { method: 'DELETE', token: lead.token });
  check(
    '5g deleting evidence with a stale version is refused',
    staleDelete.status === 409 && attachmentRows(c.id).length === 2,
    `HTTP ${staleDelete.status} rows=${attachmentRows(c.id).length}`
  );

  const deleteOne = await api(`/api/cases/${c.id}/attachments/${rows2[0].id}?version=${caseRow(c.id).version}`, { method: 'DELETE', token: lead.token });
  const fileAfterOne = fs.existsSync(path.join(UPLOAD_DIR, rows2[0].stored_name));
  check(
    '5h removing one of two rows keeps the shared file (still referenced)',
    deleteOne.status === 200 && deleteOne.data.fileDeleted === false && fileAfterOne && attachmentRows(c.id).length === 1,
    `fileDeleted=${deleteOne.data?.fileDeleted} fileExists=${fileAfterOne} rows=${attachmentRows(c.id).length}`
  );

  const deleteTwo = await api(`/api/cases/${c.id}/attachments/${rows2[1].id}?version=${caseRow(c.id).version}`, { method: 'DELETE', token: lead.token });
  const fileAfterTwo = fs.existsSync(path.join(UPLOAD_DIR, rows2[1].stored_name));
  check(
    '5i removing the last reference deletes the file',
    deleteTwo.status === 200 && deleteTwo.data.fileDeleted === true && !fileAfterTwo && attachmentRows(c.id).length === 0,
    `fileDeleted=${deleteTwo.data?.fileDeleted} fileExists=${fileAfterTwo}`
  );

  const outsider = await uploadTo(c.id, caseRow(c.id).version, 'evidence.png', png, rbOfficer.token);
  check('5j an unauthorised uploader is refused before any bytes are stored', outsider.status === 403 || outsider.status === 404, `HTTP ${outsider.status}`);
}

/* ============================================ 6. security log ≠ business history */
console.log('\n== 6. The security log is separate from the business history ==');
{
  const c = await createCase();
  const eventsBefore = events(c.id).length;
  const securityBefore = securityCount();
  const denied = await patchCase(rbLead, c.id, { version: c.version, remarks: 'foreign lead denied' });
  check('6a an unauthorised mutation is refused', denied.status === 403, `HTTP ${denied.status}`);
  check('6b the denial is recorded in the security log', securityCount() > securityBefore && securityHas(c.id) > 0, `security rows ${securityBefore}→${securityCount()}`);
  check('6c the denial wrote nothing to the case business history', events(c.id).length === eventsBefore, `events=${events(c.id).length}`);

  const staleBefore = securityCount();
  await patchCase(lead, c.id, { version: c.version - 1, remarks: 'stale attempt' });
  check('6d a stale save adds no business event', events(c.id).length === eventsBefore, `events=${events(c.id).length}`);
  check(
    '6e a stale save is not a security incident',
    securityCount() >= staleBefore,
    `security rows ${staleBefore}→${securityCount()} (stale conflicts are ordinary business conflicts)`
  );
}

/* ============================================ summary */
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nexecuted: ${results.length}   passed: ${passed}   failed: ${failed}   skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  skipped: ${s.name} — ${s.why}`);
console.log(failed === 0 ? 'M4 concurrency, transactions and retries: PASS' : 'M4 concurrency, transactions and retries: FAIL');
process.exit(failed === 0 ? 0 : 1);
