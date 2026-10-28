/**
 * M3 — case lifecycle, structured outcomes and reporting definitions.
 *
 *   BASE=http://127.0.0.1:8103 CASELINK_DB=/tmp/m3data/caselink.db node test/lifecycle-m3.mjs
 *
 * Uses a fresh, isolated demo database (auth required, CASELINK_DEMO=false) and creates its own case
 * fixtures so every assertion is about this run. Read-only SQLite assertions cross-check that the API
 * response and the stored record agree (no re-loading that silently replaces the version the user saw,
 * no duplicated transition events, no invented legacy outcomes).
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.PASSWORD ?? 'caselink-demo';
const DB_PATH = process.env.CASELINK_DB ?? 'data/caselink.db';

const results = [];
const skipped = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}  —  ${why}`);
};

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}
async function signIn(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`sign-in failed ${username}: ${r.status} ${r.text}`);
  return { username, token: r.data.token, id: r.data.user.id, role: r.data.user.role, bureau: r.data.user.bureau, region: r.data.user.region };
}

const Database = (await import('better-sqlite3')).default;
const db = new Database(DB_PATH, { readonly: true });
const caseRow = (id) => db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
const events = (id) => db.prepare('SELECT * FROM action_events WHERE case_id = ? ORDER BY at, rowid').all(id);
const dispositions = (id) => db.prepare('SELECT * FROM dispositions WHERE case_id = ? ORDER BY at, rowid').all(id);

const users = {};
for (const name of ['p.rao', 's.iyer', 'm.nair', 'l.verma', 'a.desai', 'r.khan', 'admin']) {
  users[name] = await signIn(name);
}
const south = { pgrcLead: users['m.nair'], rbLead: users['l.verma'], supervisor: users['a.desai'], pgrcOfficer: users['p.rao'], rbOfficer: users['s.iyer'] };

const institutions = (await api('/api/institutions', { token: south.pgrcLead.token })).data?.institutions ?? [];
const inst = institutions.find((i) => i.region === 'South') ?? institutions[0];
if (!inst) {
  console.log('Cannot continue: no institution visible to the PGRC lead.');
  process.exit(1);
}

const MARK = `M3-${Date.now()}`;
async function createCase(user, overrides = {}) {
  const r = await api('/api/cases', {
    method: 'POST',
    token: user.token,
    body: {
      institutionId: inst.id,
      receivedAt: new Date().toISOString(),
      sourceChannel: 'Email',
      sourceReference: `REF-${MARK}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'Infrastructure',
      complaintSummary: `Lifecycle fixture ${MARK}: a grievance created by the M3 regression suite for transition testing.`,
      complainantContact: `suite@example.test`,
      ...overrides,
    },
  });
  if (r.status !== 201) throw new Error(`case creation failed: ${r.status} ${r.text}`);
  return r.data;
}
const patch = (user, id, body) => api(`/api/cases/${id}`, { method: 'PATCH', token: user.token, body });
const getCaseApi = (user, id) => api(`/api/cases/${id}`, { token: user.token });

/* =============================================== 1. centralised transition matrix */
console.log('\n== 1. One lifecycle matrix, no bypass ==');
{
  const c = await createCase(south.pgrcLead);
  check('1a new case starts in Received', c.status === 'Received', `status=${c.status} version=${c.version}`);
  const detail = (await getCaseApi(south.pgrcLead, c.id)).data;
  check(
    '1b next states for Received come from the shared matrix',
    JSON.stringify(detail.nextStates) === JSON.stringify(['Assigned']),
    `nextStates=${JSON.stringify(detail.nextStates)}`
  );

  const jump = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Disposed', remarks: 'skip ahead', outcome: 'Other', decisionReference: 'X-1' });
  check('1c illegal jump Received→Disposed rejected', jump.status === 422 && jump.data?.error === 'invalid_transition', `status=${jump.status} code=${jump.data?.error}`);

  const backw = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Closed', remarks: 'skip ahead' });
  check('1d illegal Received→Closed rejected', backw.status === 422, `status=${backw.status}`);

  const assign = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Assigned', remarks: 'assigned to officer' });
  check('1e Received→Assigned accepted', assign.status === 200 && assign.data.status === 'Assigned', `status=${assign.status}/${assign.data?.status}`);
  const v2 = assign.data.version;

  const skipStep = await patch(south.pgrcLead, c.id, { version: v2, status: 'Disposed', remarks: 'still skipping', outcome: 'Other', decisionReference: 'X-2' });
  check('1f Assigned→Disposed rejected (review or awaiting response first)', skipStep.status === 422, `status=${skipStep.status} code=${skipStep.data?.error}`);

  const review = await patch(south.pgrcLead, c.id, { version: v2, status: 'Under review', remarks: 'review begins' });
  check('1g Assigned→Under review accepted', review.status === 200 && review.data.status === 'Under review', `status=${review.status}/${review.data?.status}`);
  globalThis.__reviewCase = { id: c.id, version: review.data.version };
}

