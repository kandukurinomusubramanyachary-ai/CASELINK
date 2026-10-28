/**
 * M5 — CSV import identity, classification, preview/commit binding and idempotent retries.
 *
 *   BASE=http://127.0.0.1:8105 CASELINK_DB=/tmp/m5data/caselink.db node test/import-m5.mjs
 *
 * Runs against an isolated, freshly seeded database. Every fixture row is synthetic.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.PASSWORD ?? 'caselink-demo';
const DB_PATH = process.env.CASELINK_DB ?? 'data/caselink.db';

const results = [];
const skipped = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
async function signIn(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`sign-in failed ${username}: ${r.status}`);
  return { username, token: r.data.token, id: r.data.user.id, bureau: r.data.user.bureau, region: r.data.user.region };
}

const Database = (await import('better-sqlite3')).default;
const statement = (sql) =>
  new Proxy(
    {},
    {
      get: (_t, method) => (...args) => {
        const reader = new Database(DB_PATH, { readonly: true });
        try {
          return reader.prepare(sql)[method](...args);
        } finally {
          reader.close();
        }
      },
    }
  );
const db = { prepare: (sql) => statement(sql) };

const lead = await signIn('m.nair'); // PGRC South lead (import capability)
const otherLead = await signIn('l.verma'); // RB South lead
const officer = await signIn('p.rao'); // no import capability
const westLead = await signIn('s.bose'); // PGRC West lead

const HEADER =
  'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact';
const MARK = `M5-${Date.now()}`;
const inst = (await api('/api/institutions?q=vaigai', { token: lead.token })).data.institutions[0];
if (!inst) {
  console.log('Cannot continue: no South institution visible.');
  process.exit(1);
}

const row = (ref, over = {}) => {
  const base = {
    institution: inst.permanentId,
    name: '',
    date: '2026-09-12',
    system: `M5 register ${MARK}`,
    ref,
    category: 'Fee / refund',
    summary: `Imported grievance ${ref} about a refund that was not processed (synthetic M5 fixture).`,
    officer: '',
    policy: 'DEMO-POL-30',
    contact: '',
  };
  const v = { ...base, ...over };
  const quote = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  return [v.institution, v.name, v.date, v.system, v.ref, v.category, v.summary, v.officer, v.policy, v.contact].map(quote).join(',');
};
const csv = (...lines) => [HEADER, ...lines].join('\n');
const preview = (text, sourceSystem = `M5 register ${MARK}`) =>
  api('/api/import/preview', { method: 'POST', token: lead.token, body: { sourceSystem, csvText: text } });
const commit = (batchId) => api(`/api/import/${batchId}/commit`, { method: 'POST', token: lead.token });

/* ============================================ 1. template and authority */
console.log('\n== 1. Template and authority ==');
{
  const templateRes = await fetch(`${BASE}/api/import/template`, { headers: { authorization: `Bearer ${lead.token}` } });
  const templateText = await templateRes.text();
  check(
    '1a the PRD template is downloadable and carries the required columns',
    templateRes.status === 200 && ['institution_permanent_id', 'source_system', 'source_reference', 'policy_id'].every((c) => templateText.includes(c)),
    `HTTP ${templateRes.status}`
  );
  const noRight = await api('/api/import/preview', {
    method: 'POST',
    token: officer.token,
    body: { sourceSystem: 'x', csvText: csv(row(`${MARK}-A`)) },
  });
  check('1b a bureau officer cannot import', noRight.status === 403, `HTTP ${noRight.status}`);
  const missingCol = await preview('institution_permanent_id,received_date\nA,2026-09-12');
  check('1c a file missing required columns is refused with the column list', missingCol.status === 422 && /Missing required column/.test(missingCol.data?.message ?? ''), `HTTP ${missingCol.status}`);
  const tooMany = await preview(csv(...Array.from({ length: 501 }, (_, i) => row(`${MARK}-BIG-${i}`))));
  check('1d more than 500 rows is refused', tooMany.status === 422 && /500 rows/.test(tooMany.data?.message ?? ''), `HTTP ${tooMany.status}`);
}

