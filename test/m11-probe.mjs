/**
 * M1.1 probe — reproduces (or refutes) the two regional-authorisation bugs in a readable form.
 *
 * Creates its own West-region fixtures through the API, then tries the two out-of-region writes and the
 * matching in-region controls. Safe to run against a pre-fix build and the fixed build: it reports what
 * happened instead of asserting.
 *
 *   BASE=http://127.0.0.1:8093 CASELINK_DB=/tmp/x/caselink.db node test/m11-probe.mjs
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = 'caselink-demo';

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
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

const Database = (await import('better-sqlite3')).default;
const db = new Database(process.env.CASELINK_DB ?? 'data/caselink.db', { readonly: true });
const alertRow = (id) => db.prepare('SELECT state, acknowledged_by AS ackBy, acknowledged_at AS ackAt FROM alerts WHERE id = ?').get(id);
const transferRow = (id) => db.prepare('SELECT case_id AS caseId, state, decided_by AS decidedBy FROM transfers WHERE id = ?').get(id);
const caseRow = (id) => db.prepare('SELECT bureau, assigned_officer_id AS officer, version FROM cases WHERE id = ?').get(id);

const login = async (username) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  return { token: r.data?.token, id: r.data?.user?.id, role: r.data?.user?.role, bureau: r.data?.user?.bureau, region: r.data?.user?.region };
};
const line = (id, text) => console.log(`PROBE ${id}: ${text}`);

const southSupervisor = await login('a.desai');
const southRbLead = await login('l.verma');
const westPgrclLead = await login('s.bose');
const westRbLead = await login('r.pillai');
const westSupervisor = await login('v.kumar');

if (!westPgrclLead.token || !westRbLead.token || !westSupervisor.token) {
  console.log('West-region accounts are missing from this seed — re-seed with the current seed.ts.');
  process.exit(2);
}

const inst = (await api('/api/institutions?q=sabarmati', { token: westPgrclLead.token })).data?.institutions?.[0];
const stamp = Date.now();
const mk = async (tag) => {
  const r = await api('/api/cases', {
    method: 'POST',
    token: westPgrclLead.token,
    body: {
      institutionId: inst.id,
      receivedAt: new Date(Date.now() - 3 * 864e5).toISOString(),
      sourceChannel: 'Email',
      sourceReference: `PROBE-${tag}-${stamp}`,
      category: 'Other',
      complaintSummary: `M1.1 probe fixture ${tag}: synthetic West-region complaint.`,
      deadlinePolicyId: 'DEMO-POL-30',
    },
  });
  return r.data;
};

const alertCase = await mk('ALERT');
const tCaseA = await mk('TRANSFER-A');
const tCaseB = await mk('TRANSFER-B');

const coord = (await api('/api/coordination', { token: westSupervisor.token })).data;
const westAlert = (coord?.overlaps ?? []).find((o) => o.institution?.permanentId === inst.permanentId);

// --- Bug 1: out-of-region alert acknowledgement ------------------------------------------------
const southRead = await api(`/api/cases/${alertCase.id}`, { token: southSupervisor.token });
line('1a', `South supervisor reads the West case → HTTP ${southRead.status}`);
const southDash = (await api('/api/coordination', { token: southSupervisor.token })).data?.overlaps ?? [];
line('1b', `West alert visible on the South supervisor dashboard: ${southDash.some((o) => o.id === westAlert.id)}`);
const before1 = alertRow(westAlert.id);
const ack = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', token: southSupervisor.token, body: {} });
const after1 = alertRow(westAlert.id);
line(
  '1c',
  `South supervisor acknowledges the West alert → HTTP ${ack.status}; persisted state ${before1.state}→${after1.state}, ackBy=${after1.ackBy ?? 'null'}`
);
const westAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', token: westSupervisor.token, body: {} });
line('1d', `West supervisor acknowledges the same alert → HTTP ${westAck.status}; persisted ackBy=${alertRow(westAlert.id).ackBy ?? 'null'}`);

// --- Bug 2: out-of-region transfer decisions -------------------------------------------------
const mkTransfer = async (caseId, tag) => {
  const c = caseRow(caseId);
  const r = await api(`/api/cases/${caseId}/transfer`, {
    method: 'POST',
    token: westPgrclLead.token,
    body: { version: c.version, toBureau: 'RB', reason: `M1.1 probe ${tag}: West PGRC case to RB.` },
  });
  const t = db.prepare('SELECT id FROM transfers WHERE case_id = ? ORDER BY requested_at DESC LIMIT 1').get(caseId);
  return { status: r.status, id: t?.id };
};
const tA = await mkTransfer(tCaseA.id, 'A');
const tB = await mkTransfer(tCaseB.id, 'B');
line('2a', `West transfer requests created: ${tA.status}/${tB.status}`);

const southReadCase = await api(`/api/cases/${tCaseA.id}`, { token: southRbLead.token });
line('2b', `South RB lead reads the West case → HTTP ${southReadCase.status}`);
const beforeA = transferRow(tA.id);
const beforeCaseA = caseRow(tCaseA.id);
const reject = await api(`/api/transfers/${tA.id}/decision`, { method: 'POST', token: southRbLead.token, body: { decision: 'reject', note: 'Probe: South RB lead rejects a West transfer.' } });
const afterA = transferRow(tA.id);
const afterCaseA = caseRow(tCaseA.id);
line(
  '2c',
  `South RB lead REJECTS a West transfer → HTTP ${reject.status}; transfer ${beforeA.state}→${afterA.state}, owner ${beforeCaseA.bureau}→${afterCaseA.bureau}, version ${beforeCaseA.version}→${afterCaseA.version}`
);
const beforeB = transferRow(tB.id);
const beforeCaseB = caseRow(transferRow(tB.id).caseId);
const accept = await api(`/api/transfers/${tB.id}/decision`, { method: 'POST', token: southRbLead.token, body: { decision: 'accept', note: 'Probe: South RB lead accepts a West transfer.' } });
const afterB = transferRow(tB.id);
const afterCaseB = caseRow(transferRow(tB.id).caseId);
line(
  '2d',
  `South RB lead ACCEPTS a West transfer → HTTP ${accept.status}; transfer ${beforeB.state}→${afterB.state}, owner ${beforeCaseB.bureau}→${afterCaseB.bureau}, version ${beforeCaseB.version}→${afterCaseB.version}`
);

// --- Controls ---------------------------------------------------------------------------------
const tC = await mkTransfer((await mk('TRANSFER-C')).id, 'C');
const okAccept = await api(`/api/transfers/${tC.id}/decision`, { method: 'POST', token: westRbLead.token, body: { decision: 'accept', note: 'Probe: West RB lead accepts a West transfer.' } });
line('3a', `West RB lead accepts a West transfer → HTTP ${okAccept.status}; state=${transferRow(tC.id).state} owner=${caseRow(transferRow(tC.id).caseId)?.bureau ?? 'n/a'}`);
const tD = await mkTransfer((await mk('TRANSFER-D')).id, 'D');
const okReject = await api(`/api/transfers/${tD.id}/decision`, { method: 'POST', token: westRbLead.token, body: { decision: 'reject', note: 'Probe: West RB lead rejects a West transfer.' } });
line('3b', `West RB lead rejects a West transfer → HTTP ${okReject.status}; state=${transferRow(tD.id).state}`);

const reviewer = await login('r.khan');
const reviewerAck = await api(`/api/alerts/${westAlert.id}/acknowledge`, { method: 'POST', token: reviewer.token, body: {} });
line('4a', `Read-only reviewer acknowledges a coordination alert → HTTP ${reviewerAck.status}`);

// Content grant must not confer regional write authority.
const grant = await api(`/api/cases/${alertCase.id}/grants`, {
  method: 'POST',
  token: westPgrclLead.token,
  body: { userId: southRbLead.id, note: 'Probe: exceptional read grant to the South RB lead.' },
});
const grantedRead = await api(`/api/cases/${alertCase.id}`, { token: southRbLead.token });
const tE = await mkTransfer(alertCase.id, 'E');
const grantedDecision = await api(`/api/transfers/${tE.id}/decision`, {
  method: 'POST',
  token: southRbLead.token,
  body: { decision: 'accept', note: 'Probe: granted South lead attempts a West transfer decision.' },
});
line(
  '4b',
  `Grant ${grant.status} → South RB lead read ${grantedRead.status} (canViewContent=${grantedRead.data?.canViewContent}); transfer decision on the same case → HTTP ${grantedDecision.status}`
);
db.close();
