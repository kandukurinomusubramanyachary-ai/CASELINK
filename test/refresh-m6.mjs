/**
 * M6 — shared-refresh behaviour in the browser.
 *
 *   BASE=http://127.0.0.1:8081 node test/refresh-m6.mjs
 *
 * Proves, in a real browser with real sessions:
 *   1. a change made by another officer reaches My work, the case workspace, the institution profile,
 *      coordination and the report view inside the 10-second target, without a reload;
 *   2. a local write refreshes its own screen straight away rather than on the next tick;
 *   3. the refresh timer stops when the screen is left, pauses while the tab is hidden, resumes when it
 *      becomes visible, and stops completely at sign-out;
 *   4. the refresh path never widens visibility: a record visible to the previous account is gone after
 *      switching accounts.
 *
 * Stat labels render in upper case, so the assertions match them case-insensitively.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = 'caselink-demo';
const TARGET_MS = 10_000; // the agreed product target: another officer's write must be on screen inside 10 s
// The pass threshold is the target itself — never a relaxed version of it. WAIT_MS is only how long the
// harness keeps polling before it reports the observation as a miss (M7/A15).
const LIMIT_MS = TARGET_MS;
const WAIT_MS = 25_000;

const results = [];
const skipped = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};

/* ------------------------------------------------------------------- helpers */
async function token(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, user: body.user };
}
const auth = (t) => ({ authorization: `Bearer ${t}` });
async function getJson(path, t) {
  const res = await fetch(`${BASE}/api${path}`, { headers: auth(t) });
  return { status: res.status, body: await res.json() };
}
async function postJson(path, t, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { ...auth(t), 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const failedRequests = [];
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});

async function signIn(username) {
  await page.goto(`${BASE}/#/my-work`);
  await page.waitForSelector('#username', { timeout: 25_000 });
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 25_000 });
  await page.waitForTimeout(700);
}
async function signOut() {
  const button = page.locator('button:has-text("Sign out")');
  if ((await button.count()) > 0) {
    await button.first().click();
    await page.waitForSelector('#username', { timeout: 20_000 }).catch(() => {});
  } else {
    // Never hide a broken screen behind a crash: fall back to clearing the session and recording it.
    console.log(`     (no sign-out control on screen at ${page.url()} — clearing the stored token instead)`);
    await page.evaluate(() => window.localStorage.removeItem('caselink.token'));
    await page.goto(`${BASE}/#/login`);
  }
  await page.waitForTimeout(400);
}
/** Wait until the predicate holds in the page; returns the elapsed milliseconds. */
async function waitForChange(predicate, arg = null, limit = WAIT_MS) {
  const started = Date.now();
  try {
    await page.waitForFunction(predicate, arg, { timeout: limit, polling: 250 });
    return { ok: true, ms: Date.now() - started };
  } catch {
    const snippet = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)).catch(() => '');
    console.log(`     (timeout at ${page.url()}: ${snippet})`);
    return { ok: false, ms: Date.now() - started };
  }
}
const bodyText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
/** Read a stat by its (upper-case) label, e.g. "ASSIGNED TO ME  31". */
async function stat(label) {
  const text = await bodyText();
  const match = text.match(new RegExp(`${label}\\s+(\\d+)`, 'i'));
  return match ? Number(match[1]) : null;
}

/* ------------------------------------------------------------------- fixtures */
const lead = await token('m.nair'); // PGRC South lead — "the other officer"
const officer = await token('p.rao'); // PGRC South officer — the browsing officer
const sup = await token('a.desai'); // South supervisor — the browsing supervisor
const rbLead = await token('s.iyer'); // RB South lead

const institutions = (await getJson('/institutions', sup.token)).body.institutions ?? [];
const target = institutions.find((i) => i.bureaus.length === 1 && i.bureaus[0] === 'PGRC' && i.activeCases > 0 && i.region === 'South');
check('0a a fixture institution with only PGRC active cases exists', Boolean(target), target?.name ?? 'none');
const mark = `M6-${Date.now()}`;
const casePayload = (extra) => ({
  receivedAt: new Date().toISOString(),
  sourceChannel: 'Email',
  category: 'Infrastructure',
  complaintSummary: 'Synthetic M6 refresh fixture. This row exists only to prove that a change made by one officer reaches another officer\u2019s open screen inside the ten-second target.',
  deadlinePolicyId: 'DEMO-POL-30',
  ...extra,
});

/* --------------------------------------- 1. My work picks up newly assigned work */
await signIn('p.rao');
const assignedBefore = await stat('ASSIGNED TO ME');
const assignedCase = await postJson('/cases', lead.token, casePayload({
  institutionId: target.id,
  sourceReference: `${mark}/MYWORK`,
  assignedOfficerId: officer.user.id,
}));
check(
  '1a a case assigned to the browsing officer was created by another officer',
  assignedCase.status === 201,
  `HTTP ${assignedCase.status} ${assignedCase.body?.caseNumber ?? ''} · assigned-to-me was ${assignedBefore}`
);
const assignedChange = await waitForChange(
  (before) => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    const match = text.match(/ASSIGNED TO ME\s+(\d+)/i);
    return Boolean(match) && Number(match[1]) !== before;
  },
  assignedBefore
);
check(
  '1b My work picks the new assignment up within the target, without a reload',
  assignedChange.ok && assignedChange.ms <= LIMIT_MS,
  `${assignedChange.ms} ms (target ${TARGET_MS} ms)`
);

