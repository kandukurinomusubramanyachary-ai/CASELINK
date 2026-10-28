/**
 * M7 — acceptance flows T01–T12 through the interface.
 *
 *   BASE=http://127.0.0.1:8082 node test/acceptance-ui.mjs
 *
 * `test/acceptance.mjs` already proves T01–T12 on the API (direct HTTP, no interface). This suite does
 * the same twelve scenarios through real browser sessions, because a backend restriction that the
 * interface bypasses — or an outcome the interface fails to show after a reload — is still a defect.
 * Fixtures are created through the API (so the scenario is deterministic) and then *observed and
 * completed in the browser*: every check below asserts something a user can see or do on screen.
 *
 * T12 needs the administrator-only fault injection, so the instance must run with
 * CASELINK_TEST_HOOKS=true; when the hook is closed the check is reported as skipped, never as passed.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = 'caselink-demo';
const results = [];
const skips = [];
const check = (id, name, ok, detail = '') => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const skip = (id, name, why) => {
  skips.push({ id, name, why });
  console.log(`SKIP  ${id}  ${name}  —  ${why}`);
};

/* ------------------------------------------------------------------ API side */
async function token(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.json();
}
const auth = (t) => ({ authorization: `Bearer ${t}` });
const getJson = async (p, t) => (await fetch(`${BASE}/api${p}`, { headers: auth(t) })).json();
const postJson = async (p, t, body) =>
  (await fetch(`${BASE}/api${p}`, { method: 'POST', headers: { ...auth(t), 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const patchJson = async (p, t, body) =>
  (await fetch(`${BASE}/api${p}`, { method: 'PATCH', headers: { ...auth(t), 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const postStatus = async (p, t, body) =>
  (await fetch(`${BASE}/api${p}`, { method: 'POST', headers: { ...auth(t), 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).status;

const people = {
  pgrcLead: await token('m.nair'),
  rbLead: await token('l.verma'),
  pgrcOfficer: await token('p.rao'),
  supervisor: await token('a.desai'),
  reviewer: await token('r.khan'),
  westOfficer: await token('m.joshi'),
  admin: await token('admin'),
};

/* ------------------------------------------------------------------ browser */
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const consoleErrors = [];
const expectedApiFailures = [];
// Console noise is only a failure when it is not the answer a deliberate step asked for: a rejected
// request (403/409/422) and the injected fault in T12 (500) are the results under test.
let expectedFailureWindow = false;
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const text = m.text();
      const deliberate = /status of (403|409|422)/.test(text) || (expectedFailureWindow && /status of 500/.test(text));
      if (!deliberate) consoleErrors.push(text);
      else expectedApiFailures.push(text);
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  return page;
}
async function signIn(page, username) {
  await page.goto(`${BASE}/#/my-work`);
  await page.waitForSelector('#username', { timeout: 25_000 });
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 25_000 });
  await page.waitForTimeout(600);
}
const text = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
/** Sign in, signing the current account out first when a session is already open. */
async function switchTo(page, username) {
  await page.keyboard.press('Escape').catch(() => {});
  const signOut = page.locator('button:has-text("Sign out")');
  if ((await signOut.count()) > 0) {
    await signOut.first().click().catch(() => {});
    await page.waitForSelector('#username', { timeout: 20_000 }).catch(() => {});
  }
  await signIn(page, username);
}

const page = await newPage();

/* ---------------------------------------------------------------- fixtures */
const southInstitutions = (await getJson('/institutions', people.supervisor.token)).institutions.filter((i) => i.region === 'South');
const singleBureau = southInstitutions.find((i) => i.bureaus.length === 1 && i.bureaus[0] === 'PGRC' && i.activeCases > 0);
const twoBureau = southInstitutions.find((i) => i.bureaus.length === 2) ?? singleBureau;
const stamp = Date.now();
const make = (extra) => ({
  receivedAt: new Date().toISOString(),
  sourceChannel: 'Email',
  category: 'Other',
  complaintSummary: 'Synthetic M7 acceptance fixture. This record exists only to exercise an acceptance scenario in the interface.',
  deadlinePolicyId: 'DEMO-POL-30',
  ...extra,
});

// T01/T02: an RB case at an institution where only PGRC had active cases → one overlap alert.
const t01 = await postJson('/cases', people.rbLead.token, make({
  institutionId: singleBureau.id,
  sourceReference: `T01-UI/${stamp}`,
  category: 'Infrastructure',
  complaintSummary: 'Synthetic T01 fixture: the second bureau files at this college, so one coordination alert must cover both cases.',
}));
const t01Paused = await postJson('/cases', people.pgrcLead.token, make({
  institutionId: singleBureau.id,
  sourceReference: `T02-UI/${stamp}`,
  category: 'Certificate / documentation',
  complaintSummary: 'Synthetic T02 fixture: an unrelated topic at the same college. An institution alert is a coordination signal, not a duplicate claim.',
}));

/* ------------------------------------------------------------------- T01 */
await signIn(page, 'a.desai');
await page.goto(`${BASE}/#/coordination`);
await page.waitForTimeout(1800);
const t01Body = await text(page);
const t01AlertListed = t01Body.includes(singleBureau.name);
await page.click(`text=${singleBureau.name}`).catch(() => {});
await page.waitForTimeout(1500);
const t01Detail = await text(page);
check(
  'T01',
  'One coordination alert links both bureaus\u2019 cases for the institution (interface)',
  t01AlertListed && t01Detail.includes(t01.caseNumber) && t01Detail.includes(t01Paused.caseNumber),
  `alert listed=${t01AlertListed}, both case numbers visible=${t01Detail.includes(t01.caseNumber) && t01Detail.includes(t01Paused.caseNumber)}`
);

/* ------------------------------------------------------------------- T02 */
check(
  'T02',
  'The interface calls the alert a coordination signal, not a duplicate claim (interface)',
  t01Detail.includes('coordination signal, not a duplicate claim') && t01Detail.includes('A reviewer') ,
  t01Detail.includes('coordination signal, not a duplicate claim') ? 'wording present' : 'wording missing'
);

/* ------------------------------------------------------------------- T03 */
// Identical wording at two different institutions must not produce a relationship in the interface.
const otherInstitution = southInstitutions.find((i) => i.id !== singleBureau.id && i.id !== twoBureau.id);
const identicalWording = 'Synthetic T03 fixture: the physics laboratory equipment has been out of order since the start of the semester and practical classes are being conducted without instruments.';
const t03a = await postJson('/cases', people.pgrcLead.token, make({ institutionId: singleBureau.id, sourceReference: `T03A-UI/${stamp}`, category: 'Infrastructure', complaintSummary: identicalWording }));
const t03b = await postJson('/cases', people.pgrcLead.token, make({ institutionId: otherInstitution.id, sourceReference: `T03B-UI/${stamp}`, category: 'Infrastructure', complaintSummary: identicalWording }));
await page.goto(`${BASE}/#/cases/${t03a.id}`);
await page.waitForTimeout(1800);
const t03Body = await text(page);
check(
  'T03',
  'Identical wording at a different institution produces no relationship in the interface',
  !t03Body.includes(t03b.caseNumber) && t03Body.includes('Related cases'),
  `other case number visible=${t03Body.includes(t03b.caseNumber)}`
);

/* ------------------------------------------------------------------- T04 */
// The seeded data already contains an unresolved-identity case: use it rather than fabricating one.
const triageCase = (await getJson('/cases?triage=1&pageSize=50', people.pgrcOfficer.token)).cases?.find((c) => c.triageState === 'unresolved');
// A case with no confirmed institution has no region, so only its own bureau sees it, and the triage
// card is offered to an account that may actually change the record (the bureau lead).
await switchTo(page, 'm.nair');
await page.goto(`${BASE}/#/cases/${triageCase?.id ?? 'missing'}`);
await page.waitForTimeout(1800);
const t04Body = await text(page);
check(
  'T04',
  'An ambiguous name stays in triage and is excluded from automatic overlap checks (interface)',
  t04Body.includes('Institution identity unresolved') && t04Body.includes('excluded from automatic institution overlap checks'),
  t04Body.includes('Institution identity unresolved') ? 'triage notice shown' : 'triage notice missing'
);

/* ------------------------------------------------------------------- T05 */
// A bureau officer from another region must not read the case; a same-region other-bureau officer sees
// coordination metadata but never the complaint text.
const t05Case = await postJson('/cases', people.pgrcLead.token, make({
  institutionId: singleBureau.id,
  sourceReference: `T05-UI/${stamp}`,
  complaintSummary: 'Synthetic T05 fixture: the complaint text must never reach an officer outside the owning bureau and region.',
}));
await page.goto(`${BASE}/#/cases/${t05Case.id}`);
await page.waitForTimeout(1200);
await switchTo(page, 'm.joshi'); // West officer
await page.goto(`${BASE}/#/cases/${t05Case.id}`);
await page.waitForTimeout(1800);
const t05West = await text(page);
await switchTo(page, 'l.verma'); // RB South lead: metadata only for a PGRC case
await page.goto(`${BASE}/#/cases/${t05Case.id}`);
await page.waitForTimeout(1800);
const t05OtherBureau = await text(page);
check(
  'T05',
  'Cross-bureau and cross-region reads are refused or masked in the interface',
  !t05West.includes(t05Case.complaintSummary ?? 'never-matches') &&
    (t05West.includes('Access denied') || t05West.includes('not available') || t05West.includes('restricted')) &&
    !t05OtherBureau.includes(t05Case.complaintSummary ?? 'never-matches'),
  `west officer blocked=${t05West.includes('Access denied') || t05West.includes('restricted')}, complaint text leaked to other bureau=${t05OtherBureau.includes(t05Case.complaintSummary ?? 'x')}`
);

/* ------------------------------------------------------------------- T06 */
// Link then revoke through the interface. A decision needs current content access to *both* cases, so the
// same-bureau pair is used here; the reviewer and cross-bureau variants are asserted by the API suite
// (test/acceptance.mjs T06 and test/security-m2.mjs).
const coordination = await getJson('/coordination', people.pgrcLead.token);
const alertWithPair = (coordination.overlaps ?? []).find((a) =>
  (a.suggestions ?? []).some((s) => s.state === 'open' && s.caseA?.bureau === 'PGRC' && s.caseB?.bureau === 'PGRC')
);
const decidablePair = (alertWithPair?.suggestions ?? []).find((s) => s.state === 'open' && s.caseA?.bureau === 'PGRC' && s.caseB?.bureau === 'PGRC');
if (!alertWithPair || !decidablePair) {
  skip('T06', 'A lead links two cases and revokes the link through the interface', 'no open same-bureau suggestion was available to decide');
} else {
  await switchTo(page, 'm.nair');
  await page.goto(`${BASE}/#/coordination/${alertWithPair.id}`);
  await page.waitForTimeout(1800);
  const card = page.locator(`.evidence-card:has-text("${decidablePair.caseA.caseNumber}")`).first();
  await card.locator('button:has-text("Review")').click();
  await page.waitForTimeout(800);
  await page.fill('textarea', 'T06 interface check: the two records describe the same incident, so they are linked.');
  await page.click('button:has-text("Save decision")');
  await page.waitForTimeout(2500);
  const afterLink = await text(page);
  page.on('dialog', async (d) => d.accept('T06 interface check: the link was recorded in error and is revoked.'));
  const revoke = page.locator(`button:has-text("Revoke")`).first();
  const hadRevoke = (await revoke.count()) > 0;
  if (hadRevoke) {
    await revoke.click();
    await page.waitForTimeout(2500);
  }
  const afterRevoke = await text(page);
  check(
    'T06',
    'A lead links two cases and revokes the link, with the reason recorded (interface)',
    hadRevoke && afterRevoke.includes('Revoked'),
    `link recorded=${hadRevoke}, reason shown after revocation=${afterRevoke.includes('Revoked')}`
  );
}

/* ------------------------------------------------------------------- T07 */
// Request a transfer in the interface, then accept it as the receiving lead. The interface text is not
// the proof: the transfer row, the business events and the stored bureau are read back from the API
// after each step (M7/A17 - the earlier version of this check passed on page text alone).
const t07Case = await postJson('/cases', people.pgrcLead.token, make({
  institutionId: singleBureau.id,
  sourceReference: `T07-UI/${stamp}`,
  assignedOfficerId: people.pgrcOfficer.user.id,
  complaintSummary: 'Synthetic T07 fixture: ownership must move to RB only when the receiving lead accepts.',
}));
await switchTo(page, 'm.nair');
await page.goto(`${BASE}/#/cases/${t07Case.id}`);
await page.waitForTimeout(1800);
// Scoped controls: the transfer card only, never a page-wide "first match".
const transferCard = page.locator('.card', { hasText: 'Transfer ownership' }).first();
await transferCard.locator('select').selectOption({ label: 'RB' });
await transferCard.locator('textarea').fill('T07 interface check: RB owns the related approval, so ownership should move.');
await transferCard.locator('button:has-text("Request transfer")').click();
await page.waitForTimeout(2500);
const t07AfterRequest = (await getJson(`/cases/${t07Case.id}`, people.pgrcLead.token)).case;
const t07PendingRows = (await getJson(`/cases/${t07Case.id}`, people.pgrcLead.token)).transfers ?? [];
const t07Pending = await text(page);

await switchTo(page, 'l.verma');
await page.goto(`${BASE}/#/cases/${t07Case.id}`);
await page.waitForTimeout(1800);
const acceptCard = page.locator('.card', { hasText: 'Transfer ownership' }).first();
await acceptCard.locator('input').first().fill('Accepted in the interface acceptance check.');
await acceptCard.locator('button:has-text("Accept transfer")').click();
await page.waitForTimeout(2500);
const t07AfterAccept = (await getJson(`/cases/${t07Case.id}`, people.pgrcLead.token)).case;
const t07Events = (await getJson(`/cases/${t07Case.id}`, people.pgrcLead.token)).history ?? [];
const transferStates = t07Events.filter((h) => /transfer/.test(h.actionType)).map((h) => h.actionType);
check(
  'T07',
  'A transfer stays pending until the receiving lead accepts it, then ownership moves (interface)',
  t07AfterRequest.bureau === 'PGRC' &&
    t07PendingRows.some((t) => t.state === 'pending') &&
    t07Pending.includes('pending') &&
    t07AfterAccept.bureau === 'RB' &&
    transferStates.includes('transfer_requested') &&
    transferStates.includes('transfer_accepted'),
  `pending shown=${t07Pending.includes('pending')}, stored bureau before=${t07AfterRequest.bureau}, after=${t07AfterAccept.bureau}, events=${transferStates.join(',')}`
);

/* ------------------------------------------------------------------- T08 */
const noDeadline = (await getJson('/cases?q=RB-2026-00023', people.supervisor.token)).cases?.[0];
await switchTo(page, 'a.desai');
if (noDeadline) {
  await page.goto(`${BASE}/#/cases/${noDeadline.id}`);
  await page.waitForTimeout(1800);
  const t08Body = await text(page);
  const t08Case = (await getJson(`/cases/${noDeadline.id}`, people.supervisor.token)).case;
  check(
    'T08',
    'A case with no policy shows "No deadline configured" instead of an invented due date (interface)',
    /No deadline configured/i.test(t08Body) && t08Case?.expectedDisposalAt === null,
    `wording present=${/No deadline configured/i.test(t08Body)}, stored deadline=${t08Case?.expectedDisposalAt ?? 'none'}`
  );
} else {
  skip('T08', 'No-policy case shows no invented deadline (interface)', 'the seeded no-policy case was not visible to this account');
}

/* ------------------------------------------------------------------- T09 */
// Disposition and reopening are proven from the stored record: status, disposition row, reopenedAt and
// the business events — not from text that can appear anywhere on the page (M7/A17).
const t09Case = await postJson('/cases', people.pgrcLead.token, make({
  institutionId: singleBureau.id,
  sourceReference: `T09-UI/${stamp}`,
  assignedOfficerId: people.pgrcOfficer.user.id,
  complaintSummary: 'Synthetic T09 fixture: disposition outcome and reopening receipt must survive a reload.',
}));
await switchTo(page, 'm.nair');
await page.goto(`${BASE}/#/cases/${t09Case.id}`);
await page.waitForTimeout(1800);
const t09Card = page.locator('.card', { hasText: 'Record an action' }).first();
await t09Card.locator('textarea').fill('T09 interface check: the complaint is upheld and the institution must reply in writing.');
await t09Card.locator('select').nth(1).selectOption({ label: 'Disposed' });
await page.waitForSelector('input[placeholder*="DEMO-DISP"]', { timeout: 10_000 });
await t09Card.locator('select').nth(2).selectOption({ label: 'Upheld — corrective action directed' });
await t09Card.locator('input[placeholder*="DEMO-DISP"]').fill('DEMO-DISP-T09-UI');
await t09Card.locator('button:has-text("Save action")').click();
await page.waitForTimeout(2500);
const t09Disposed = (await getJson(`/cases/${t09Case.id}`, people.pgrcLead.token)).case;
const t09AfterDisposeText = await text(page);
await page.reload();
await page.waitForTimeout(2000);
const t09ReloadedText = await text(page);

// Reopening is a protected operation with its own reason field.
const reopenCard = page.locator('.card', { hasText: 'Reopen case' }).first();
await reopenCard.locator('textarea, input').first().fill('T09 interface check: a late reply from the institution arrived, so the case is reopened.');
await reopenCard.locator('button:has-text("Reopen for review")').click();
await page.waitForTimeout(2500);
const t09Reopened = (await getJson(`/cases/${t09Case.id}`, people.pgrcLead.token)).case;
const t09Detail = await getJson(`/cases/${t09Case.id}`, people.pgrcLead.token);
const t09Outcomes = (t09Detail.dispositions ?? []).map((d) => d.outcome);
check(
  'T09',
  'Disposition and reopening keep the structured outcome and the receipt time (interface)',
  t09Disposed.status === 'Disposed' &&
    t09Disposed.outcome === 'Upheld — corrective action directed' &&
    t09Disposed.decisionReference === 'DEMO-DISP-T09-UI' &&
    /Upheld/.test(t09AfterDisposeText) &&
    /Upheld/.test(t09ReloadedText) &&
    t09Reopened.status === 'Under review' &&
    Boolean(t09Reopened.reopenedAt) &&
    t09Outcomes.includes('Upheld — corrective action directed'),
  `disposed=${t09Disposed.status}/${t09Disposed.outcome}, shownAfterSave=${/Upheld/.test(t09AfterDisposeText)}, shownAfterReload=${/Upheld/.test(t09ReloadedText)}, reopened=${t09Reopened.status} at=${t09Reopened.reopenedAt ?? 'null'}, dispositions=${t09Outcomes.join('|')}`
);

/* ------------------------------------------------------------------- T10 */
// The same CSV committed twice through the interface must not create a second case. On the repeat the
// interface reports the row as a duplicate, and the commit control is disabled because nothing is left
// to import — which is the behaviour under test.
const csv = [
  'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact',
  `${singleBureau.permanentId},,2026-09-20,M7 interface register,T10-UI/${stamp},Fee / refund,Synthetic T10 fixture imported twice through the interface to prove the repeat creates no second case.,,DEMO-POL-30,`,
].join('\n');
const previewImport = async () => {
  await page.goto(`${BASE}/#/import`);
  await page.waitForTimeout(1500);
  await page.fill('input >> nth=0', 'M7 interface register').catch(() => {});
  await page.fill('textarea', csv);
  await page.click('button:has-text("Validate and preview")');
  await page.waitForTimeout(2500);
  return text(page);
};
await previewImport();
await page.click('button:has-text("Commit")');
await page.waitForTimeout(3000);
const t10First = await text(page);
const t10Second = await previewImport();
const commitDisabled = await page.locator('button:has-text("Commit")').first().isDisabled().catch(() => false);
const importedOnce = (await getJson(`/cases?q=T10-UI/${stamp}`, people.pgrcLead.token)).cases ?? [];
check(
  'T10',
  'Committing the same import twice creates one case and reports the repeat (interface)',
  /Accepted 1|accepted 1/.test(t10First) && /accepted 0/.test(t10Second) && commitDisabled && importedOnce.length === 1,
  `first commit accepted=1 (${/Accepted 1/.test(t10First)}), repeat preview accepted 0 (${/accepted 0/.test(t10Second)}), commit disabled (${commitDisabled}), cases with that reference=${importedOnce.length}`
);

/* ------------------------------------------------------------------- T11 */
// Two editors save the same version: the second one is told the case changed and keeps its draft.
await switchTo(page, 'm.nair');
await page.goto(`${BASE}/#/cases/${t09Case.id}`);
await page.waitForTimeout(1800);
const pageB = await newPage();
await signIn(pageB, 'm.nair');
await pageB.goto(`${BASE}/#/cases/${t09Case.id}`);
await pageB.waitForTimeout(1800);
// Editor B saves first…
await pageB.fill('textarea', 'T11 interface check: editor B saves first.');
await pageB.click('button:has-text("Save action")');
await pageB.waitForTimeout(2200);
// …then editor A, whose screen still shows the earlier version, tries to save.
await page.fill('textarea', 'T11 interface check: editor A typed this before B saved.');
await page.click('button:has-text("Save action")');
await page.waitForTimeout(2500);
const t11Conflict = await text(page);
const draftKept = await page.locator('textarea').first().inputValue();
check(
  'T11',
  'The second editor is told the case changed and the typed draft is kept (interface)',
  /changed since you opened it|stale|conflict/i.test(t11Conflict) && draftKept.includes('editor A typed this'),
  `conflict message=${/changed since you opened it/i.test(t11Conflict)}, draft kept=${draftKept.includes('editor A typed this')}`
);

/* ------------------------------------------------------------------- T12 */
// Failure injection is administrator-only and opt-in. The write must fail, and the case must be unchanged
// on screen after a reload — no half-applied state.
const injected = await postStatus('/system/inject-audit-failure', people.admin.token, { on: true });
if (injected !== 200) {
  skip('T12', 'An injected failure rolls back the write and the interface shows no change', `fault injection is closed on this instance (HTTP ${injected}); start it with CASELINK_TEST_HOOKS=true`);
} else {
  expectedFailureWindow = true;
  await pageB.reload();
  await pageB.waitForTimeout(1800);
  await pageB.fill('textarea', 'T12 interface check: this save must fail and change nothing.');
  await pageB.click('button:has-text("Save action")');
  await pageB.waitForTimeout(2500);
  const t12AfterFailure = await text(pageB);
  await pageB.reload();
  await pageB.waitForTimeout(2000);
  const t12Reloaded = await text(pageB);
  const detail = (await getJson(`/cases/${t09Case.id}`, people.pgrcLead.token)).history ?? [];
  const halfWritten = detail.some((h) => String(h.remarks ?? '').includes('T12 interface check'));
  expectedFailureWindow = false;
  await postStatus('/system/inject-audit-failure', people.admin.token, { on: false });
  check(
    'T12',
    'An injected failure rolls back the write and the interface shows no change',
    /could not|failed|error/i.test(t12AfterFailure) && !t12Reloaded.includes('T12 interface check') && !halfWritten,
    `error shown=${/could not|failed|error/i.test(t12AfterFailure)}, nothing persisted=${!halfWritten}`
  );
}

check(
  'S09',
  'No uncaught browser exceptions, and no console error beyond the deliberate rejection and the injected fault',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | ') ||
    `none (${expectedApiFailures.length} expected rejected request(s) logged by the browser)`
);

await browser.close();
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nexecuted: ${results.length}   passed: ${passed}   failed: ${failed}   skipped: ${skips.length}`);
for (const s of skips) console.log(`skipped: ${s.id} ${s.name} — ${s.why}`);
console.log(failed === 0 ? 'M7 interface acceptance T01–T12: PASS' : 'M7 interface acceptance T01–T12: FAIL');
process.exit(failed === 0 ? 0 : 1);