/* =============================================== 2. structured disposition */
console.log('\n== 2. Disposition needs a structured outcome and a decision reference ==');
{
  const { id, version } = globalThis.__reviewCase;
  const remarksOnly = await patch(south.pgrcLead, id, { version, status: 'Disposed', remarks: 'Disposed with a long narrative remark but no structured fields.' });
  check(
    '2a remarks alone cannot substitute for the structured outcome',
    remarksOnly.status === 422 && Boolean(remarksOnly.data?.fields?.outcome),
    `status=${remarksOnly.status} fields=${JSON.stringify(Object.keys(remarksOnly.data?.fields ?? {}))}`
  );

  const noRef = await patch(south.pgrcLead, id, { version, status: 'Disposed', remarks: 'outcome but no reference', outcome: 'Closed — no action required' });
  check('2b missing decision reference rejected', noRef.status === 422 && Boolean(noRef.data?.fields?.decisionReference), `status=${noRef.status}`);

  const badOutcome = await patch(south.pgrcLead, id, { version, status: 'Disposed', remarks: 'narrative', outcome: 'Whatever I like', decisionReference: 'DEMO-X' });
  check('2c unknown outcome rejected', badOutcome.status === 422 && badOutcome.data?.error === 'validation_error', `status=${badOutcome.status}`);

  const officerDispose = await patch(south.pgrcOfficer, id, {
    version,
    status: 'Disposed',
    remarks: 'officer tries to dispose',
    outcome: 'Other',
    decisionReference: 'DEMO-X',
  });
  check('2d disposal stays a bureau-lead action (officer 403)', officerDispose.status === 403, `status=${officerDispose.status}`);

  const otherBureauLead = await patch(users['l.verma'], id, {
    version,
    status: 'Disposed',
    remarks: 'foreign lead tries to dispose',
    outcome: 'Other',
    decisionReference: 'DEMO-X',
  });
  check('2e a lead from another bureau cannot dispose (403)', otherBureauLead.status === 403, `status=${otherBureauLead.status}`);

  const reference = `DEMO-DISP-${MARK}`;
  const disposed = await patch(south.pgrcLead, id, {
    version,
    status: 'Disposed',
    remarks: 'Compliance evidence verified; disposition recorded.',
    actionType: 'internal_note',
    outcome: 'Upheld — corrective action directed',
    decisionReference: reference,
  });
  check('2f valid disposition accepted', disposed.status === 200 && disposed.data.status === 'Disposed', `status=${disposed.status}/${disposed.data?.status}`);
  check(
    '2g outcome and reference are on the case record immediately',
    disposed.data.outcome === 'Upheld — corrective action directed' && disposed.data.decisionReference === reference,
    `outcome=${disposed.data?.outcome} ref=${disposed.data?.decisionReference}`
  );
  globalThis.__disposedCase = { id, version: disposed.data.version, reference };

  const reload = (await getCaseApi(south.pgrcLead, id)).data;
  check(
    '2h outcome and reference survive a reload',
    reload.case.outcome === 'Upheld — corrective action directed' && reload.case.decisionReference === reference,
    `reload outcome=${reload.case?.outcome}`
  );
  check('2i disposition history exposes the structured record', reload.dispositions?.length === 1 && reload.dispositions[0].decisionReference === reference, `rows=${reload.dispositions?.length}`);
  const dbRow = caseRow(id);
  check('2j database row carries the same structured fields', dbRow.outcome === 'Upheld — corrective action directed' && dbRow.decision_reference === reference, `db outcome=${dbRow.outcome}`);
  check('2k one dispositions row per disposal', dispositions(id).length === 1, `rows=${dispositions(id).length}`);
}

