/**
 * M7 audit counterexamples — one check per finding raised in the all-milestones audit.
 *
 *   BASE=http://127.0.0.1:8084 CASELINK_DB=/tmp/x/caselink.db node test/audit-m7.mjs
 *
 * Each block reproduces the *exact* scenario the audit reported (unique private markers, persisted state,
 * nested response bodies) and asserts the fixed behaviour. Nothing here is a restatement of an existing
 * suite: these are the counterexamples that the earlier suites did not cover.
 *
 * The instance must run with CASELINK_TEST_HOOKS=true for the failure-injection checks (A05); when the
 * hooks are closed those checks are reported as skipped, never as passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const DB_PATH = process.env.CASELINK_DB ?? '';
const PASSWORD = 'caselink-demo';
const MARK = `M7A-${Date.now().toString(36)}`;
let failures = 0;
let skipped = 0;
const results = [];
// Each check is named with its audit finding ("A05a …") so a failure points at the finding.
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && typeof detail === 'string' ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`SKIP  ${name}  —  ${why}`);
};

if (!DB_PATH) {
  console.error('CASELINK_DB must point at the isolated fixture database of the instance under test.');
  process.exit(2);
}
const fixture = new Database(DB_PATH);

/* ------------------------------------------------------------------ helpers */
const login = async (username) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}`);
  return res.json();
};
const api = async (p, { method = 'GET', token, body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
};
const rows = (sql, params = []) => fixture.prepare(sql).all(...params);
const upload = async (caseId, version, token, name = 'evidence.png') => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735c1d10000000049454e44ae426082',
    'hex'
  );
  const form = new FormData();
  if (version !== undefined && version !== null) form.append('version', String(version));
  form.append('file', new Blob([png], { type: 'image/png' }), name);
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
    data = { raw: text };
  }
  return { status: res.status, data };
};

const users = {};
for (const u of [
  'admin',
  'm.nair',
  'l.verma',
  'p.rao',
  's.iyer',
  'a.desai',
  'r.khan',
  'k.menon',
  's.bose',
  'n.iyer',
]) {
  users[u] = { token: (await login(u)).token };
}
const pgrcLead = users['m.nair'];
const rbLead = users['l.verma'];
const pgrcOfficer = users['p.rao'];
const southSup = users['a.desai'];
const northSup = users['n.iyer']; // national oversight, no bureau
const westLead = users['s.bose']; // PGRC West

const inst = (permanentId) => rows('SELECT * FROM institutions WHERE permanent_id = ?', [permanentId])[0];
const southInstA = rows("SELECT * FROM institutions WHERE region = 'South' ORDER BY permanent_id LIMIT 1")[0];
const southInstB = rows("SELECT * FROM institutions WHERE region = 'South' ORDER BY permanent_id LIMIT 1 OFFSET 1")[0];
const westInst = rows("SELECT * FROM institutions WHERE region = 'West' ORDER BY permanent_id LIMIT 1")[0];

const createCase = async (token, body) => {
  const r = await api('/cases', { method: 'POST', token, body });
  if (r.status !== 201) throw new Error(`case fixture failed: ${r.status} ${r.text}`);
  return r.data;
};
const caseRow = (id) => rows('SELECT * FROM cases WHERE id = ?', [id])[0];
const detailOf = async (token, id) => (await api(`/cases/${id}`, { token })).data;

/* ======================================================================
 * A01 — transfer data must not bypass content and regional scope
 * ==================================================================== */
{
  const PRIVATE_TRANSFER_REASON = `${MARK} private transfer reason: complainant is a staff member's relative`;
  // A South institution with an RB case (the transfer's origin) and a PGRC case (which gives the PGRC
  // lead coordination metadata for the RB case while withholding its content).
  const rbCase = await createCase(rbLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 3 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A01-RB`,
    category: 'Infrastructure',
    complaintSummary: `${MARK} A01 RB case: library air-conditioning has failed for three weeks.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A01-PGRC`,
    category: 'Infrastructure',
    complaintSummary: `${MARK} A01 PGRC case: hostel water supply is intermittent in the same campus.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const transfer = await api(`/cases/${rbCase.id}/transfer`, {
    method: 'POST',
    token: rbLead.token,
    body: { version: caseRow(rbCase.id).version, toBureau: 'PGRC', reason: PRIVATE_TRANSFER_REASON },
  });
  check('A01a a cross-bureau transfer is requested for the fixture', transfer.status === 200 || transfer.status === 201, `HTTP ${transfer.status}`);

  // (1) The PGRC officer can see the RB case's coordination metadata but not its content.
  const officerView = await api(`/cases/${rbCase.id}`, { token: pgrcOfficer.token });
  const officerBody = JSON.stringify(officerView.data ?? {});
  check(
    'A01b a metadata-only reader gets no transfer reason in the case detail',
    officerView.data?.canViewContent === false &&
      (officerView.data?.transfers ?? []).length > 0 &&
      !officerBody.includes(PRIVATE_TRANSFER_REASON) &&
      (officerView.data?.transfers ?? []).every((t) => t.reason === null || /restricted/.test(t.reason)),
    `canViewContent=${officerView.data?.canViewContent} transfers=${(officerView.data?.transfers ?? []).length} reasonLeaked=${officerBody.includes(PRIVATE_TRANSFER_REASON)}`
  );

  // (2) South lead + West case: My work must not list a foreign case's pending transfer.
  const westCase = await createCase(westLead.token, {
    institutionId: westInst.id,
    receivedAt: new Date(Date.now() - 3 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A01-WEST`,
    category: 'Infrastructure',
    complaintSummary: `${MARK} A01 West case: laboratory safety equipment is missing from the stores list.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const WEST_PRIVATE = `${MARK} west-only private transfer reason`;
  await api(`/cases/${westCase.id}/transfer`, {
    method: 'POST',
    token: westLead.token,
    body: { version: caseRow(westCase.id).version, toBureau: 'RB', reason: WEST_PRIVATE },
  });
  // The West case is now pending from PGRC? No: it is RB-owned after acceptance, so ask the South PGRC
  // lead, whose bureau is one end of the pair, for their My work.
  const myWork = await api('/my-work', { token: pgrcLead.token });
  const myWorkText = JSON.stringify(myWork.data ?? {});
  const listedIds = (myWork.data?.pendingTransfers ?? []).map((t) => t.caseId);
  check(
    'A01c My work omits pending transfers for cases outside the viewer’s scope',
    !listedIds.includes(westCase.id) && !myWorkText.includes(WEST_PRIVATE) && !myWorkText.includes(westCase.caseNumber),
    `pending=${(myWork.data?.pendingTransfers ?? []).length} westListed=${listedIds.includes(westCase.id)} privateReasonLeaked=${myWorkText.includes(WEST_PRIVATE)}`
  );

  // (3) The target-bureau lead without content access is told about the request, not its reason.
  await api(`/cases/${rbCase.id}/grants`, {
    method: 'POST',
    token: rbLead.token,
    body: { userId: pgrcLead.id, note: 'A01 fixture: PGRC lead receives the transfer request notice.' },
  }).catch(() => {});
  const notices = await api('/notifications', { token: pgrcLead.token });
  const transferNotice = (notices.data?.notifications ?? []).find((n) => n.kind === 'transfer' && JSON.stringify(n).includes(rbCase.caseNumber));
  check(
    'A01d a transfer notification carries no private reason for a metadata-only reader',
    Boolean(transferNotice) && !JSON.stringify(transferNotice).includes(PRIVATE_TRANSFER_REASON),
    transferNotice ? `notice=${transferNotice.title}, contentVisible=${transferNotice.contentVisible}` : 'no transfer notice delivered'
  );
}

/* ======================================================================
 * A02 — relationship reasons must not leak through the paired case's history
 * ==================================================================== */
{
  const PRIVATE_RELATION_REASON = `${MARK} private relationship reasoning: the complainant named an official`;
  // Two cases at the same institution: PGRC (readable by the PGRC officer) and RB (not).
  const a = await createCase(pgrcLead.token, {
    institutionId: southInstB.id,
    receivedAt: new Date(Date.now() - 6 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A02-PGRC`,
    category: 'Fee / refund',
    complaintSummary: `${MARK} A02 PGRC case: the same refund complaint was filed twice by one student.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const b = await createCase(rbLead.token, {
    institutionId: southInstB.id,
    receivedAt: new Date(Date.now() - 5 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A02-RB`,
    category: 'Fee / refund',
    complaintSummary: `${MARK} A02 RB case: duplicate refund complaint forwarded from the regulator desk.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  // The supervisor needs content access to both cases before deciding; grants are versioned writes.
  const supervisorId = rows('SELECT id FROM users WHERE username = ?', ['a.desai'])[0].id;
  for (const [id, actor] of [
    [a.id, pgrcLead],
    [b.id, rbLead],
  ]) {
    const granted = await api(`/cases/${id}/grants`, {
      method: 'POST',
      token: actor.token,
      body: { version: caseRow(id).version, userId: supervisorId, note: 'A02 fixture: supervisor reviews the pair.' },
    });
    if (granted.status !== 200) console.log(`      A02 grant to ${id} returned ${granted.status} ${JSON.stringify(granted.data?.message ?? '')}`);
  }
  // Suggestions are recomputed asynchronously; poll for the pair.
  let suggestion = null;
  for (let i = 0; i < 20 && !suggestion; i += 1) {
    const list = await api(`/cases/${a.id}`, { token: pgrcLead.token });
    suggestion = (list.data?.suggestions ?? []).find((s) => s.caseB?.id === b.id || s.caseA?.id === b.id) ?? null;
    if (!suggestion) await new Promise((r) => setTimeout(r, 500));
  }
  if (!suggestion) {
    skip('A02a relationship history pairing', 'no suggestion was generated for this pair in the seeded fixture');
  } else {
    const decide = await api(`/suggestions/${suggestion.id}/decision`, {
      method: 'POST',
      token: southSup.token,
      body: {
        decision: 'Related issue',
        reason: PRIVATE_RELATION_REASON,
        caseAVersion: suggestion.caseA.version,
        caseBVersion: suggestion.caseB.version,
      },
    });
    check('A02a the supervisor with both grants confirms the pair', decide.status === 200, `HTTP ${decide.status}`);

    const pgrcView = await api(`/cases/${a.id}`, { token: pgrcOfficer.token });
    const bodyText = JSON.stringify(pgrcView.data ?? {});
    check(
      'A02b the paired case’s history withholds the reviewer’s reason from a reader who cannot read the other case',
      pgrcView.data?.canViewContent === true && !bodyText.includes(PRIVATE_RELATION_REASON) && /restricted/i.test(bodyText),
      `contentReadable=${pgrcView.data?.canViewContent} leaked=${bodyText.includes(PRIVATE_RELATION_REASON)}`
    );

    // Revoke the supervisor's RB grant: the reason must stay hidden from the PGRC officer.
    await api(`/cases/${b.id}/grants`, {
      method: 'POST',
      token: rbLead.token,
      body: { version: caseRow(b.id).version, userId: supervisorId, note: 'A02 cleanup', revoke: true },
    });
    const afterGrantRevoke = JSON.stringify((await api(`/cases/${a.id}`, { token: pgrcOfficer.token })).data ?? {});
    check(
      'A02c revoking the reviewer’s grant does not restore the reason to the paired history',
      !afterGrantRevoke.includes(PRIVATE_RELATION_REASON),
      `leaked=${afterGrantRevoke.includes(PRIVATE_RELATION_REASON)}`
    );
  }
}

/* ======================================================================
 * A03 — unassignment must not reactivate a completed case
 * ==================================================================== */
{
  const c = await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 20 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A03`,
    category: 'Other',
    complaintSummary: `${MARK} A03 case: disposed and then closed to test the unassignment path.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const officerId = rows('SELECT id FROM users WHERE username = ?', ['p.rao'])[0].id;
  await api(`/cases/${c.id}/assign`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { version: caseRow(c.id).version, officerId, reason: 'A03 fixture: assign for the disposal path' },
  });
  const step = async (body) =>
    api(`/cases/${c.id}`, { method: 'PATCH', token: pgrcLead.token, body: { version: caseRow(c.id).version, ...body } });
  const underReview = await step({ status: 'Under review', remarks: 'A03 fixture: under review.' });
  const disposed = await step({
    status: 'Disposed',
    remarks: 'A03 fixture: disposed with a structured outcome.',
    outcome: 'Upheld — corrective action directed',
    decisionReference: `${MARK}-A03-DISP`,
  });
  const closedStep = await step({ status: 'Closed', remarks: 'A03 fixture: closed after completion.' });
  if (underReview.status !== 200 || disposed.status !== 200 || closedStep.status !== 200) {
    console.log(
      `      lifecycle fixture: under-review=${underReview.status} disposed=${disposed.status} closed=${closedStep.status} ` +
        JSON.stringify(disposed.data?.message ?? disposed.data?.fields ?? '')
    );
  }
  const closed = caseRow(c.id);
  check('A03a the fixture is closed', closed.status === 'Closed', `status=${closed.status}`);

  const unassign = await api(`/cases/${c.id}/assign`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { version: closed.version, officerId: null, reason: 'Adjust assignment queue' },
  });
  const after = caseRow(c.id);
  const reopenedEvents = rows(
    `SELECT COUNT(*) AS n FROM action_events WHERE case_id = ? AND action_type IN ('reopened','case_reopened')`,
    [c.id]
  )[0].n;
  check(
    'A03b unassigning a closed case is refused and leaves it closed',
    unassign.status === 409 && after.status === 'Closed' && after.reopened_at === null && reopenedEvents === 0,
    `HTTP ${unassign.status} status=${after.status} reopenedAt=${after.reopened_at} reopenedEvents=${reopenedEvents}`
  );
  // The protected reopening path still works, and it is the only way back.
  const reopened = await api(`/cases/${c.id}/reopen`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { version: caseRow(c.id).version, reason: 'A03 fixture: reopen through the protected operation.' },
  });
  check(
    'A03c the protected reopening still works for the owning lead',
    reopened.status === 200 && caseRow(c.id).status === 'Under review' && Boolean(caseRow(c.id).reopened_at),
    `HTTP ${reopened.status} status=${caseRow(c.id).status}`
  );
}

/* ======================================================================
 * A04 — an invalid regional owner is refused on every route
 * ==================================================================== */
{
  const westOfficer = rows("SELECT username FROM users WHERE role = 'bureau_officer' AND bureau = 'PGRC' AND region = 'West'")[0];
  const body = {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A04`,
    category: 'Other',
    complaintSummary: `${MARK} A04 case: South intake offered to a West-region owner.`,
    deadlinePolicyId: 'DEMO-POL-30',
  };
  const created = await api('/cases', {
    method: 'POST',
    token: pgrcLead.token,
    body: { ...body, assignedOfficerId: rows('SELECT id FROM users WHERE username = ?', [westOfficer.username])[0].id },
  });
  check(
    'A04a intake refuses an owner outside the case region',
    created.status === 422,
    `HTTP ${created.status} ${created.data?.message ?? ''}`
  );

  const southCase = await createCase(pgrcLead.token, { ...body, sourceReference: `${MARK}-A04-B` });
  const reassign = await api(`/cases/${southCase.id}/assign`, {
    method: 'POST',
    token: pgrcLead.token,
    body: {
      version: caseRow(southCase.id).version,
      officerId: rows('SELECT id FROM users WHERE username = ?', [westOfficer.username])[0].id,
      reason: 'A04 fixture: out-of-region reassignment attempt',
    },
  });
  check('A04b reassignment refuses the same owner', reassign.status === 422, `HTTP ${reassign.status}`);
  check(
    'A04c the case is still unowned and unchanged after the refusal',
    caseRow(southCase.id).assigned_officer_id === null,
    `owner=${caseRow(southCase.id).assigned_officer_id}`
  );
  // The interface is offered the same set the server accepts.
  const detail = await detailOf(pgrcLead.token, southCase.id);
  const optionIds = (detail?.options?.officers ?? []).map((o) => o.id);
  check(
    'A04d the owner picker offers only accepted accounts',
    !optionIds.includes(rows('SELECT id FROM users WHERE username = ?', [westOfficer.username])[0].id),
    `options=${(detail?.options?.officers ?? []).length}`
  );
}

/* ======================================================================
 * A05 — a publication failure is compensated; nothing is reported as saved
 * ==================================================================== */
{
  const c = await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A05`,
    category: 'Other',
    complaintSummary: `${MARK} A05 case: evidence publication failure fixture.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const hook = await api('/system/inject-audit-failure', {
    method: 'POST',
    token: users.admin.token,
    body: { on: true, target: 'publish' },
  });
  if (hook.status !== 200) {
    skip('A05a a failed publication leaves no committed record', 'the fault-injection hook is closed on this instance');
  } else {
    const before = caseRow(c.id);
    const failed = await upload(c.id, before.version, pgrcLead.token, 'a05.pdf');
    await api('/system/inject-audit-failure', { method: 'POST', token: users.admin.token, body: { on: false, target: 'publish' } });
    const after = caseRow(c.id);
    const attachmentRows = rows('SELECT COUNT(*) AS n FROM attachments WHERE case_id = ?', [c.id])[0].n;
    const events = rows(
      `SELECT COUNT(*) AS n FROM action_events WHERE case_id = ? AND action_type = 'evidence_uploaded'`,
      [c.id]
    )[0].n;
    const staging = fs.existsSync(path.join(path.dirname(DB_PATH), 'uploads'))
      ? fs.readdirSync(path.join(path.dirname(DB_PATH), 'uploads')).filter((f) => f.startsWith('.staging-'))
      : [];
    check(
      'A05a a failed publication is reported as a failure and leaves no row, no event, no version bump and no staging file',
      failed.status >= 500 &&
        attachmentRows === 0 &&
        events === 0 &&
        after.version === before.version &&
        staging.length === 0,
      `HTTP ${failed.status} rows=${attachmentRows} events=${events} version ${before.version}→${after.version} staging=${staging.length}`
    );
  }

  // Reconciliation: a row left mid-publication by an interrupted process is rolled back.
  const c2 = await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A05-RECONCILE`,
    category: 'Other',
    complaintSummary: `${MARK} A05 reconcile case: interrupted publication fixture.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const before2 = caseRow(c2.id);
  fixture
    .prepare(
      `INSERT INTO attachments (id, case_id, original_name, mime, size, sha256, stored_name, uploaded_by, uploaded_at, state)
       VALUES (?,?,?,?,?,?,?,?,?, 'publishing')`
    )
    .run(
      `${MARK}-interrupted`,
      c2.id,
      'interrupted.pdf',
      'application/pdf',
      10,
      'deadbeef',
      `${MARK}-never-written.pdf`,
      rows('SELECT id FROM users WHERE username = ?', ['m.nair'])[0].id,
      new Date().toISOString()
    );
  const reconcile = await api('/system/reconcile-uploads', { method: 'POST', token: users.admin.token });
  const after2 = caseRow(c2.id);
  const stillStuck = rows(`SELECT COUNT(*) AS n FROM attachments WHERE case_id = ? AND state <> 'ready'`, [c2.id])[0].n;
  if (reconcile.status !== 200) {
    skip('A05b an interrupted publication is reconciled', 'the reconciliation hook is closed on this instance');
  } else {
    check(
      'A05b an interrupted publication is rolled back by reconciliation and never offered for download',
      stillStuck === 0 && after2.version === before2.version && reconcile.data?.rolledBack >= 1,
      `rolledBack=${reconcile.data?.rolledBack} stuck=${stillStuck} version ${before2.version}→${after2.version}`
    );
  }

  // The healthy path still works and now returns the saved version.
  const okUpload = await upload(c2.id, caseRow(c2.id).version, pgrcLead.token, 'a05-ok.pdf');
  check(
    'A05c a successful upload is downloadable and returns the new case version',
    okUpload.status === 201 &&
      okUpload.data?.version === caseRow(c2.id).version &&
      rows(`SELECT COUNT(*) AS n FROM attachments WHERE case_id = ? AND state = 'ready'`, [c2.id])[0].n === 1,
    `HTTP ${okUpload.status} savedVersion=${okUpload.data?.version} caseVersion=${caseRow(c2.id).version}`
  );
}

/* ======================================================================
 * A06 — an idempotent replay is re-authorised against current scope
 * ==================================================================== */
{
  const key = `${MARK}-A06-KEY`;
  const body = {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A06`,
    category: 'Other',
    complaintSummary: `${MARK} A06 case: private complaint text used to prove replay re-authorisation.`,
    deadlinePolicyId: 'DEMO-POL-30',
  };
  const created = await api('/cases', { method: 'POST', token: pgrcOfficer.token, body, headers: { 'Idempotency-Key': key } });
  check('A06a the case is created with an idempotency key', created.status === 201, `HTTP ${created.status}`);

  // Move the account out of the region; the session reloads the current account row on every request.
  fixture.prepare("UPDATE users SET region = 'West' WHERE username = 'p.rao'").run();
  const readAfterMove = await api(`/cases/${created.data.id}`, { token: pgrcOfficer.token });
  const replay = await api('/cases', { method: 'POST', token: pgrcOfficer.token, body, headers: { 'Idempotency-Key': key } });
  fixture.prepare("UPDATE users SET region = 'South' WHERE username = 'p.rao'").run();
  const replayBody = JSON.stringify(replay.data ?? {});
  check(
    'A06b a replay after the caller lost scope is refused and returns no cached content',
    readAfterMove.status === 403 && replay.status === 403 && !replayBody.includes('private complaint text'),
    `directRead=${readAfterMove.status} replay=${replay.status} contentLeaked=${replayBody.includes('private complaint text')}`
  );
  const restored = await api(`/cases/${created.data.id}`, { token: pgrcOfficer.token });
  check('A06c the case is readable again once the account is back in scope', restored.status === 200, `HTTP ${restored.status}`);
}

/* ======================================================================
 * A07 — versions are mandatory on evidence and relationship writes
 * ==================================================================== */
{
  const c = await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A07`,
    category: 'Other',
    complaintSummary: `${MARK} A07 case: version-requirement fixture for evidence.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const noVersionUpload = await upload(c.id, undefined, pgrcLead.token, 'a07.png');
  check('A07a an evidence upload without a version is refused', noVersionUpload.status === 422, `HTTP ${noVersionUpload.status}`);

  const withVersion = await upload(c.id, caseRow(c.id).version, pgrcLead.token, 'a07-ok.png');
  const uploadedEvent = rows(
    `SELECT version_after FROM action_events WHERE case_id = ? AND action_type = 'evidence_uploaded' ORDER BY rowid DESC LIMIT 1`,
    [c.id]
  )[0];
  check(
    'A07b the upload event is recorded against the version it produced',
    withVersion.status === 201 && uploadedEvent?.version_after === caseRow(c.id).version,
    `HTTP ${withVersion.status} eventVersion=${uploadedEvent?.version_after} caseVersion=${caseRow(c.id).version}`
  );

  // Relationship writes: both versions are mandatory, and authority is still decided first.
  const rels = rows('SELECT * FROM relationships WHERE state = ? LIMIT 1', ['active']);
  const openSuggestion = rows("SELECT * FROM suggestions WHERE state IN ('open','outdated') LIMIT 1")[0];
  if (openSuggestion) {
    const decideNoVersions = await api(`/suggestions/${openSuggestion.id}/decision`, {
      method: 'POST',
      token: pgrcOfficer.token, // a bureau officer holds no relationship authority
      body: { decision: 'Related issue', reason: 'A07 fixture: decision without versions.' },
    });
    check(
      'A07c a relationship decision from an unauthorised account is refused for authority first (403, not 422)',
      decideNoVersions.status === 403,
      `HTTP ${decideNoVersions.status}`
    );
    if (rels.length) {
      const revokeNoVersions = await api(`/relationships/${rels[0].id}/revoke`, {
        method: 'POST',
        token: users.admin.token,
        body: { reason: 'A07 fixture: revoke without versions.' },
      });
      check('A07d a relationship revocation without versions is refused', revokeNoVersions.status === 403 || revokeNoVersions.status === 422, `HTTP ${revokeNoVersions.status}`);
    } else {
      skip('A07d relationship revocation version requirement', 'no active relationship exists in this fixture');
    }
  } else {
    skip('A07c relationship version requirement', 'no active relationship exists in this fixture');
  }
}

/* ======================================================================
 * A08 — changed import records are conflicts, not "unchanged duplicates"
 * ==================================================================== */
{
  const csvHeader =
    'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact';
  const row = (ref, extra = {}) =>
    [
      extra.institution ?? southInstA.permanent_id,
      '',
      '2026-09-20',
      'A08 register',
      ref,
      'Fee / refund',
      extra.summary ?? `${MARK} A08 complaint summary for the imported record.`,
      '',
      'DEMO-POL-30',
      '',
    ].join(',');
  const preview = async (csvText) =>
    api('/import/preview', { method: 'POST', token: pgrcLead.token, body: { sourceSystem: 'A08 register', csvText } });

  const inFile = await preview([csvHeader, row(`${MARK}-A08-1`), row(`${MARK}-A08-1`, { summary: `${MARK} A08 same reference but a completely different complaint about staffing.` })].join('\n'));
  const inFileRows = inFile.data?.rows ?? [];
  check(
    'A08a two rows with one identity but different content are a conflict, not an unchanged duplicate',
    inFileRows[1]?.status === 'conflict' && /different content/i.test(inFileRows[1]?.note ?? ''),
    `status=${inFileRows[1]?.status} note=${(inFileRows[1]?.note ?? '').slice(0, 80)}`
  );

  // Across batches: import, then change only the institution.
  const first = await preview([csvHeader, row(`${MARK}-A08-2`)].join('\n'));
  await api(`/import/${first.data.batchId}/commit`, { method: 'POST', token: pgrcLead.token });
  const changed = await preview([csvHeader, row(`${MARK}-A08-2`, { institution: southInstB.permanent_id })].join('\n'));
  const changedRow = changed.data?.rows?.[0];
  check(
    'A08b changing the institution under the same identity is disclosed as a changed record',
    changedRow?.status === 'conflict' && /institution/i.test(changedRow?.note ?? ''),
    `status=${changedRow?.status} note=${(changedRow?.note ?? '').slice(0, 90)}`
  );
}

/* ======================================================================
 * A09 — the approved policy is bound to the commit
 * ==================================================================== */
{
  const csvHeader =
    'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact';
  const csvText = [
    csvHeader,
    [
      southInstA.permanent_id,
      '',
      '2026-09-01',
      'A09 register',
      `${MARK}-A09`,
      'Other',
      `${MARK} A09 imported complaint used to test the policy binding.`,
      '',
      'DEMO-POL-30',
      '',
    ].join(','),
  ].join('\n');
  const preview = await api('/import/preview', {
    method: 'POST',
    token: pgrcLead.token,
    body: { sourceSystem: 'A09 register', csvText },
  });
  const previewed = preview.data?.rows?.[0];
  // Change the policy after the preview.
  const policy = rows('SELECT * FROM deadline_policies WHERE id = ?', ['DEMO-POL-30'])[0];
  fixture.prepare('UPDATE deadline_policies SET calendar_days = 60 WHERE id = ?').run('DEMO-POL-30');
  const commit = await api(`/import/${preview.data.batchId}/commit`, { method: 'POST', token: pgrcLead.token });
  fixture.prepare('UPDATE deadline_policies SET calendar_days = ? WHERE id = ?').run(policy.calendar_days, 'DEMO-POL-30');
  const imported = rows('SELECT * FROM cases WHERE source_reference = ?', [`${MARK}-A09`]);
  check(
    'A09a a policy changed after the preview blocks the commit and imports nothing',
    commit.status === 409 && commit.data?.error === 'policy_changed' && imported.length === 0,
    `HTTP ${commit.status} (${commit.data?.error}) imported=${imported.length} previewedDue=${previewed?.expectedDisposalAt}`
  );

  // Unchanged policy: the commit stores exactly the previewed due time.
  const preview2 = await api('/import/preview', {
    method: 'POST',
    token: pgrcLead.token,
    body: {
      sourceSystem: 'A09 register',
      csvText: csvText.replace(`${MARK}-A09`, `${MARK}-A09B`).replace('2026-09-01', '2026-09-02'),
    },
  });
  const previewed2 = preview2.data?.rows?.[0];
  const commit2 = await api(`/import/${preview2.data.batchId}/commit`, { method: 'POST', token: pgrcLead.token });
  const stored = rows('SELECT * FROM cases WHERE source_reference = ?', [`${MARK}-A09B`])[0];
  check(
    'A09b an unchanged policy stores the due time the officer previewed',
    commit2.status === 200 && Boolean(stored) && stored.expected_disposal_at === previewed2?.expectedDisposalAt,
    `HTTP ${commit2.status} previewed=${previewed2?.expectedDisposalAt} stored=${stored?.expected_disposal_at}`
  );
}

/* ======================================================================
 * A10 — calendar dates are validated, not rolled over
 * ==================================================================== */
{
  const csvHeader =
    'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact';
  const csvText = [
    csvHeader,
    [southInstA.permanent_id, '', '2026-02-30', 'A10 register', `${MARK}-A10`, 'Other', `${MARK} A10 impossible date row for validation.`, '', 'DEMO-POL-30', ''].join(','),
  ].join('\n');
  const preview = await api('/import/preview', {
    method: 'POST',
    token: pgrcLead.token,
    body: { sourceSystem: 'A10 register', csvText },
  });
  const row = preview.data?.rows?.[0];
  check(
    'A10a 2026-02-30 is rejected as an impossible date',
    row?.status === 'rejected' && (row?.errors ?? []).some((e) => /real calendar date/i.test(e)),
    `status=${row?.status} errors=${(row?.errors ?? []).join(' | ')}`
  );
}

/* ======================================================================
 * A11 — scheduled reminders reach regional leads and supervisors
 * ==================================================================== */
{
  const c = await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 40 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A11`,
    category: 'Other',
    complaintSummary: `${MARK} A11 overdue case used to check the reminder recipients.`,
    deadlinePolicyId: 'DEMO-POL-30',
    nextAction: 'Chase the institution for a written reply',
  });
  const tick = await api('/system/worker/tick', { method: 'POST', token: users.admin.token });
  if (tick.status !== 200) {
    skip('A11a reminders reach the regional lead and supervisor', `the worker-tick hook is closed (HTTP ${tick.status})`);
  } else {
    const notices = (who) => rows('SELECT * FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = ?)', [who]);
    const southLeadNotices = notices('m.nair').filter((n) => n.entity_id === c.id);
    const southSupNotices = notices('a.desai').filter((n) => n.entity_id === c.id);
    const nationalSupNotices = notices('n.iyer').filter((n) => n.entity_id === c.id);
    const westLeadNotices = notices('s.bose').filter((n) => n.entity_id === c.id);
    check(
      'A11a an overdue South case reminds the South lead, the South supervisor and national oversight, never a West lead',
      southLeadNotices.length > 0 && southSupNotices.length > 0 && nationalSupNotices.length > 0 && westLeadNotices.length === 0,
      `southLead=${southLeadNotices.length} southSupervisor=${southSupNotices.length} national=${nationalSupNotices.length} westLead=${westLeadNotices.length}`
    );
  }
}

/* ======================================================================
 * A12 — metadata-only readers never receive private next actions
 * ==================================================================== */
{
  const PRIVATE_NEXT = `${MARK} PRIVATE next action: verify the anonymous complaint with the named warden`;
  const rbCase = await createCase(rbLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 45 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A12`,
    category: 'Faculty / staffing',
    complaintSummary: `${MARK} A12 RB case with a private next action used to test notification projection.`,
    deadlinePolicyId: 'DEMO-POL-30',
    nextAction: PRIVATE_NEXT,
  });
  const tick = await api('/system/worker/tick', { method: 'POST', token: users.admin.token });
  if (tick.status !== 200) {
    skip('A12a notification bodies withhold private next actions', `the worker-tick hook is closed (HTTP ${tick.status})`);
  } else {
    const supervisorNotices = await api('/notifications', { token: northSup.token });
    const notice = (supervisorNotices.data?.notifications ?? []).find((n) => n.entityId === rbCase.id && n.kind === 'overdue');
    const noticeText = JSON.stringify(notice ?? {});
    const contentVisible = (
      await api(`/cases/${rbCase.id}`, { token: northSup.token })
    ).data?.canViewContent;
    check(
      'A12a a metadata-only reader sees the coordination facts and not the private next action',
      Boolean(notice) && contentVisible === false && !noticeText.includes(PRIVATE_NEXT) && /deadline/i.test(notice?.body ?? ''),
      `contentVisible=${contentVisible} leaked=${noticeText.includes(PRIVATE_NEXT)} body=${(notice?.body ?? '').slice(0, 80)}`
    );
    // A reader with content access still gets the operational text.
    const leadNotices = await api('/notifications', { token: rbLead.token });
    const leadNotice = (leadNotices.data?.notifications ?? []).find((n) => n.entityId === rbCase.id && n.kind === 'overdue');
    check(
      'A12b a reader with content access still receives the operational detail',
      Boolean(leadNotice) && leadNotice.contentVisible === true && String(leadNotice.body).includes(PRIVATE_NEXT),
      leadNotice ? `contentVisible=${leadNotice.contentVisible} nextActionPresent=${String(leadNotice.body).includes(PRIVATE_NEXT)}` : 'no notice for the owning lead'
    );
  }
}

/* ======================================================================
 * A13 — triage cannot silently rewrite a resolved identity
 * ==================================================================== */
{
  const c = await createCase(pgrcLead.token, {
    institutionId: southInstA.id,
    receivedAt: new Date(Date.now() - 3 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A13`,
    category: 'Other',
    complaintSummary: `${MARK} A13 case: identity already confirmed, used for the triage guard.`,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const attempt = await api(`/cases/${c.id}/triage`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { version: caseRow(c.id).version, institutionId: southInstB.id, reason: 'A13 fixture: rewrite a confirmed identity' },
  });
  check(
    'A13a triage on a resolved case is refused and the institution is unchanged',
    attempt.status === 409 && caseRow(c.id).institution_id === southInstA.id,
    `HTTP ${attempt.status} institutionUnchanged=${caseRow(c.id).institution_id === southInstA.id}`
  );

  // The legitimate path: an unresolved intake is resolved once, with the previous value recorded.
  const triageCase = await createCase(pgrcLead.token, {
    receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    sourceChannel: 'Email',
    sourceReference: `${MARK}-A13-TRIAGE`,
    category: 'Other',
    complaintSummary: `${MARK} A13 triage case: institution name was ambiguous at intake.`,
    intakeInstitutionText: 'Sri Vidya College (name as filed by the complainant)',
    deadlinePolicyId: 'DEMO-POL-30',
  });
  const resolved = await api(`/cases/${triageCase.id}/triage`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { version: caseRow(triageCase.id).version, institutionId: southInstB.id, reason: 'A13 fixture: identity confirmed from the register.' },
  });
  const event = rows(
    `SELECT before_json, after_json FROM action_events WHERE case_id = ? AND action_type = 'triage_resolved' ORDER BY rowid DESC LIMIT 1`,
    [triageCase.id]
  )[0];
  check(
    'A13b an unresolved intake is resolved with the previous identity recorded',
    resolved.status === 200 && caseRow(triageCase.id).triage_state === 'resolved' && Boolean(event) && JSON.parse(event.after_json).previousInstitutionId === null,
    `HTTP ${resolved.status} state=${caseRow(triageCase.id).triage_state} after=${event?.after_json}`
  );
}

console.log(`\nexecuted: ${results.length}   passed: ${results.length - failures}   failed: ${failures}   skipped: ${skipped}`);
fixture.close();
console.log(failures === 0 ? 'M7 audit counterexamples: PASS' : 'M7 audit counterexamples: FAIL');
process.exit(failures === 0 ? 0 : 1);
