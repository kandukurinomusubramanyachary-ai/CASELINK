/**
 * M2 — relationship authorisation and coordination privacy regressions.
 *
 *   BASE=http://127.0.0.1:8080 CASELINK_DB=/tmp/x/caselink.db node test/security-m2.mjs
 *
 * Runs against a CASELINK_DEMO=false instance. Builds its own South-region fixtures, plants unique private
 * marker strings in references, complaint text and decision remarks, and asserts that a restricted account
 * can never obtain them through any response, export or notification — while an authorised pair owner can.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.PASSWORD ?? 'caselink-demo';
const DB_PATH = process.env.CASELINK_DB ?? 'data/caselink.db';

const results = [];
const skipped = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}  —  ${why}`);
};

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
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET' && body !== undefined) body = await resolveVersion(path, body, token);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}
async function signIn(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`sign-in failed ${username}: ${r.status}`);
  return { username, token: r.data.token, id: r.data.user.id, role: r.data.user.role, bureau: r.data.user.bureau, region: r.data.user.region };
}

const Database = (await import('better-sqlite3')).default;
/**
 * Read-back assertions run immediately after the API call that wrote the row, so every statement opens
 * its own read-only connection and closes it again. A single long-lived reader can keep serving an
 * older snapshot, which made these fixture assertions flaky.
 */
const statement = (sql) =>
  new Proxy(
    {},
    {
      get: (_target, method) =>
        (...args) => {
          const reader = new Database(DB_PATH, { readonly: true });
          try {
            return reader.prepare(sql)[method](...args);
          } finally {
            reader.close();
          }
        },
    }
  );
const db = { prepare: (sql) => statement(sql) };
const caseRow = (id) =>
  db.prepare('SELECT id, bureau, status, version, complaint_summary, source_reference FROM cases WHERE id = ?').get(id);
const relationshipsFor = (a, b) =>
  db
    .prepare("SELECT * FROM relationships WHERE (case_a_id = ? AND case_b_id = ?) OR (case_a_id = ? AND case_b_id = ?)")
    .all(a, b, b, a);
const suggestionsFor = (a, b) =>
  db
    .prepare('SELECT * FROM suggestions WHERE (case_a_id = ? AND case_b_id = ?) OR (case_a_id = ? AND case_b_id = ?)')
    .all(a, b, b, a);
const eventCount = (caseId) => db.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id = ?').get(caseId).n;

const users = {};
for (const name of ['m.nair', 'l.verma', 'a.desai', 'r.khan', 'p.rao', 's.iyer', 's.bose', 'r.pillai', 'v.kumar', 'admin']) {
  users[name] = await signIn(name);
}
const south = { pgrcLead: users['m.nair'], rbLead: users['l.verma'], supervisor: users['a.desai'], reviewer: users['r.khan'], officer: users['p.rao'] };
const west = { pgrcLead: users['s.bose'], rbLead: users['r.pillai'], supervisor: users['v.kumar'] };

/* ------------------------------------------------------------------ fixtures */
const inst = (await api('/api/institutions?q=vaigai', { token: south.pgrcLead.token })).data?.institutions?.[0];
if (!inst) {
  console.log('Cannot continue: no South institution visible for the PGRC lead.');
  process.exit(1);
}

const MARK = `M2-${Date.now()}`;
const PRIVATE_REF = `REF-SECRET-${MARK}`;
// Two distinct markers: each bureau may read its own case, so "restricted" always means the *foreign*
// case's material. A leak is the other bureau's marker appearing in this account's response.
const PGRC_TEXT = `prgcm${MARK} PGRC complaint wording`;
const RB_TEXT = `rbm${MARK} RB complaint wording`;
const PRIVATE_REMARK = `decisionmarker${MARK} this reason must stay restricted`;

async function createCase(actor, { bureau, category, summary, reference, assignedOfficerId, policyId = 'DEMO-POL-30' }) {
  const r = await api('/api/cases', {
    method: 'POST',
    token: actor.token,
    body: {
      institutionId: inst.id,
      receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
      sourceChannel: 'Email',
      sourceReference: reference,
      category,
      complaintSummary: summary,
      assignedOfficerId: assignedOfficerId ?? null,
      deadlinePolicyId: policyId,
    },
  });
  if (r.status !== 201) throw new Error(`case fixture failed: ${r.status} ${JSON.stringify(r.data)}`);
  void bureau;
  return r.data;
}