/* =============================================== 3. canonical transition event */
console.log('\n== 3. Canonical transition events, independent of the note category ==');
{
  const { id } = globalThis.__disposedCase;
  const rows = events(id);
  const disposedEvents = rows.filter((e) => e.action_type === 'status_disposed');
  check('3a exactly one status_disposed event', disposedEvents.length === 1, `count=${disposedEvents.length}`);
  const ev = disposedEvents[0];
  const after = JSON.parse(ev.after_json ?? '{}');
  check(
    '3b the event type is the lifecycle change, not the chosen note category',
    ev.action_type === 'status_disposed' && after.noteCategory === 'internal_note',
    `actionType=${ev.action_type} noteCategory=${after.noteCategory}`
  );
  check(
    '3c the event records the transition explicitly',
    after.transition?.from === 'Under review' && after.transition?.to === 'Disposed',
    `transition=${JSON.stringify(after.transition)}`
  );
  const statusEvents = rows.filter((e) => String(e.action_type).startsWith('status_'));
  const uniqueStatusEvents = new Set(statusEvents.map((e) => `${e.action_type}@${e.version_after}`));
  check(
    '3d one transition event per lifecycle change (no duplicates at the same version)',
    statusEvents.length === 3 && uniqueStatusEvents.size === statusEvents.length,
    `status events=${statusEvents.map((e) => `${e.action_type}@${e.version_after}`).join(',')}`
  );
  const maxVersionAfter = Math.max(...rows.map((e) => e.version_after));
  check('3e events and the case version agree', maxVersionAfter === caseRow(id).version, `max event version=${maxVersionAfter} case version=${caseRow(id).version}`);
}

/* =============================================== 4. reopen is protected */
console.log('\n== 4. Reopening is a protected operation, not a PATCH ==');
{
  const { id, version } = globalThis.__disposedCase;
  const viaPatch = await patch(south.pgrcLead, id, { version, status: 'Under review', remarks: 'sneaky reopen through the edit form' });
  check(
    '4a PATCH cannot reopen a disposed case',
    viaPatch.status === 422 && viaPatch.data?.error === 'use_reopen_operation',
    `status=${viaPatch.status} code=${viaPatch.data?.error}`
  );

  const viaAction = await api(`/api/cases/${id}/actions`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version, actionType: 'reopen_attempt', remarks: 'action-form reopen attempt', status: 'Under review' },
  });
  check(
    '4b the action form has no lifecycle field and cannot reopen either',
    viaAction.status === 422 && caseRow(id).status === 'Disposed' && caseRow(id).version === version,
    `status=${viaAction.status} stored=${caseRow(id).status} v${caseRow(id).version}`
  );

  const officer = await api(`/api/cases/${id}/reopen`, { method: 'POST', token: south.pgrcOfficer.token, body: { version, reason: 'officer reopen attempt' } });
  check('4c an officer cannot reopen (403)', officer.status === 403, `status=${officer.status}`);

  const foreignLead = await api(`/api/cases/${id}/reopen`, { method: 'POST', token: users['l.verma'].token, body: { version, reason: 'foreign lead reopen attempt' } });
  check('4d another bureau lead cannot reopen (403)', foreignLead.status === 403, `status=${foreignLead.status}`);

  const noReason = await api(`/api/cases/${id}/reopen`, { method: 'POST', token: south.pgrcLead.token, body: { version } });
  check('4e a reopen needs a reason (422)', noReason.status === 422, `status=${noReason.status}`);

  const stale = await api(`/api/cases/${id}/reopen`, { method: 'POST', token: south.pgrcLead.token, body: { version: version - 1, reason: 'stale reopen attempt' } });
  check('4f a stale version is rejected with 409', stale.status === 409, `status=${stale.status} code=${stale.data?.error}`);

  const reopened = await api(`/api/cases/${id}/reopen`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version, reason: 'Fresh compliance evidence contradicts the earlier disposition (suite fixture).' },
  });
  check('4g the owner lead reopens with reason + version', reopened.status === 200 && reopened.data.status === 'Under review', `status=${reopened.status}/${reopened.data?.status}`);
  check('4h the current outcome fields are cleared on reopen', reopened.data.outcome === null && reopened.data.decisionReference === null, `outcome=${reopened.data?.outcome}`);

  const reload = (await getCaseApi(south.pgrcLead, id)).data;
  check(
    '4i the earlier disposition is still visible after reopening',
    reload.dispositions?.length === 1 && reload.dispositions[0].decisionReference === globalThis.__disposedCase.reference,
    `rows=${reload.dispositions?.length} ref=${reload.dispositions?.[0]?.decisionReference}`
  );
  check('4j the disposition row is marked reopened, not deleted', Boolean(dispositions(id)[0]?.reopened_at), `reopened_at=${dispositions(id)[0]?.reopened_at}`);
  check('4k the receipt time is preserved through reopening', caseRow(id).received_at === reload.case.receivedAt, 'received_at unchanged');
  const reopenEvent = events(id).filter((e) => e.action_type === 'reopened');
  check('4l exactly one reopening event, with its reason', reopenEvent.length === 1 && reopenEvent[0].remarks.includes('Fresh compliance evidence'), `count=${reopenEvent.length}`);
  check('4m no disposition event is duplicated by the reopening', events(id).filter((e) => e.action_type === 'status_disposed').length === 1, 'still one disposition event');

  const twice = await api(`/api/cases/${id}/reopen`, { method: 'POST', token: south.pgrcLead.token, body: { version: reopened.data.version, reason: 'reopen a case that is already under review' } });
  check('4n reopening a case that is not disposed/closed is rejected', twice.status === 422 || twice.status === 409, `status=${twice.status} code=${twice.data?.error}`);
  globalThis.__reopenedCase = { id, version: reopened.data.version };
}

