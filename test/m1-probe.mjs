/**
 * Compact before/after probe for the three Milestone 1 defects.
 *
 *   BASE=http://127.0.0.1:8093 node test/m1-probe.mjs
 *
 * Prints one line per probe so the same script can be run against a pre-fix build and the fixed build.
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
  return { status: res.status, data, setCookie: (res.headers.getSetCookie?.() ?? []).join('; ') };
}

const login = async (username) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  return { token: r.data?.token, id: r.data?.user?.id, role: r.data?.user?.role, bureau: r.data?.user?.bureau };
};

const line = (id, text) => console.log(`PROBE ${id}: ${text}`);

const lead = await login('m.nair');
const rbLead = await login('l.verma');
const reviewer = await login('r.khan');

const visible = (await api('/api/cases?pageSize=100', { token: lead.token })).data?.cases ?? [];
const foreign = visible.find((c) => c.access === 'restricted' && c.bureau !== lead.bureau);
const own = ((await api('/api/cases?pageSize=100', { token: rbLead.token })).data?.cases ?? []).find(
  (c) => c.bureau === rbLead.bureau && c.permissions?.canUploadEvidence,
);

// Defect 1 — foreign lead self-grants on a restricted case, then reads the contents.
const grant = await api(`/api/cases/${foreign.id}/grants`, {
  method: 'POST',
  token: lead.token,
  body: { userId: lead.id, note: 'Probe: foreign lead self-grant' },
});
const afterGrant = await api(`/api/cases/${foreign.id}`, { token: lead.token });
const reachedContent = Boolean(afterGrant.data?.case?.complaintSummary) && afterGrant.data?.canViewContent === true;
line('1', `self-grant on ${foreign.caseNumber} (${foreign.bureau}) HTTP ${grant.status}; contents readable afterwards: ${reachedContent}`);
if (reachedContent) line('1b', `complaint text exposed: "${String(afterGrant.data.case.complaintSummary).slice(0, 80)}…"`);

// Defect 2 — the same lead, now with a grant, uploads evidence to the foreign case.
const form = new FormData();
form.append('file', new Blob([Buffer.from('%PDF-1.4\n% probe specimen\n')], { type: 'application/pdf' }), 'probe.pdf');
const uploadAsForeignLead = await fetch(`${BASE}/api/cases/${foreign.id}/attachments`, {
  method: 'POST',
  headers: { authorization: `Bearer ${lead.token}` },
  body: form,
});
line('2', `foreign lead evidence upload HTTP ${uploadAsForeignLead.status}`);

// Defect 2 (as reported) — a read-only reviewer holding a grant uploads evidence.
const grantReviewer = await api(`/api/cases/${own.id}/grants`, {
  method: 'POST',
  token: rbLead.token,
  body: { userId: reviewer.id, note: 'Probe: reviewer read grant' },
});
const form2 = new FormData();
form2.append('file', new Blob([Buffer.from('%PDF-1.4\n% probe reviewer specimen\n')], { type: 'application/pdf' }), 'reviewer-probe.pdf');
const uploadReviewer = await fetch(`${BASE}/api/cases/${own.id}/attachments`, {
  method: 'POST',
  headers: { authorization: `Bearer ${reviewer.token}` },
  body: form2,
});
line('3', `granted reviewer upload on ${own.caseNumber} HTTP ${uploadReviewer.status} (grant HTTP ${grantReviewer.status})`);

// Defect 3 — default configuration lets a visitor in without credentials.
const demo = await api('/api/auth/demo-login', { method: 'POST', body: { username: 'm.nair' } });
const session = await api('/api/session');
line(
  '4',
  `demo-login without credentials HTTP ${demo.status}; /api/session demoMode=${session.data?.demoMode}; published demo accounts=${(session.data?.demoAccounts ?? []).length}`
);

// Baseline: unauthenticated protected read.
const anon = await api('/api/cases');
line('0', `unauthenticated GET /api/cases HTTP ${anon.status}`);