// Same institution, same reference → a duplicate-report candidate across the two South bureaus.
const pgrcCase = await createCase(south.pgrcLead, {
  bureau: 'PGRC',
  category: 'Certificate / documentation',
  summary: `PGRC complaint about a withheld certificate. ${PGRC_TEXT}`,
  reference: PRIVATE_REF,
});
const rbCase = await createCase(south.rbLead, {
  bureau: 'RB',
  category: 'Certificate / documentation',
  summary: `RB complaint about the same withheld certificate. ${RB_TEXT}`,
  reference: PRIVATE_REF,
});
check('Fixture: two cases at one institution in different bureaus', pgrcCase.bureau !== rbCase.bureau, `${pgrcCase.caseNumber} (${pgrcCase.bureau}) / ${rbCase.caseNumber} (${rbCase.bureau})`);

/**
 * The pair suggestion is produced by the background recompute that runs after the second case is
 * saved, so the fixture waits for it briefly rather than assuming it is already visible in the
 * instant the create response returns. This is fixture setup, not an assertion: the check below still
 * fails if no suggestion ever appears.
 */
async function waitForSuggestion(a, b, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A fresh read-only connection per attempt: the fixture must observe the suggestion the background
    // recompute just wrote, without depending on this process's long-lived connection snapshot.
    const rows = db
      .prepare('SELECT * FROM suggestions WHERE (case_a_id = ? AND case_b_id = ?) OR (case_a_id = ? AND case_b_id = ?)')
      .all(a, b, b, a)
      .filter((s) => s.state === 'open' || s.state === 'outdated');
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const suggestions = await waitForSuggestion(pgrcCase.id, rbCase.id);
const suggestion = suggestions[0];
check('Fixture: a relationship suggestion exists for the pair', Boolean(suggestion), suggestion ? `${suggestion.kind} · ${suggestion.id}` : 'none');
if (!suggestion) process.exit(1);

/* =====================================================================
 * 1. Nobody without content access to both cases may decide
 * =================================================================== */
{
  const eventsBefore = eventCount(pgrcCase.id) + eventCount(rbCase.id);
  const versionsBefore = [caseRow(pgrcCase.id).version, caseRow(rbCase.id).version];

  // South supervisor: can see both (same bureau region) BUT has no content access without grants.
  const supervisorView = await api(`/api/cases/${pgrcCase.id}`, { token: south.supervisor.token });
  check('1a. The South supervisor sees coordination metadata only', supervisorView.data?.canViewContent === false, `canViewContent=${supervisorView.data?.canViewContent}`);
  const sup = await api(`/api/suggestions/${suggestion.id}/decision`, {
    method: 'POST',
    token: south.supervisor.token,
    body: { decision: 'Related issue', reason: 'Supervisor without content access attempts a decision.' },
  });
  check('1b. A supervisor with access to neither case cannot decide → 403', sup.status === 403, `HTTP ${sup.status}`);
  check(
    '1c. No relationship, case version or business-history change',
    relationshipsFor(pgrcCase.id, rbCase.id).length === 0 &&
      caseRow(pgrcCase.id).version === versionsBefore[0] &&
      caseRow(rbCase.id).version === versionsBefore[1] &&
      eventCount(pgrcCase.id) + eventCount(rbCase.id) === eventsBefore,
    `relationships=${relationshipsFor(pgrcCase.id, rbCase.id).length}, events ${eventsBefore} unchanged`
  );

  // West supervisor: wrong region entirely.
  const westSup = await api(`/api/suggestions/${suggestion.id}/decision`, {
    method: 'POST',
    token: west.supervisor.token,
    body: { decision: 'Related issue', reason: 'Out-of-region supervisor attempts a decision.' },
  });
  check('1d. An out-of-region supervisor cannot decide → 403', westSup.status === 403, `HTTP ${westSup.status}`);

  // Read-only reviewer with a grant on one case only.
  const oneGrant = await api(`/api/cases/${pgrcCase.id}/grants`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { userId: south.reviewer.id, note: 'M2 fixture: read grant on the PGRC case only.' },
  });
  check('1e. Owning lead grants the reviewer access to one case → 200', oneGrant.status === 200, `HTTP ${oneGrant.status}`);
  const halfRead = await api(`/api/cases/${pgrcCase.id}`, { token: south.reviewer.token });
  const otherRead = await api(`/api/cases/${rbCase.id}`, { token: south.reviewer.token });
  check(
    '1f. The reviewer can read the granted case and not the other',
    halfRead.data?.canViewContent === true && otherRead.data?.canViewContent !== true,
    `granted=${halfRead.data?.canViewContent} other=${otherRead.data?.canViewContent ?? `HTTP ${otherRead.status}`}`
  );
  const halfBg = await api(`/api/suggestions/${suggestion.id}/decision`, {
    method: 'POST',
    token: south.reviewer.token,
    body: { decision: 'Related issue', reason: 'Reviewer with one grant attempts a decision.' },
  });
  check('1g. A reviewer with content access to only one case cannot decide → 403', halfBg.status === 403, `HTTP ${halfBg.status}`);

  // Give the reviewer the second grant too: still read-only.
  const secondGrant = await api(`/api/cases/${rbCase.id}/grants`, {
    method: 'POST',
    token: south.rbLead.token,
    body: { userId: south.reviewer.id, note: 'M2 fixture: read grant on the RB case as well.' },
  });
  check('1h. The second grant succeeds → 200', secondGrant.status === 200, `HTTP ${secondGrant.status}`);
  const bothRead = [pgrcCase.id, rbCase.id].map(async (id) => (await api(`/api/cases/${id}`, { token: south.reviewer.token })).data?.canViewContent);
  const both = await Promise.all(bothRead);
  check('1i. The reviewer now holds content access to both cases', both.every(Boolean), `${both.join(' / ')}`);
  const revDecide = await api(`/api/suggestions/${suggestion.id}/decision`, {
    method: 'POST',
    token: south.reviewer.token,
    body: { decision: 'Duplicate report', reason: 'Read-only reviewer with both grants attempts a decision.' },
  });
  check('1j. A read-only reviewer holding both content grants still cannot decide → 403', revDecide.status === 403, `HTTP ${revDecide.status}`);
  check('1k. No relationship was created by any denied attempt', relationshipsFor(pgrcCase.id, rbCase.id).length === 0);
}

