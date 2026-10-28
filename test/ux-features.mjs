import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const output = '.runtime/ux-qa';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {});
let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const waitTheme = (page, theme) => page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
async function signIn(page) { await page.locator('#username').fill('m.nair'); await page.locator('#password').fill('caselink-demo'); await page.locator('button[type="submit"]').click(); await page.locator('.topbar').waitFor(); await page.locator('.stat').first().waitFor(); }
async function themeChoice(page, value, mobile = false) {
  if (mobile) { await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('dialog', { name: 'Navigation', exact: true }).getByRole('button', { name: value[0].toUpperCase() + value.slice(1), exact: true }).click(); await page.keyboard.press('Escape'); }
  else await page.getByLabel('Theme preference', { exact: true }).selectOption(value);
  await waitTheme(page, value);
}
try {
  const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = []; const outsideRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(BASE).origin && request.url().startsWith('http')) outsideRequests.push(request.url()); });
  await page.goto(`${BASE}/#/login`); await page.locator('#username').waitFor();
  check('No-choice theme follows dark OS', await page.locator('html').getAttribute('data-theme') === 'dark');
  await page.evaluate(() => { window.themeNoReloadMarker = 42; });
  await page.getByLabel('Theme preference', { exact: true }).selectOption('light'); await waitTheme(page, 'light');
  check('Theme changes without reloading', await page.evaluate(() => window.themeNoReloadMarker === 42));
  await page.reload(); await page.locator('#username').waitFor();
  check('Explicit theme survives reload', await page.locator('html').getAttribute('data-theme') === 'light');
  await page.getByLabel('Theme preference', { exact: true }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'light' }); await waitTheme(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' }); await waitTheme(page, 'dark');
  check('System selection tracks OS changes', true);
  check('Password initially hidden', await page.locator('#password').getAttribute('type') === 'password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  check('Password show control works', await page.locator('#password').getAttribute('type') === 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await signIn(page);
  const firstCase = await page.locator('.case-number').first().getAttribute('href');
  for (const theme of ['dark', 'light']) {
    await themeChoice(page, theme);
    for (const route of ['my-work', 'institutions', 'cases', 'coordination', 'alerts', 'reports', 'import', 'settings']) {
      await page.goto(`${BASE}/#/${route}`); await page.locator('main h1').waitFor();
      await page.waitForTimeout(180);
      check(`${theme}: /${route} fits desktop`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (['my-work', 'cases', 'settings'].includes(route)) await page.screenshot({ path: `${output}/${theme}-${route}.png` });
    }
    await page.goto(`${BASE}/${firstCase}`); await page.getByRole('button', { name: 'Print evidence' }).waitFor();
    await page.screenshot({ path: `${output}/${theme}-evidence.png` });
    check(`${theme}: real case freshness displayed`, (await page.locator('.freshness').textContent()).includes('Last fetched'));
    await page.emulateMedia({ media: 'print' });
    check(`${theme}: print hides navigation`, await page.locator('.topbar').evaluate(element => getComputedStyle(element).display === 'none'));
    check(`${theme}: print contains authorized evidence`, await page.locator('.print-evidence').evaluate(element => getComputedStyle(element).display === 'block' && element.textContent.includes('Action history')));
    await page.emulateMedia({ media: 'screen' });
  }
  await page.getByRole('button', { name: 'Copy case ID', exact: true }).click();
  const caseId = page.url().split('/cases/')[1].split('?')[0];
  check('Clipboard matches displayed authorized case ID', await page.evaluate(() => navigator.clipboard.readText()) === caseId);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) } }));
  await page.getByRole('button', { name: 'Copy case ID', exact: true }).click();
  await page.getByText('Could not copy', { exact: true }).waitFor();
  check('Clipboard denial reports failure', (await page.getByRole('button', { name: 'Copy case ID', exact: true }).textContent()).includes('Copy case ID'));

  await page.keyboard.press('Control+k');
  let search = page.getByRole('dialog', { name: 'Search CaseLink' }); await search.waitFor();
  await page.locator('#global-search').fill('PGRC'); await page.locator('.search-result').first().waitFor();
  check('Search returns real case records', (await page.locator('.search-result').first().textContent()).includes('PGRC'));
  await page.locator('#global-search').fill('NO_MATCH_FOR_THIS_QUERY_8264');
  await page.getByText('No matching accessible records or help topics.', { exact: false }).waitFor();
  check('Search handles empty matches', true);
  await page.locator('#global-search').fill('tamper-proof'); await page.locator('.search-result').first().waitFor();
  await page.locator('#global-search').press('ArrowDown'); await page.locator('#global-search').press('Enter');
  await page.getByRole('dialog', { name: 'CaseLink help' }).waitFor();
  check('Keyboard search opens real help', true);
  await page.keyboard.press('Escape');
  await page.route('**/api/search?*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Unexpected backend response</h1>' }));
  await page.keyboard.press('Control+k'); await page.locator('#global-search').fill('PGRC');
  await page.getByText('The server returned an unexpected response. Please retry.', { exact: true }).waitFor();
  check('Unexpected search responses show retry and preserve query', await page.locator('#global-search').inputValue() === 'PGRC');
  await page.unroute('**/api/search?*'); await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.locator('.search-result').first().waitFor();
  check('Search recovers after retry', true); await page.keyboard.press('Escape');

  await page.goto(`${BASE}/#/cases`); await page.locator('.case-table').waitFor();
  await page.locator('.table-wrap').first().evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole('button', { name: 'Back to top', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to top', exact: true }).click();
  check('Back-to-top resets long table with reduced motion', await page.locator('.table-wrap').first().evaluate(element => element.scrollTop === 0));
  check('Table header is sticky', await page.locator('table.data th').first().evaluate(element => getComputedStyle(element).position === 'sticky'));
  await page.route('**/api/cases', route => route.request().method() === 'POST' ? route.abort('connectionrefused') : route.continue());
  await page.locator('.page-actions').getByRole('button', { name: 'Register a case' }).click();
  let dialog = page.getByRole('dialog', { name: 'Register a complaint case' });
  await dialog.getByLabel('Complaint summary', { exact: false }).fill('Preserve this unsaved draft');
  await dialog.getByRole('button', { name: 'Save case', exact: true }).click();
  await dialog.getByText('Cannot connect to the server.', { exact: false }).waitFor();
  check('Network errors preserve unsaved form input', await dialog.getByLabel('Complaint summary', { exact: false }).inputValue() === 'Preserve this unsaved draft');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  check('Keeping a draft preserves typed text', await dialog.getByLabel('Complaint summary', { exact: false }).inputValue() === 'Preserve this unsaved draft');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.unroute('**/api/cases');
  check('Nested discard dialogs restore scrolling', await page.evaluate(() => document.body.style.overflow !== 'hidden'));

  let releaseExport;
  const exportGate = new Promise(resolve => { releaseExport = resolve; });
  await page.route('**/api/reports/export*', async route => { await exportGate; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Temporarily unavailable"}' }); });
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await page.getByRole('button', { name: 'Preparing export…', exact: true }).waitFor();
  check('Export has a real pending state', true); releaseExport();
  await page.getByText('The file could not be prepared. Please retry;', { exact: false }).waitFor();
  check('Export errors are visible and recoverable', await page.getByRole('button', { name: 'Export CSV', exact: true }).isEnabled());
  await page.unroute('**/api/reports/export*');
  await page.getByRole('button', { name: 'Open help', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'CaseLink help' });
  await help.getByRole('button', { name: 'Close dialog' }).focus(); await page.keyboard.press('Tab');
  check('Help topics are reachable by keyboard', await page.evaluate(() => document.activeElement.tagName === 'SUMMARY'));
  await help.locator('summary').filter({ hasText: 'Cookies, local storage and privacy' }).click();
  check('Privacy explains real storage and lack of optional tracking', (await help.textContent()).includes('no optional analytics'));
  await page.keyboard.press('Escape');
  check('No third-party tracking requests', outsideRequests.length === 0);
  check('No browser runtime errors', errors.length === 0);
  await context.close();

  for (const width of [390, 320]) {
    const mobile = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    const phone = await mobile.newPage(); await phone.goto(`${BASE}/#/login`); await phone.locator('#username').waitFor(); await signIn(phone);
    for (const theme of ['dark', 'light']) {
      await themeChoice(phone, theme, true);
      for (const route of ['my-work', 'cases', 'reports', 'settings']) {
        await phone.goto(`${BASE}/#/${route}`); await phone.locator('main h1').waitFor();
        check(`${width}px ${theme}: /${route} fits`, await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await phone.screenshot({ path: `${output}/${width}-${theme}-${route}.png` });
      }
      await phone.getByRole('button', { name: 'Search CaseLink' }).click(); await phone.locator('#global-search').fill('triage'); await phone.locator('.search-result').first().waitFor();
      check(`${width}px ${theme}: search dialog fits`, await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await phone.screenshot({ path: `${output}/${width}-${theme}-search.png` }); await phone.keyboard.press('Escape');
    }
    await mobile.close();
  }
  const blocked = await browser.newContext({ colorScheme: 'dark' });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
  const blockedPage = await blocked.newPage(); await blockedPage.goto(`${BASE}/#/login`); await blockedPage.locator('#username').waitFor();
  await blockedPage.getByLabel('Theme preference', { exact: true }).selectOption('light'); await waitTheme(blockedPage, 'light');
  check('Theme still works when storage is unavailable', true); await blocked.close();
} finally { await browser.close(); }
console.log(failures ? `${failures} UX checks failed.` : 'All UX feature checks passed.');
process.exitCode = failures ? 1 : 0;
