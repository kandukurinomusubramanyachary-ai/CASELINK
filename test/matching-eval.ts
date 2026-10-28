/**
 * M6 — reproducible related-case matching evaluation.
 *
 *   npx tsx test/matching-eval.ts            # evaluate against the frozen labelled set
 *   npx tsx test/matching-eval.ts --freeze   # (re)write test/fixtures/matching-set.json
 *
 * The labelled set is 60 synthetic complaints across 10 synthetic institutions with 120 labelled
 * pairs (40 duplicate, 40 related, 40 unrelated). Pairs are split into a tune half and a held-out
 * half **by incident family** (institution), so no pair straddles the split except the deliberately
 * cross-institution "identical wording" pairs, which are generated inside each half only.
 *
 * Labels express what an officer would want: two reports of the same underlying incident are
 * `duplicate`; the same incident's other facet (a different sub-issue at the same college in the same
 * period) is `related`; everything else - including identical wording at a *different* college - is
 * `unrelated`. The rules are deterministic and rule-based; nothing here invents an AI component.
 *
 * The script never touches data/caselink.db: it builds a private database in a temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FREEZE = process.argv.includes('--freeze');
const SWEEP = process.argv.includes('--sweep');
const TUNE_ONLY = process.argv.includes('--tune-only');
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const fixturePath = path.join(repo, 'test/fixtures/matching-set.json');
const SET_VERSION = 'm6-matching-1';

/* ------------------------------------------------------------------ dataset */

type Label = 'duplicate' | 'related' | 'unrelated';
interface SetCase {
  key: string;
  institution: string;
  role: 'fee1' | 'fee2' | 'fee3' | 'hostel1' | 'hostel2' | 'lab';
  receivedAt: string;
  category: string;
  sourceReference: string | null;
  summary: string;
}
interface SetPair {
  a: string;
  b: string;
  label: Label;
  family: string;
  split: 'tune' | 'heldout';
  note: string;
}

const INSTITUTIONS = [
  { key: 'i1', permanentId: 'AICTE-DEMO-1001', name: 'Sri Vaigai College of Engineering', alias: 'Vaigai Engineering College', region: 'South', split: 'tune' },
  { key: 'i2', permanentId: 'AICTE-DEMO-1002', name: 'Meenakshi Institute of Technology', alias: 'Meenakshi Tech', region: 'South', split: 'tune' },
  { key: 'i3', permanentId: 'AICTE-DEMO-1003', name: 'Kaveri Polytechnic College', alias: null, region: 'South', split: 'tune' },
  { key: 'i4', permanentId: 'AICTE-DEMO-1004', name: 'Noyyal College of Engineering', alias: null, region: 'South', split: 'tune' },
  { key: 'i5', permanentId: 'AICTE-DEMO-1005', name: 'Thamirabarani Institute of Science', alias: 'Thamira Institute', region: 'South', split: 'tune' },
  { key: 'i6', permanentId: 'AICTE-DEMO-1006', name: 'Agasthiyar College of Technology', alias: null, region: 'South', split: 'tune' },
  { key: 'i7', permanentId: 'AICTE-DEMO-1007', name: 'Palar Institute of Engineering', alias: null, region: 'South', split: 'heldout' },
  { key: 'i8', permanentId: 'AICTE-DEMO-1008', name: 'Vellar College of Engineering', alias: null, region: 'South', split: 'heldout' },
  { key: 'i9', permanentId: 'AICTE-DEMO-1009', name: 'Bhavani Institute of Technology', alias: 'Bhavani Tech', region: 'South', split: 'heldout' },
  { key: 'i10', permanentId: 'AICTE-DEMO-1010', name: 'Amaravathi College of Engineering', alias: null, region: 'West', split: 'heldout' },
] as const;

const DAY = 86_400_000;
const base = Date.UTC(2026, 7, 3, 4, 30, 0); // fixed anchor: 2026-08-03, no dependence on "today"
const at = (dayOffset: number) => new Date(base + dayOffset * DAY).toISOString();