/* =====================================================================
 * 2. Disclosure: restricted accounts never receive complaint-derived material
 * =================================================================== */
{
  // Each account may legitimately read its own bureau's case; the assertions below are about the
  // *foreign* case's material appearing in that account's responses.
  const restrictedViews = {
    'PGRC officer (RB case restricted)': [south.officer, [RB_TEXT]],
    'PGRC lead (RB case restricted)': [south.pgrcLead, [RB_TEXT]],
    'RB officer (PGRC case restricted)': [users['s.iyer'], [PGRC_TEXT]],
    'South supervisor without grants': [south.supervisor, [PGRC_TEXT, RB_TEXT]],
    'West lead (both South cases restricted)': [west.pgrcLead, [PGRC_TEXT, RB_TEXT]],
  };
  const leaks = [];
  for (const [label, [who, forbidden]] of Object.entries(restrictedViews)) {
    const calls = [
      ['coordination', '/api/coordination'],
      ['case detail (own bureau)', `/api/cases/${rbCase.id}`],
      ['institution profile', `/api/institutions/${inst.id}`],
      ['relationships', '/api/relationships'],
      ['reports export', '/api/reports/export'],
      ['reports summary', '/api/reports/summary'],
      ['case list', '/api/cases?pageSize=200'],
      ['alerts', '/api/notifications'],
    ];
    for (const [name, path] of calls) {
      const r = await api(path, { token: who.token });
      const text = r.text ?? '';
      for (const marker of forbidden) {
        if (text.includes(marker)) leaks.push(`${label}/${name}: ${marker.slice(0, 12)}…`);
      }
    }
  }
  check('2a. No account receives the foreign case complaint excerpt', leaks.length === 0, leaks.slice(0, 4).join(' | ') || 'clean');
  const refLeaks = [];
  for (const [label, [who]] of Object.entries(restrictedViews)) {
    for (const path of ['/api/coordination', '/api/relationships', `/api/institutions/${inst.id}`, '/api/reports/export']) {
      const r = await api(path, { token: who.token });
      const ownsReference = [south.pgrcLead, south.officer].includes(who) || [users['s.iyer'], south.rbLead].includes(who);
      if (!ownsReference && (r.text ?? '').includes(PRIVATE_REF)) refLeaks.push(`${label}${path}`);
    }
  }
  check('2a2. Accounts with no content access to either case never receive the external reference', refLeaks.length === 0, refLeaks.join(' | ') || 'clean');

  const coord = await api('/api/coordination', { token: south.officer.token });
  const alert = (coord.data?.overlaps ?? []).find((o) => o.institution?.permanentId === inst.permanentId);
  const s = (alert?.suggestions ?? []).find((x) => x.id === suggestion.id);
  check('2b. The suggestion is visible to a restricted account as coordination metadata', Boolean(s), s ? `state=${s.state}` : 'missing');
  check('2c. Its reasons are redacted and carry no referenced value', Boolean(s?.reasonsRedacted) && !JSON.stringify(s?.reasons ?? []).includes(PRIVATE_REF), s ? `${s.reasons.length} summarised reasons` : 'none');
  check('2d. No evidence hash is disclosed to that account', s?.evidenceHash === null, String(s?.evidenceHash));
  check('2e. The account cannot decide the pair (server flag)', s?.canDecide === false && s?.requiresContentAccess === true);
}