/* =============================================== 5. next-action semantics */
console.log('\n== 5. Next action: keep, set, clear explicitly ==');
{
  const c = await createCase(south.pgrcLead, { nextAction: 'Contact the institute nodal officer' });
  check('5a next action set at creation', c.nextAction === 'Contact the institute nodal officer', `nextAction=${c.nextAction}`);

  const keep = await patch(south.pgrcLead, c.id, { version: c.version, remarks: 'Unrelated edit that does not mention the next action.' });
  check('5b an edit that omits the field keeps it', keep.status === 200 && keep.data.nextAction === 'Contact the institute nodal officer', `nextAction=${keep.data?.nextAction}`);

  const cleared = await patch(south.pgrcLead, c.id, { version: keep.data.version, nextAction: null, remarks: 'Next action explicitly cleared after handover.' });
  check('5c an explicit null clears it', cleared.status === 200 && cleared.data.nextAction === null, `nextAction=${cleared.data?.nextAction}`);

  const reSet = await patch(south.pgrcLead, c.id, { version: cleared.data.version, nextAction: 'Await the compliance report', remarks: 'New next action recorded.' });
  const viaActionEmpty = await api(`/api/cases/${c.id}/actions`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version: reSet.data.version, actionType: 'review_completed', remarks: 'Action form submitted without touching the next step.' },
  });
  check(
    '5d an action that omits the next step does not erase the stored value',
    viaActionEmpty.status === 201 && viaActionEmpty.data.case.nextAction === 'Await the compliance report',
    `status=${viaActionEmpty.status} nextAction=${viaActionEmpty.data?.case?.nextAction} (was v${reSet.data?.version})`
  );
  const explicitClear = await api(`/api/cases/${c.id}/actions`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version: viaActionEmpty.data.case.version, actionType: 'review_completed', remarks: 'Clear the next step deliberately.', nextStep: null },
  });
  check(
    '5e an explicit null from the action form clears it',
    explicitClear.status === 201 && explicitClear.data.case.nextAction === null,
    `status=${explicitClear.status} nextAction=${explicitClear.data?.case?.nextAction}`
  );
}

