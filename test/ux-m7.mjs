/**
 * M7 interface-quality checks (U01–U10) — the non-scenario half of browser acceptance.
 *
 *   BASE=http://127.0.0.1:8082 node test/ux-m7.mjs
 *
 * `test/acceptance-ui.mjs` proves the twelve acceptance scenarios on screen. This suite proves the
 * qualities the PRD asks for around them: keyboard operation, narrow screens, labelled controls,
 * empty and error states, filters that survive opening a record, cached state that is cleared by
 * sign-out and account switching, and a default startup that refuses to show data to an anonymous
 * visitor.
 *
 * Every check states what it observed. A check that cannot be executed is reported as skipped with the
 * reason, never as a pass.
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
const text = (page) => page.evaluate(() => document.body.innerText);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const consoleErrors = [];
const expectedApiFailures = [];
let expectedFailureWindow = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/status of (401|403|404|409|422)/.test(t) || (expectedFailureWindow && /status of 500/.test(t))) expectedApiFailures.push(t);
  else consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

async function signIn(username, password = PASSWORD) {
  await page.goto(`${BASE}/#/login`);
  await page.waitForSelector('#username', { timeout: 20_000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('button:has-text("Sign out")', { timeout: 20_000 });
  await page.waitForTimeout(1200);
}

async function signOut() {
  await page.keyboard.press('Escape').catch(() => {});
  const out = page.locator('button:has-text("Sign out")');
  if (await out.count()) {
    await out.first().click();
    await page.waitForSelector('#username', { timeout: 20_000 });
  }
}

/* ------------------------------------------------------- U01 labelled sign-in */
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#username', { timeout: 20_000 });
const labels = await page.evaluate(() => {
  const labelled = (id) => {
    const el = document.getElementById(id);
    if (!el) return 'missing';
    const explicit = document.querySelector(`label[for="${id}"]`);
    const aria = el.getAttribute('aria-label');
    return explicit ? explicit.textContent?.trim() ?? '' : aria ?? '';
  };
  return { username: labelled('username'), password: labelled('password') };
});
check(
  'U01',
  'Sign-in fields carry visible labels, and a wrong password is refused with a message',
  /username/i.test(labels.username) && /password/i.test(labels.password),
  `username label="${labels.username}", password label="${labels.password}"`
);
await page.fill('#username', 'm.nair');
await page.fill('#password', 'not-the-password');
await page.click('button[type=submit]');
await page.waitForTimeout(1500);
const wrongPasswordBody = await text(page);
check(
  'U02',
  'A refused sign-in shows an error and keeps the visitor on the form',
  /invalid|incorrect|failed|not recognised|unauthor/i.test(wrongPasswordBody) && (await page.locator('#username').count()) === 1,
  /invalid|incorrect|failed/i.test(wrongPasswordBody) ? 'error message shown, form still present' : 'no error message'
);

/* --------------------------------------------- U03 anonymous startup is closed */
{
  const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/#/my-work`);
  await anonPage.waitForTimeout(2500);
  const body = await anonPage.evaluate(() => document.body.innerText);
  const apiStatus = await anonPage.evaluate(async (base) => {
    const res = await fetch(`${base}/api/cases`, { credentials: 'omit' });
    return res.status;
  }, BASE);
  const showsSignIn = /sign in/i.test(body);
  const leaksCases = /PGRC-2026-/.test(body);
  check(
    'U03',
    'A fresh browser reaches only the sign-in screen, and the API refuses the anonymous read',
    showsSignIn && !leaksCases && apiStatus === 401,
    `sign-in shown=${showsSignIn}, case numbers visible=${leaksCases}, GET /api/cases without a session=${apiStatus}`
  );
  // Header links and theme controls precede the form. Both fields must remain reachable in order.
  const focused = [];
  for (let i = 0; i < 12; i++) {
    await anonPage.keyboard.press('Tab');
    focused.push(await anonPage.evaluate(() => document.activeElement?.id ?? ''));
    if (focused.at(-1) === 'password') break;
  }
  const usernameIndex = focused.indexOf('username');
  check(
    'U04',
    'The sign-in screen is operable from the keyboard alone (Tab reaches both fields, in order)',
    usernameIndex >= 0 && focused.indexOf('password') === usernameIndex + 1,
    `tab order: ${focused.filter(Boolean).join(' → ')}`
  );
  await anon.close();
}

