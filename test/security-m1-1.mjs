/**
 * M1.1 — regional authorisation regressions (alert acknowledgement and transfer decisions).
 *
 * Runs against an instance started with CASELINK_DEMO=false and asserts BOTH the HTTP response and the
 * persisted database state. Fixtures are created through the API inside this run: two West-region
 * institutions-worth of cases (the seed's West institution AICTE-DEMO-1010), a real West overlap alert,
 * and four West transfers.
 *
 *   BASE=http://127.0.0.1:8080 CASELINK_DB=/path/to/caselink.db node test/security-m1-1.mjs
 *
 * Exit code 0 = every executed check passed. Skipped checks are reported separately and never count as
 * passes.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.PASSWORD ?? 'caselink-demo';
const DB_PATH = process.env.CASELINK_DB ?? 'data/caselink.db';

const results = [];
const skipped = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function skip(name, why) {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}  —  ${why}`);
}

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
  return { status: res.status, data };
}

async function signIn(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`sign-in failed for ${username}: ${r.status} ${JSON.stringify(r.data)}`);
  return { username, token: r.data.token, id: r.data.user.id, role: r.data.user.role, bureau: r.data.user.bureau, region: r.data.user.region };
}

const as = (who) => ({ token: who.token });

const Database = (await import('better-sqlite3')).default;
const db = new Database(DB_PATH, { readonly: true });

const alertRow = (id) =>
  db.prepare('SELECT id, state, acknowledged_by AS acknowledgedBy, acknowledged_at AS acknowledgedAt, case_ids_json AS caseIds FROM alerts WHERE id = ?').get(id);
const transferRow = (id) =>
  db
    .prepare('SELECT id, case_id AS caseId, from_bureau AS fromBureau, to_bureau AS toBureau, state, decided_by AS decidedBy, decided_at AS decidedAt, decision_note AS decisionNote FROM transfers WHERE id = ?')
    .get(id);
const caseRow = (id) =>
  db
    .prepare('SELECT id, bureau, assigned_officer_id AS assignedOfficerId, version, status, updated_at AS updatedAt FROM cases WHERE id = ?')
    .get(id);
const eventCount = (caseId, actionType) =>
  db.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id = ? AND action_type = ?').get(caseId, actionType).n;
const eventTotal = (caseId) => db.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id = ?').get(caseId).n;

/* ------------------------------------------------------------------ accounts */
const users = {};
for (const name of ['m.nair', 'l.verma', 'a.desai', 'r.khan', 's.bose', 'm.joshi', 'r.pillai', 'k.menon', 'v.kumar', 'n.iyer', 'admin']) {
  try {
    users[name] = await signIn(name);
  } catch {
    /* recorded below */
  }
}

const south = {
  pgrcLead: users['m.nair'],
  rbLead: users['l.verma'],
  supervisor: users['a.desai'],
  reviewer: users['r.khan'],
};
const west = {
  pgrcLead: users['s.bose'],
  pgrcOfficer: users['m.joshi'],
  rbLead: users['r.pillai'],
  rbOfficer: users['k.menon'],
  supervisor: users['v.kumar'],
};
const national = { supervisor: users['n.iyer'] };

for (const [label, u] of [
  ['South PGRC lead m.nair', south.pgrcLead],
  ['South RB lead l.verma', south.rbLead],
  ['South supervisor a.desai', south.supervisor],
  ['Read-only reviewer r.khan', south.reviewer],
  ['West PGRC lead s.bose', west.pgrcLead],
  ['West PGRC officer m.joshi', west.pgrcOfficer],
  ['West RB lead r.pillai', west.rbLead],
  ['West RB officer k.menon', west.rbOfficer],
  ['West supervisor v.kumar', west.supervisor],
  ['National supervisor n.iyer', national.supervisor],
]) {
  if (!u) skip(`Fixture account — ${label}`, 'account missing from this seed; rows depending on it are skipped');
}
if (!west.pgrcLead || !west.supervisor || !west.rbLead) {
  console.log('\nCannot build West-region fixtures — the seed does not provide a West lead, supervisor and RB lead.');
  console.log('Re-seed with the current seed.ts (s.bose, m.joshi, r.pillai, v.kumar, n.iyer).');
  process.exit(1);
}