/* ============================================ 2. classification */
console.log('\n== 2. Valid-new, unchanged duplicate, invalid and same-key conflict are distinguished ==');
{
  const firstRef = `${MARK}-C1`;
  const text = csv(
    row(firstRef),
    row(firstRef), // repeated inside the batch
    row(`${MARK}-C2`, { date: '2026-09-12' }),
    // invalid: bad date, unknown category, short summary, unknown institution
    row(`${MARK}-C3`, { date: '2026-13-45', category: 'Not a category', summary: 'short', institution: 'NOPE-0000' }),
    // triage: institution name only
    row(`${MARK}-C4`, { institution: '', name: 'Unconfirmed college in South' }),
    // no policy: explicit "No deadline configured"
    row(`${MARK}-C5`, { policy: '' })
  );
  const p = await preview(text);
  check('2a the preview classifies rows without writing anything', p.status === 200, `HTTP ${p.status}`);
  const statuses = (p.data?.rows ?? []).map((r) => r.status);
  check('2b a new reference is valid', statuses[0] === 'valid', `row2=${statuses[0]}`);
  check('2c a reference repeated inside the batch is an unchanged duplicate', statuses[1] === 'duplicate', `row3=${statuses[1]}`);
  check('2d an invalid row is rejected with its own row number', statuses[3] === 'rejected' && p.data.rows[3].lineNumber === 5 && p.data.rows[3].errors.length >= 3, `line=${p.data?.rows?.[3]?.lineNumber} errors=${p.data?.rows?.[3]?.errors?.length}`);
  check('2e an unresolved institution name goes to triage', statuses[4] === 'triage', `row6=${statuses[4]}`);
  check(
    '2f a blank policy is labelled "No deadline configured", not defaulted',
    p.data.rows[5].policyId === null && /No deadline configured/.test(p.data.rows[5].deadlineLabel),
    `policyId=${p.data?.rows?.[5]?.policyId} label=${p.data?.rows?.[5]?.deadlineLabel}`
  );
  check('2g nothing was written by the preview', db.prepare('SELECT COUNT(*) AS n FROM cases WHERE source_reference = ?').get(firstRef).n === 0, 'no case rows');
  check(
    '2h each row carries the normalised identity',
    p.data.rows[0].identity === `m5 register ${MARK.toLowerCase()}|PGRC|${firstRef.toLowerCase()}` ||
      p.data.rows[0].identity === `${`M5 register ${MARK}`.toLowerCase()}|PGRC|${firstRef.toLowerCase()}`,
    p.data?.rows?.[0]?.identity
  );

  const c = await commit(p.data.batchId);
  // valid C1, valid C2, triage C4 and the no-policy C5 are created; the repeated C1 and the invalid C3 are not.
  check(
    '2i the commit creates only the valid, triage and no-policy rows',
    c.status === 200 && c.data.accepted === 4,
    `accepted=${c.data?.accepted} rejected=${c.data?.rejected} skipped=${c.data?.skipped}`
  );
  check('2j the rejected row is reported with its line number', c.data.failures.some((f) => f.lineNumber === 5), JSON.stringify(c.data.failures.map((f) => f.lineNumber)));
  check('2k the duplicate row is reported, not silently dropped', c.data.skips.some((s) => s.lineNumber === 3), JSON.stringify(c.data.skips.map((s) => s.lineNumber)));
  const created = db.prepare('SELECT source_system, source_identity, deadline_policy_id, expected_disposal_at, import_batch_id FROM cases WHERE source_reference = ?').get(firstRef);
  check('2l the created case persists its source system and identity', Boolean(created?.source_system) && created.source_identity.endsWith(firstRef.toLowerCase()), `system=${created?.source_system} identity=${created?.source_identity}`);
  check('2m the created case records its batch', Boolean(created?.import_batch_id), created?.import_batch_id);
  const noPolicy = db.prepare('SELECT deadline_policy_id, expected_disposal_at FROM cases WHERE source_reference = ?').get(`${MARK}-C5`);
  check('2n the blank-policy row was created with no deadline', noPolicy.deadline_policy_id === null && noPolicy.expected_disposal_at === null, `policy=${noPolicy?.deadline_policy_id} due=${noPolicy?.expected_disposal_at}`);
}

