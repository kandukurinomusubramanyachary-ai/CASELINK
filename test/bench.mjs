#!/usr/bin/env node
/**
 * Reference-scale benchmark for the PRD section 9 targets.
 *
 *   node test/bench.mjs            # seed if needed, then measure
 *   node test/bench.mjs --reseed   # rebuild the benchmark database from scratch
 *
 * Shape of the run:
 *   - 10,000 synthetic cases across 100 synthetic institutions in a scratch database under
 *     data/bench (data/caselink.db is only ever read, to copy the seed users/institutions from);
 *   - 20 concurrent authenticated sessions against one API process;
 *   - a warm-up pass that is excluded from the numbers;
 *   - then, for each probe: p50/p95, the request count, and the number of errors;
 *   - each session mutates its own case, so a 409 from version contention is never counted as a slow
 *     success; conflicts are reported separately.
 *
 * Targets (PRD section 9): p95 case read/filter < 1500 ms, mutation < 2000 ms, overlap alert < 5000 ms,
 * dashboard < 10 000 ms. These are the prototype's own targets on the stated machine, not a production
 * capacity claim.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '..');
const BENCH_DIR = process.env.CASELINK_BENCH_DIR ? path.resolve(process.env.CASELINK_BENCH_DIR) : path.join(ROOT, 'data', 'bench');
const BENCH_DB = path.join(BENCH_DIR, 'caselink.db');
const PORT = Number(process.env.BENCH_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET_CASES = 10_000;
const TARGET_INSTITUTIONS = 100;
const SESSIONS = Number(process.env.BENCH_SESSIONS ?? 20);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 12);
const RESEED = process.argv.includes('--reseed');
const PASSWORD = 'caselink-demo';
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------- seeding */
if (RESEED) fs.rmSync(BENCH_DIR, { recursive: true, force: true });
fs.mkdirSync(BENCH_DIR, { recursive: true });
if (!fs.existsSync(BENCH_DB)) {
  // The source may still have committed pages in its WAL; copying only the main file loses them.
  const source = new Database(process.env.CASELINK_SOURCE_DB ?? path.join(ROOT, 'data', 'caselink.db'), { readonly: true });
  try { await source.backup(BENCH_DB); } finally { source.close(); }
}

const db = new Database(BENCH_DB);
const existing = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;
if (existing < TARGET_CASES) {
  const rand = (() => {
    let a = 42;
    return () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    };
  })();
  const regions = ['South', 'West', 'North', 'East'];
  const categories = [
    'Certificate / documentation',
    'Infrastructure',
    'Fee / refund',
    'Academic governance',
    'Faculty / staffing',
    'Approval compliance',
    'Other',
  ];
  const insertInstitution = db.prepare('INSERT OR IGNORE INTO institutions (id, permanent_id, name, region, created_at) VALUES (?,?,?,?,?)');
  const startInstitutions = db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n;
  const institutions = db.prepare('SELECT id FROM institutions').all().map((r) => r.id);
  for (let i = startInstitutions; i < TARGET_INSTITUTIONS; i += 1) {
    const id = `bench-inst-${i}`;
    insertInstitution.run(id, `AICTE-BENCH-${1000 + i}`, `Benchmark Institute ${i}`, regions[i % regions.length], nowIso());
    institutions.push(id);
  }
  const insertCase = db.prepare(
    `INSERT INTO cases (id, case_number, institution_id, triage_state, received_at, source_channel, source_reference, category,
       complaint_summary, bureau, assigned_officer_id, status, next_action, expected_disposal_at, deadline_policy_id, version,
       created_by, created_at, updated_at)
     VALUES (?,?,?, 'resolved', ?, 'Email', ?, ?, ?, ?, ?, ?, ?, ?, 'DEMO-POL-30', 1, ?, ?, ?)`
  );
  const statuses = ['Received', 'Assigned', 'Under review', 'Awaiting response', 'Disposed'];
  const seed = db.transaction(() => {
    for (let i = existing; i < TARGET_CASES; i += 1) {
      const age = Math.floor(rand() * 200);
      const received = new Date(Date.now() - age * 86_400_000).toISOString();
      const status = statuses[Math.floor(rand() * statuses.length)];
      const bureau = rand() > 0.5 ? 'PGRC' : 'RB';
      const officer = bureau === 'PGRC' ? 'u-officer-pgrc' : 'u-officer-rb';
      insertCase.run(
        uuid(),
        `BENCH-${bureau}-${String(i).padStart(6, '0')}`,
        institutions[Math.floor(rand() * institutions.length)],
        received,
        `BENCH/2026/${i}`,
        categories[Math.floor(rand() * categories.length)],
        `Synthetic benchmark complaint ${i}: institution records request requiring coordination review.`,
        bureau,
        officer,
        status,
        'Confirm next step with the institute single point of contact',
        new Date(new Date(received).getTime() + 30 * 86_400_000).toISOString(),
        officer,
        nowIso(),
        nowIso()
      );
    }
  });
  seed();
  console.log(`Seeded benchmark database to ${TARGET_CASES} cases / ${TARGET_INSTITUTIONS} institutions.`);
}
const counts = db.prepare('SELECT (SELECT COUNT(*) FROM cases) AS cases, (SELECT COUNT(*) FROM institutions) AS institutions').get();
db.close();

