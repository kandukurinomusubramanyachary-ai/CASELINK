import { chromium } from 'playwright';
const browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {});
let failures = 0;
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ colorScheme: theme });
    const page = await context.newPage();
    await page.goto('http://localhost:8080/#/login'); await page.locator('#username').waitFor();
    await page.locator('#username').fill('m.nair'); await page.locator('#password').fill('caselink-demo'); await page.locator('button[type="submit"]').click(); await page.locator('.stat').first().waitFor();
    for (const route of ['my-work', 'cases', 'settings']) {
      await page.goto(`http://localhost:8080/#/${route}`); await page.locator('main h1').waitFor();
      const ratios = await page.evaluate(() => {
        const rgb = value => value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        const lum = value => { const c = rgb(value).map(channel => { const v = channel / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
        return ['body', '.page-sub', '.nav-item-active', '.btn-primary', '.pill-red', '.pill-amber', '.pill-green', '.field-label', 'input', '.card-sub'].flatMap(selector => {
          const element = document.querySelector(selector); if (!element) return [];
          let parent = element; let bg;
          while (parent) { const value = getComputedStyle(parent).backgroundColor; if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') { bg = value; break; } parent = parent.parentElement; }
          const foreground = lum(getComputedStyle(element).color), background = lum(bg ?? 'rgb(255,255,255)');
          return [{ selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) }];
        });
      });
      for (const result of ratios) { const ok = result.ratio >= 4.5; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${theme} /${route} ${result.selector}: ${result.ratio.toFixed(2)}:1`); }
    }
    await context.close();
  }
} finally { await browser.close(); }
console.log(failures ? `${failures} contrast checks failed.` : 'All measured text and status contrasts meet 4.5:1.');
process.exitCode = failures ? 1 : 0;
