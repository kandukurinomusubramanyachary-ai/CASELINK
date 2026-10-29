/** One release gate. Every API suite gets its own explicitly seeded synthetic database. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const repo = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(repo, '.runtime'), { recursive: true });
const output = fs.mkdtempSync(path.join(repo, '.runtime/verification-'));
const results = [];
const children = new Set();
const stop = async child => {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(1);
});

async function command(name, args, env = {}) {
  console.log(`RUN ${name}`);
  const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let text = '';
  child.stdout.on('data', value => { text += value; });
  child.stderr.on('data', value => { text += value; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 240_000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  clearTimeout(timeout); children.delete(child);
  const log = path.join(output, `${name}.log`);
  fs.writeFileSync(log, text);
  const skipped = (text.match(/^\s*SKIP\b/gm) ?? []).length;
  const ok = code === 0 && skipped === 0;
  results.push({ name, code, skipped, ok, log: path.relative(repo, log) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${skipped ? ` (${skipped} required checks skipped)` : ''}`);
  if (!ok) console.log(text.slice(-7000));
  return ok;
}

async function apiSuite(file, demo = false) {
  const name = path.basename(file, '.mjs');
  const data = path.join(output, `${name}-data`);
  if (!await command(`${name}-seed`, ['--import', 'tsx', 'server/src/seed.ts', '--force'], { CASELINK_DATA_DIR: data })) return;
  const port = await new Promise(resolve => {
    const listener = createServer(); listener.listen(0, '127.0.0.1', () => {
      const chosen = listener.address().port; listener.close(() => resolve(chosen));
    });
  });
  const env = { CASELINK_DATA_DIR: data, CASELINK_DB: path.join(data, 'caselink.db'), PORT: String(port),
    CASELINK_DEMO: String(demo), CASELINK_TEST_HOOKS: 'true', BASE: `http://127.0.0.1:${port}`,
    CASELINK_SCREENSHOT_DIR: path.join(output, 'screenshots'), CASELINK_ACCEPTANCE_RESULTS: path.join(output, 'acceptance-results.json') };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let text = '';
  child.stdout.on('data', value => { text += value; });
  child.stderr.on('data', value => { text += value; });
  try {
    const deadline = Date.now() + 20_000;
    while (!text.includes('CaseLink listening')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`API startup failed: ${text}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await command(name, [file, ...(name === 'acceptance' ? [env.BASE] : [])], env);
    if (name === 'import-m5') await command('migration-check', ['test/migration-check.mjs', env.CASELINK_DB], env);
  } finally {
    await stop(child);
    fs.writeFileSync(path.join(output, `${name}-server.log`), text);
  }
}

try {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Use Node 22 (see .nvmrc) before running verification.');
  const tsc = await command('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
  const build = await command('build', ['node_modules/vite/bin/vite.js', 'build']);
  if (!tsc || !build) throw new Error('Typecheck/build failed; see verification logs.');
  await command('reliability', ['--test', 'test/reliability.mjs']);
  await command('search-access', ['test/search-access.mjs']);
  await command('matching-eval', ['--import', 'tsx', 'test/matching-eval.ts']);
  for (const file of ['security-m1', 'security-m1-1', 'security-m2', 'lifecycle-m3', 'concurrency-m4', 'import-m5', 'audit-m7', 'acceptance', 'login-check', 'ui-smoke', 'acceptance-ui', 'refresh-m6', 'ux-m7']) {
    await apiSuite(`test/${file}.mjs`);
  }
  for (const file of ['demo-mode', 'direct-entry']) await apiSuite(`test/${file}.mjs`, true);
} catch (err) {
  console.error(err);
  results.push({ name: 'verification-runner', ok: false, error: String(err) });
} finally {
  for (const child of children) await stop(child);
  fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Verification: ${results.filter(r => r.ok).length}/${results.length} commands passed. Logs: ${path.relative(repo, output)}`);
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
}