function buildSet() {
  const cases: SetCase[] = [];
  for (const [index, inst] of INSTITUTIONS.entries()) {
    const amount = 18_500 + index * 1_250;
    const hostelAmount = 9_400 + index * 375;
    const feeRef = `FEE/${inst.permanentId}/2026`;
    const hostelRef = `HOSTEL/${inst.permanentId}/2026`;
    // Two reports of the same refund incident, written by two different complainants, plus a third
    // restatement from the office note. All three quote the same register reference.
    // The second restatement deliberately names the college by its reviewed alias where one exists, so
    // the alias signal is exercised rather than assumed.
    const aliasName = inst.alias ?? inst.name;
    const fee1 = `Semester fee of Rs ${amount} paid at ${inst.name} before withdrawal has not been refunded; register reference ${feeRef} is still pending.`;
    const fee2 = `Withdrawal from ${aliasName} on 12 July: the semester fee of Rs ${amount} was not refunded although register reference ${feeRef} was quoted in my letter.`;
    const fee3 = `Refund of the semester fee Rs ${amount} at ${inst.name} is pending against register reference ${feeRef}. Accounts section says the file is with the principal.`;
    // A different sub-issue of the same fee incident: the hostel component. Deliberately a different
    // category and different reference, but the same incident and the same vocabulary.
    const hostel1 = `The hostel fee of Rs ${hostelAmount} for the same semester at ${inst.name} was charged twice, and the refund against the semester fee is still pending; hostel reference ${hostelRef}.`;
    const hostel2 = `Double charge of the hostel fee Rs ${hostelAmount} for the semester at ${aliasName} is not adjusted and the pending refund carries hostel reference ${hostelRef}.`;
    // Identical wording at every college: the cross-institution negative control.
    const lab = `The physics laboratory equipment at ${inst.name} has been out of order since the start of the semester and practical classes are being conducted without instruments.`;

    cases.push(
      { key: `${inst.key}-fee1`, institution: inst.key, role: 'fee1', receivedAt: at(0 + index), category: 'Fee / refund', sourceReference: feeRef, summary: fee1 },
      { key: `${inst.key}-fee2`, institution: inst.key, role: 'fee2', receivedAt: at(2 + index), category: 'Fee / refund', sourceReference: feeRef, summary: fee2 },
      { key: `${inst.key}-fee3`, institution: inst.key, role: 'fee3', receivedAt: at(5 + index), category: 'Fee / refund', sourceReference: feeRef, summary: fee3 },
      { key: `${inst.key}-hostel1`, institution: inst.key, role: 'hostel1', receivedAt: at(3 + index), category: 'Hostel / accommodation', sourceReference: hostelRef, summary: hostel1 },
      { key: `${inst.key}-hostel2`, institution: inst.key, role: 'hostel2', receivedAt: at(6 + index), category: 'Hostel / accommodation', sourceReference: hostelRef, summary: hostel2 },
      { key: `${inst.key}-lab`, institution: inst.key, role: 'lab', receivedAt: at(40 + index), category: 'Infrastructure', sourceReference: null, summary: lab }
    );
  }

  const pairs: SetPair[] = [];
  const add = (a: string, b: string, label: Label, family: string, split: 'tune' | 'heldout', note: string) =>
    pairs.push({ a, b, label, family, split, note });

  for (const inst of INSTITUTIONS) {
    const f = inst.key;
    // 4 duplicates per institution: the three fee restatements and the two hostel restatements.
    add(`${f}-fee1`, `${f}-fee2`, 'duplicate', f, inst.split, 'same refund incident, same register reference');
    add(`${f}-fee1`, `${f}-fee3`, 'duplicate', f, inst.split, 'same refund incident, third restatement');
    add(`${f}-fee2`, `${f}-fee3`, 'duplicate', f, inst.split, 'same refund incident, paraphrased');
    add(`${f}-hostel1`, `${f}-hostel2`, 'duplicate', f, inst.split, 'same hostel double-charge, same hostel reference');
    // 4 related per institution: the hostel component of the same fee incident.
    add(`${f}-hostel1`, `${f}-fee1`, 'related', f, inst.split, 'hostel component of the same incident');
    add(`${f}-hostel1`, `${f}-fee2`, 'related', f, inst.split, 'hostel component of the same incident');
    add(`${f}-hostel2`, `${f}-fee1`, 'related', f, inst.split, 'hostel component of the same incident');
    add(`${f}-fee3`, `${f}-hostel1`, 'related', f, inst.split, 'hostel component of the same incident');
    // 2 unrelated per institution (plus 2 more for two institutions, to keep the class balance).
    add(`${f}-lab`, `${f}-fee1`, 'unrelated', f, inst.split, 'same college, different incident and different period');
    add(`${f}-lab`, `${f}-hostel1`, 'unrelated', f, inst.split, 'same college, different incident and different period');
  }
  add('i1-lab', 'i1-fee2', 'unrelated', 'i1', 'tune', 'same college, different incident and different period');
  add('i7-lab', 'i7-fee2', 'unrelated', 'i7', 'heldout', 'same college, different incident and different period');

  // Cross-college identical wording: 12 pairs inside the tune families and 6 inside the held-out
  // families, so the negative control never leaks across the split.
  const tuneInsts = INSTITUTIONS.filter((i) => i.split === 'tune').map((i) => i.key);
  const heldInsts = INSTITUTIONS.filter((i) => i.split === 'heldout').map((i) => i.key);
  const crossPairs = (keys: string[], count: number) => {
    const out: [string, string][] = [];
    for (let i = 0; i < keys.length && out.length < count; i += 1) {
      for (let j = i + 1; j < keys.length && out.length < count; j += 1) out.push([keys[i], keys[j]]);
    }
    return out;
  };
  for (const [a, b] of crossPairs(tuneInsts, 12)) {
    add(`${a}-lab`, `${b}-lab`, 'unrelated', a, 'tune', 'identical wording at a different institution ID');
  }
  for (const [a, b] of crossPairs(heldInsts, 6)) {
    add(`${a}-lab`, `${b}-lab`, 'unrelated', a, 'heldout', 'identical wording at a different institution ID');
  }

  return {
    version: SET_VERSION,
    anchor: new Date(base).toISOString(),
    institutions: INSTITUTIONS.map((i) => ({ key: i.key, permanentId: i.permanentId, name: i.name, alias: i.alias, region: i.region, split: i.split })),
    cases,
    pairs,
  };
}