/* ----------------------------------------------------------- U05 keyboard nav */
await signIn('m.nair');
await page.goto(`${BASE}/#/my-work`);
await page.waitForTimeout(1500);
const navFocus = await page.evaluate(async () => {
  const nav = document.querySelector('nav[aria-label="Primary"]');
  const link = nav ? Array.from(nav.querySelectorAll('a')).find((a) => /coordination/i.test(a.textContent ?? '')) : null;
  if (!link) return 'no coordination link';
  link.focus();
  return document.activeElement === link ? 'focused' : 'not focused';
});
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
const afterEnter = await page.evaluate(() => window.location.hash);
check(
  'U05',
  'The main navigation can be driven with the keyboard (focus a nav link, press Enter)',
  navFocus === 'focused' && /coordination/.test(afterEnter),
  `nav link ${navFocus}, hash after Enter=${afterEnter}`
);
// Escape must close a dialog and leave the page usable.
const reviewButton = page.locator('.evidence-card button:has-text("Review")').first();
if (await reviewButton.count()) {
  await reviewButton.click();
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const dialogGone = !(await page.getByRole('dialog').isVisible());
  check('U06', 'Escape closes a review dialog and the screen stays usable', dialogGone, `dialog closed=${dialogGone}`);
} else {
  skip('U06', 'Escape closes a review dialog and the screen stays usable', 'no reviewable suggestion is offered to this account on this database');
}

/* ------------------------------------------------------------ U07 filters kept */
await page.goto(`${BASE}/#/cases`);
await page.waitForTimeout(1800);
const filterState = await page.evaluate(() => {
  const input = document.querySelector('input[type="search"], input[placeholder*="Search" i], input#q');
  return input ? 'present' : 'absent';
});
let filtersPreserved = false;
let filterDetail = `search field ${filterState}`;
if (filterState === 'present') {
  const term = 'PGRC-2026';
  await page.fill('input[type="search"], input[placeholder*="Search" i], input#q', term);
  await page.waitForTimeout(2000);
  const beforeNav = await page.evaluate(() => window.location.hash);
  const rowLink = page.locator('a[href*="#/cases/"]').first();
  const rows = await rowLink.count();
  if (rows) {
    await rowLink.click();
    await page.waitForTimeout(1800);
    await page.click('.crumb a:has-text("Cases")');
    await page.waitForTimeout(2000);
    const afterNav = await page.evaluate(() => window.location.hash);
    const valueAfter = await page.inputValue('input[type="search"], input[placeholder*="Search" i], input#q');
    filtersPreserved = afterNav === beforeNav && valueAfter === term;
    filterDetail = `filter hash before=${beforeNav}, after=${afterNav}, value after=${valueAfter}`;
  } else {
    filterDetail = 'no case row was listed for this filter, so the round trip could not be exercised';
  }
}
check('U07', 'Opening a case and returning keeps the list filters', filtersPreserved, filterDetail);

/* -------------------------------------------------------- U08 empty and error */
await page.goto(`${BASE}/#/cases?q=zzz-nothing-matches-this`);
await page.waitForTimeout(2000);
const emptyBody = await text(page);
check(
  'U08',
  'A filter with no matches shows an empty state instead of a blank screen',
  /No results for these filters/i.test(emptyBody),
  /No results for these filters/i.test(emptyBody) ? 'empty state shown' : 'no empty state'
);
await page.goto(`${BASE}/#/cases/00000000-0000-4000-8000-000000000000`);
await page.waitForTimeout(2000);
const badCaseBody = await text(page);
check(
  'U09',
  'A case that does not exist (or is out of scope) shows a handled error, not a crash',
  /not found|access denied|no longer|permission/i.test(badCaseBody) && !/Something went wrong/i.test(badCaseBody),
  /not found/i.test(badCaseBody) ? 'not-found message shown' : /access denied/i.test(badCaseBody) ? 'access-denied message shown' : 'neither message present'
);

/* ------------------------------------------------ U10 sign-out clears the session */
await page.goto(`${BASE}/#/my-work`);
await page.waitForTimeout(1800);
const cachedBefore = /PGRC-2026-/.test(await text(page));
await signOut();
const afterSignOutBody = await text(page);
await page.goBack().catch(() => {});
await page.waitForTimeout(1800);
const afterBackBody = await text(page);
await page.reload();
await page.waitForTimeout(1800);
const afterReloadBody = await text(page);
const tokenAfter = await page.evaluate(() => {
  const keys = Object.keys(localStorage);
  return keys.filter((k) => /token|session|auth/i.test(k)).map((k) => `${k}=${String(localStorage.getItem(k)).slice(0, 12)}`);
});
check(
  'U10',
  'Signing out clears cached records, and Back or Reload does not restore them',
  cachedBefore &&
    /sign in/i.test(afterSignOutBody) &&
    !/PGRC-2026-/.test(afterSignOutBody) &&
    !/PGRC-2026-/.test(afterBackBody) &&
    !/PGRC-2026-/.test(afterReloadBody) &&
    tokenAfter.every((k) => !/=ey/.test(k)),
  `records before sign-out=${cachedBefore}, sign-in screen after sign-out=${/sign in/i.test(afterSignOutBody)}, records after Back=${/PGRC-2026-/.test(afterBackBody)}, after Reload=${/PGRC-2026-/.test(afterReloadBody)}, stored auth keys=[${tokenAfter.join(', ')}]`
);