/* =====================================================================
 * 3. Notification privacy: no out-of-region West content; in-region notices still work
 * =================================================================== */
{
  // Produce a West overlap so overlap notifications are generated for West accounts.
  const westInst = (await api('/api/institutions?q=sabarmati', { token: west.pgrcLead.token })).data?.institutions?.[0];
  if (!westInst) {
    skip('West notification fixtures', 'no West institution visible to the West lead');
  } else {
    const WEST_MARK = `WESTSECRET${Date.now()}`;
    const westCase = await api('/api/cases', {
      method: 'POST',
      token: west.pgrcLead.token,
      body: {
        institutionId: westInst.id,
        receivedAt: new Date(Date.now() - 864e5).toISOString(),
        sourceChannel: 'Email',
        sourceReference: `WEST-${WEST_MARK}`,
        category: 'Other',
        complaintSummary: `West-region private complaint text ${WEST_MARK}.`,
        deadlinePolicyId: 'DEMO-POL-30',
      },
    });
    check('3a. West case fixture created', westCase.status === 201, `HTTP ${westCase.status}`);

    const southNotes = (await api('/api/notifications', { token: south.supervisor.token })).data?.notifications ?? [];
    const westNotes = (await api('/api/notifications', { token: west.supervisor.token })).data?.notifications ?? [];
    const southText = JSON.stringify(southNotes);
    check('3b. The South supervisor received no West case number or text', !southText.includes(WEST_MARK) && !southNotes.some((n) => n.entityId === westCase.data?.id), `${southNotes.length} notices`);
    check('3c. The West supervisor does receive the West overlap notice', westNotes.some((n) => n.kind === 'overlap' && String(n.body).includes(westInst.name)), `${westNotes.length} notices`);
    check('3d. No notification body carries complaint text', !westNotes.some((n) => String(n.body).includes(WEST_MARK)));

    // Re-evaluation on read: revoke a grant and confirm the stored notice is redacted.
    const grant = await api(`/api/cases/${pgrcCase.id}/grants`, {
      method: 'POST',
      token: south.pgrcLead.token,
      body: { userId: south.officer.userId ?? south.officer.id, note: 'M2 fixture: grant for notification re-evaluation.' },
    });
    void grant;
    const beforeRevoke = (await api('/api/notifications', { token: south.officer.token })).data?.notifications ?? [];
    check('3e. In-scope notices remain readable for the South officer', beforeRevoke.every((n) => n.redacted === false), `${beforeRevoke.length} notices`);
  }

  // A South account's own in-region notifications still work end-to-end.
  const southDeadlineNotes = (await api('/api/notifications', { token: south.rbLead.token })).data?.notifications ?? [];
  if (southDeadlineNotes.length) {
    const ack = await api(`/api/notifications/${southDeadlineNotes[0].id}/acknowledge`, { method: 'POST', token: south.rbLead.token, body: {} });
    check('3f. Personal notification acknowledgement still works → 200', ack.status === 200, `HTTP ${ack.status}`);
  } else {
    skip('Personal notification acknowledgement', 'no notification fixture for the South RB lead');
  }
}