const set = buildSet();
const fingerprint = crypto.createHash('sha256').update(JSON.stringify(set)).digest('hex').slice(0, 16);
if (FREEZE) {
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify({ ...set, fingerprint }, null, 2)}\n`);
  console.log(`Frozen ${set.cases.length} complaints / ${set.pairs.length} labelled pairs to ${path.relative(repo, fixturePath)} (fingerprint ${fingerprint}).`);
  process.exit(0);
}
if (!fs.existsSync(fixturePath)) {
  console.error(`No frozen set at ${path.relative(repo, fixturePath)}. Run with --freeze first.`);
  process.exit(1);
}
const frozen = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as ReturnType<typeof buildSet> & { fingerprint: string };
if (frozen.fingerprint !== fingerprint) {
  console.error('The generated set no longer matches the frozen labels. Regenerate deliberately with --freeze and review the diff.');
  process.exit(1);
}

/* ------------------------------------------------------------- isolated db */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caselink-matching-'));
process.env.CASELINK_DATA_DIR = dataDir;
const { db } = await import('../server/src/db.js');
const { evaluatePair, recomputeOverlap, SIMILARITY_THRESHOLD } = await import('../server/src/rules.js');

db.prepare("INSERT INTO bureaus (code, name) VALUES ('PGRC','PGRC'),('RB','RB')").run();
const nowIso = new Date().toISOString();
db.prepare(
  "INSERT INTO users (id, username, display_name, role, bureau, region, password_hash, created_at) VALUES ('u-eval','eval.officer','Evaluation Officer','bureau_officer','PGRC','South','x',?)"
).run(nowIso);
for (const inst of frozen.institutions) {
  db.prepare('INSERT INTO institutions (id, permanent_id, name, region, created_at) VALUES (?,?,?,?,?)').run(inst.key, inst.permanentId, inst.name, inst.region, nowIso);
  if (inst.alias) db.prepare("INSERT INTO institution_aliases (id, institution_id, alias, source, reviewed_by, reviewed_at) VALUES (?,?,?, 'reviewed', 'u-eval', ?)").run(`alias-${inst.key}`, inst.key, inst.alias, nowIso);
}
let caseSeq = 0;
for (const c of frozen.cases) {
  caseSeq += 1;
  db.prepare(
    `INSERT INTO cases (id, case_number, institution_id, triage_state, received_at, source_channel, source_reference, category,
       complaint_summary, bureau, assigned_officer_id, status, version, created_by, created_at, updated_at)
     VALUES (?,?,?, 'resolved', ?, 'Email', ?, ?, ?, ?, 'u-eval', 'Under review', 1, 'u-eval', ?, ?)`
  ).run(
    c.key,
    `EVAL-${String(caseSeq).padStart(4, '0')}`,
    c.institution,
    c.receivedAt,
    c.sourceReference,
    c.category,
    c.summary,
    // Alternate the owning bureau so every institution carries both bureaus, which is what makes the
    // institution overlap alert (>=2 bureaus with active cases) meaningful in the exact-ID evaluation.
    c.role === 'fee2' || c.role === 'hostel2' || c.role === 'lab' ? 'RB' : 'PGRC',
    nowIso,
    nowIso
  );
}
const rows = new Map(db.prepare('SELECT * FROM cases').all().map((r: any) => [r.id, r]));

/* ----------------------------------------------------------------- metrics */
interface Metrics { tp: number; fp: number; fn: number; tn: number }
const empty = (): Metrics => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

const dup = empty();
const rel = empty();
const any = empty();
const perSplit: Record<string, { dup: Metrics; rel: Metrics; any: Metrics; pairs: number }> = {
  tune: { dup: empty(), rel: empty(), any: empty(), pairs: 0 },
  heldout: { dup: empty(), rel: empty(), any: empty(), pairs: 0 },
};
const runtimeSamples: number[] = [];
const errors: { pair: string; label: Label; predicted: string; note: string; reasons: string[] }[] = [];

const classify = (a: any, b: any) => {
  const started = performance.now();
  const cand = evaluatePair(a, b);
  runtimeSamples.push(performance.now() - started);
  return cand;
};

for (let warm = 0; warm < 3; warm += 1) for (const p of frozen.pairs) classify(rows.get(p.a), rows.get(p.b));

const confusion: Record<string, number> = {};
for (const pair of frozen.pairs) {
  const cand = classify(rows.get(pair.a), rows.get(pair.b));
  const predicted: Label = cand === null ? 'unrelated' : cand.kind === 'Duplicate report' ? 'duplicate' : 'related';
  // One-vs-rest per class: precision/recall are only meaningful when each class is scored on its own.
  const tally = (m: Metrics, target: Label | 'any') => {
    const predictedIn = target === 'any' ? predicted !== 'unrelated' : predicted === target;
    const labelIn = target === 'any' ? pair.label !== 'unrelated' : pair.label === target;
    if (predictedIn && labelIn) m.tp += 1;
    else if (predictedIn && !labelIn) m.fp += 1;
    else if (!predictedIn && labelIn) m.fn += 1;
    else m.tn += 1;
  };
  const splitTally = perSplit[pair.split];
  splitTally.pairs += 1;
  tally(dup, 'duplicate');
  tally(rel, 'related');
  tally(any, 'any');
  tally(splitTally.dup, 'duplicate');
  tally(splitTally.rel, 'related');
  tally(splitTally.any, 'any');
  const cell = `${pair.label} → ${predicted}`;
  confusion[cell] = (confusion[cell] ?? 0) + 1;
  if (predicted !== pair.label) {
    errors.push({
      pair: `${pair.a} × ${pair.b}`,
      label: pair.label,
      predicted,
      note: pair.note,
      reasons: cand ? cand.reasons.map((r) => r.rule) : [],
    });
  }
}

const line = (name: string, m: Metrics) =>
  `  ${name.padEnd(22)} precision ${pct(m.tp, m.tp + m.fp).padStart(6)}  recall ${pct(m.tp, m.tp + m.fn).padStart(6)}  ` +
  `TP ${m.tp}  FP ${m.fp}  FN ${m.fn}  TN ${m.tn}`;

const sortedRuntime = runtimeSamples.slice().sort((a, b) => a - b);
const p = (q: number) => sortedRuntime[Math.min(sortedRuntime.length - 1, Math.floor(sortedRuntime.length * q))];

/* ------------------------------------------- adversarial probe (separate) */
// Outside the 120 labelled pairs: how does the rule cope when the same incident is restated with the
// vocabulary replaced? Reported as a descriptive rate, not as a pass/fail gate, because a lexical rule
// is expected to lose recall here — that is the honest boundary of a non-AI matcher.
const probeBase = {
  institution_id: 'i1',
  triage_state: 'resolved',
  status: 'Under review',
  category: 'Fee / refund',
  received_at: new Date(base).toISOString(),
} as any;
const probeCanonical = {
  ...probeBase,
  source_reference: null,
  complaint_summary: 'Semester fee of Rs 18500 paid before withdrawal has not been refunded and the accounts section keeps deferring the payment.',
};
const probeVariants = [
  'The tuition money of Rs 18500 that I paid prior to cancelling my admission was never given back; the accounts office repeatedly postpones the payment.',
  'My academic charges amounting to Rs 18500, remitted before I quit the programme, remain unreimbursed; finance keeps delaying settlement.',
  'Admission cancelled, yet the course charges of Rs 18500 paid earlier were not returned and the billing desk postpones the credit each week.',
  'Rs 18500 of tuition paid before withdrawal is still outstanding with the college and the treasury office delays the remittance.',
  'Dues of Rs 18500 remitted earlier were not repaid after cancellation of admission; the accountant postpones the reimbursement.',
  'The programme was discontinued by me but the tuition of Rs 18500 already remitted has not been returned; accounts postpones payment.',
  'Cancellation of my enrolment did not result in the return of Rs 18500 tuition already paid, and finance keeps postponing settlement.',
  'Tuition of Rs 18500 remitted prior to quitting the course was not repaid; the accounts department defers the reimbursement repeatedly.',
  'I quit the programme after paying Rs 18500 tuition, yet no reimbursement came and the billing office postpones the payment.',
  'Payment of Rs 18500 tuition made before my withdrawal was never reimbursed; the accounts section postpones settlement every week.',
];
const probeDetected = probeVariants.filter(
  (summary) => evaluatePair(probeCanonical, { ...probeBase, source_reference: null, complaint_summary: summary }) !== null
).length;

/* ------------------------------------------------- exact-ID overlap check */
const overlapByInstitution = new Map<string, any>();
for (const inst of frozen.institutions) overlapByInstitution.set(inst.key, recomputeOverlap(inst.key));
const overlapChecks = frozen.institutions.map((inst) => {
  const expected = frozen.cases.filter((c) => c.institution === inst.key).length;
  const summary = overlapByInstitution.get(inst.key);
  return { institution: inst.key, expected, actual: summary.caseIds.length, state: summary.state };
});
const exactRefPairs = frozen.pairs.filter((p2) => {
  const a = rows.get(p2.a);
  const b = rows.get(p2.b);
  return a.source_reference && b.source_reference && a.source_reference === b.source_reference && a.institution_id === b.institution_id;
});
const exactRefHit = exactRefPairs.filter((p2) => {
  const cand = evaluatePair(rows.get(p2.a), rows.get(p2.b));
  return cand && cand.reasons.some((r) => r.rule === 'shared_external_reference');
}).length;
const crossInstitutionPairs = frozen.pairs.filter((p2) => rows.get(p2.a).institution_id !== rows.get(p2.b).institution_id);
const crossInstitutionFlagged = crossInstitutionPairs.filter((p2) => classify(rows.get(p2.a), rows.get(p2.b)) !== null).length;

/* ------------------------------------------------------------------ report */
const report = {
  version: frozen.version,
  fingerprint,
  similarityThreshold: SIMILARITY_THRESHOLD,
  institutions: frozen.institutions.length,
  complaints: frozen.cases.length,
  pairs: frozen.pairs.length,
  labelCounts: {
    duplicate: frozen.pairs.filter((x) => x.label === 'duplicate').length,
    related: frozen.pairs.filter((x) => x.label === 'related').length,
    unrelated: frozen.pairs.filter((x) => x.label === 'unrelated').length,
  },
  overall: { duplicate: dup, related: rel, anyCandidate: any },
  confusion,
  perSplit,
  runtimeMs: { pairs: runtimeSamples.length, p50: p(0.5), p95: p(0.95), total: runtimeSamples.reduce((a, b) => a + b, 0) },
  exactOverlap: { institutions: overlapChecks, exactReferencePairs: exactRefPairs.length, exactReferenceHits: exactRefHit, crossInstitutionPairs: crossInstitutionPairs.length, crossInstitutionFlagged },
  adversarialProbe: { synonymHeavyParaphrases: probeVariants.length, detected: probeDetected },
  illustrativeErrors: errors.slice(0, 8),
  errorCount: errors.length,
};

if (SWEEP) {
  // Threshold sweep on the TUNE split only. The held-out split is never used to choose a value.
  const sweepRows = ['0.25', '0.30', '0.34', '0.38', '0.42', '0.46', '0.50'].map((t) => {
    const child = spawnSync(path.join(repo, 'node_modules/.bin/tsx'), ['test/matching-eval.ts', '--tune-only'], {
      cwd: repo,
      env: { ...process.env, CASELINK_MATCH_THRESHOLD: t },
      encoding: 'utf8',
    });
    const out = child.stdout ?? '';
    const read = (label: string) => {
      const m = out.match(new RegExp(`${label}\\s+precision\\s+(\\S+)\\s+recall\\s+(\\S+)`));
      return m ? `${m[1]} / ${m[2]}` : 'n/a';
    };
    return { threshold: t, duplicate: read('duplicate'), related: read('related'), any: read('any candidate') };
  });
  console.log('threshold sweep on the tune split (precision / recall)');
  for (const r of sweepRows) console.log(`  ${r.threshold}  duplicate ${r.duplicate}  related ${r.related}  any ${r.any}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