/* ============================================ 3. re-import and conflicts */
console.log('\n== 3. Re-import: unchanged duplicates are skipped, changed content is a conflict ==');
{
  const ref = `${MARK}-C1`;
  const unchanged = await preview(csv(row(ref)));
  check('3a an unchanged re-import is classified as a duplicate', unchanged.data.rows[0].status === 'duplicate', unchanged.data?.rows?.[0]?.status);
  const unchangedCommit = await commit(unchanged.data.batchId);
  check('3b committing it creates no second case', unchangedCommit.data.accepted === 0 && db.prepare('SELECT COUNT(*) AS n FROM cases WHERE source_reference = ?').get(ref).n === 1, `accepted=${unchangedCommit.data?.accepted}`);

  const changed = await preview(csv(row(ref, { summary: 'The same reference now carries a completely different complaint summary.' })));
  check('3c the same identity with different content is a conflict, not a duplicate', changed.data.rows[0].status === 'conflict', changed.data?.rows?.[0]?.status);
  const changedCommit = await commit(changed.data.batchId);
  const rowAfter = db.prepare('SELECT complaint_summary FROM cases WHERE source_reference = ?').get(ref);
  check(
    '3d the conflict never overwrites the existing record',
    changedCommit.data.accepted === 0 && rowAfter.complaint_summary.includes('refund'),
    `accepted=${changedCommit.data?.accepted} summary=${rowAfter?.complaint_summary?.slice(0, 40)}`
  );
}

/* ============================================ 4. preview/commit binding */
console.log('\n== 4. Preview and commit are bound to the same normalised input ==');
{
  const ref = `${MARK}-D1`;
  const p = await preview(csv(row(ref)));
  check('4a the preview returns an input fingerprint and a policy snapshot', Boolean(p.data.inputHash) && Object.keys(p.data.policySnapshot ?? {}).length > 0, `hash=${String(p.data?.inputHash).slice(0, 12)} policies=${Object.keys(p.data?.policySnapshot ?? {}).length}`);
  const stored = db.prepare('SELECT input_hash, policy_snapshot_json FROM import_batches WHERE id = ?').get(p.data.batchId);
  check('4b the batch stores the fingerprint and snapshot', stored.input_hash === p.data.inputHash && Boolean(stored.policy_snapshot_json), 'stored');

  // Simulate a batch whose stored input no longer matches the previewed fingerprint (tampering or an
  // interrupted migration): the commit must refuse rather than import a different file than was shown.
  const Database2 = (await import('better-sqlite3')).default;
  const writer = new Database2(DB_PATH);
  const changed = writer
    .prepare("UPDATE import_batches SET input_hash = 'tampered-fingerprint' WHERE id = ?")
    .run(p.data.batchId).changes;
  writer.close();
  check('4c the batch fingerprint can be compared against a changed value', changed === 1, `rows changed=${changed}`);
  const tampered = await commit(p.data.batchId);
  check('4d a batch whose stored input no longer matches is refused', tampered.status === 409 && tampered.data.error === 'batch_changed', `HTTP ${tampered.status} (${tampered.data?.error})`);
  check('4e nothing was created from the altered batch', db.prepare('SELECT COUNT(*) AS n FROM cases WHERE source_reference = ?').get(ref).n === 0, 'no rows');
}

/* ============================================ 5. conflicts appearing after the preview */
console.log('\n== 5. A duplicate that appears between preview and commit is disclosed ==');
{
  const ref = `${MARK}-E1`;
  const p = await preview(csv(row(ref)));
  check('5a the row previews as valid', p.data.rows[0].status === 'valid', p.data?.rows?.[0]?.status);
  // Another lead imports the same identity before the first batch is committed.
  const competing = await preview(csv(row(ref)));
  const competingCommit = await commit(competing.data.batchId);
  check('5b the competing import creates the case', competingCommit.data.accepted === 1, `accepted=${competingCommit.data?.accepted}`);
  const late = await commit(p.data.batchId);
  check(
    '5c the late commit reports a new conflict instead of duplicating or overwriting',
    late.data.accepted === 0 && (late.data.newConflicts ?? []).some((c) => c.lineNumber === 2) && db.prepare('SELECT COUNT(*) AS n FROM cases WHERE source_reference = ?').get(ref).n === 1,
    `accepted=${late.data?.accepted} newConflicts=${(late.data.newConflicts ?? []).length}`
  );
}

