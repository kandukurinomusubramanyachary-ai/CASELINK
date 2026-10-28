import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const output = process.env.SCREENSHOT_DIR ?? '.runtime/polish-qa';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {});
let failures = 0;
const check = (name, value) => { console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); if (!value) failures++; };

async function focusWraps(page, dialog) {
  await dialog.evaluate(root => {
    const controls = [...root.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(element => !element.disabled && element.getClientRects().length);
    controls.at(-1)?.focus();
  });
  await page.keyboard.press('Tab');
  return dialog.evaluate(root => {
    const controls = [...root.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(element => !element.disabled && element.getClientRects().length);
    return document.activeElement === controls[0];
  });
}

try {
  for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 }, compact: { width: 320, height: 740 } })) {
    const context = await browser.newContext({ viewport, reducedMotion: name === 'compact' ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.goto(`${BASE}/#/login`);
    await page.locator('#username').waitFor();
    await page.evaluate(() => document.fonts.ready);
    check(`${name}: sign-in page fits viewport`, !(await overflow()));
    if (name !== 'tablet') await page.screenshot({ path: `${output}/${name}-login.png` });
    await page.locator('#username').fill('m.nair');
    await page.locator('#password').fill('caselink-demo');
    await page.locator('button[type="submit"]').click();
    await page.locator('.topbar').waitFor();
    await page.locator('.queue-grid .stat').first().waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    check(`${name}: all six work queues present`, await page.locator('.queue-grid .stat').count() === 6);
    check(`${name}: dashboard fits viewport`, !(await overflow()));
    const firstCase = await page.locator('.case-table a.case-number').first().boundingBox();
    check(`${name}: a case is visible without scrolling`, firstCase?.y < viewport.height);
    await page.screenshot({ path: `${output}/${name}-work.png` });

    const bell = page.getByRole('button', { name: /^Notifications/ });
    await bell.click();
    const notifications = page.getByRole('dialog', { name: 'Recent notifications' });
    await notifications.waitFor();
    const bounds = await notifications.boundingBox();
    check(`${name}: notifications fit viewport`, bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
    await page.keyboard.press('Escape');
    await notifications.waitFor({ state: 'hidden' });
    check(`${name}: notification Escape restores focus`, await bell.evaluate(element => element === document.activeElement));

    if (viewport.width < 1024) {
      const menu = page.getByRole('button', { name: 'Open navigation' });
      await menu.click();
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
      await drawer.waitFor();
      check(`${name}: drawer includes all eight destinations`, await drawer.locator('nav a').count() === 8);
      check(`${name}: drawer traps keyboard focus`, await focusWraps(page, drawer));
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      check(`${name}: drawer Escape restores focus`, await menu.evaluate(element => element === document.activeElement));
      await menu.click();
      await page.getByRole('dialog', { name: 'Navigation', exact: true }).getByRole('link', { name: 'Cases', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
    } else {
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Cases', exact: true }).click();
    }
    await page.getByRole('heading', { name: 'Cases', exact: true, level: 1 }).waitFor();
    await page.locator('.case-table').waitFor();
    check(`${name}: case list fits viewport`, !(await overflow()));
    check(`${name}: additional filters initially collapsed`, !(await page.getByLabel('Region', { exact: true }).isVisible()));
    if (viewport.width < 768) check(`${name}: case rows adapt to phone`, await page.locator('.case-table tbody tr').first().evaluate(row => getComputedStyle(row).display === 'grid'));
    await page.screenshot({ path: `${output}/${name}-cases.png` });

    await page.getByRole('button', { name: /More filters/ }).click();
    await page.getByLabel('Received', { exact: true }).check();
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('status') === 'Received');
    await page.getByRole('button', { name: /Fewer filters/ }).click();
    check(`${name}: active filter remains visible when collapsed`, (await page.locator('.filter-summary').textContent()).includes('Received'));
    const filteredUrl = page.url();
    await page.goto(filteredUrl);
    await page.getByRole('button', { name: /More filters/ }).click();
    check(`${name}: URL filters survive reload`, await page.getByLabel('Received', { exact: true }).isChecked());
    await page.getByRole('button', { name: /Fewer filters/ }).click();

    const register = page.locator('.page-actions').getByRole('button', { name: 'Register a case' });
    await register.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Register a complaint case' });
    await dialog.waitFor();
    check(`${name}: keyboard-opened dialog has no animation`, await dialog.evaluate(element => element.getAnimations().length === 0));
    const field = dialog.locator('input').first();
    await field.fill('Test institution');
    await page.waitForTimeout(350);
    check(`${name}: typing does not reset dialog focus`, await field.evaluate(element => document.activeElement === element));
    check(`${name}: modal locks background scrolling`, await page.evaluate(() => document.body.style.overflow === 'hidden'));
    check(`${name}: modal traps keyboard focus`, await focusWraps(page, dialog));
    await page.screenshot({ path: `${output}/${name}-dialog.png` });
    await page.keyboard.press('Escape');
    const discard = page.getByRole('dialog', { name: 'Discard unsaved case?' });
    await discard.waitFor();
    check(`${name}: unsaved case asks before discarding`, await dialog.isVisible());
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    check(`${name}: keep editing preserves input`, await field.inputValue() === 'Test institution');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Discard unsaved case?' }).getByRole('button', { name: 'Discard draft' }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(`${name}: modal restores trigger focus`, await register.evaluate(element => document.activeElement === element));
    check(`${name}: background scrolling restored`, await page.evaluate(() => document.body.style.overflow !== 'hidden'));

    const routes = name === 'desktop' ? ['institutions', 'coordination', 'alerts', 'reports', 'import', 'settings'] : name === 'phone' ? ['coordination', 'reports', 'settings'] : [];
    for (const route of routes) {
      await page.goto(`${BASE}/#/${route}`);
      await page.locator('main h1').waitFor();
      await page.waitForTimeout(250);
      check(`${name}: /${route} fits viewport`, !(await overflow()));
      await page.screenshot({ path: `${output}/${name}-${route}.png` });
    }
    check(`${name}: no browser errors`, errors.length === 0);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} checks failed.` : 'All design and interaction checks passed.');
process.exitCode = failures ? 1 : 0;