console.log(`M6 matching evaluation — set ${frozen.version} (fingerprint ${fingerprint})`);
console.log(`  ${report.complaints} complaints · ${report.institutions} institutions · ${report.pairs} labelled pairs ` +
  `(duplicate ${report.labelCounts.duplicate} / related ${report.labelCounts.related} / unrelated ${report.labelCounts.unrelated})`);
console.log(`  rule similarity threshold ${SIMILARITY_THRESHOLD} · tune families ${frozen.institutions.filter((i: any) => i.split === 'tune').length} · held-out families ${frozen.institutions.filter((i: any) => i.split === 'heldout').length}`);
console.log(`\n  class-level results (whole set)`);
console.log(line('duplicate', dup));
console.log(line('related', rel));
console.log(line('any candidate', any));
for (const split of ['tune', 'heldout'] as const) {
  const s = perSplit[split];
  console.log(`\n  ${split} split (${s.pairs} pairs)`);
  console.log(line('duplicate', s.dup));
  console.log(line('related', s.rel));
  console.log(line('any candidate', s.any));
}
console.log('\n  confusion counts (label → prediction)');
for (const key of Object.keys(confusion).sort()) console.log(`    ${key.padEnd(26)} ${confusion[key]}`);
console.log(`\n  runtime for ${runtimeSamples.length} pair evaluations: p50 ${p(0.5).toFixed(3)} ms · p95 ${p(0.95).toFixed(3)} ms · total ${report.runtimeMs.total.toFixed(0)} ms`);
console.log(`\n  adversarial probe (outside the labelled set): synonym-heavy paraphrases of the same incident detected ${probeDetected}/${probeVariants.length}` +
  ` — a lexical rule is expected to lose recall when the wording, not just the order, changes.`);