/* ------------------------------------------------- U11 account switch is clean */
// Account switching must drop the previous account's *content*. A case number may legitimately remain
// visible when the new account holds coordination metadata for a shared institution (that is the PRD's
// deliberate cross-bureau coordination rule), so this check uses a case the new account has no
// visibility into at all, and asserts that both the record and its complaint text are gone.
{
  const API = BASE;
  const tokenOf = async (username) =>
    (
      await (
        await fetch(`${API}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: PASSWORD }),
        })
      ).json()
    ).token;
  const leadToken = await tokenOf('m.nair');
  const rbToken = await tokenOf('l.verma');
  const institutions = (await (await fetch(`${API}/api/institutions?q=`, { headers: { authorization: `Bearer ${leadToken}` } })).json())
    ?.institutions ?? [];
  // An institution with no RB case at all: nothing ties the RB lead to it.
  const rbInstitutions = new Set(
    (await (await fetch(`${API}/api/institutions?q=`, { headers: { authorization: `Bearer ${rbToken}` } })).json())?.institutions?.map((i) => i.id) ?? []
  );
  const isolated = institutions.find((i) => !rbInstitutions.has(i.id)) ?? institutions[0];
  const marker = `U11 private PGRC complaint ${Date.now()}`;
  const created = await (
    await fetch(`${API}/api/cases`, {
      method: 'POST',
      headers: { authorization: `Bearer ${leadToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        institutionId: isolated.id,
        receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
        sourceChannel: 'Email',
        sourceReference: `U11-UI-${Date.now()}`,
        category: 'Other',
        complaintSummary: `${marker}: this text belongs to the PGRC bureau only.`,
        deadlinePolicyId: 'DEMO-POL-30',
      }),
    })
  ).json();

  await signIn('m.nair');
  await page.goto(`${BASE}/#/cases/${created.id}`);
  await page.waitForTimeout(2000);
  const beforeSwitch = await text(page);
  const rbResponse = await fetch(`${API}/api/cases/${created.id}`, { headers: { authorization: `Bearer ${rbToken}` } });
  const rbView = rbResponse.status === 200 ? await rbResponse.json() : null;
  // Coordination metadata for a shared institution is deliberately visible across bureaus; complaint
  // content is not. The check therefore asserts content, not the case number.
  const rbCanReadContent = rbView?.canViewContent === true;

  await signOut();
  await signIn('l.verma');
  await page.goto(`${BASE}/#/cases/${created.id}`);
  await page.waitForTimeout(2000);
  const afterSwitch = await text(page);
  check(
    'U11',
    'Switching account drops the previous account’s record and complaint text',
    beforeSwitch.includes(marker) && !rbCanReadContent && !afterSwitch.includes(marker),
    `marker before=${beforeSwitch.includes(marker)}, RB content access=${rbCanReadContent}, marker after=${afterSwitch.includes(marker)} (coordination metadata may remain visible by design)`
  );
}

/* -------------------------------------------------------- U12 narrow screens */
await page.setViewportSize({ width: 390, height: 844 });
const narrowRoutes = ['/my-work', '/cases', '/coordination', '/reports'];
const overflow = [];
for (const route of narrowRoutes) {
  await page.goto(`${BASE}/#${route}`);
  await page.waitForTimeout(1800);
  const dims = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  overflow.push(`${route} ${dims.scroll}/${dims.inner}`);
}
await page.setViewportSize({ width: 1440, height: 950 });
const worst = Math.max(...overflow.map((o) => Number(o.split(' ')[1].split('/')[0]) - Number(o.split(' ')[1].split('/')[1])));
check(
  'U12',
  'At 390 px wide the main screens do not scroll sideways',
  worst <= 2,
  `${overflow.join(', ')} (worst overflow ${worst}px)`
);

