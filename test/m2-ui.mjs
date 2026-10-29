import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const OUT = process.env.CASELINK_SCREENSHOT_DIR ?? '.runtime/screenshots';
fs.mkdirSync(OUT,{recursive:true});
const browser = await chromium.launch({args:['--no-sandbox']});
const errors = [];
async function login(page) {
  await page.goto(BASE + '/#/login');
  await page.waitForSelector('#username',{timeout:15000});
  await page.fill('#username','m.nair');
  await page.fill('#password','caselink-demo');
  await page.click('button[type=submit]');
  await page.locator('#username').waitFor({state:'detached',timeout:15000});
}
async function capture(page,label) {
  await page.screenshot({path:OUT + '/' + label + '.png',fullPage:true});
}
try {
  const ctx = await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1});
  const page = await ctx.newPage();
  page.on('pageerror',(e)=>errors.push(String(e)));
  await login(page);
  await page.goto(BASE + '/#/overlaps');
  await page.getByRole('heading',{name:'Intelligent overlap detection'}).waitFor({timeout:12000});
  await page.locator('.m2-table').waitFor({timeout:12000});
  await capture(page,'m2-01-queue');
  await page.getByRole('button',{name:'All candidates'}).click();
  await page.locator('select[aria-label="Rank by"]').selectOption('recent');
  await page.locator('select[aria-label="Rank by"]').selectOption('signals');
  const inspect = page.getByRole('button',{name:'Inspect →'}).first();
  await inspect.waitFor();
  await inspect.click();
  await page.getByRole('heading',{name:'Matched complaint details'}).waitFor({timeout:12000});
  await capture(page,'m2-02-matches');
  await page.getByRole('button',{name:'Explain this match →'}).click();
  await page.getByRole('heading',{name:'Why were these complaints matched?'}).waitFor();
  await capture(page,'m2-03-explanation');
  const handoff = page.getByRole('button',{name:'Send for supervisor review →'});
  // Restricted pair + no scoped supervisor => no submission. Enabled candidates open the fourth view.
  if (await handoff.isEnabled()) {
    await handoff.click();
    await page.getByRole('heading',{name:'Supervisor review handoff'}).waitFor();
    await capture(page,'m2-04-handoff');
    const submit = page.getByRole('button',{name:'Send for supervisor review',exact:true});
    if (await submit.isEnabled()) throw new Error('Handoff submit must require a reason');
    await page.locator('.m2-formlabel textarea').fill('The evidence points to shared infrastructure disruption. Request human examination.');
    if (!await submit.isEnabled()) throw new Error('Valid authorized handoff must enable submit');
    // Do not send in visual smoke; API suite verifies persistence and audit trail.
  }
  if (errors.length) throw new Error('Desktop console errors: '+errors.join('; '));
  await ctx.close();

  const mobile = await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const pageMobile = await mobile.newPage();
  pageMobile.on('pageerror',(e)=>errors.push(String(e)));
  await login(pageMobile);
  await pageMobile.goto(BASE+'/#/overlaps');
  await pageMobile.getByRole('heading',{name:'Intelligent overlap detection'}).waitFor();
  await capture(pageMobile,'m2-05-mobile');
  const overflow = await pageMobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 3);
  if (overflow) throw new Error('Mobile horizontal page overflow');
  if (errors.length) throw new Error('Browser errors: '+errors.join('; '));
  console.log('PASS M2 Playwright desktop: list, filter, ranking, detail, explanation, scoped handoff');
  console.log('PASS M2 Playwright mobile: navigation and responsive viewport');
  await mobile.close();
} finally { await browser.close(); }