/* ------------------------------------------------------------------- machine */
function machineInfo() {
  const cpu = os.cpus()[0];
  const memGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  let osRelease = `${os.type()} ${os.release()}`;
  try {
    osRelease = fs.readFileSync('/etc/os-release', 'utf8').split('\n').find((l) => l.startsWith('PRETTY_NAME='))?.split('=')[1]?.replace(/"/g, '') ?? osRelease;
  } catch {
    /* keep the generic name */
  }
  return { cpu: `${cpu?.model ?? 'unknown'} × ${os.cpus().length}`, memoryGb: memGb, os: osRelease, node: process.version, sqlite: db.constructor?.name === 'Database' ? null : null };
}

const machine = machineInfo();
machine.sqlite = (() => {
  try {
    const probe = new Database(BENCH_DB, { readonly: true });
    const version = probe.prepare('SELECT sqlite_version() AS v').get().v;
    probe.close();
    return version;
  } catch {
    return 'unknown';
  }
})();

/* --------------------------------------------------------------------- server */
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CASELINK_DATA_DIR: BENCH_DIR, CASELINK_DEMO: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[bench server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[bench server] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopServer = () => {
  try {
    server.kill('SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', stopServer);
for (let i = 0; i < 120; i += 1) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(500);
}

/* ------------------------------------------------------------------- sessions */
const ACCOUNTS = ['m.nair', 'p.rao', 's.iyer', 'l.verma', 'a.desai', 'r.khan', 'k.menon', 'm.joshi', 's.bose', 'r.pillai', 'v.kumar', 'n.iyer', 'admin'];
const sessions = [];
for (let i = 0; i < SESSIONS; i += 1) {
  const username = ACCOUNTS[i % ACCOUNTS.length];
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`session ${i} (${username}) could not sign in: ${res.status}`);
  const body = await res.json();
  sessions.push({ username, token: body.token, user: body.user });
}
console.log(`${sessions.length} authenticated sessions: ${[...new Set(sessions.map((s) => s.username))].join(', ')} (one account may hold more than one session)`);

async function call(session, method, endpoint, payload) {
  const started = performance.now();
  const res = await fetch(`${BASE}/api${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${session.token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ms: performance.now() - started, status: res.status, json };
}

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

/* --------------------------------------------------------------- probe corpus */
// Each session gets its own cases so mutations do not fight over one version.
/**
 * Each session works on a case inside its own scope: overlapping the same records across bureaus would
 * measure 403s, not latency. A mutation probe is only registered for a session that can actually act on
 * its case, and the report states how many sessions that was.
 */
const ACTIVE = ['Received', 'Assigned', 'Under review', 'Awaiting response'];
const owned = [];
const unactionable = [];
for (const session of sessions) {
  let chosen = null;
  for (let page = 1; page <= 4 && !chosen; page += 1) {
    const list = await call(session, 'GET', `/cases?pageSize=25&page=${page}`);
    const rows = list.json?.cases ?? [];
    chosen = rows.find((row) => row.access === 'full' && ACTIVE.includes(row.status) && !owned.some((o) => o.id === row.id));
    if (!chosen) chosen = rows.find((row) => row.access === 'full' && !owned.some((o) => o.id === row.id)) ?? null;
    if (chosen) break;
  }
  if (!chosen) {
    unactionable.push(session.username);
    continue;
  }
  const detail = await call(session, 'GET', `/cases/${chosen.id}`);
  owned.push({ session, id: chosen.id, version: detail.json?.case?.version ?? 1, mutable: ACTIVE.includes(chosen.status) });
}
console.log(`mutation probes: ${owned.filter((o) => o.mutable).length}/${sessions.length} sessions have a case they may act on${unactionable.length ? ` · no visible case for ${unactionable.join(', ')}` : ''}`);

/* ------------------------------------------------------------------- warm-up */
// A warm-up mutation decides empirically whether a session may act on its case: content visibility and
// write authority are different things, and only the write probe should be counted.
for (const entry of owned) {
  const probe = await call(entry.session, 'POST', `/cases/${entry.id}/actions`, {
    version: entry.version,
    actionType: 'internal_note',
    remarks: 'Benchmark warm-up note (excluded from the numbers).',
    nextStep: null,
  });
  entry.mutable = probe.status === 201;
  entry.warmupStatus = probe.status;
  // The action endpoint answers with the updated case envelope, not a bare case row.
  if (entry.mutable) entry.version = probe.json.case.version;
}
const mutable = owned.filter((e) => e.mutable);
console.log(
  `warm-up complete (excluded from the numbers below) · ${mutable.length}/${owned.length} sessions may act on their case` +
    (mutable.length === owned.length ? '' : ` · not writable: ${owned.filter((e) => !e.mutable).map((e) => `${e.session.username}(${e.warmupStatus})`).join(', ')}`)
);

/* --------------------------------------------------------------- measurements */
const filters = ['', '?pending=1', '?overdue=1', '?bureau=RB&status=Assigned', '?q=Institute', '?page=4&pageSize=50'];

async function runPhase(label, entries, rounds, participants = entries, options = {}) {
  const out = {
    label,
    sessions: entries.length,
    rounds,
    list: [],
    read: [],
    mutation: [],
    dashboard: [],
    coordination: [],
    errors: { list: 0, read: 0, mutation: 0, dashboard: 0, coordination: 0 },
    conflicts: 0,
  };
  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(
      participants.map(async ({ session, id }, index) => {
        const filter = filters[(round + index) % filters.length];
        const list = await call(session, 'GET', `/cases${filter}${filter ? '&' : '?'}pageSize=25`);
        if (list.status === 200) out.list.push(list.ms);
        else out.errors.list += 1;

        if (id) {
          const read = await call(session, 'GET', `/cases/${id}`);
          if (read.status === 200) out.read.push(read.ms);
          else out.errors.read += 1;
        }

        if (!options.readOnlyMix) {
          const coordination = await call(session, 'GET', '/coordination');
          if (coordination.status === 200) out.coordination.push(coordination.ms);
          else out.errors.coordination += 1;
        }

        if (!options.readOnlyMix && index % 2 === 0) {
          const dashboard = await call(session, 'GET', '/reports/summary');
          if (dashboard.status === 200) out.dashboard.push(dashboard.ms);
          else out.errors.dashboard += 1;
        }
      })
    );

    if (options.readOnlyMix) continue;

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.mutable) return;
        const res = await call(entry.session, 'POST', `/cases/${entry.id}/actions`, {
          version: entry.version,
          actionType: 'internal_note',
          remarks: `Benchmark round ${round}: synthetic note recorded by the reference-scale run.`,
          nextStep: null,
        });
        if (res.status === 201) {
          out.mutation.push(res.ms);
          entry.version = res.json.case.version;
        } else if (res.status === 409) out.conflicts += 1;
        else {
          out.errors.mutation += 1;
          out.firstMutationError = out.firstMutationError ?? `${res.status} ${res.json?.error ?? ''} ${res.json?.message ?? ''}`.trim();
        }
      })
    );
  }
  return out;
}

// Every authenticated session takes part in the concurrent phase (list, coordination and, for half of
// them, the dashboard); reads and mutations are only issued by sessions that hold a case.
const participants = sessions.map((session) => ({ session, id: owned.find((o) => o.session === session)?.id ?? null }));
const ownedBySession = new Map(owned.map((entry) => [entry.session, entry]));
const phaseEntries = sessions.map((session) => ownedBySession.get(session) ?? { session, id: null, mutable: false });
const singleSession = mutable[0] ?? owned[0];
const single = await runPhase('single session', [singleSession], 30);
const concurrent = await runPhase(`concurrency ${sessions.length}`, phaseEntries, ITERATIONS, participants);
// The same concurrency with only list+read traffic, so the boundary between "read latency" and
// "queuing behind the heavier coordination and dashboard requests" is visible rather than assumed.
const readOnly = await runPhase(`concurrency ${sessions.length}, list+read only`, phaseEntries, ITERATIONS, participants, { readOnlyMix: true });

/* ------------------------------------------------- overlap alert propagation */
// A new case filed by a second bureau at an institution that only had one bureau must open the
// institution alert; measure wall time from the write to the alert being visible to a supervisor.
const supervisor = sessions.find((s) => s.user.role === 'supervisor') ?? sessions[0];
const institutions = (await call(supervisor, 'GET', '/institutions')).json.institutions;
const target = institutions.find((i) => i.bureaus.length === 1 && i.activeCases > 0) ?? institutions[0];
const otherBureauLead = sessions.find((s) => s.user.bureau !== target.bureaus[0]) ?? supervisor;
const startedAt = performance.now();
const created = await call(otherBureauLead, 'POST', '/cases', {
  institutionId: target.id,
  receivedAt: nowIso(),
  sourceChannel: 'Email',
  sourceReference: `BENCH-OVERLAP/${Date.now()}`,
  category: 'Other',
  complaintSummary: 'Benchmark overlap probe: a second bureau files at an institution that already has active work, so the coordination alert must appear inside the target window.',
  deadlinePolicyId: 'DEMO-POL-30',
});
let alertLatency = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const coord = await call(supervisor, 'GET', '/coordination');
  const hit = coord.json?.overlaps?.find((a) => a.institution?.id === target.id && a.state === 'open' && a.cases.some((c) => c.id === created.json?.id));
  if (hit) {
    alertLatency = performance.now() - startedAt;
    break;
  }
  await sleep(100);
}

/* --------------------------------------------------------------------- report */
const rowsOf = (phase) => [
  { label: 'case list (filtered, 25/page)', values: phase.list, errors: phase.errors.list, target: 1500 },
  { label: 'case read (single record)', values: phase.read, errors: phase.errors.read, target: 1500 },
  { label: 'mutation (record an action)', values: phase.mutation, errors: phase.errors.mutation, target: 2000, conflicts: phase.conflicts },
  { label: 'dashboard (report summary)', values: phase.dashboard, errors: phase.errors.dashboard, target: 10_000 },
  { label: 'coordination list', values: phase.coordination, errors: phase.errors.coordination, target: null },
];

const formatPhase = (phase) => {
  console.log(`\n--- ${phase.label}: ${phase.sessions} session(s) × ${phase.rounds} rounds ---`);
  if (phase.firstMutationError) console.log(`    first mutation failure: ${phase.firstMutationError}`);
  console.log('probe                                 n     p50 ms    p95 ms   errors   target');
  for (const row of rowsOf(phase)) {
    console.log(
      `${row.label.padEnd(33)} ${String(row.values.length).padStart(5)} ${String(quantile(row.values, 0.5)?.toFixed(0) ?? '-').padStart(9)} ${String(
        quantile(row.values, 0.95)?.toFixed(0) ?? '-'
      ).padStart(9)} ${String(row.errors).padStart(8)}   ${row.target ? `p95 < ${row.target} ms` : 'reference only'}${row.conflicts ? ` · ${row.conflicts} version conflict(s)` : ''}`
    );
  }
};

console.log('\n=== CaseLink reference-scale benchmark ===');
console.log(`machine: ${machine.cpu} · ${machine.memoryGb} GB RAM · ${machine.os}`);
console.log(`runtime: Node ${machine.node} · SQLite ${machine.sqlite} · single API process, one SQLite file (WAL)`);
console.log(`data: ${counts.cases} cases / ${counts.institutions} institutions · ${sessions.length} authenticated sessions`);
formatPhase(single);
formatPhase(concurrent);
formatPhase(readOnly);
console.log(`\noverlap alert visible after the write: ${alertLatency === null ? 'not observed' : `${alertLatency.toFixed(0)} ms`} (target < 5000 ms)`);

const fails = (phase) =>
  rowsOf(phase)
    // A probe with no samples in this phase (e.g. mutations in a read-only mix) is not a failure.
    .filter((row) => row.target && row.values.length > 0 && (quantile(row.values, 0.95) ?? Infinity) > row.target)
    .map((row) => `${row.label} p95 ${quantile(row.values, 0.95)?.toFixed(0)} ms > ${row.target} ms`);
const singleFails = fails(single);
const concurrentFails = fails(concurrent);
const readOnlyFails = fails(readOnly);
console.log(`\nsingle session: ${singleFails.length === 0 ? 'every target met' : `missed — ${singleFails.join('; ')}`}`);
console.log(`concurrency ${sessions.length} (mixed traffic): ${concurrentFails.length === 0 ? 'every target met' : `missed — ${concurrentFails.join('; ')}`}`);
console.log(`concurrency ${sessions.length} (list+read only): ${readOnlyFails.length === 0 ? 'every target met' : `missed — ${readOnlyFails.join('; ')}`}`);
console.log(`overlap alert: ${alertLatency === null ? 'not observed' : alertLatency <= 5000 ? 'met' : 'missed'}`);

const reportPath = process.env.CASELINK_BENCH_REPORT ? path.resolve(process.env.CASELINK_BENCH_REPORT) : path.join(ROOT, 'docs', 'm6-benchmark.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const phaseJson = (phase) =>
  rowsOf(phase).map((row) => ({ probe: row.label, n: row.values.length, p50: quantile(row.values, 0.5), p95: quantile(row.values, 0.95), errors: row.errors, targetP95: row.target }));
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      measuredAt: nowIso(),
      machine,
      dataset: counts,
      sessions: sessions.length,
      warmupExcluded: true,
      singleSession: { rounds: single.rounds, rows: phaseJson(single) },
      concurrentMixed: { sessions: sessions.length, rounds: concurrent.rounds, rows: phaseJson(concurrent) },
      concurrentReadOnly: { sessions: sessions.length, rounds: readOnly.rounds, rows: phaseJson(readOnly) },
      overlapAlertMs: alertLatency,
      targets: { caseRead: 1500, caseFilter: 1500, mutation: 2000, overlapAlert: 5000, dashboard: 10000 },
    },
    null,
    2
  )}\n`
);
console.log(`\nraw numbers written to ${path.relative(ROOT, reportPath)}`);

stopServer();
const failed = singleFails.length > 0 || concurrentFails.length > 0 || alertLatency === null || alertLatency > 5000;
console.log(failed ? '\nresult: at least one PRD target was missed (see the lines above)' : '\nresult: every PRD section 9 latency target was met on this machine');
process.exit(failed ? 1 : 0);