console.log(`\n  exact-ID overlap evaluation (separate from wording matching)`);
for (const o of overlapChecks) console.log(`    ${o.institution.padEnd(4)} expected ${o.expected} cases in the institution alert · alert ${o.state} · cases ${o.actual}`);
console.log(`    shared-external-reference pairs flagged as duplicate evidence: ${exactRefHit}/${exactRefPairs.length}`);
console.log(`    cross-institution identical-wording pairs flagged as a relationship: ${crossInstitutionFlagged}/${crossInstitutionPairs.length}`);

const pass =
  report.labelCounts.duplicate === 40 &&
  report.labelCounts.related === 40 &&
  report.labelCounts.unrelated === 40 &&
  report.pairs === 120 &&
  report.complaints === 60 &&
  report.institutions === 10 &&
  overlapChecks.every((o) => o.actual === o.expected) &&
  exactRefHit === exactRefPairs.length &&
  crossInstitutionFlagged === 0;

console.log(`\n  result: ${pass ? 'PASS' : 'FAIL'} — set integrity, exact-ID overlap and the cross-institution negative control ${pass ? 'hold' : 'do not hold'}.`);
console.log('  Note: precision/recall above are measured on this synthetic set. The PRD 90% precision / 80% recall figures are a P1 target, not a measured result.');
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