/* --------------------------------------------------------------- fixtures */
const westInstitution = (await api('/api/institutions?q=sabarmati', as(west.pgrcLead))).data?.institutions?.[0];
if (!westInstitution) {
  console.log('Cannot continue: the West institution (AICTE-DEMO-1010) is not visible to the West PGRC lead.');
  process.exit(1);
}
check(
  'Fixture: West institution resolves for the West lead',
  westInstitution.region === 'West',
  `${westInstitution.permanentId} · ${westInstitution.region}`
);
{
  // The institution directory is a shared catalogue; the boundary that matters is the case-level one, so
  // assert that the South lead sees the West institution but no West cases through it.
  const profile = await api(`/api/institutions/${westInstitution.id}`, as(south.pgrcLead));
  const westCasesVisible = (profile.data?.cases ?? []).filter((c) => c.bureau && c.access === 'full');
  check(
    'Fixture: the South lead sees the shared institution entry but no West case contents',
    profile.status === 200 && westCasesVisible.length === 0,
    `HTTP ${profile.status}, ${(profile.data?.cases ?? []).length} cases listed, ${westCasesVisible.length} readable`
  );
}

const stamp = Date.now();
async function createWestCase(actor, tag) {
  const r = await api('/api/cases', {
    method: 'POST',
    ...as(actor),
    body: {
      institutionId: westInstitution.id,
      receivedAt: new Date(Date.now() - 3 * 864e5).toISOString(),
      sourceChannel: 'Email',
      sourceReference: `M11-${tag}-${stamp}`,
      category: 'Other',
      complaintSummary: `M1.1 regional-authorisation fixture ${tag}: synthetic West-region complaint used to test regional boundaries.`,
      assignedOfficerId: west.pgrcOfficer?.id ?? null,
      deadlinePolicyId: 'DEMO-POL-30',
    },
  });
  if (r.status !== 201) throw new Error(`case fixture ${tag} failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

// W1 makes the West institution an overlap (seeded RB West case + a new PGRC West case).
const westAlertCase = await createWestCase(west.pgrcLead, 'ALERT');
// Cases used only for transfer decisions.
const westCases = {};
for (const tag of ['DENY-REJECT', 'DENY-ACCEPT', 'OK-ACCEPT', 'OK-REJECT']) {
  westCases[tag] = await createWestCase(west.pgrcLead, tag);
}

const coordinationWest = (await api('/api/coordination', as(west.supervisor))).data;
const westAlert = (coordinationWest?.overlaps ?? []).find((o) => o.institution?.permanentId === westInstitution.permanentId);
check('Fixture: a West-region overlap alert exists for the West institution', Boolean(westAlert), westAlert ? `alert ${westAlert.id} · ${westAlert.cases.length} visible cases` : 'none');
if (!westAlert) {
  console.log('\nCannot continue without the West alert fixture.');
  process.exit(1);
}
const westAlertDbIds = JSON.parse(alertRow(westAlert.id).caseIds);
check(
  'Fixture: the alert lists both West cases (PGRC and RB)',
  westAlertDbIds.includes(westAlertCase.id) &&
    westAlertDbIds.some((id) => caseRow(id)?.bureau === 'RB'),
  `${westAlertDbIds.length} case ids`
);

async function requestTransfer(caseId, tag) {
  const r = await api(`/api/cases/${caseId}/transfer`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { version: caseRow(caseId).version, toBureau: 'RB', reason: `M1.1 fixture ${tag}: West PGRC case to RB.` },
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`transfer fixture ${tag} failed: ${r.status} ${JSON.stringify(r.data)}`);
  const t = db.prepare('SELECT id FROM transfers WHERE case_id = ? ORDER BY requested_at DESC LIMIT 1').get(caseId);
  return t.id;
}
const transfers = {
  denyReject: await requestTransfer(westCases['DENY-REJECT'].id, 'deny-reject'),
  denyAccept: await requestTransfer(westCases['DENY-ACCEPT'].id, 'deny-accept'),
  okAccept: await requestTransfer(westCases['OK-ACCEPT'].id, 'ok-accept'),
  okReject: await requestTransfer(westCases['OK-REJECT'].id, 'ok-reject'),
};
check('Fixture: four West→RB transfers are pending', [transfers.denyReject, transfers.denyAccept, transfers.okAccept, transfers.okReject].every((id) => transferRow(id)?.state === 'pending'));

/* =====================================================================
 * 1. South supervisor cannot act on the West alert
 * =================================================================== */
{
  const southView = await api(`/api/cases/${westAlertCase.id}`, as(south.supervisor));
  check('1a. South supervisor cannot read the West case → 403', southView.status === 403, `HTTP ${southView.status}`);
  const coordSouth = (await api('/api/coordination', as(south.supervisor))).data?.overlaps ?? [];
  check(
    '1b. The West overlap alert is absent from the South supervisor dashboard',
    !coordSouth.some((o) => o.id === westAlert.id),
    `${coordSouth.length} visible overlaps`
  );

  const before = alertRow(westAlert.id);
  const eventsBefore = eventTotal(westAlertCase.id);
  const ack = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(south.supervisor), body: {} });
  check('1c. South supervisor acknowledging the West alert → 403', ack.status === 403, `HTTP ${ack.status}`);
  const after = alertRow(westAlert.id);
  check(
    '1d. Alert state, acknowledgement fields and business history are unchanged',
    after.state === before.state && after.acknowledgedBy === before.acknowledgedBy && after.acknowledgedAt === before.acknowledgedAt &&
      eventTotal(westAlertCase.id) === eventsBefore,
    `state=${after.state} ackBy=${after.acknowledgedBy ?? 'null'} events ${eventsBefore}→${eventTotal(westAlertCase.id)}`
  );
}

/* =====================================================================
 * 2. Authorised West acknowledgement still works (supervisor, officer, national oversight)
 * =================================================================== */
{
  const ack = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(west.supervisor), body: {} });
  check('2a. West supervisor acknowledging the West alert → 200', ack.status === 200, `HTTP ${ack.status}`);
  const row = alertRow(westAlert.id);
  check(
    '2b. The alert is persisted as acknowledged by that supervisor',
    row.state === 'acknowledged' && row.acknowledgedBy === west.supervisor.id && Boolean(row.acknowledgedAt),
    `state=${row.state} ackBy=${row.acknowledgedBy}`
  );
  check(
    '2c. Authorised acknowledgement is audited',
    db.prepare("SELECT COUNT(*) AS n FROM security_log WHERE action = 'alert_acknowledged' AND detail = ?").get(westAlert.id).n > 0
  );

  if (west.rbOfficer) {
    const officerAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(west.rbOfficer), body: {} });
    check('2d. West bureau officer (in-region coordination scope) may acknowledge → 200', officerAck.status === 200, `HTTP ${officerAck.status}`);
  } else {
    skip('West bureau officer acknowledgement', 'no West bureau-officer fixture');
  }

  if (national.supervisor) {
    const nationalAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(national.supervisor), body: {} });
    check('2e. National-scope supervisor keeps national oversight → 200', nationalAck.status === 200, `HTTP ${nationalAck.status}`);
    check('2f. National-scope acknowledgement is persisted', alertRow(westAlert.id).acknowledgedBy === national.supervisor.id, alertRow(westAlert.id).acknowledgedBy);
  } else {
    skip('National-scope supervisor acknowledgement', 'no region=null supervisor fixture in this seed');
  }

  // Positive in-region control for a South alert: the South supervisor's own region still works.
  const southAlerts = (await api('/api/coordination', as(south.supervisor))).data?.overlaps ?? [];
  if (southAlerts.length) {
    const southAck = await api(`/api/alerts/${southAlerts[0].id}/acknowledge`, { method: 'POST', ...as(south.supervisor), body: {} });
    check('2g. South supervisor acknowledging a South alert still works → 200', southAck.status === 200, `HTTP ${southAck.status}`);
  } else {
    skip('In-region South acknowledgement', 'no South overlap alert in the seeded fixtures');
  }

  // Personal notification acknowledgement is not shared state and stays available.
  const notes = (await api('/api/notifications', as(south.supervisor))).data?.notifications ?? [];
  if (notes.length) {
    const ackNote = await api(`/api/notifications/${notes[0].id}/acknowledge`, { method: 'POST', ...as(south.supervisor), body: {} });
    check('2h. Personal notification acknowledgement still works → 200', ackNote.status === 200, `HTTP ${ackNote.status}`);
  } else {
    skip('Personal notification acknowledgement', 'no notification fixture for the South supervisor');
  }
}

/* =====================================================================
 * 3. Reviewer and administrator cannot change shared acknowledgement state
 * =================================================================== */
{
  const before = alertRow(westAlert.id);
  const reviewerAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(south.reviewer), body: {} });
  check('3a. Read-only reviewer acknowledging a coordination alert → 403', reviewerAck.status === 403, `HTTP ${reviewerAck.status}`);
  const after = alertRow(westAlert.id);
  check('3b. Reviewer attempt changed nothing', after.state === before.state && after.acknowledgedBy === before.acknowledgedBy);

  if (users['admin']) {
    const adminAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(users['admin']), body: {} });
    check('3c. Administrator cannot change shared acknowledgement state → 403', adminAck.status === 403, `HTTP ${adminAck.status}`);
    check('3d. Administrator attempt changed nothing', alertRow(westAlert.id).acknowledgedBy === before.acknowledgedBy);
  } else {
    skip('Administrator acknowledgement denial', 'no administrator fixture');
  }
}

/* =====================================================================
 * 4. South RB lead cannot decide West transfers (accept and reject)
 * =================================================================== */
{
  const southView = await api(`/api/cases/${westCases['DENY-ACCEPT'].id}`, as(south.rbLead));
  check('4a. South RB lead cannot read the West case → 403', southView.status === 403, `HTTP ${southView.status}`);

  for (const [label, id, decision] of [
    ['reject', transfers.denyReject, 'reject'],
    ['accept', transfers.denyAccept, 'accept'],
  ]) {
    const t = transferRow(id);
    const c = caseRow(t.caseId);
    const events = eventTotal(c.id);
    const r = await api(`/api/transfers/${id}/decision`, {
      method: 'POST',
      ...as(south.rbLead),
      body: { decision, note: `M1.1 regression: South RB lead attempts to ${decision} a West transfer.` },
    });
    check(`4b. South RB lead ${decision} on a West transfer → 403`, r.status === 403, `HTTP ${r.status}`);
    const t2 = transferRow(id);
    const c2 = caseRow(t.caseId);
    check(
      `4c. ${decision} denial left the transfer pending`,
      t2.state === 'pending' && t2.decidedBy === t.decidedBy && t2.decidedAt === t.decidedAt,
      `state=${t2.state} decidedBy=${t2.decidedBy ?? 'null'}`
    );
    check(
      `4d. ${decision} denial left ownership, assignment and version untouched`,
      c2.bureau === c.bureau && c2.assignedOfficerId === c.assignedOfficerId && c2.version === c.version,
      `bureau=${c2.bureau} version ${c.version}→${c2.version}`
    );
    check(
      `4e. ${decision} denial wrote no business history`,
      eventTotal(c.id) === events && eventCount(c.id, 'transfer_accepted') === 0 && eventCount(c.id, 'transfer_rejected') === 0,
      `${events}→${eventTotal(c.id)} events`
    );
  }

  const reviewerDecision = await api(`/api/transfers/${transfers.okAccept}/decision`, {
    method: 'POST',
    ...as(south.reviewer),
    body: { decision: 'accept', note: 'M1.1 regression: read-only reviewer attempts a transfer decision.' },
  });
  check('4f. Read-only reviewer deciding any transfer → 403', reviewerDecision.status === 403, `HTTP ${reviewerDecision.status}`);
  check('4g. Reviewer attempt left the transfer pending', transferRow(transfers.okAccept).state === 'pending');
}

/* =====================================================================
 * 5. Authorised West RB lead: acceptance and rejection both work
 * =================================================================== */
{
  const accept = await api(`/api/transfers/${transfers.okAccept}/decision`, {
    method: 'POST',
    ...as(west.rbLead),
    body: { decision: 'accept', note: 'M1.1: West RB lead accepts the West PGRC transfer.' },
  });
  check('5a. West RB lead accepting a West transfer → 200', accept.status === 200, `HTTP ${accept.status}`);
  const accepted = transferRow(transfers.okAccept);
  const acceptedCase = caseRow(accepted.caseId);
  check(
    '5b. Acceptance persisted: transfer accepted by the West lead, ownership moved to RB',
    accepted.state === 'accepted' && accepted.decidedBy === west.rbLead.id && acceptedCase.bureau === 'RB',
    `state=${accepted.state} decidedBy=${accepted.decidedBy} bureau=${acceptedCase.bureau}`
  );
  check('5c. Acceptance wrote the business history event', eventCount(accepted.caseId, 'transfer_accepted') === 1);

  const reject = await api(`/api/transfers/${transfers.okReject}/decision`, {
    method: 'POST',
    ...as(west.rbLead),
    body: { decision: 'reject', note: 'M1.1: West RB lead rejects the West PGRC transfer.' },
  });
  check('5d. West RB lead rejecting a West transfer → 200', reject.status === 200, `HTTP ${reject.status}`);
  const rejected = transferRow(transfers.okReject);
  const rejectedCase = caseRow(rejected.caseId);
  check(
    '5e. Rejection persisted: transfer rejected, ownership stays with PGRC',
    rejected.state === 'rejected' && rejected.decidedBy === west.rbLead.id && rejectedCase.bureau === 'PGRC',
    `state=${rejected.state} bureau=${rejectedCase.bureau}`
  );
  check('5f. Rejection wrote the business history event', eventCount(rejected.caseId, 'transfer_rejected') === 1);
}

/* =====================================================================
 * 6. Same-region cross-bureau decisions keep working (regression guard)
 * =================================================================== */
{
  const southInstitution = (await api('/api/institutions?q=vaigai', as(south.pgrcLead))).data?.institutions?.[0];
  if (!southInstitution) {
    skip('Same-region cross-bureau transfer', 'no South institution visible to the South PGRC lead');
  } else {
    const southCase = await api('/api/cases', {
      method: 'POST',
      ...as(south.pgrcLead),
      body: {
        institutionId: southInstitution.id,
        receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
        sourceChannel: 'Email',
        sourceReference: `M11-SOUTH-${stamp}`,
        category: 'Other',
        complaintSummary: 'M1.1 fixture: South PGRC case used to confirm same-region cross-bureau transfer decisions still work.',
        deadlinePolicyId: 'DEMO-POL-30',
      },
    });
    if (southCase.status !== 201) {
      skip('Same-region cross-bureau transfer', `fixture case create returned HTTP ${southCase.status}`);
    } else {
      const req = await api(`/api/cases/${southCase.data.id}/transfer`, {
        method: 'POST',
        ...as(south.pgrcLead),
        body: { version: southCase.data.version, toBureau: 'RB', reason: 'M1.1: same-region cross-bureau transfer (South PGRC to South RB).' },
      });
      const tid = db.prepare('SELECT id FROM transfers WHERE case_id = ? ORDER BY requested_at DESC LIMIT 1').get(southCase.data.id)?.id;
      check('6a. Same-region transfer request created', req.status === 201 || req.status === 200, `HTTP ${req.status}`);
      if (tid) {
        const d = await api(`/api/transfers/${tid}/decision`, {
          method: 'POST',
          ...as(south.rbLead),
          body: { decision: 'accept', note: 'M1.1: South RB lead accepts a South transfer.' },
        });
        check('6b. Same-region cross-bureau acceptance by the target lead still works → 200', d.status === 200, `HTTP ${d.status}`);
        check('6c. Ownership moved to RB', caseRow(southCase.data.id).bureau === 'RB', caseRow(southCase.data.id).bureau);

        const second = await api('/api/cases', {
          method: 'POST',
          ...as(south.pgrcLead),
          body: {
            institutionId: southInstitution.id,
            receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
            sourceChannel: 'Email',
            sourceReference: `M11-SOUTH-REJ-${stamp}`,
            category: 'Other',
            complaintSummary: 'M1.1 fixture: second South PGRC case used to confirm same-region rejection still works.',
            deadlinePolicyId: 'DEMO-POL-30',
          },
        });
        const req2 = await api(`/api/cases/${second.data.id}/transfer`, {
          method: 'POST',
          ...as(south.pgrcLead),
          body: { version: second.data.version, toBureau: 'RB', reason: 'M1.1: same-region transfer to be rejected.' },
        });
        const tid2 = db.prepare('SELECT id FROM transfers WHERE case_id = ? ORDER BY requested_at DESC LIMIT 1').get(second.data.id)?.id;
        if (tid2 && (req2.status === 200 || req2.status === 201)) {
          const rej = await api(`/api/transfers/${tid2}/decision`, {
            method: 'POST',
            ...as(south.rbLead),
            body: { decision: 'reject', note: 'M1.1: South RB lead rejects a South transfer.' },
          });
          check('6d. Same-region rejection by the target lead still works → 200', rej.status === 200, `HTTP ${rej.status}`);
          check('6e. Rejection kept ownership with PGRC', caseRow(second.data.id).bureau === 'PGRC', caseRow(second.data.id).bureau);
        } else {
          skip('Same-region rejection', 'second transfer fixture not created');
        }
      } else {
        skip('Same-region transfer acceptance', 'transfer row not found');
      }
    }
  }
}

/* =====================================================================
 * 7. An exceptional content-read grant does not confer regional write authority
 * =================================================================== */
{
  const grant = await api(`/api/cases/${westAlertCase.id}/grants`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { userId: south.rbLead.id, note: 'M1.1 fixture: exceptional read grant to the South RB lead for a cross-region review.' },
  });
  check('7a. West lead grants the South RB lead read access → 200', grant.status === 200, `HTTP ${grant.status}`);
  const read = await api(`/api/cases/${westAlertCase.id}`, as(south.rbLead));
  check(
    '7b. The granted South lead can now read the West case',
    read.status === 200 && read.data?.canViewContent === true,
    `HTTP ${read.status} canViewContent=${read.data?.canViewContent}`
  );

  // A pending West transfer on that same case is the sharpest test: read yes, decide no.
  const c0 = caseRow(westAlertCase.id);
  const req = await api(`/api/cases/${westAlertCase.id}/transfer`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { version: c0.version, toBureau: 'RB', reason: 'M1.1 fixture: West transfer on the grant case.' },
  });
  const grantTransferId = db.prepare('SELECT id FROM transfers WHERE case_id = ? ORDER BY requested_at DESC LIMIT 1').get(westAlertCase.id)?.id;
  if (req.status === 200 || req.status === 201) {
    const denied = await api(`/api/transfers/${grantTransferId}/decision`, {
      method: 'POST',
      ...as(south.rbLead),
      body: { decision: 'accept', note: 'M1.1 regression: granted South lead attempts a West transfer decision.' },
    });
    check('7c. The read grant does not allow deciding the West transfer → 403', denied.status === 403, `HTTP ${denied.status}`);
    check('7d. The transfer is still pending after the denied attempt', transferRow(grantTransferId).state === 'pending');
    check('7e. Ownership is unchanged after the denied attempt', caseRow(westAlertCase.id).bureau === c0.bureau, caseRow(westAlertCase.id).bureau);
  } else {
    skip('Grant + transfer decision denial', `transfer request returned HTTP ${req.status}`);
  }

  const supersAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(south.supervisor), body: {} });
  check('7f. A South supervisor without a grant is still refused the West alert → 403', supersAck.status === 403, `HTTP ${supersAck.status}`);

  // The same grant to the South supervisor: read yes, shared-state write no.
  const supGrant = await api(`/api/cases/${westAlertCase.id}/grants`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { userId: south.supervisor.id, note: 'M1.1 fixture: exceptional read grant to the South supervisor.' },
  });
  const supRead = await api(`/api/cases/${westAlertCase.id}`, as(south.supervisor));
  check(
    '7g. The granted South supervisor can read the West case',
    supGrant.status === 200 && supRead.status === 200 && supRead.data?.canViewContent === true,
    `grant HTTP ${supGrant.status}, read HTTP ${supRead.status}`
  );
  const beforeAckBy = alertRow(westAlert.id).acknowledgedBy;
  const supAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(south.supervisor), body: {} });
  check('7h. The read grant does not allow acknowledging the West alert → 403', supAck.status === 403, `HTTP ${supAck.status}`);
  check('7i. Alert acknowledgement state is unchanged', alertRow(westAlert.id).acknowledgedBy === beforeAckBy);

  // The read-only reviewer with the same exceptional grant: read yes, shared-state write no.
  const revGrant = await api(`/api/cases/${westAlertCase.id}/grants`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { userId: south.reviewer.id, note: 'M1.1 fixture: exceptional read grant to the read-only reviewer.' },
  });
  const revRead = await api(`/api/cases/${westAlertCase.id}`, as(south.reviewer));
  check(
    '7k. The granted reviewer can read the West case',
    revGrant.status === 200 && revRead.status === 200 && revRead.data?.canViewContent === true,
    `grant HTTP ${revGrant.status}, read HTTP ${revRead.status}`
  );
  const revAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', ...as(south.reviewer), body: {} });
  check('7l. The granted reviewer still cannot acknowledge the West alert → 403', revAck.status === 403, `HTTP ${revAck.status}`);
  const revDecision = await api(`/api/transfers/${transfers.denyReject}/decision`, {
    method: 'POST',
    ...as(south.reviewer),
    body: { decision: 'reject', note: 'M1.1 regression: granted reviewer attempts a transfer decision.' },
  });
  check('7m. The granted reviewer still cannot decide a transfer → 403', revDecision.status === 403, `HTTP ${revDecision.status}`);
  await api(`/api/cases/${westAlertCase.id}/grants`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { userId: south.reviewer.id, note: 'M1.1 fixture cleanup.', revoke: true },
  });

  // Revoke so the fixtures end clean.
  await api(`/api/cases/${westAlertCase.id}/grants`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { userId: south.rbLead.id, note: 'M1.1 fixture cleanup.', revoke: true },
  });
  await api(`/api/cases/${westAlertCase.id}/grants`, {
    method: 'POST',
    ...as(west.pgrcLead),
    body: { userId: south.supervisor.id, note: 'M1.1 fixture cleanup.', revoke: true },
  });
  const afterRevoke = await api(`/api/cases/${westAlertCase.id}`, as(south.rbLead));
  check(
    '7j. After revocation the South lead loses read access again',
    afterRevoke.status === 403 || afterRevoke.data?.canViewContent === false,
    `HTTP ${afterRevoke.status} canViewContent=${afterRevoke.data?.canViewContent}`
  );
}

/* =====================================================================
 * 8. Client-supplied identity cannot widen either permission
 * =================================================================== */
{
  const forged = await api(`/api/transfers/${transfers.denyAccept}/decision`, {
    method: 'POST',
    ...as(south.rbLead),
    body: { decision: 'accept', note: 'M1.1 regression: forged bureau/region in the body.', bureau: 'RB', region: 'West', role: 'bureau_lead' },
  });
  check('8a. Client-supplied bureau/region/role cannot widen transfer authority → 403', forged.status === 403, `HTTP ${forged.status}`);
  check('8b. Transfer still pending after the forged attempt', transferRow(transfers.denyAccept).state === 'pending');
  const forgedAck = await api(`/api/alerts/${westAlert.id}/acknowledge?region=West&role=supervisor`, {
    method: 'POST',
    ...as(south.supervisor),
    body: { region: 'West', role: 'supervisor' },
  });
  check('8c. Client-supplied region/role cannot widen acknowledgement authority → 403', forgedAck.status === 403, `HTTP ${forgedAck.status}`);
}

/* ------------------------------------------------------------------ report */
db.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} executed checks passed`);
if (skipped.length) {
  console.log(`${skipped.length} skipped (not counted as passes):`);
  for (const s of skipped) console.log(` - ${s.name}: ${s.why}`);
}
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('M1.1 regional authorisation regressions: PASS');
