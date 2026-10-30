/** Real React -> Express -> SQLite journey, including process restart. Synthetic data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const repo = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.CASELINK_INTEGRATION_DIR ?? '.runtime/integration');
fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(output, 'synthetic-'));
const screenshots = process.env.CASELINK_SCREENSHOT_DIR ?? path.join(output, 'screenshots');
fs.mkdirSync(screenshots, { recursive: true });
const database = path.join(dataDir, 'caselink.db');
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(() => resolve(selected));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, CASELINK_DATA_DIR: dataDir, CASELINK_DEMO: 'false',
  CASELINK_TEST_HOOKS: 'false', CASELINK_HOST: '127.0.0.1', PORT: String(port) };
const seed = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/seed.ts', '--force'],
  { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(seed.status, 0, seed.stderr);
let child, browser, serverOutput = '';
const errors = [];
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;
}
async function start() {
  let output = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'],
    { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output += b; serverOutput += b; });
  const deadline = Date.now() + 20000;
  while (!output.includes('CaseLink listening')) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function api(method, route, token, body) {
  const response = await fetch(base + '/api' + route, { method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
async function login(username) {
  const result = await api('POST', '/auth/login', null, { username, password: 'caselink-demo' });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.token;
}
function query(sql, ...params) {
  const db = new Database(database, { readonly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
async function browserLogin(page, username) {
  await page.goto(base + '/#/login');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('caselink-demo');
  await page.locator('button[type=submit]').click();
  await page.locator('#username').waitFor({ state: 'detached' });
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(screenshots, name + '.png'), fullPage: true });
}
async function reviewAction(page, action, reason) {
  await page.locator('#m3-action').selectOption(action);
  await page.locator('#m3-reason').fill(reason);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/actions'));
  await page.getByRole('button', { name: 'Record Supervisor Action' }).click();
  assert.equal((await response).status(), 200);
}
try {
  await start();
  const lead = await login('m.nair');
  const supervisor = await login('a.desai');
  const institution = (await api('GET', '/institutions?q=vaigai', lead)).data.institutions[0];
  const cases = [];
  for (const [i, summary] of [
    'North hostel drinking water pipeline failed after construction and students have no safe supply.',
    'Students in the north hostel report unsafe drinking water after construction damaged the supply pipeline.',
  ].entries()) {
    const created = await api('POST', '/cases', lead, {
      institutionId: institution.id, category: 'Infrastructure', sourceChannel: 'Email',
      sourceReference: 'INTEGRATION-' + Date.now() + '-' + i,
      receivedAt: new Date(Date.now() - 86400000).toISOString(),
      complaintSummary: summary, deadlinePolicyId: 'DEMO-POL-30',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    cases.push(created.data);
    const grant = await api('POST', '/cases/' + created.data.id + '/grants', lead, {
      userId: 'u-supervisor', version: created.data.version, note: 'Synthetic integration supervisor content authorization.',
    });
    assert.equal(grant.status, 200);
    const current = await api('GET', '/cases/' + created.data.id, lead);
    const form = new FormData();
    form.append('version', String(current.data.case.version));
    form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), `synthetic-proof-${i}.png`);
    assert.equal((await api('POST', '/cases/' + created.data.id + '/attachments', lead, form)).status, 201);
  }
  let pair;
  for (let i = 0; i < 100; i++) {
    const result = await api('GET', '/m2/suggestions?state=open&caseId=' + cases[0].id + '&pageSize=50', lead);
    pair = result.data.rows.find(p => [p.caseA.id, p.caseB.id].includes(cases[1].id));
    if (pair) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(pair, 'Actual matching worker must generate the candidate');
  const originalCases = query('SELECT id,complaint_summary,bureau,status,version FROM cases WHERE id IN (?,?) ORDER BY id', ...cases.map(c => c.id));
  const relationships = query('SELECT id FROM relationships').length;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.on('page', p => p.on('pageerror', error => errors.push(String(error))));
  const page = await context.newPage();
  await browserLogin(page, 'm.nair');
  await page.locator('a[href="#/overlaps"]').first().click();
  await page.getByRole('heading', { name: 'Intelligent overlap detection' }).waitFor();
  await page.getByLabel('Search complaints', { exact: true }).fill(cases[0].caseNumber);
  await page.getByLabel('Category', { exact: true }).selectOption('Infrastructure');
  const row = page.locator('.m2-table tbody tr').filter({ hasText: cases[0].caseNumber }).filter({ hasText: cases[1].caseNumber });
  await row.waitFor();
  await shot(page, '01-m2-ranked-candidate');
  await row.getByRole('button', { name: /Inspect/ }).click();
  await page.getByRole('heading', { name: 'Matched complaint details' }).waitFor();
  await page.getByRole('button', { name: /Explain this match/ }).click();
  await page.getByRole('heading', { name: 'Why were these complaints matched?' }).waitFor();
  await shot(page, '02-m2-explanation');
  await page.getByRole('button', { name: /Send for supervisor review/ }).click();
  await page.locator('.m2-formlabel select').selectOption('u-supervisor');
  await page.locator('.m2-formlabel textarea').fill('Compare the independent reports and protected evidence before classifying this water supply incident.');
  const sent = page.waitForResponse(r => r.url().endsWith('/handoff') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send for supervisor review', exact: true }).click();
  const sentResponse = await sent;
  assert.equal(sentResponse.status(), 201);
  const { handoffId } = await sentResponse.json();
  await page.getByRole('heading', { name: 'Sent for supervisor review' }).waitFor();
  await shot(page, '03-m2-durable-handoff');
  assert.equal(query('SELECT id FROM relationships').length, relationships);
  assert.deepEqual(query('SELECT id,complaint_summary,bureau,status,version FROM cases WHERE id IN (?,?) ORDER BY id', ...cases.map(c => c.id)), originalCases);
  assert.equal((await api('GET', '/m3/reviews/' + handoffId, supervisor)).data.review.state, 'pending');
  console.log('PASS real M2 UI handoff creates pending M3 review without changing originals or relationships');

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await browserLogin(page, 'a.desai');
  await page.locator('a[href="#/supervisor-review"]').first().click();
  await page.getByRole('heading', { name: 'Assigned supervisor reviews' }).waitFor();
  await page.getByRole('button', { name: new RegExp(cases[0].caseNumber) }).click();
  await page.getByRole('heading', { name: 'Complaint A', exact: true }).waitFor();
  await shot(page, '04-m3-originals-and-evidence');
  await page.getByRole('button', { name: /Inspect independent timeline/ }).first().click();
  await page.getByRole('button', { name: /synthetic-proof-0/ }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Same-module navigation must use the current hash, including browser back/forward.
  await page.locator('a[href="#/supervisor-review"]').first().click();
  await page.getByRole('heading', { name: 'Assigned supervisor reviews' }).waitFor({ timeout: 5000 });
  await page.goBack();
  await page.getByRole('heading', { name: 'Complaint A', exact: true }).waitFor();
  await reviewAction(page, 'request_evidence', 'Please provide the original pipeline inspection report before classification.');
  await page.getByText('Awaiting Evidence', { exact: true }).waitFor();
  await shot(page, '05-m3-evidence-request');
  const notices = (await api('GET', '/notifications', lead)).data.notifications.filter(n => n.kind === 'Supervisor evidence request');
  assert.ok(notices.length >= 2);
  for (const notice of notices) assert.ok(!notice.body.includes(handoffId), 'Notice must not expose the cross-case identifier');
  await reviewAction(page, 'resume', 'The requested inspection evidence is now available for independent examination.');
  await reviewAction(page, 'accept', 'Both complaint histories and protected evidence have been examined for a relationship decision.');
  await page.getByRole('button', { name: /Proceed to Relationship Decision/ }).waitFor();
  await shot(page, '06-m3-accepted');
  await page.getByRole('button', { name: /Proceed to Relationship Decision/ }).click();
  await page.getByRole('heading', { name: /M4.*Relationship Decision/ }).waitFor();
  await page.getByRole('radio', { name: /Related/ }).check();
  const explanation = 'Both complaints concern connected hostel water supply failures; each retains its original evidence and ownership.';
  await page.locator('#m4-reason').fill(explanation);
  await page.getByRole('button', { name: 'Save Draft', exact: true }).click();
  await page.getByText('Draft saved; no relationship has been confirmed.').waitFor();
  await page.reload();
  await page.locator('#m4-reason').waitFor();
  assert.equal(await page.locator('#m4-reason').inputValue(), explanation);
  assert.equal(query('SELECT id FROM relationships').length, relationships);
  await shot(page, '07-m4-persisted-draft');
  await page.getByRole('button', { name: 'Confirm Decision', exact: true }).click();
  await page.getByText('Confirmed: Related', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Confirmed: Related', { exact: true }).waitFor();
  const persisted = (await api('GET', '/m4/decisions/' + handoffId, supervisor)).data;
  assert.equal(persisted.activeDecision.decision, 'Related');
  assert.equal(query('SELECT id FROM relationships WHERE revoked_at IS NULL').filter(r => r.id === persisted.activeDecision.relationshipId).length, 1);
  await shot(page, '08-m4-confirmed');
  const dashboard = await context.newPage();
  await dashboard.goto(base + '/#/overlaps');
  await dashboard.getByRole('button', { name: 'Previously decided', exact: true }).click();
  await dashboard.getByLabel('Search complaints', { exact: true }).fill(cases[0].caseNumber);
  const decidedRow = dashboard.locator('.m2-table tbody tr').filter({ hasText: cases[0].caseNumber }).filter({ hasText: cases[1].caseNumber });
  await decidedRow.getByText('Relationship confirmed', { exact: true }).waitFor({ timeout: 5000 });
  await shot(dashboard, '08b-m2-confirmed-backend-state');
  await dashboard.close();
  await stop();
  await start();
  const restarted = (await api('GET', '/m4/decisions/' + handoffId, supervisor)).data;
  assert.deepEqual(restarted, persisted, 'Decision, audit, draft, evidence, histories and session must survive server restart');
  await page.reload();
  await page.getByText('Confirmed: Related', { exact: true }).waitFor();
  await page.locator('#m4-reversal-reason').fill('New inspection evidence requires reconsideration; preserve the original decision and both complaint histories.');
  await page.getByRole('button', { name: 'Undo / Reverse Decision' }).click();
  await page.getByText('Decision reversed. Both complaint histories remain preserved.').waitFor();
  await page.reload();
  await page.getByText('No active confirmed relationship for this pair.').waitFor();
  await shot(page, '09-m4-reversed-audit');
  const reversed = (await api('GET', '/m4/decisions/' + handoffId, supervisor)).data;
  assert.equal(reversed.activeDecision, null);
  assert.equal(reversed.decisions[0].state, 'reversed');
  assert.deepEqual(reversed.auditEvents.map(e => e.action), ['draft_saved', 'decision_confirmed', 'decision_reversed']);
  for (const original of originalCases) {
    const current = query('SELECT id,complaint_summary,bureau,status FROM cases WHERE id=?', original.id)[0];
    const { version, ...unchanged } = original;
    assert.deepEqual(current, unchanged);
  }
  await stop(); await start();
  assert.deepEqual((await api('GET', '/m4/decisions/' + handoffId, supervisor)).data, reversed);
  console.log('PASS M3 evidence request/resume/accept -> M4 draft/confirm/reverse; refresh and two server restarts preserve audit and originals');

  for (const [name, width, height] of [['tablet', 820, 1180], ['mobile', 390, 844]]) {
    const responsive = await browser.newContext({ viewport: { width, height } });
    const p = await responsive.newPage();
    p.on('pageerror', error => errors.push(String(error)));
    await browserLogin(p, 'a.desai');
    for (const [module, route, heading] of [
      ['m2', 'overlaps', 'Intelligent overlap detection'],
      ['m3', 'supervisor-review/' + handoffId, /M3.*Supervisor Review/],
      ['m4', 'relationship-decision/' + handoffId, /M4.*Relationship Decision/],
    ]) {
      await p.goto(base + '/#/' + route);
      await p.getByRole('heading', { name: heading }).waitFor();
      await p.locator(module === 'm2' ? '.m2-table' : module === 'm3' ? '.m3-case' : '.m4-case').first().waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 3), false, name + ' ' + module + ' overflow');
      await shot(p, `10-${name}-${module}`);
    }
    await responsive.close();
    console.log('PASS ' + name + ' actual M2/M3/M4 routes render without horizontal overflow');
  }
  for (const username of ['p.rao', 'v.kumar']) {
    const denied = await browser.newContext();
    const p = await denied.newPage();
    await browserLogin(p, username);
    for (const route of ['supervisor-review', 'relationship-decision']) {
      await p.goto(base + '/#/' + route + '/' + handoffId);
      await p.getByText(username === 'p.rao' ? /requires a supervisor account/ : /not found/i).first().waitFor();
      assert.equal(await p.getByText(cases[0].complaintSummary ?? 'North hostel drinking water pipeline failed after construction and students have no safe supply.', { exact: true }).count(), 0);
    }
    await denied.close();
  }
  // Hold the real request to verify loading, then let it reach the backend.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/m4/decisions/*', async route => { await gate; await route.continue(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('status').filter({ hasText: 'Loading current authorized decision record' }).waitFor();
  release();
  await page.getByRole('heading', { name: 'Relationship classification', exact: true }).waitFor();
  await page.unroute('**/api/m4/decisions/*');
  // Deliberately fail a network request, then recover against the actual backend.
  await page.route('**/api/m4/decisions/*', route => route.abort('failed'));
  await page.reload();
  await page.locator('.m4-alert').waitFor();
  await shot(page, '11-network-error');
  await page.unroute('**/api/m4/decisions/*');
  await page.getByRole('button', { name: 'Refresh versions' }).click();
  await page.getByRole('heading', { name: 'Relationship classification', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.equal(query('PRAGMA foreign_key_check').length, 0);
  assert.equal(query('PRAGMA integrity_check')[0].integrity_check, 'ok');
  fs.writeFileSync(path.join(output, 'journey.json'), JSON.stringify({ handoffId, caseIds: cases.map(c => c.id),
    result: 'passed', screenshots: fs.readdirSync(screenshots), dataDir }, null, 2));
  console.log('PASS direct URL authorization, recoverable network error, foreign keys and database integrity');
} catch (error) {
  if (browser) for (const c of browser.contexts()) for (const p of c.pages()) await shot(p, 'failure').catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stop();
  fs.writeFileSync(path.join(output, 'server.log'), serverOutput);
}