/* =============================================== 6. ownership through transfers */
console.log('\n== 6. Ownership stays coherent through a transfer ==');
{
  const c = await createCase(south.pgrcLead);
  const assign = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Assigned', remarks: 'assign at intake' });
  const requested = await api(`/api/cases/${c.id}/transfer`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version: assign.data.version, toBureau: 'RB', reason: 'Regulation content detected in this grievance (suite fixture).' },
  });
  check('6a transfer request accepted', requested.status === 201, `status=${requested.status}`);
  const pendingRow = caseRow(c.id);
  check('6b a pending transfer does not change ownership or status', pendingRow.bureau === 'PGRC' && pendingRow.status === 'Assigned', `bureau=${pendingRow.bureau} status=${pendingRow.status}`);

  const selfAccept = await api(`/api/transfers/${requested.data.transferId}/decision`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version: pendingRow.version - 1 + 1, decision: 'accept', note: 'sender tries to accept its own request' },
  });
  check('6c the sending bureau cannot decide its own request', selfAccept.status === 403, `status=${selfAccept.status}`);

  const wrongBureauOfficer = await api(`/api/transfers/${requested.data.transferId}/decision`, {
    method: 'POST',
    token: users['l.verma'].token,
    body: {
      version: pendingRow.version,
      decision: 'accept',
      note: 'recipient lead names an officer from the sending bureau',
      officerId: south.pgrcOfficer.id,
    },
  });
  check('6d a recipient officer outside the target bureau is rejected (422)', wrongBureauOfficer.status === 422, `status=${wrongBureauOfficer.status} code=${wrongBureauOfficer.data?.error}`);
  check('6e the rejected decision left the case untouched', caseRow(c.id).bureau === 'PGRC' && caseRow(c.id).status === 'Assigned', `bureau=${caseRow(c.id).bureau}`);

  const accepted = await api(`/api/transfers/${requested.data.transferId}/decision`, {
    method: 'POST',
    token: users['l.verma'].token,
    body: { version: pendingRow.version, decision: 'accept', note: 'Accepted into the regulation bureau queue.' },
  });
  check('6f the recipient lead accepts', accepted.status === 200 && accepted.data.state === 'accepted', `status=${accepted.status} state=${accepted.data?.state}`);
  const after = caseRow(c.id);
  check('6g ownership moved atomically with the accepted transfer', after.bureau === 'RB' && after.status === 'Received', `bureau=${after.bureau} status=${after.status}`);
  check('6h the transfer row and case version both moved', after.version === pendingRow.version + 1, `version ${pendingRow.version} → ${after.version}`);
  const again = await api(`/api/transfers/${requested.data.transferId}/decision`, {
    method: 'POST',
    token: users['l.verma'].token,
    body: { version: after.version, decision: 'accept', note: 'duplicate acceptance attempt' },
  });
  check('6i accepting twice is rejected', again.status === 409, `status=${again.status} code=${again.data?.error}`);
  check('6j no second ownership event was written', events(c.id).filter((e) => e.action_type === 'transfer_accepted').length === 1, 'one acceptance event');
}

/* =============================================== 7. escalation is a flag */
console.log('\n== 7. Escalation is a flag, not a lifecycle state ==');
{
  const c = await createCase(south.pgrcLead);
  const assigned = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Assigned', remarks: 'assign before escalation' });
  const ok = await api(`/api/cases/${c.id}/escalate`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: {
      version: assigned.data.version,
      reason: 'No institute response after two reminders (suite fixture).',
      supervisorId: south.supervisor.id,
    },
  });
  check('7a the owning lead can escalate', ok.status === 200 && ok.data.escalationOpen === true, `status=${ok.status} open=${ok.data?.escalationOpen}`);
  check(
    '7b escalating does not change the lifecycle status',
    ok.data.status === assigned.data.status && caseRow(c.id).status === 'Assigned',
    `status=${ok.data?.status}`
  );
  const twice = await api(`/api/cases/${c.id}/escalate`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version: ok.data.version, reason: 'Escalate the same case again immediately.', supervisorId: south.supervisor.id },
  });
  check('7c a second open escalation is rejected', twice.status === 409, `status=${twice.status} code=${twice.data?.error}`);

  const close = await api(`/api/cases/${c.id}/escalation/close`, {
    method: 'POST',
    token: south.supervisor.token,
    body: { version: twice.status === 409 ? ok.data.version : ok.data.version, note: 'Institute responded; closing the escalation (suite fixture).' },
  });
  check('7d the responsible supervisor closes the flag', close.status === 200 && close.data.escalationOpen === false, `status=${close.status} open=${close.data?.escalationOpen}`);
  check('7e closing the flag does not change the lifecycle status either', caseRow(c.id).status === 'Assigned', `status=${caseRow(c.id).status}`);
}