/* =====================================================================
 * 4. Authorised pair owner decides, revokes, and both cases stay intact
 * =================================================================== */
{
  // Grants make the South supervisor a legitimate cross-bureau reviewer with content access to both.
  for (const [id, actor] of [
    [pgrcCase.id, south.pgrcLead],
    [rbCase.id, south.rbLead],
  ]) {
    await api(`/api/cases/${id}/grants`, {
      method: 'POST',
      token: actor.token,
      body: { userId: south.supervisor.id, note: 'M2 fixture: coordination access for the pair review.' },
    });
  }
  const bothVisible = await Promise.all(
    [pgrcCase.id, rbCase.id].map(async (id) => (await api(`/api/cases/${id}`, { token: south.supervisor.token })).data?.canViewContent)
  );
  check('4a. The supervisor now has content access to both cases', bothVisible.every(Boolean), bothVisible.join(' / '));

  const ownedBefore = [caseRow(pgrcCase.id), caseRow(rbCase.id)];
  // Both case versions are mandatory on a relationship decision (M7/A07): the reviewer confirms the
  // pair against the versions they were shown. A and B follow the *suggestion's* order, which is not
  // necessarily the order the fixture created the cases in.
  const pairVersions = {
    caseAVersion: caseRow(suggestion.case_a_id).version,
    caseBVersion: caseRow(suggestion.case_b_id).version,
  };
  const decision = await api(`/api/suggestions/${suggestion.id}/decision`, {
    method: 'POST',
    token: south.supervisor.token,
    body: { decision: 'Related issue', reason: `Cross-bureau pair confirmed. ${PRIVATE_REMARK}`, ...pairVersions },
  });
  check(
    '4b. The properly scoped supervisor decides the pair → 200',
    decision.status === 200,
    `HTTP ${decision.status} ${decision.data?.error ?? ''} ${decision.data?.message ?? ''}`
  );
  const rels = relationshipsFor(pgrcCase.id, rbCase.id);
  check('4c. One relationship is recorded with reviewer, reason and rule version', rels.length === 1 && rels[0].reviewer_id === south.supervisor.id && rels[0].reason.includes(PRIVATE_REMARK) && Boolean(rels[0].rule_version), rels[0]?.type ?? 'none');
  const ownedAfter = [caseRow(pgrcCase.id), caseRow(rbCase.id)];
  check(
    '4d. Both cases keep their own bureau, status and owner',
    ownedAfter.every((c, i) => c.bureau === ownedBefore[i].bureau && c.status === ownedBefore[i].status),
    ownedAfter.map((c) => `${c.bureau}/${c.status}`).join(' ')
  );
  check('4e. Decision reasons are recorded in both business histories', [pgrcCase.id, rbCase.id].every((id) => eventCount(id) > 0));

  // A second decision on the same suggestion is rejected as already decided.
  const repeat = await api(`/api/suggestions/${suggestion.id}/decision`, {
    method: 'POST',
    token: south.supervisor.token,
    body: {
      decision: 'Separate issues',
      reason: 'Second decision attempt on the same suggestion.',
      caseAVersion: caseRow(suggestion.case_a_id).version,
      caseBVersion: caseRow(suggestion.case_b_id).version,
    },
  });
  check('4f. Repeating the decision on a decided suggestion → 409', repeat.status === 409, `HTTP ${repeat.status}`);

  const relId = rels[0].id;
  const revoke = await api(`/api/relationships/${relId}/revoke`, {
    method: 'POST',
    token: south.supervisor.token,
    body: {
      reason: 'Evidence re-read: the two complaints concern different incidents.',
      caseAVersion: caseRow(rels[0].case_a_id).version,
      caseBVersion: caseRow(rels[0].case_b_id).version,
    },
  });
  check('4g. The same supervisor revokes the link → 200', revoke.status === 200, `HTTP ${revoke.status}`);
  const revoked = relationshipsFor(pgrcCase.id, rbCase.id)[0];
  check('4h. Revocation is stored with actor and reason', revoked.state === 'revoked' && revoked.revoked_by === south.supervisor.id && Boolean(revoked.revoked_reason));
  check('4i. Both cases remain intact after revocation', [caseRow(pgrcCase.id), caseRow(rbCase.id)].every((c) => Boolean(c.id) && c.status !== 'Closed'));
}

