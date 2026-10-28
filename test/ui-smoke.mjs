import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const shots = 'docs/screenshots';
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

async function shot(name, extraWait = 400) {
  await page.waitForTimeout(extraWait);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
  console.log('captured', name);
}

async function login(username) {
  await page.goto(`${BASE}/#/my-work`);
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', username);
  await page.fill('#password', 'caselink-demo');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  await page.waitForTimeout(700);
}

async function signOut() {
  await page.click('button:has-text("Sign out")');
  await page.waitForSelector('#username', { timeout: 15000 });
}

/* ---------------------------------------------------------------- bureau lead */
await login('m.nair');
await shot('01-my-work');
await page.goto(`${BASE}/#/institutions`);
await page.waitForTimeout(800);
await shot('02-institutions');
await page.click('.card table.data tbody tr:first-child a.cell-strong');
await page.waitForTimeout(1000);
await shot('03-institution-profile');

await page.goto(`${BASE}/#/cases`);
await page.waitForTimeout(900);
await shot('06-cases');

// case workspace on an active case this lead may act on, then save an action
await page.goto(`${BASE}/#/my-work`);
await page.waitForTimeout(1000);
await page.click('.card:has-text("Unassigned in your scope") table.data tbody tr:first-child a.case-number');
await page.waitForTimeout(1000);
await shot('07-case-workspace', 600);
const actionCard = page.locator('.card:has-text("Record an action")').first();
if (await actionCard.count()) {
  await actionCard
    .locator('textarea')
    .first()
    .fill('Owner contacted the institute nodal officer and requested the dispatch register extract.');
  await actionCard.locator('button:has-text("Save action")').click();
  await page.waitForSelector('.toast-success, .error-note', { timeout: 10000 });
  console.log('action save:', (await page.locator('.toast-success').count()) ? 'saved' : 'rejected');
  await shot('07b-action-saved', 800);
}

// coordination + relationship review modal
await page.goto(`${BASE}/#/coordination`);
await page.waitForTimeout(1100);
await shot('04-coordination', 800);
const reviewBtn = page.locator('.evidence-card button', { hasText: 'Review' }).first();
if (await reviewBtn.count()) {
  await reviewBtn.click();
  await page.waitForSelector('.modal', { timeout: 8000 });
  await page.waitForTimeout(500);
  await shot('05-relationship-review');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

await page.goto(`${BASE}/#/reports`);
await page.waitForTimeout(1000);
await shot('08-reports');
await page.goto(`${BASE}/#/alerts`);
await page.waitForTimeout(1000);
await shot('09-alerts');

await page.goto(`${BASE}/#/import`);
await page.waitForTimeout(700);
await page.click('button:has-text("Load sample rows")');
await page.waitForTimeout(200);
await page.click('button:has-text("Validate and preview")');
await page.waitForSelector('.import-rows', { timeout: 10000 });
await page.waitForTimeout(500);
await shot('10-import');

await page.goto(`${BASE}/#/settings`);
await page.waitForTimeout(900);
await shot('11-settings');

/* ------------------------------------------------------------------ supervisor */
await signOut();
await login('a.desai');
await page.goto(`${BASE}/#/coordination`);
await page.waitForTimeout(1200);
await shot('12-coordination-supervisor', 900);
const supReview = page.locator('.evidence-card button', { hasText: 'Review' }).first();
if (await supReview.count()) {
  await supReview.click();
  await page.waitForSelector('.modal', { timeout: 8000 });
  await page.waitForTimeout(500);
  await shot('12b-supervisor-review');
  await page.keyboard.press('Escape');
}

/* --------------------------------------------------------------------- officer */
await signOut();
await login('p.rao');
await page.goto(`${BASE}/#/coordination`);
await page.waitForTimeout(1100);
const restrictedLink = page.locator('.coord-case-list li:has(.pill-violet) a.case-number').first();
const restrictedHref = (await restrictedLink.count()) ? await restrictedLink.getAttribute('href') : null;
if (restrictedHref) {
  await page.goto(`${BASE}/#${restrictedHref.replace(/^#/, '')}`);
  await page.waitForTimeout(1200);
  await shot('15-restricted-case');
}

/* ------------------------------------------------------------------- read-only */
await signOut();
await login('r.khan');
await page.goto(`${BASE}/#/cases`);
await page.waitForTimeout(1200);
await shot('16-reviewer-scope');

/* ---------------------------------------------------------------------- mobile */
await page.setViewportSize({ width: 430, height: 900 });
await page.goto(`${BASE}/#/my-work`);
await page.waitForTimeout(1000);
await shot('13-mobile-my-work');
await page.goto(`${BASE}/#/cases`);
await page.waitForTimeout(900);
await shot('13b-mobile-cases');
await page.setViewportSize({ width: 1440, height: 950 });

/* ------------------------------------------------------------- narrow desktop */
await signOut();
await login('m.nair');
await page.setViewportSize({ width: 900, height: 900 });
await page.goto(`${BASE}/#/my-work`);
await page.waitForTimeout(900);
await shot('14-narrow-desktop');
await page.setViewportSize({ width: 1440, height: 950 });

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log(' -', e);
await browser.close();
process.exitCode = errors.length ? 1 : 0;
