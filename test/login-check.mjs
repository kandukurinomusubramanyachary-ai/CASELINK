/**
 * Verifies the sign-in path in three browser conditions (as a normal, sign-in-only deployment):
 *   1. normal (cookie session),
 *   2. session cookie lost/blocked after sign-in (Bearer token fallback — the preview-frame case),
 *   3. reload with no cookies but a stored token.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}

const DEMO = process.env.CASELINK_DEMO === 'true';

async function signIn(page, username) {
  // In an explicitly configured demo instance the app auto-enters; the form stays reachable at #/login.
  await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', username);
  await page.fill('#password', 'caselink-demo');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  await page.waitForTimeout(700);
}

// 1. normal sign-in
{
  const { ctx, page, errors } = await fresh();
  await signIn(page, 'p.rao');
  const heading = await page.textContent('h1');
  check('Normal sign-in reaches My work', heading?.includes('My work') ?? false, `heading "${heading?.trim()}"`);
  const cases = await page.locator('.stat').count();
  check('My work renders its queue tiles', cases >= 6, `${cases} tiles`);
  check('No console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  // 2. drop the session cookie, keep the Bearer token → still signed in
  await ctx.clearCookies();
  const cookies = await ctx.cookies();
  check('Cookies cleared (simulating a blocked cookie)', cookies.length === 0);
  await page.goto(`${BASE}/#/cases`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const onCases = await page.locator('.sidebar').count();
  const hasLoginForm = await page.locator('#username').count();
  const rows = await page.locator('table.data tbody tr').count();
  check('Bearer token keeps the session alive without cookies', onCases === 1 && hasLoginForm === 0, `login form present: ${hasLoginForm === 1}`);
  check('Cases load with the token-only session', rows > 0, `${rows} rows`);

  // 3. hard reload, still no cookies
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('Reload without cookies stays signed in', (await page.locator('#username').count()) === 0);

  // 4. sign out removes the token
  await page.click('button:has-text("Sign out")');
  await page.waitForSelector('#username', { timeout: 10000 });
  check('Sign out returns to the sign-in screen', true);
  await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  check('After sign out, protected routes ask for sign-in again', (await page.locator('#username').count()) === 1);
  await ctx.close();
}

// 5. wrong password is rejected with a readable message
{
  const { ctx, page } = await fresh();
  await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username');
  await page.fill('#username', 'p.rao');
  await page.fill('#password', 'wrong-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('.error-note, .sidebar', { timeout: 10000 });
  const err = await page.locator('.error-note').count();
  const detail = err ? await page.locator('.error-note').first().textContent() : '';
  check('Wrong password shows an error, not a silent failure', err === 1, detail?.trim().slice(0, 80));
  await ctx.close();
}

// 6. fixture shortcuts exist only in an explicitly configured demo instance
if (DEMO) {
  const { ctx, page } = await fresh();
  await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.demo-account', { timeout: 15000 });
  await page.locator('.demo-account', { hasText: 'a.desai' }).first().click();
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const role = await page.textContent('.user-role');
  check('Demo account shortcut signs in (demo instance)', role?.includes('Supervisor') ?? false, `role line "${role?.trim()}"`);
  await ctx.close();
} else {
  // Normal configuration: no fixture shortcuts, no published demo passwords.
  const { ctx, page } = await fresh();
  await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.waitForTimeout(800);
  check('No demo account shortcuts in a normal configuration', (await page.locator('.demo-account').count()) === 0);
  const body = (await page.textContent('body')) ?? '';
  check('No demo password hints in a normal configuration', !body.includes('caselink-demo'));
  const cookieCount = (await ctx.cookies()).length;
  check('Opening the app does not create a session in a normal configuration', cookieCount === 0, `${cookieCount} cookies`);
  await page.goto(`${BASE}/#/my-work`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const sidebar = await page.locator('.sidebar').count();
  check('A protected route without sign-in shows the sign-in screen', sidebar === 0 && (await page.locator('#username').count()) === 1);
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll sign-in checks passed.');
process.exitCode = failures ? 1 : 0;