/* ------------------------------- 6. a local write refreshes without waiting a tick */
await page.goto(`${BASE}/#/alerts`);
await page.waitForTimeout(1800);
const notificationRequests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/notifications')) notificationRequests.push(Date.now());
});
const ackButtons = page.locator('button:has-text("Acknowledge")');
const ackCount = await ackButtons.count();
let localWrite = { ok: false, ms: null, note: 'no acknowledgement control on this screen' };
if (ackCount > 0) {
  const before = notificationRequests.length;
  const startedAt = Date.now();
  await ackButtons.first().click().catch(() => {});
  await page.waitForTimeout(2500);
  localWrite = {
    ok: notificationRequests.length > before,
    ms: Date.now() - startedAt,
    note: `${notificationRequests.length - before} notification refresh(es)`,
  };
}
if (ackCount === 0) {
  skipped.push('6a a local acknowledgement refreshes its own screen straight away (no personal notification fixture for this account)');
  console.log('SKIP  6a a local acknowledgement refreshes its own screen straight away  —  no personal notification fixture for this account');
} else {
  check('6a a local acknowledgement refreshes its own screen straight away', localWrite.ok, `${localWrite.ms} ms · ${localWrite.note}`);
}

/* ------------------------------------ 2. case workspace picks up a new action */
const caseNumber = assignedCase.body.caseNumber;
const caseId = assignedCase.body.id;
await page.goto(`${BASE}/#/cases/${caseId}`);
await page.waitForTimeout(1500);
const detail = await getJson(`/cases/${caseId}`, lead.token);
const noteText = `M6 refresh note ${mark}`;
const action = await postJson(`/cases/${caseId}/actions`, lead.token, {
  version: detail.body.case.version,
  actionType: 'internal_note',
  remarks: `${noteText} — recorded by the bureau lead while the officer had this case open.`,
  nextStep: null,
});
check('2a another officer recorded an action on the open case', action.status === 201, `HTTP ${action.status}`);
const caseChange = await waitForChange((text) => document.body.innerText.includes(text), noteText);
check(
  '2b the open case workspace shows the other officer\u2019s action within the target',
  caseChange.ok && caseChange.ms <= LIMIT_MS,
  `${caseChange.ms} ms on ${caseNumber}`
);

/* ---------------------------------------- 3. coordination view picks up a change */
await signOut();
await signIn('a.desai');
await page.goto(`${BASE}/#/coordination`);
await page.waitForTimeout(1800);
const overlapBefore = await page.evaluate(() => {
  const match = document.body.innerText.replace(/\s+/g, ' ').match(/Institution overlaps\s*\((\d+)\)/i);
  return match ? Number(match[1]) : null;
});
const coordinationAlreadyShowed = (await bodyText()).includes(target.name) && overlapBefore !== null;
const rbCase = await postJson('/cases', rbLead.token, casePayload({
  institutionId: target.id,
  sourceReference: `${mark}/RB`,
  category: 'Fee / refund',
}));
check(
  '3a the second-bureau case was created after the coordination view was open',
  rbCase.status === 201,
  `HTTP ${rbCase.status} ${rbCase.body?.caseNumber ?? ''} · overlaps before ${overlapBefore} · institution already listed ${coordinationAlreadyShowed}`
);
const coordinationChange = await waitForChange(
  (before) => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    const match = text.match(/INSTITUTION OVERLAPS\s*\((\d+)\)/i);
    return Boolean(match) && Number(match[1]) !== before;
  },
  overlapBefore
);
check(
  '3b the coordination view picks the new overlap alert up within the target',
  coordinationChange.ok && !coordinationAlreadyShowed && coordinationChange.ms <= LIMIT_MS,
  `${coordinationChange.ms} ms (overlaps ${overlapBefore} → later)`
);

/* ----------------------------------- 4. institution profile picks up a new case */
await page.goto(`${BASE}/#/institutions/${target.id}`);
await page.waitForTimeout(1800);
const profileCase = await postJson('/cases', lead.token, casePayload({
  institutionId: target.id,
  sourceReference: `${mark}/PROFILE`,
  category: 'Other',
}));
check('4a a case was created at the institution whose profile is open', profileCase.status === 201, `HTTP ${profileCase.status} ${profileCase.body?.caseNumber ?? ''}`);
const profileChange = await waitForChange((ref) => document.body.innerText.includes(ref), profileCase.body.caseNumber);
check(
  '4b the open institution profile lists the new case within the target',
  profileChange.ok && profileChange.ms <= LIMIT_MS,
  `${profileChange.ms} ms (${profileCase.body.caseNumber})`
);