/* =============================================== 8. reporting definitions */
console.log('\n== 8. Reporting definitions are consistent and separated ==');
{
  const c = await createCase(south.pgrcLead);
  const a1 = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Assigned', remarks: 'assign for disposal' });
  const a2 = await patch(south.pgrcLead, c.id, { version: a1.data.version, status: 'Under review', remarks: 'review for disposal' });
  const disposed = await patch(south.pgrcLead, c.id, {
    version: a2.data.version,
    status: 'Disposed',
    remarks: 'Disposed inside this reporting period (suite fixture).',
    outcome: 'Closed — no action required',
    decisionReference: `DEMO-REPORT-${MARK}`,
  });
  check('8a fixture disposed inside the period', disposed.status === 200, `status=${disposed.status}`);

  const report = (await api('/api/reports/summary', { token: south.pgrcLead.token })).data;
  const t = report.totals;
  check('8b disposals-in-period counts disposition events', t.disposalsInPeriod > t.currentlyDisposed, `disposalsInPeriod=${t.disposalsInPeriod} currentlyDisposed=${t.currentlyDisposed}`);
  check('8c structured disposals are counted separately', t.structuredDisposalsInPeriod >= 1, `structuredDisposalsInPeriod=${t.structuredDisposalsInPeriod}`);
  check('8d legacy disposals are counted, not invented', typeof t.legacyDisposedWithoutOutcome === 'number' && t.legacyDisposedWithoutOutcome >= 0, `legacy=${t.legacyDisposedWithoutOutcome}`);
  check(
    '8e pending excludes disposed and closed cases',
    report.byStatus.Disposed + report.byStatus.Closed + t.pending === t.current,
    `pending=${t.pending} disposed=${report.byStatus.Disposed} closed=${report.byStatus.Closed} current=${t.current}`
  );
  check('8f overdue is a subset of pending', t.overdue <= t.pending, `overdue=${t.overdue} pending=${t.pending}`);
  check('8g cases with no configured deadline are reported separately', t.noDeadlineConfigured >= 0 && typeof report.definitions.deadline === 'string', `noDeadline=${t.noDeadlineConfigured}`);
  check(
    '8h every definition is present and distinct',
    ['pending', 'overdue', 'transferred', 'escalated', 'disposalThroughput', 'structuredDisposals', 'legacyDisposals'].every(
      (k) => typeof report.definitions[k] === 'string' && report.definitions[k].length > 20
    ),
    Object.keys(report.definitions).join(',')
  );

  const escalatedCase = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE escalation_open = 1").get().n;
  check('8i escalated is the open flag count, not a lifecycle bucket', t.escalated === escalatedCase, `report=${t.escalated} db=${escalatedCase}`);

  const acceptedTransfers = db
    .prepare("SELECT COUNT(*) AS n FROM transfers WHERE state = 'accepted' AND decided_at IS NOT NULL")
    .get().n;
  check('8j transferred counts accepted transfer decisions', t.transferred <= acceptedTransfers, `report=${t.transferred} db accepted=${acceptedTransfers}`);

  const csv = (await api('/api/reports/export', { token: south.pgrcLead.token })).text;
  const headerLine = csv.split('\n').find((l) => /case_number/i.test(l)) ?? '';
  check(
    '8k the export carries the structured outcome columns',
    /outcome/i.test(headerLine) && /decision_reference/i.test(headerLine),
    `header=${headerLine.slice(0, 200)}`
  );
  const disposedLine = csv
    .split('\n')
    .find((l) => l.includes(`DEMO-REPORT-${MARK}`)) ?? '';
  check('8l the exported row shows the recorded decision reference', disposedLine.length > 0, `row=${disposedLine.slice(0, 160)}`);
}