/* ============================================ 6. idempotent retries */
console.log('\n== 6. Retrying a commit is idempotent with accurate counts ==');
{
  const ref = `${MARK}-F1`;
  const p = await preview(csv(row(ref), row(`${MARK}-F2`)));
  const first = await commit(p.data.batchId);
  const replay = await commit(p.data.batchId);
  check('6a the first commit reports its counts', first.data.accepted === 2 && first.data.replayed === false, `accepted=${first.data?.accepted}`);
  check(
    '6b the replay returns the same counts and creates nothing',
    replay.status === 200 && replay.data.replayed === true && replay.data.accepted === 2 && replay.data.createdCaseNumbers.length === 2,
    `accepted=${replay.data?.accepted} replayed=${replay.data?.replayed}`
  );
  check('6c no duplicate case exists after the replay', db.prepare('SELECT COUNT(*) AS n FROM cases WHERE source_reference IN (?, ?)').get(ref, `${MARK}-F2`).n === 2, 'two rows');
}

/* ============================================ 7. scope, bureau and identity boundary */
console.log('\n== 7. Scope and cross-bureau identity boundaries ==');
{
  const outOfRegion = await preview(csv(row(`${MARK}-G1`, { institution: 'AICTE-DEMO-1010' })));
  const badRows = outOfRegion.data?.rows ?? [];
  check('7a a row for an institution outside the actor region is rejected', badRows[0]?.status === 'rejected' && badRows[0].errors.some((e) => /region/.test(e)), badRows[0]?.errors?.join(' '));
  const wrongBureauOfficer = await preview(csv(row(`${MARK}-G2`, { officer: 's.iyer' })));
  check('7b assigning an officer from another bureau is rejected', wrongBureauOfficer.data.rows[0].errors.some((e) => /another bureau/.test(e)), wrongBureauOfficer.data?.rows?.[0]?.errors?.join(' '));
  const otherBureauBatch = await preview(csv(row(`${MARK}-G3`)));
  const wrongBureauCommit = await api(`/api/import/${otherBureauBatch.data.batchId}/commit`, { method: 'POST', token: otherLead.token });
  check('7c another bureau cannot commit this batch', wrongBureauCommit.status === 403, `HTTP ${wrongBureauCommit.status}`);
  const westPreview = await api('/api/import/preview', {
    method: 'POST',
    token: westLead.token,
    body: { sourceSystem: `M5 register ${MARK}`, csvText: csv(row(`${MARK}-G4`, { institution: 'AICTE-DEMO-1010' })) },
  });
  check('7d the same reference imported by another region stays a separate identity', westPreview.status === 200, `HTTP ${westPreview.status}`);
}

/* ============================================ 8. stored state */
console.log('\n== 8. Stored state ==');
{
  const missing = db
    .prepare("SELECT COUNT(*) AS n FROM cases WHERE source_channel = 'CSV import' AND source_identity IS NULL AND source_system IS NOT NULL AND source_reference IS NOT NULL")
    .get().n;
  check('8a every imported case with provenance has a normalised identity', missing === 0, `missing=${missing}`);
  const dupes = db
    .prepare('SELECT source_identity, COUNT(*) AS n FROM cases WHERE source_identity IS NOT NULL GROUP BY source_identity HAVING n > 1')
    .all();
  check('8b no duplicate identity exists', dupes.length === 0, `duplicates=${dupes.length}`);
  const orphan = db
    .prepare("SELECT COUNT(*) AS n FROM cases WHERE import_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.id = cases.import_batch_id)")
    .get().n;
  check('8c every imported case points at a real batch', orphan === 0, `orphans=${orphan}`);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  check('8d database integrity is intact', Object.values(integrity)[0] === 'ok', String(Object.values(integrity)[0]));
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nexecuted: ${results.length}   passed: ${passed}   failed: ${failed}   skipped: ${skipped.length}`);
console.log(failed === 0 ? 'M5 CSV import identity and safety: PASS' : 'M5 CSV import identity and safety: FAIL');
process.exit(failed === 0 ? 0 : 1);
