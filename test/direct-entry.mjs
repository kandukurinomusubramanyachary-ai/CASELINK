/**
 * Verifies the direct-entry demo flow: no sign-in step, working role switcher, login page still reachable.
 * Runs ONLY against an instance started with CASELINK_DEMO=true — the default deployment requires sign-in.
 */
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
if (process.env.CASELINK_DEMO !== 'true') {
  console.error('Direct-entry checks require an instance started with CASELINK_DEMO=true.');
  process.exit(2);
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  —  ${d}` : ''}`); if (!ok) failures += 1; };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// 1. opening the app goes straight to My work, no login form
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar', { timeout: 15000 });
await page.waitForTimeout(900);
check('Opening the app lands directly in the workspace', (await page.locator('#username').count()) === 0);
check('Default page is My work', (await page.textContent('h1'))?.includes('My work') ?? false);
const roleLine = await page.textContent('.user-role');
check('Signed in as the bureau lead by default', roleLine?.includes('Bureau lead') ?? false, roleLine?.trim());

// 2. role switcher in the header
const switcher = page.locator('.switcher select');
check('Account switcher is present in the header', (await switcher.count()) === 1);
await switcher.selectOption('a.desai');
await page.waitForTimeout(2500);
const afterSwitch = await page.textContent('.user-role');
check('Switching account changes the session', afterSwitch?.includes('Supervisor') ?? false, afterSwitch?.trim());

// 3. deep link with ?as= chooses an account
await page.goto(`${BASE}/?as=p.rao#/cases`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sidebar', { timeout: 15000 });
await page.waitForTimeout(2000);
const asOfficer = await page.textContent('.user-name');
const asOfficerRole = await page.textContent('.user-role');
check(
  '?as=p.rao enters as that account',
  (asOfficer?.includes('Priya Rao') ?? false) && (asOfficerRole?.includes('Bureau officer') ?? false),
  `${asOfficer?.trim()} · ${asOfficerRole?.trim()}`
);
const rows = await page.locator('table.data tbody tr').count();
check('Cases screen still loads for the chosen account', rows > 0, `${rows} rows`);

// 4. sign out goes to the login page and stays signed out in this tab
await page.click('button:has-text("Sign out")');
await page.waitForSelector('#username', { timeout: 10000 });
check('Sign out shows the login page', true);
await page.goto(`${BASE}/#/cases`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
check('After sign out, a protected route asks for sign-in', (await page.locator('#username').count()) === 1);

// 5. the login page offers one-click direct entry
const direct = page.locator('button:has-text("Enter the demo workspace directly")');
check('Login page offers a direct-entry button', (await direct.count()) === 1);
await direct.click();
await page.waitForSelector('.sidebar', { timeout: 15000 });
await page.waitForTimeout(1800);
check(
  'Direct-entry button opens the workspace',
  ((await page.textContent('h1')) ?? '').includes('My work') || (await page.locator('.stat').count()) >= 6,
  `heading "${((await page.textContent('h1')) ?? '').trim()}"`
);

// 6. #/login is always reachable on demand
await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
check('#/login shows the sign-in page even with a session', (await page.locator('#username').count()) === 1);

check('No console or page errors during the flow', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll direct-entry checks passed.');
process.exitCode = failures ? 1 : 0;