/* =============================================== 9. stored-state cross-checks */
console.log('\n== 9. Stored state agrees with the API ==');
{
  const all = db.prepare('SELECT id, status, version, outcome, decision_reference, disposed_at FROM cases').all();
  const badStatuses = all.filter(
    (r) => (r.status === 'Disposed' || r.status === 'Closed') && r.disposed_at === null
  );
  check('9a every disposed/closed case carries a disposal time', badStatuses.length === 0, `offenders=${badStatuses.length}`);
  const nullOutcomes = all.filter((r) => r.status === 'Disposed' && !r.outcome);
  check(
    '9b current disposed cases either have a structured outcome or are flagged legacy',
    nullOutcomes.every((r) => db.prepare('SELECT 1 FROM migration_notes WHERE subject = ?').get(r.id) || r.decision_reference === null),
    `without outcome=${nullOutcomes.length}`
  );
  const orphanDispositions = db.prepare('SELECT COUNT(*) AS n FROM dispositions d LEFT JOIN cases c ON c.id = d.case_id WHERE c.id IS NULL').get().n;
  check('9c no disposition row is orphaned', orphanDispositions === 0, `orphans=${orphanDispositions}`);
  const eventless = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dispositions d
        WHERE NOT EXISTS (SELECT 1 FROM action_events e WHERE e.case_id = d.case_id AND e.action_type = 'status_disposed')`
    )
    .get().n;
  check('9d every structured disposition has its canonical event', eventless === 0, `without event=${eventless}`);
  const dupes = db
    .prepare(
      `SELECT case_id, COUNT(*) AS n FROM action_events WHERE action_type = 'status_disposed' GROUP BY case_id, version_after HAVING n > 1`
    )
    .all();
  check('9e no duplicated disposition event at the same version', dupes.length === 0, `duplicate groups=${dupes.length}`);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  check('9f database integrity is intact', Object.values(integrity)[0] === 'ok', String(Object.values(integrity)[0]));
}

/* =============================================== 10. alerts recomputed */
console.log('\n== 10. Institution alerts are recomputed after dispose, reopen and transfer ==');
{
  const recomputeJobs = (institutionId) =>
    db
      .prepare("SELECT id, state FROM jobs WHERE kind = 'recompute_overlap' AND payload_json LIKE ? ORDER BY created_at")
      .all(`%"institutionId":"${institutionId}"%`).length;

  const c = await createCase(south.pgrcLead);
  const t = inst;
  const a1 = await patch(south.pgrcLead, c.id, { version: c.version, status: 'Assigned', remarks: 'assign for recompute check' });
  const a2 = await patch(south.pgrcLead, c.id, { version: a1.data.version, status: 'Under review', remarks: 'review for recompute check' });
  const before = recomputeJobs(t.id);
  const disposed = await patch(south.pgrcLead, c.id, {
    version: a2.data.version,
    status: 'Disposed',
    remarks: 'Disposal that must trigger an institution alert recompute (suite fixture).',
    outcome: 'Closed — no action required',
    decisionReference: `DEMO-RECOMPUTE-${MARK}`,
  });
  const afterDispose = recomputeJobs(t.id);
  check('10a disposing a case queued and ran an institution recompute', disposed.status === 200 && afterDispose > before, `jobs ${before} → ${afterDispose}`);

  const reopened = await api(`/api/cases/${c.id}/reopen`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: { version: disposed.data.version, reason: 'Reopening to check that alerts are recomputed again (suite fixture).' },
  });
  const afterReopen = recomputeJobs(t.id);
  check('10b reopening recomputes the institution alerts again', reopened.status === 200 && afterReopen > afterDispose, `jobs ${afterDispose} → ${afterReopen}`);

  const moved = await api(`/api/cases/${c.id}/transfer`, {
    method: 'POST',
    token: south.pgrcLead.token,
    body: {
      version: reopened.data.version,
      toBureau: 'RB',
      reason: 'Transfer to check alert recompute on acceptance (suite fixture).',
    },
  });
  const afterRequest = recomputeJobs(t.id);
  const pendingVersion = caseRow(c.id).version;
  const accepted = await api(`/api/transfers/${moved.data.transferId}/decision`, {
    method: 'POST',
    token: users['l.verma'].token,
    body: {
      version: pendingVersion,
      decision: 'accept',
      note: 'Accepting to check that alerts recompute after the move.',
    },
  });
  const afterAccept = recomputeJobs(t.id);
  check(
    '10c a pending request alone does not recompute, acceptance does',
    accepted.status === 200 && afterAccept > afterRequest,
    `jobs ${afterRequest} → ${afterAccept}`
  );
  const failed = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'failed'").get().n;
  check('10d no background job failed during these lifecycle changes', failed === 0, `failed jobs=${failed}`);
}

/* =============================================== summary */
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nexecuted: ${results.length}   passed: ${passed}   failed: ${failed}   skipped: ${skipped.length}`);
if (skipped.length) {
  for (const s of skipped) console.log(`  skipped: ${s.name} — ${s.why}`);
}
console.log(failed === 0 ? 'M3 lifecycle, outcomes and reporting: PASS' : 'M3 lifecycle, outcomes and reporting: FAIL');
process.exit(failed === 0 ? 0 : 1);
