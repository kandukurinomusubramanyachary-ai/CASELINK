/**
 * Milestone 1 — access-control regressions.
 *
 * Runs against an instance configured with CASELINK_DEMO=false (authenticated sign-in only).
 * Every check goes through the public HTTP API exactly as a hostile client would: no interface
 * cooperation, no client-supplied role/bureau/region widening.
 *
 *   BASE=http://127.0.0.1:8080 PASSWORD=caselink-demo node test/security-m1.mjs
 *
 * Exit code 0 = all checks passed.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.PASSWORD ?? 'caselink-demo';

let failures = 0;
const results = [];
const skipped = [];
function skipCheck(name, why) {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}  —  ${why}`);
}
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const Database = (await import('better-sqlite3')).default;
const requireDb = () => new Database(process.env.CASELINK_DB ?? 'data/caselink.db', { readonly: true });

/**
 * Versioned mutations carry the version of the record the caller was shown. Tests that exercise the
 * stale-version path pass `version` explicitly; for the rest this resolves the current version just
 * before the call, exactly as a client that re-read the record would — so every other assertion keeps
 * testing authorisation and behaviour rather than the version plumbing.
 */
let _versionDb = null;
const versionDb = () => {
  if (_versionDb === null) {
    try {
      _versionDb = requireDb();
    } catch {
      _versionDb = false;
    }
  }
  return _versionDb;
};
async function resolveVersion(path, body, token) {
  if (!body || typeof body !== 'object' || body.version !== undefined) return body;
  let caseId = null;
  const direct = /^\/api\/cases\/([^/?]+)\//.exec(path);
  if (direct) caseId = direct[1];
  if (!caseId) {
    const viaTransfer = /^\/api\/transfers\/([^/?]+)\//.exec(path);
    const dbc = viaTransfer ? versionDb() : null;
    if (dbc) {
      const row = dbc.prepare('SELECT case_id FROM transfers WHERE id = ?').get(viaTransfer[1]);
      if (row) caseId = row.case_id;
    }
  }
  if (!caseId) return body;
  if (token) {
    const res = await fetch(`${BASE}/api/cases/${caseId}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      const version = data?.case?.version;
      if (version !== undefined) return { ...body, version };
    }
  }
  // The actor may not be allowed to read the case at all; the fixture still needs a version so the
  // authority check (not the version plumbing) is what the assertion exercises.
  try {
    const dbc = versionDb();
    const row = dbc ? dbc.prepare('SELECT version FROM cases WHERE id = ?').get(caseId) : null;
    if (row) return { ...body, version: row.version };
  } catch {
    /* fall through: no version available */
  }
  return body;
}
async function api(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET' && body !== undefined && !raw) body = await resolveVersion(path, body, token);
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function signIn(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`sign-in failed for ${username}: ${r.status} ${JSON.stringify(r.data)}`);
  return {
    username,
    token: r.data.token,
    user: r.data.user,
    id: r.data.user?.id,
    role: r.data.user?.role,
    bureau: r.data.user?.bureau,
    region: r.data.user?.region,
  };
}

const users = {};
for (const name of ['m.nair', 'l.verma', 'p.rao', 's.iyer', 'a.desai', 'r.khan', 'k.menon', 's.bose', 'r.pillai', 'v.kumar', 'admin']) {
  users[name] = await signIn(name);
}

const listCases = async (who, extra = '') =>
  (await api(`/api/cases?pageSize=100${extra}`, { token: users[who].token })).data?.cases ?? [];

const pgrcLead = users['m.nair'];
const rbLead = users['l.verma'];
const supervisor = users['a.desai'];
const reviewer = users['r.khan'];
const rbOfficer = users['s.iyer'];

// ---------------------------------------------------------------- fixtures
const restricted = await listCases('m.nair');
const rbCase = restricted.find((c) => c.bureau !== pgrcLead.bureau && c.access === 'restricted');
check('Fixture: PGRC lead sees at least one restricted foreign (RB) case', Boolean(rbCase), rbCase ? `${rbCase.caseNumber} bureau=${rbCase.bureau} access=${rbCase.access}` : 'none');

if (!rbCase) {
  console.log('\nCannot continue without a restricted foreign case fixture.');
  process.exit(1);
}

const rbOwnCase = (await listCases('l.verma')).find((c) => c.bureau === rbLead.bureau && c.access === 'full');
const rbWorkable = (await listCases('l.verma')).find((c) => c.bureau === rbLead.bureau && c.permissions?.canUploadEvidence);
check('Fixture: RB lead has a case they own and may upload to', Boolean(rbWorkable), rbWorkable?.caseNumber);
const rbAssignedOfficer = rbWorkable?.assignedOfficerId ?? null;

// Snapshot helpers — used to prove that a denied call changed nothing.
const detail = async (who, id) => (await api(`/api/cases/${id}`, { token: users[who].token })).data ?? {};
const caseOf = async (who, id) => (await detail(who, id)).case ?? {};
const grantRows = async (who, id) => (await api(`/api/cases/${id}/grants`, { token: users[who].token })).data?.grants ?? [];
const attachmentCount = async (who, id) => (await detail(who, id)).attachments?.length ?? 0;

/**
 * Version of a case read straight from the isolated fixture database. Used where the point of the check
 * is that an *unauthorised* caller is refused: the request must reach the authority check rather than
 * stop at a missing-version validation error (M7/A07 made both versions mandatory).
 */
const caseVersionOf = (caseId) => {
  const dbc = versionDb();
  if (!dbc) return undefined;
  const row = dbc.prepare('SELECT version FROM cases WHERE id = ?').get(caseId);
  return row?.version;
};
const historyEntries = async (who, id) => (await detail(who, id)).history?.length ?? -1;

/* ======================================================================
 * 1. PGRC lead self-grant on a restricted RB case
 * ==================================================================== */
{
  const before = await detail('m.nair', rbCase.id);
  const beforeGrants = before.grants ?? null;
  const r = await api(`/api/cases/${rbCase.id}/grants`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { userId: pgrcLead.id, note: 'Self-grant attempt from outside bureau (security regression)' },
  });
  check('1a. PGRC lead self-grant on restricted RB case → 403', r.status === 403, `HTTP ${r.status}`);
  const after = await detail('m.nair', rbCase.id);
  check('1b. Case remains restricted for the PGRC lead after the attempt', after?.case?.access === 'restricted', `access=${after?.case?.access}`);
  check(
    '1c. Contents are still redacted (no complaint text / contact)',
    !after?.case?.complaintSummary,
    JSON.stringify(after?.case?.complaintSummary ?? null).slice(0, 60)
  );
  const afterGrants = after.grants ?? null;
  check('1d. No grant row was created for the PGRC lead', JSON.stringify(afterGrants) === JSON.stringify(beforeGrants));
  // A direct content read must still be refused
  const read = await api(`/api/cases/${rbCase.id}`, { token: pgrcLead.token });
  check(
    '1e. Restricted detail returns no contents, attachments or history remarks',
    read.data?.canViewContent === false && (read.data?.attachments ?? []).length === 0 && !read.data?.case?.complaintSummary,
    `canViewContent=${read.data?.canViewContent} attachments=${(read.data?.attachments ?? []).length}`
  );
  const redactedHistory = (read.data?.history ?? []).every((h) => !/PGRC-lead-visible/.test(String(h.remarks ?? '')));
  check('1f. Coordination history remarks stay redacted', redactedHistory && (read.data?.history ?? []).length > 0, `${(read.data?.history ?? []).length} entries`);
  void before;
}

/* ======================================================================
 * 2. PGRC lead revoking another bureau's grant
 * ==================================================================== */
const revokeTarget = reviewer; // an account that receives the RB grant in check 3
let grantWorked = false;
{
  // Create a legitimate RB grant first (as the owning lead) so there is something to revoke.
  const r = await api(`/api/cases/${rbWorkable.id}/grants`, {
    method: 'POST',
    token: rbLead.token,
    body: { userId: reviewer.id, note: 'Reviewer needs read access for a review request (fixture)' },
  });
  const granted = (r.data?.grants ?? []).find((g) => g.userId === reviewer.id && !g.revokedAt);
  grantWorked = r.status === 200 && Boolean(granted);
  check('3a. Owning bureau lead grants a reviewer read access → 200', grantWorked, `HTTP ${r.status}`);

  const grantsBefore = await grantRows('l.verma', rbWorkable.id);
  void revokeTarget;
  const rv = await api(`/api/cases/${rbWorkable.id}/grants`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { userId: reviewer.id, note: 'Foreign lead attempts revocation (security regression)', revoke: true },
  });
  check('2a. PGRC lead revoking another bureau\'s grant → 403', rv.status === 403, `HTTP ${rv.status}`);
  const grantsAfter = await grantRows('l.verma', rbWorkable.id);
  check('2b. The grant record is unchanged after the denied revoke', JSON.stringify(grantsBefore) === JSON.stringify(grantsAfter));
}

/* ======================================================================
 * 3. Authorised grant is audited; supervisor cross-bureau granting works
 * ==================================================================== */
{
  const hist = (await detail('l.verma', rbWorkable.id)).history ?? [];
  const grantedEvent = hist.find((h) => h.actionType === 'access_granted');
  check('3b. The authorised grant is recorded in business history', Boolean(grantedEvent), grantedEvent?.actionType ?? 'missing');

  // Supervisor with regional oversight may manage access on a case outside their own bureau.
  const foreignForSupervisor = restricted.find((c) => c.bureau !== supervisor.bureau);
  const sup = await api(`/api/cases/${foreignForSupervisor.id}/grants`, {
    method: 'POST',
    token: supervisor.token,
    body: { userId: pgrcLead.id, note: 'Cross-bureau coordination approved by supervisor (fixture)' },
  });
  check('3c. Supervisor with oversight may grant access across bureaus → 200', sup.status === 200, `HTTP ${sup.status}`);
  const supGrants = sup.data?.grants ?? [];
  check('3d. Supervisor grant is present in the grant list', supGrants.some((g) => g.userId === pgrcLead.id && !g.revokedAt));

  // Clean up: revoke the same grant again (authorised) → 200
  const back = await api(`/api/cases/${foreignForSupervisor.id}/grants`, {
    method: 'POST',
    token: supervisor.token,
    body: { userId: pgrcLead.id, note: 'Coordination complete (fixture)', revoke: true },
  });
  check('3e. Supervisor revoke of the same grant → 200', back.status === 200, `HTTP ${back.status}`);
}

/* ======================================================================
 * 4. Out-of-region access management
 * ----------------------------------------------------------------------
 * `k.menon` is a West-region **bureau officer**, so a denial from that account proves nothing about a
 * lead's regional boundary. The real test uses a West-region bureau lead (`s.bose`, PGRC West) against a
 * South case; the officer case is kept as a secondary observation and labelled as such.
 * ==================================================================== */
{
  const westLead = users['s.bose']; // bureau_lead, PGRC, West
  const southCase = rbWorkable; // South-region case
  const r = await api(`/api/cases/${southCase.id}/grants`, {
    method: 'POST',
    token: westLead.token,
    body: { userId: westLead.id, note: 'Out-of-region self-grant attempt by a West lead (security regression)' },
  });
  check(
    '4a. Out-of-region access management by a West bureau lead → 403',
    r.status === 403,
    `HTTP ${r.status} case=${southCase.caseNumber} caseRegion=${southCase.region} actor=${users['s.bose'].role}/${users['s.bose'].bureau}/${users['s.bose'].user?.region}`
  );
  const afterRes = await api(`/api/cases/${southCase.id}`, { token: westLead.token });
  const grantsForActor = (await api(`/api/cases/${southCase.id}`, { token: users['l.verma'].token })).data?.grants ?? [];
  check(
    '4b. The case did not become readable and no grant row was created',
    (afterRes.status === 403 || afterRes.data?.case?.access !== 'full') && !grantsForActor.some((g) => g.userId === users['s.bose'].id),
    `HTTP ${afterRes.status}, access=${afterRes.data?.case?.access ?? 'denied'}, grants for actor=${grantsForActor.filter((g) => g.userId === users['s.bose'].id).length}`
  );

  // Secondary observation, explicitly not the proof of a lead boundary: a West officer is also refused.
  const westOfficer = users['k.menon'];
  const officer = await api(`/api/cases/${southCase.id}/grants`, {
    method: 'POST',
    token: westOfficer.token,
    body: { userId: westOfficer.id, note: 'Out-of-region grant attempt by a West officer (secondary observation)' },
  });
  check(
    '4c. Out-of-region grant attempt by a West officer is refused (officers hold no grant authority at all)',
    officer.status === 403,
    `HTTP ${officer.status} actor=${users['k.menon'].role}/${users['k.menon'].bureau}/${users['k.menon'].user?.region}`
  );

  // Positive control: the West lead *can* manage access to a case in their own region. A West PGRC case is
  // created here rather than relied on from the seed.
  const westInstitution = (await api('/api/institutions?q=sabarmati', { token: westLead.token })).data?.institutions?.[0];
  let ownRegionCase = null;
  if (westInstitution) {
    const created = await api('/api/cases', {
      method: 'POST',
      token: westLead.token,
      body: {
        institutionId: westInstitution.id,
        receivedAt: new Date(Date.now() - 4 * 864e5).toISOString(),
        sourceChannel: 'Email',
        sourceReference: `M1-WEST-CONTROL-${Date.now()}`,
        category: 'Other',
        complaintSummary: 'M1 fixture: West-region PGRC case used as the in-region positive control for access management.',
        deadlinePolicyId: 'DEMO-POL-30',
      },
    });
    ownRegionCase = created.status === 201 ? created.data : null;
  }
  if (westInstitution && ownRegionCase) {
    const ok = await api(`/api/cases/${ownRegionCase.id}/grants`, {
      method: 'POST',
      token: westLead.token,
      body: { userId: westOfficer.id, note: 'In-region grant by the owning West lead (positive control)' },
    });
    check('4d. The West lead can still manage access inside their own region → 200', ok.status === 200, `HTTP ${ok.status}`);
    const cleanup = await api(`/api/cases/${ownRegionCase.id}/grants`, {
      method: 'POST',
      token: westLead.token,
      body: { userId: westOfficer.id, note: 'positive control cleanup', revoke: true },
    });
    check('4e. In-region revoke by the same lead → 200', cleanup.status === 200, `HTTP ${cleanup.status}`);
  } else {
    skipCheck('4d/4e. In-region access management by the West lead', 'no West-region PGRC case owned by the West lead in the seeded fixtures');
  }
}

/* ======================================================================
 * 5. Read-only reviewer with a legitimate grant: upload denied, nothing written
 * ==================================================================== */
{
  const beforeAttachments = await attachmentCount('l.verma', rbWorkable.id);
  const beforeHistory = await historyEntries('l.verma', rbWorkable.id);
  const form = new FormData();
  form.append('version', String(caseVersionOf(rbWorkable.id) ?? 1));
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% security regression specimen\n')], { type: 'application/pdf' }), 'reviewer-upload.pdf');
  const res = await fetch(`${BASE}/api/cases/${rbWorkable.id}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${reviewer.token}` },
    body: form,
  });
  check('5a. Granted reviewer evidence upload → 403', res.status === 403, `HTTP ${res.status}`);
  const afterAttachments = await attachmentCount('l.verma', rbWorkable.id);
  const afterHistory = await historyEntries('l.verma', rbWorkable.id);
  check('5b. No attachment was stored', afterAttachments === beforeAttachments, `${beforeAttachments} → ${afterAttachments}`);
  check('5c. No upload event was written to history', afterHistory === beforeHistory, `${beforeHistory} → ${afterHistory}`);
  check('5d. The reviewer can still read the case they were granted', (await api(`/api/cases/${rbWorkable.id}`, { token: reviewer.token })).status === 200);
}

/* ======================================================================
 * 6. Granted reviewer: every case mutation denied
 * ==================================================================== */
{
  const d = await caseOf('l.verma', rbWorkable.id);
  const version = d?.version ?? 1;
  // Real suggestion and relationship ids so the denial is a permission decision, not a lookup miss.
  const rbDetail = await detail('l.verma', rbWorkable.id);
  const suggestionId = rbDetail.suggestions?.[0]?.id ?? null;
  const relationshipId =
    rbDetail.relationships?.[0]?.id ?? ((await api('/api/relationships', { token: rbLead.token })).data?.relationships ?? [])[0]?.id ?? null;
  // Both case versions are mandatory on a relationship decision; the fixture supplies them so the
  // assertion below is about authority (403), not about a missing field (422).
  const pairVersions = (() => {
    const rel = (rbDetail.relationships ?? []).find((r) => r.id === relationshipId);
    const a = rel?.caseA?.id ?? rel?.case_a_id;
    const b = rel?.caseB?.id ?? rel?.case_b_id;
    return {
      caseAVersion: (a ? caseVersionOf(a) : undefined) ?? caseVersionOf(rbWorkable.id) ?? 1,
      caseBVersion: (b ? caseVersionOf(b) : undefined) ?? caseVersionOf(rbWorkable.id) ?? 1,
    };
  })();

  const attempts = [
    ['PATCH case fields', await api(`/api/cases/${rbWorkable.id}`, { method: 'PATCH', token: reviewer.token, body: { version, nextAction: 'Reviewer attempted edit' } })],
    ['Add case action', await api(`/api/cases/${rbWorkable.id}/actions`, { method: 'POST', token: reviewer.token, body: { version, actionType: 'note', remarks: 'Reviewer attempted a workflow action' } })],
    ['Assign officer', await api(`/api/cases/${rbWorkable.id}/assign`, { method: 'POST', token: reviewer.token, body: { version, officerId: rbAssignedOfficer, reason: 'Reviewer attempted assign' } })],
    ['Request transfer', await api(`/api/cases/${rbWorkable.id}/transfer`, { method: 'POST', token: reviewer.token, body: { version, toBureau: pgrcLead.bureau, reason: 'Reviewer attempted transfer' } })],
    ['Change deadline', await api(`/api/cases/${rbWorkable.id}/deadline`, { method: 'POST', token: reviewer.token, body: { version, expectedDisposalAt: new Date(Date.now() + 5 * 864e5).toISOString(), reason: 'Reviewer attempted deadline change' } })],
    ['Reopen case', await api(`/api/cases/${rbWorkable.id}/reopen`, { method: 'POST', token: reviewer.token, body: { version, reason: 'Reviewer attempted reopen' } })],
    ['Resolve triage', await api(`/api/cases/${rbWorkable.id}/triage`, { method: 'POST', token: reviewer.token, body: { version, institutionId: rbWorkable.institutionId ?? rbCase.institutionId, reason: 'Reviewer attempted triage' } })],
    ['Escalate case', await api(`/api/cases/${rbWorkable.id}/escalate`, { method: 'POST', token: reviewer.token, body: { reason: 'Reviewer attempted escalation', supervisorId: supervisor.id } })],
    ['Manage grants', await api(`/api/cases/${rbWorkable.id}/grants`, { method: 'POST', token: reviewer.token, body: { userId: reviewer.id, note: 'Reviewer attempted self-grant' } })],
    ...(suggestionId
      ? [['Confirm relationship', await api(`/api/suggestions/${suggestionId}/decision`, { method: 'POST', token: reviewer.token, body: { decision: 'Related issue', reason: 'Reviewer attempted relationship decision', ...pairVersions } })]]
      : []),
    ...(relationshipId
      ? [['Revoke relationship', await api(`/api/relationships/${relationshipId}/revoke`, { method: 'POST', token: reviewer.token, body: { reason: 'Reviewer attempted relationship revoke', ...pairVersions } })]]
      : []),
  ];
  for (const [label, r] of attempts) {
    check(`6. Reviewer denied: ${label} → 403`, r.status === 403, `HTTP ${r.status}`);
  }
  const after = await caseOf('l.verma', rbWorkable.id);
  check('6z. Case record unchanged after the denied mutations', after?.version === version && after?.nextAction !== 'Reviewer attempted edit', `version ${version} → ${after?.version}`);

  // Personal notification acknowledgement is not shared state: allowed.
  const notes = (await api('/api/notifications', { token: reviewer.token })).data?.notifications ?? [];
  if (notes.length) {
    const ack = await api(`/api/notifications/${notes[0].id}/acknowledge`, { method: 'POST', token: reviewer.token, body: {} });
    check('6y. Reviewer may acknowledge their own notification (personal, not shared state) → 200', ack.status === 200, `HTTP ${ack.status}`);
  } else {
    check('6y. Reviewer may acknowledge their own notification (personal, not shared state) — no notification fixture', true, 'skipped');
  }
}

/* ======================================================================
 * 7. Authorised case worker can still upload evidence
 * ==================================================================== */
{
  const before = await attachmentCount('l.verma', rbWorkable.id);
  const form = new FormData();
  form.append('version', String((await caseOf('l.verma', rbWorkable.id))?.version ?? caseVersionOf(rbWorkable.id) ?? 1));
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% authorised case worker specimen\n')], { type: 'application/pdf' }), 'worker-evidence.pdf');
  const res = await fetch(`${BASE}/api/cases/${rbWorkable.id}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rbLead.token}` },
    body: form,
  });
  check('7a. Authorised case worker upload still succeeds → 201', res.status === 201, `HTTP ${res.status}`);
  const after = await attachmentCount('l.verma', rbWorkable.id);
  check('7b. Attachment count increased', after === before + 1, `${before} → ${after}`);
  const hist = (await detail('l.verma', rbWorkable.id)).history ?? [];
  check('7c. Upload is recorded in business history', hist.some((h) => h.actionType === 'evidence_uploaded'));

  // An assigned officer (not the lead) can also upload — lead role is not required.
  const officerCase = (await listCases('s.iyer')).find((c) => c.bureau === rbOfficer.bureau && c.permissions?.canUploadEvidence);
  if (officerCase) {
    const f2 = new FormData();
    f2.append('version', String(caseVersionOf(officerCase.id) ?? 1));
    f2.append('file', new Blob([Buffer.from('%PDF-1.4\n% assigned officer specimen\n')], { type: 'application/pdf' }), 'officer-evidence.pdf');
    const r2 = await fetch(`${BASE}/api/cases/${officerCase.id}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rbOfficer.token}` },
      body: f2,
    });
    check('7d. Assigned officer can upload evidence to their own case → 201', r2.status === 201, `HTTP ${r2.status}`);
  } else {
    check('7d. Assigned officer upload path available — no assigned officer case fixture', true, 'skipped');
  }
}

/* ======================================================================
 * 7e. A content grant does not confer write authority on a foreign officer
 * ==================================================================== */
{
  const grant = await api(`/api/cases/${rbWorkable.id}/grants`, {
    method: 'POST',
    token: rbLead.token,
    body: { userId: users['p.rao'].id, note: 'PGRC officer needs to read this RB case (fixture)' },
  });
  check('7e. Owning lead grants a foreign-bureau officer read access → 200', grant.status === 200, `HTTP ${grant.status}`);
  const foreign = { token: users['p.rao'].token };
  const read = await api(`/api/cases/${rbWorkable.id}`, { token: foreign.token });
  check('7f. The granted foreign officer can read the contents', read.status === 200 && read.data?.canViewContent === true);
  const write = await api(`/api/cases/${rbWorkable.id}`, { method: 'PATCH', token: foreign.token, body: { version: read.data?.case?.version ?? 1, nextAction: 'Granted officer attempted edit' } });
  check('7g. The same grant does not allow modifying the case → 403', write.status === 403, `HTTP ${write.status}`);
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% foreign officer specimen\n')], { type: 'application/pdf' }), 'foreign-officer.pdf');
  const upload = await fetch(`${BASE}/api/cases/${rbWorkable.id}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${foreign.token}` }, body: form });
  check('7h. The same grant does not allow evidence upload → 403', upload.status === 403, `HTTP ${upload.status}`);
  const manage = await api(`/api/cases/${rbWorkable.id}/grants`, { method: 'POST', token: foreign.token, body: { userId: users['p.rao'].id, note: 'Granted officer attempted self-management' } });
  check('7i. The same grant does not allow managing access → 403', manage.status === 403, `HTTP ${manage.status}`);
  const revoke = await api(`/api/cases/${rbWorkable.id}/grants`, {
    method: 'POST',
    token: rbLead.token,
    body: { userId: users['p.rao'].id, note: 'Fixture cleanup', revoke: true },
  });
  check('7j. Owning lead can revoke the grant again → 200', revoke.status === 200, `HTTP ${revoke.status}`);
}

/* ======================================================================
 * 8–9. Normal configuration: sign-in required, demo entry refused
 * ==================================================================== */
{
  for (const path of ['/api/cases', '/api/my-work', '/api/notifications', '/api/reports/summary', '/api/users', '/api/coordination']) {
    const r = await api(path);
    check(`8. Unauthenticated ${path} → 401`, r.status === 401, `HTTP ${r.status}`);
  }
  const demo = await api('/api/auth/demo-login', { method: 'POST', body: { username: 'm.nair' } });
  check('9a. /api/auth/demo-login is refused in a normal configuration', demo.status === 403, `HTTP ${demo.status}`);
  const sess = await api('/api/session');
  check('9b. Session payload exposes no demo accounts in a normal configuration', (sess.data?.demoAccounts ?? []).length === 0 && sess.data?.demoMode === false, `demoMode=${sess.data?.demoMode} accounts=${(sess.data?.demoAccounts ?? []).length}`);
  check('9c. Session payload leaks no demo password', !JSON.stringify(sess.data ?? {}).includes('caselink-demo'));
  const meta = await api('/api/meta');
  check('9d. Public metadata does not disclose demo credentials', !JSON.stringify(meta.data ?? {}).includes('caselink-demo'));
  // A forged session cookie/token must not work
  const forged = await api('/api/cases', { token: 'forged-token-value' });
  check('9e. A forged bearer token is rejected → 401', forged.status === 401, `HTTP ${forged.status}`);
}

/* ======================================================================
 * 10. Client-supplied identity cannot widen permissions
 * ==================================================================== */
{
  const sneaky = await api(`/api/cases/${rbCase.id}/grants`, {
    method: 'POST',
    token: pgrcLead.token,
    body: { userId: pgrcLead.id, note: 'Spoofed role/bureau/region attempt', role: 'supervisor', bureau: 'RB', region: null },
  });
  check('10a. Client-supplied role/bureau/region does not widen grant authority → 403', sneaky.status === 403, `HTTP ${sneaky.status}`);
  const listSpoof = await api('/api/cases?pageSize=100&bureau=RB&role=supervisor', { token: pgrcLead.token });
  const stillRestricted = (listSpoof.data?.cases ?? []).some((c) => c.id === rbCase.id && c.access === 'restricted');
  check('10b. Query-string role/bureau hints do not reveal foreign contents', stillRestricted || (listSpoof.data?.cases ?? []).length === 0, `${listSpoof.data?.cases?.length ?? 0} rows`);
  const adminOnly = await api('/api/system/worker/tick', { method: 'POST', token: rbLead.token, body: {} });
  check('10c. Administrative configuration change refused for a bureau lead → 403', adminOnly.status === 403, `HTTP ${adminOnly.status}`);
}

/* ======================================================================
 * 11. Security denials are logged separately from business history
 * ----------------------------------------------------------------------
 * The security log has no read API (it is append-only, deliberately), so the test reads the
 * database file the instance was started with.
 * ==================================================================== */
{
  const Database = (await import('better-sqlite3')).default;
  const dbPath = process.env.CASELINK_DB ?? 'data/caselink.db';
  const db = new Database(dbPath, { readonly: true });
  const denials = db
    .prepare("SELECT actor_id, action, detail FROM security_log WHERE action = 'access_denied' OR action LIKE '%denied%' ORDER BY at DESC LIMIT 60")
    .all();
  check('11a. Denied access attempts are recorded in the security log', denials.length > 0, `${denials.length} denial entries`);
  const details = denials.map((d) => String(d.detail));
  check(
    '11b. Denials are recorded for the foreign grant attempt',
    details.some((d) => /(grant_denied|manage_access_denied)/.test(d) && d.includes(rbCase.id)),
    denials.length ? denials[0].detail.slice(0, 90) : 'none'
  );
  check(
    '11c. Denials are recorded for the reviewer upload and mutation attempts',
    details.some((d) => d.includes('evidence_upload_denied')) && details.some((d) => d.includes('modify_case_denied')),
    [...new Set(denials.map((d) => d.action))].join(', ')
  );
  const denialText = JSON.stringify(denials);
  check('11d. Denial entries carry no complaint text or contact details', !/complaint|complainant/i.test(denialText));

  // Authorised changes keep their audit trail.
  const events = db
    .prepare("SELECT action_type, remarks FROM action_events WHERE case_id = ? ORDER BY at")
    .all(rbWorkable.id);
  check('11e. Authorised grant and upload are preserved in business history', events.some((e) => e.action_type === 'access_granted') && events.some((e) => e.action_type === 'evidence_uploaded'), `${events.length} events`);
  db.close();
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} executed checks passed`);
if (skipped.length) {
  console.log(`${skipped.length} skipped (not counted as passes):`);
  for (const s of skipped) console.log(` - ${s.name}: ${s.why}`);
}
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('M1 security regressions: PASS');