/* ------------------------------------------------------ 5. report view refreshes */
await page.goto(`${BASE}/#/reports`);
await page.waitForTimeout(2000);
const totalBefore = await stat('CURRENT TOTAL');
check('5a the report view renders its current total', totalBefore !== null, `current total ${totalBefore}`);
const reportRequests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/reports')) reportRequests.push(Date.now());
});
const reportCase = await postJson('/cases', lead.token, casePayload({
  institutionId: target.id,
  sourceReference: `${mark}/REPORT`,
  category: 'Other',
}));
check('5b the report fixture case was created', reportCase.status === 201, `HTTP ${reportCase.status}`);
const reportChange = await waitForChange(
  (before) => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    const match = text.match(/CURRENT TOTAL\s+(\d+)/i);
    return Boolean(match) && Number(match[1]) !== before;
  },
  totalBefore
);
check(
  '5c the report total moves within the target without a reload',
  reportChange.ok && reportChange.ms <= LIMIT_MS,
  `${reportChange.ms} ms (was ${totalBefore}) · ${reportRequests.length} report request(s)`
);

/* -------------------------------- 7. timers stop when the screen is left */
const coordinationRequests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/coordination')) coordinationRequests.push(Date.now());
});
await page.goto(`${BASE}/#/coordination`);
await page.waitForTimeout(11_500); // at least one full cycle while the screen is open
const whileOnScreen = coordinationRequests.length;
await page.goto(`${BASE}/#/settings`);
await page.waitForTimeout(1500);
const beforeIdle = coordinationRequests.length;
await page.waitForTimeout(12_000);
check(
  '7a the coordination view polls while open and stops as soon as the screen is left',
  whileOnScreen >= 2 && coordinationRequests.length === beforeIdle,
  `${whileOnScreen} request(s) in an 11.5 s window · ${coordinationRequests.length - beforeIdle} in 12 s after leaving`
);

/* ------------------------------------ 8. hidden tab pauses; visible tab resumes */
const apiRequests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/') && !r.url().includes('/api/auth/')) apiRequests.push(r.url());
});
await page.goto(`${BASE}/#/my-work`);
await page.waitForTimeout(1800);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const hiddenBefore = apiRequests.length;
await page.waitForTimeout(12_000);
const whileHidden = apiRequests.length - hiddenBefore;
// Count from before the tab becomes visible again: the immediate refresh can otherwise be counted in
// between the dispatch and the reading of the counter.
const visibleBefore = apiRequests.length;
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(2500);
check(
  '8a a hidden tab does not poll, and becoming visible refreshes immediately',
  whileHidden === 0 && apiRequests.length > visibleBefore,
  `${whileHidden} request(s) while hidden · ${apiRequests.length - visibleBefore} immediately after becoming visible`
);

/* ------------------------------------------- 9. sign-out stops all activity */
await signOut();
const afterSignOut = [];
page.on('request', (r) => {
  if (r.url().includes('/api/') && !r.url().includes('/api/auth/')) afterSignOut.push(r.url());
});
await page.waitForTimeout(12_000);
const tokenCleared = await page.evaluate(() => window.localStorage.getItem('caselink.token'));
check(
  '9a signing out stops the refresh cycle and clears the stored token',
  afterSignOut.length === 0 && tokenCleared === null,
  `${afterSignOut.length} authenticated request(s) in 12 s · token ${tokenCleared === null ? 'cleared' : 'still present'}`
);

/* --------------------------- 10. switching accounts clears cached state */
await signIn('p.rao');
await page.goto(`${BASE}/#/cases`);
await page.waitForTimeout(2000);
const southText = await bodyText();
const southCaseNumber = caseNumber; // a South case only South officers may read
await signOut();
await signIn('k.menon'); // West bureau lead
await page.goto(`${BASE}/#/cases`);
await page.waitForTimeout(2500);
const westText = await bodyText();
check(
  '10a a South case visible to the previous account is gone after switching accounts',
  southText.includes(southCaseNumber) && !westText.includes(southCaseNumber),
  `${southCaseNumber}: ${southText.includes(southCaseNumber) ? 'visible' : 'not visible'} to the South officer, ${westText.includes(southCaseNumber) ? 'still visible' : 'absent'} for the West lead`
);
check(
  '10b the screen re-renders for the new scope rather than reusing the previous account\u2019s rows',
  westText !== southText,
  westText === southText ? 'identical screen after the switch' : 'screen re-rendered'
);

check('11a no uncaught browser exceptions or console errors were logged', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');

await browser.close();
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
if (failedRequests.length > 0) console.log(`\nfailed API responses: ${failedRequests.slice(0, 8).join(' · ')}`);
for (const item of skipped) console.log(`skipped: ${item}`);
console.log(`\nexecuted: ${results.length}   passed: ${passed}   failed: ${failed}   skipped: ${skipped.length}`);
console.log(failed === 0 ? 'M6 shared refresh: PASS' : 'M6 shared refresh: FAIL');
process.exit(failed === 0 ? 0 : 1);
