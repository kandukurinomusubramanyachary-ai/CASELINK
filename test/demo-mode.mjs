/**
 * Demo-mode checks. Runs ONLY against an instance started with CASELINK_DEMO=true.
 *
 *   BASE=http://127.0.0.1:8090 CASELINK_DEMO=true node test/demo-mode.mjs
 *
 * Verifies that the explicitly configured fixture environment still works (passwordless fixture
 * entry, published demo accounts) while the default configuration does not.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8090';
if (process.env.CASELINK_DEMO !== 'true') {
  console.error('This suite must run against an instance started with CASELINK_DEMO=true.');
  process.exit(2);
}

let failures = 0;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

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

// 10. Explicit demo configuration still supports fixture entry.
const sess0 = await api('/api/session');
check('10a. Demo instance reports demoMode=true', sess0.data?.demoMode === true, `demoMode=${sess0.data?.demoMode}`);
const accounts = sess0.data?.demoAccounts ?? [];
check('10b. Demo accounts are published only in this configuration', accounts.length >= 6, `${accounts.length} accounts`);

const demo = await api('/api/auth/demo-login', { method: 'POST', body: { username: 'l.verma' } });
check('10c. Passwordless fixture entry works → 200', demo.status === 200 && Boolean(demo.data?.token), `HTTP ${demo.status}`);
const token = demo.data?.token;
check('10d. Fixture entry lands as the requested account', demo.data?.user?.username === 'l.verma', demo.data?.user?.username);

const sess = await api('/api/session', { token });
check('10e. The fixture session is authenticated and usable', sess.data?.authenticated === true);

// Fixture entry does not bypass the permission model: the demo PGRC lead still cannot self-grant
// on an RB case.
const m = await api('/api/auth/demo-login', { method: 'POST', body: { username: 'm.nair' } });
const mToken = m.data?.token;
const mId = m.data?.user?.id;
const list = await api('/api/cases?pageSize=100', { token: mToken });
const foreign = (list.data?.cases ?? []).find((c) => c.access === 'restricted' && c.bureau !== 'PGRC');
const attempt = foreign
  ? await api(`/api/cases/${foreign.id}/grants`, { method: 'POST', token: mToken, body: { userId: mId, note: 'Demo self-grant attempt' } })
  : { status: 0 };
check('10f. Fixture accounts are still bound by the permission rules → 403', attempt.status === 403, `HTTP ${attempt.status}`);

// Identity switching via the demo endpoint does not destroy the earlier session token.
const stillOk = await api('/api/session', { token });
check('10g. Switching fixture identity does not invalidate the earlier session', stillOk.data?.authenticated === true);

const signIn = await api('/api/auth/login', { method: 'POST', body: { username: 'p.rao', password: 'caselink-demo' } });
check('10h. Password sign-in also works in the demo instance', signIn.status === 200 && Boolean(signIn.data?.token), `HTTP ${signIn.status}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('Demo-mode checks: PASS');