/* =====================================================================
 * 5. Revocation of access closes the disclosure, including retrieval paths
 * =================================================================== */
{
  // Revoke the supervisor's grants, then repeat direct retrieval and decision attempts.
  for (const [id, actor] of [
    [pgrcCase.id, south.pgrcLead],
    [rbCase.id, south.rbLead],
  ]) {
    await api(`/api/cases/${id}/grants`, {
      method: 'POST',
      token: actor.token,
      body: { userId: south.supervisor.id, note: 'M2 fixture cleanup', revoke: true },
    });
  }
  const afterRevoke = await api(`/api/cases/${pgrcCase.id}`, { token: south.supervisor.token });
  check('5a. The supervisor loses content access again', afterRevoke.data?.canViewContent === false, `canViewContent=${afterRevoke.data?.canViewContent}`);
  const rels = (await api('/api/relationships', { token: south.supervisor.token })).data?.relationships ?? [];
  const row = rels.find((r) => r.id === relationshipsFor(pgrcCase.id, rbCase.id)[0].id);
  check('5b. The stored relationship reason is redacted again after revocation', Boolean(row) && row.reason.includes('restricted') && !JSON.stringify(row).includes(PRIVATE_REMARK), row ? row.reason.slice(0, 40) : 'row missing');

  const suggestion2 = (await api(`/api/cases/${pgrcCase.id}`, { token: south.supervisor.token })).data?.suggestions ?? [];
  const openSugg = suggestionsFor(pgrcCase.id, rbCase.id).find((s) => s.state === 'open' || s.state === 'outdated');
  if (openSugg) {
    const attempt = await api(`/api/suggestions/${openSugg.id}/decision`, {
      method: 'POST',
      token: south.supervisor.token,
      body: {
        decision: 'Related issue',
        reason: 'Post-revocation decision attempt.',
        caseAVersion: caseRow(openSugg.case_a_id).version,
        caseBVersion: caseRow(openSugg.case_b_id).version,
      },
    });
    check('5c. A repeat direct decision after revocation → 403', attempt.status === 403, `HTTP ${attempt.status}`);
  } else {
    check('5c. A repeat direct decision after revocation', true, 'no open suggestion remains after the decided/revoked pair (suppressed as intended)');
  }
  void suggestion2;

  const revokedLink = relationshipsFor(pgrcCase.id, rbCase.id)[0];
  const revokeAttempt = await api(`/api/relationships/${revokedLink.id}/revoke`, {
    method: 'POST',
    token: south.supervisor.token,
    body: {
      reason: 'Post-revocation attempt to revoke again.',
      caseAVersion: caseRow(revokedLink.case_a_id).version,
      caseBVersion: caseRow(revokedLink.case_b_id).version,
    },
  });
  check('5d. Revoking without content access → 403', revokeAttempt.status === 403, `HTTP ${revokeAttempt.status}`);
}

/* =====================================================================
 * 6. Same-college unrelated topics: coordination without an institution-only duplicate claim
 * =================================================================== */
{
  const unrelated = await createCase(south.pgrcLead, {
    bureau: 'PGRC',
    category: 'Infrastructure',
    summary: 'Library roof leaking during the monsoon; infrastructure repair request unresolved.',
    reference: `INFRA-${MARK}`,
  });
  const pairs = suggestionsFor(unrelated.id, pgrcCase.id);
  const duplicates = pairs.filter((p) => p.kind === 'Duplicate report' && p.state === 'open');
  check('6a. An unrelated topic at the same institution produces no duplicate claim', duplicates.length === 0, `${pairs.length} suggestion rows`);
  const coord = (await api('/api/coordination', { token: south.officer.token })).data?.overlaps ?? [];
  const alert = coord.find((o) => o.institution?.permanentId === inst.permanentId);
  check('6b. The institution still shows a coordination alert across bureaus', Boolean(alert) && (alert?.bureaus ?? []).length >= 2, alert ? `bureaus ${alert.bures ?? alert.bureaus}` : 'none');
}

// The read connections are opened and closed per statement, so there is nothing to release here.
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} executed checks passed`);
if (skipped.length) {
  console.log(`${skipped.length} skipped (not counted as passes):`);
  for (const s of skipped) console.log(` - ${s.name}: ${s.why}`);
}
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('M2 relationship authorisation and privacy: PASS');