/* --------------------------------------- U14 a note keeps the stored next action */
// The ordinary note form used to submit an empty next step, which cleared the stored next action on save
// (M7/A18). The check drives the real form and reads the stored value back through the API.
{
  const API = BASE;
  const login = async (username) => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    return (await res.json()).token;
  };
  const token = await login('m.nair');
  const call = async (p, init = {}) => {
    const res = await fetch(`${API}/api${p}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const institutions = (await call('/institutions?q=')).data?.institutions ?? [];
  const inst = institutions.find((i) => i.region === 'South') ?? institutions[0];
  const created = await call('/cases', {
    method: 'POST',
    body: JSON.stringify({
      institutionId: inst.id,
      receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
      sourceChannel: 'Email',
      sourceReference: `U14-UI-${Date.now()}`,
      category: 'Other',
      complaintSummary: 'U14 fixture: an ordinary note must not erase the stored next action.',
      deadlinePolicyId: 'DEMO-POL-30',
      nextAction: 'Keep the scheduled follow-up already recorded.',
    }),
  });
  if (created.status !== 201) {
    skip('U14 an ordinary note keeps the stored next action', `fixture creation failed (HTTP ${created.status})`);
  } else {
    await page.goto(`${BASE}/#/login`);
    await page.waitForSelector('#username', { timeout: 20_000 });
    await signIn('m.nair');
    await page.goto(`${BASE}/#/cases/${created.data.id}`);
    await page.waitForTimeout(2000);
    const card = page.locator('.card', { hasText: 'Record an action' }).first();
    const prefilled = await card.locator('input').first().inputValue();
    await card.locator('textarea').fill('U14 interface check: an ordinary note with the next step left untouched.');
    await card.locator('button:has-text("Save action")').click();
    await page.waitForTimeout(2500);
    const stored = (await call(`/cases/${created.data.id}`)).data?.case;
    check(
      'U14',
      'An ordinary note leaves the stored next action intact, and the field shows it',
      prefilled === 'Keep the scheduled follow-up already recorded.' && stored?.nextAction === 'Keep the scheduled follow-up already recorded.',
      `prefilled=${JSON.stringify(prefilled)} stored=${JSON.stringify(stored?.nextAction)}`
    );
  }
}

/* ------------------------------------------------ U15 an expired session clears the screen */
// Expiring the session server-side and then using the workspace must drop the rendered record and show
// the sign-in form (M7/A19).
{
  const API = BASE;
  const token = await (async () => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'm.nair', password: PASSWORD }),
    });
    return (await res.json()).token;
  })();
  const headers = { authorization: `Bearer ${token}` };
  const institutions = (await (await fetch(`${API}/api/institutions?q=`, { headers })).json())?.institutions ?? [];
  const inst = institutions.find((i) => i.region === 'South') ?? institutions[0];
  const marker = `U15 private complaint marker ${Date.now()}`;
  const created = await (
    await fetch(`${API}/api/cases`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        institutionId: inst.id,
        receivedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
        sourceChannel: 'Email',
        sourceReference: `U15-UI-${Date.now()}`,
        category: 'Other',
        complaintSummary: `${marker}: this text must not survive session expiry on screen.`,
        deadlinePolicyId: 'DEMO-POL-30',
      }),
    })
  ).json();
  await signIn('m.nair');
  await page.goto(`${BASE}/#/cases/${created.id}`);
  await page.waitForTimeout(2000);
  const visibleBefore = (await text(page)).includes(marker);

  // Expire every session of this account, then use the case Refresh control.
  const DB_PATH = process.env.CASELINK_DB;
  if (!DB_PATH) {
    skip('U15 an expired session clears the workspace', 'CASELINK_DB is not set, so the session cannot be expired');
  } else {
    const { default: Database } = await import('better-sqlite3');
    const fixture = new Database(DB_PATH);
    fixture
      .prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)')
      .run('m.nair');
    fixture.close();
    const refresh = page.locator('button:has-text("Refresh")').first();
    if (await refresh.count()) await refresh.click();
    else await page.reload();
    await page.waitForTimeout(3000);
    const bodyAfter = await text(page);
    const signInShown = (await page.locator('#username').count()) === 1;
    check(
      'U15',
      'An expired session returns the interface to sign-in and leaves no private record on screen',
      visibleBefore && !bodyAfter.includes(marker) && signInShown,
      `marker before=${visibleBefore}, after=${bodyAfter.includes(marker)}, sign-in form=${signInShown}`
    );
  }
}

/* -------------------------------------------------------------------- results */
expectedFailureWindow = false;
check(
  'U13',
  'No uncaught browser exception, and no console error beyond the deliberate refusals',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | ') || `none (${expectedApiFailures.length} expected refused request(s) logged by the browser)`
);

await context.close();
await browser.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\nexecuted: ${results.length}   passed: ${results.length - failed}   failed: ${failed}   skipped: ${skips.length}`);
console.log(failed === 0 ? 'M7 interface quality checks: PASS' : 'M7 interface quality checks: FAIL');
process.exit(failed === 0 ? 0 : 1);
