#!/usr/bin/env node
/**
 * CaseLink acceptance checks (PRD section 10, T01–T12).
 * Exercises the running API directly — permissions are tested through HTTP requests, not the interface.
 *
 * Usage: node test/acceptance.mjs [baseUrl]
 * Every fixture used here is synthetic demo data.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8080';
const PASSWORD = 'caselink-demo';
let pass = 0;
const failures = [];

const results = [];

function check(id, name, condition, detail = '') {
  const ok = Boolean(condition);
  results.push({ id, name, ok, detail });
  if (ok) pass += 1;
  else failures.push({ id, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }
  async login(username) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`);
    const raw = res.headers.getSetCookie?.() ?? [];
    this.cookie = raw.map((c) => c.split(';')[0]).join('; ');
    this.user = (await res.json()).user;
    return this;
  }
  async call(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Cookie: this.cookie,
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(path) {
    return this.call('GET', path);
  }
  post(path, body, headers) {
    return this.call('POST', path, body ?? {}, headers);
  }
  patch(path, body) {
    return this.call('PATCH', path, body);
  }
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

async function main() {
  console.log(`CaseLink acceptance run against ${BASE}\n`);

  const officerPgrc = await new Client('officer-pgrc').login('p.rao');
  const officerRb = await new Client('officer-rb').login('s.iyer');
  const leadPgrc = await new Client('lead-pgrc').login('m.nair');
  const leadRb = await new Client('lead-rb').login('l.verma');
  const supervisor = await new Client('supervisor').login('a.desai');
  const reviewer = await new Client('reviewer').login('r.khan');
  const westOfficer = await new Client('west').login('k.menon');
  // System-wide configuration (fault injection, matching mode) is administrator-only since M1.
  const admin = await new Client('admin').login('admin');

  const institutions = (await supervisor.get('/institutions')).body.institutions;
  const vaigai = institutions.find((i) => i.permanentId === 'AICTE-DEMO-1001');
  const kaveri = institutions.find((i) => i.permanentId === 'AICTE-DEMO-1002');
  const bhavani = institutions.find((i) => i.permanentId === 'AICTE-DEMO-1009');

  /* ------------------------------------------------------------------ T01 */
  {
    const coord = (await supervisor.get('/coordination')).body;
    const alert = coord.overlaps.find((a) => a.institution.permanentId === 'AICTE-DEMO-1001');
    const refs = alert ? alert.cases.map((c) => c.bureau).sort() : [];
    check(
      'T01',
      'Same institution with active cases in RB and PGRC yields one coordination alert listing both cases',
      alert && refs.includes('PGRC') && refs.includes('RB') && new Set(refs).size >= 2,
      alert ? `alert ${alert.id.slice(0, 8)}, bureaus ${refs.join('+')}, cases ${alert.cases.length}` : 'no alert found'
    );
  }

  /* ------------------------------------------------------------------ T02 */
  {
    const coord = (await supervisor.get('/coordination')).body;
    const alert = coord.overlaps.find((a) => a.institution.permanentId === 'AICTE-DEMO-1001');
    const certCase = alert.cases.find((c) => c.category === 'Certificate / documentation');
    const infraCase = alert.cases.find((c) => c.category === 'Infrastructure');
    const duplicateBetweenThem = alert.suggestions.some(
      (s) =>
        s.kind === 'Duplicate report' &&
        [s.caseA.id, s.caseB.id].includes(certCase.id) &&
        [s.caseA.id, s.caseB.id].includes(infraCase.id)
    );
    const everySuggestionHasEvidence = alert.suggestions.every((s) => s.reasons.length >= 2);
    check(
      'T02',
      'Institution alert appears for unrelated topics; no institution-only duplicate claim',
      Boolean(alert) && !duplicateBetweenThem && everySuggestionHasEvidence,
      `alert present=${Boolean(alert)}, duplicate(cert,infra)=${duplicateBetweenThem}, all suggestions carry >=2 reasons=${everySuggestionHasEvidence}`
    );
  }

  /* ------------------------------------------------------------------ T03 */
  {
    const kaveriCases = (await officerPgrc.get(`/institutions/${kaveri.id}`)).body.cases;
    const kaveriIdentical = kaveriCases.find((c) => c.nextAction?.includes('dispatch register'));
    const vaigaiCases = (await officerPgrc.get(`/institutions/${vaigai.id}`)).body.cases;
    const vaigaiCert = vaigaiCases.find((c) => c.sourceReference === 'PGRC/2026/0412');
    const detail = (await supervisor.get(`/cases/${kaveriIdentical.id}`)).body;
    const linked = detail.suggestions.some((s) => [s.caseA.id, s.caseB.id].includes(vaigaiCert.id));
    check(
      'T03',
      'Identical wording at different institution IDs produces no duplicate relationship',
      !linked,
      `kaveri case ${kaveriIdentical.caseNumber} vs vaigai case ${vaigaiCert.caseNumber}: suggestion present=${linked}`
    );
  }

  /* ------------------------------------------------------------------ T04 */
  {
    const triage = (await officerPgrc.get('/cases?triage=1')).body.cases;
    const unresolved = triage.find((c) => c.triageState === 'unresolved');
    const coord = (await supervisor.get('/coordination')).body;
    const inAnyAlert = coord.overlaps.some((a) => a.cases.some((c) => c.id === unresolved.id));
    const resolve = (await officerPgrc.get('/institutions/resolve?name=Sri%20Ranga%20College')).body;
    check(
      'T04',
      'Ambiguous college name stays in triage; no speculative canonical merge',
      unresolved && unresolved.institutionId === null && !inAnyAlert && resolve.suggestions.every((s) => s.suggestionOnly === true),
      `triage case ${unresolved.caseNumber}, excluded from overlap=${!inAnyAlert}, suggestions are advisory only=${resolve.suggestions.every((s) => s.suggestionOnly)}`
    );
  }

  /* ------------------------------------------------------------------ T05 */
  {
    const rbCases = (await officerRb.get('/cases?pageSize=50')).body.cases.filter((c) => c.bureau === 'RB');
    const rbCase = rbCases[0];
    const directRead = await officerPgrc.get(`/cases/${rbCase.id}`);
    const masked = directRead.status === 200 && directRead.body?.case?.access === 'restricted' && !('complaintSummary' in (directRead.body?.case ?? {}));
    const decidedByOther = directRead.status === 403 || masked;
    const westCase = (await westOfficer.get('/cases?pageSize=5')).body.cases[0];
    const sameBureauOtherRegion = await officerRb.get(`/cases/${westCase.id}`);
    const listForOfficer = (await officerPgrc.get('/cases?pageSize=200')).body.cases;
    const leaksRestrictedText = listForOfficer.some((c) => c.access === 'restricted' && c.complaintSummary);
    check(
      'T05a',
      'Cross-bureau case read is denied or fully masked for a bureau officer',
      decidedByOther,
      `HTTP ${directRead.status}${masked ? ' (coordination metadata only, complaint text absent)' : ''}`
    );
    check(
      'T05b',
      'Region scope is enforced for the same bureau',
      sameBureauOtherRegion.status === 403,
      `HTTP ${sameBureauOtherRegion.status} for a West-region case read by a South officer`
    );
    check('T05c', 'Restricted rows in list responses never carry complaint text', !leaksRestrictedText);
  }

  /* ------------------------------------------------------------------ T06 */
  {
    // Self-contained: two bureaus register near-identical complaints at one institution, then a
    // supervisor takes a reviewed grant on both files (content access is never implied by role) and decides.
    const sharedSummary =
      'Duplicate migration certificate not issued after two written reminders from the student help desk; compliance reply sought from the registrar.';
    const caseA = await leadPgrc.post('/cases', {
      institutionId: bhavani.id,
      receivedAt: isoDaysAgo(6),
      sourceChannel: 'Email',
      sourceReference: `T06-PGRC/${Date.now()}`,
      category: 'Certificate / documentation',
      complaintSummary: sharedSummary,
      assignedOfficerId: officerPgrc.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const caseB = await leadRb.post('/cases', {
      institutionId: bhavani.id,
      receivedAt: isoDaysAgo(5),
      sourceChannel: 'Letter',
      sourceReference: `T06-RB/${Date.now()}`,
      category: 'Certificate / documentation',
      complaintSummary: sharedSummary,
      assignedOfficerId: officerRb.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const selfId = (await supervisor.get('/session')).body.user.id;
    // Grants are versioned mutations: the caller sends the version it just read.
    for (const id of [caseA.body.id, caseB.body.id]) {
      const current = (await supervisor.get(`/cases/${id}`)).body.case;
      await supervisor.post(`/cases/${id}/grants`, {
        version: current.version,
        userId: selfId,
        note: 'T06: supervisor coordinating a cross-bureau certificate pair.',
      });
    }
    const coord = (await supervisor.get('/coordination')).body;
    const target = coord.overlaps
      .flatMap((a) => a.suggestions)
      .find(
        (s) =>
          s.state === 'open' &&
          [s.caseA.id, s.caseB.id].includes(caseA.body.id) &&
          [s.caseA.id, s.caseB.id].includes(caseB.body.id)
      );
    const beforeA = (await supervisor.get(`/cases/${caseA.body.id}`)).body.case;
    const beforeB = (await supervisor.get(`/cases/${caseB.body.id}`)).body.case;
    const decision = target
      ? await supervisor.post(`/suggestions/${target.id}/decision`, {
          decision: 'Related issue',
          reason: 'T06 acceptance check: same certificate process at one institution; both cases stay open and keep their owners.',
          caseAVersion: beforeA.version,
          caseBVersion: beforeB.version,
        })
      : { status: 0, body: {} };
    const afterA = (await supervisor.get(`/cases/${caseA.body.id}`)).body.case;
    const afterB = (await supervisor.get(`/cases/${caseB.body.id}`)).body.case;
    const relationship = (await supervisor.get('/relationships')).body.relationships.find(
      (r) => r.id === decision.body.relationshipId
    );
    const revoke = await supervisor.post(`/relationships/${decision.body.relationshipId}/revoke`, {
      reason: 'T06 acceptance check: reviewer revoked the link after fresh institute evidence arrived.',
      caseAVersion: afterA.version,
      caseBVersion: afterB.version,
    });
    const afterRevokeA = (await supervisor.get(`/cases/${caseA.body.id}`)).body.case;
    const afterRevokeB = (await supervisor.get(`/cases/${caseB.body.id}`)).body.case;
    const history = (await supervisor.get(`/cases/${caseA.body.id}`)).body.history;
    const linkedEvent = history.find((h) => h.actionType === 'relationship_confirmed');
    const revokedEvent = history.find((h) => h.actionType === 'relationship_revoked');
    check(
      'T06',
      'Reviewer links then revokes two cases; both stay intact with recorded reasons and actors',
      Boolean(target) &&
        decision.status === 200 &&
        Boolean(relationship) &&
        relationship.type === 'Related issue' &&
        revoke.status === 200 &&
        afterA.status === beforeA.status &&
        afterB.status === beforeB.status &&
        afterRevokeA.assignedOfficerId === beforeA.assignedOfficerId &&
        afterRevokeB.assignedOfficerId === beforeB.assignedOfficerId &&
        afterA.bureau === 'PGRC' &&
        afterB.bureau === 'RB' &&
        Boolean(linkedEvent) &&
        Boolean(revokedEvent),
      `suggestion found=${Boolean(target)}, link HTTP ${decision.status}, revoke HTTP ${revoke.status}, owners unchanged=${afterRevokeA.assignedOfficerId === beforeA.assignedOfficerId && afterRevokeB.assignedOfficerId === beforeB.assignedOfficerId}`
    );
  }

  /* ------------------------------------------------------------------ T07 */
  let transferCaseNumber = null;
  {
    const created = await leadPgrc.post('/cases', {
      institutionId: bhavani.id,
      receivedAt: isoDaysAgo(3),
      sourceChannel: 'Email',
      sourceReference: `T07/${Date.now()}`,
      category: 'Approval compliance',
      complaintSummary: 'T07 acceptance check: approved intake question that should be owned by the Regulation Bureau.',
      assignedOfficerId: officerPgrc.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const caseId = created.body.id;
    transferCaseNumber = created.body.caseNumber;
    const fresh = async (client) => (await client.get(`/cases/${caseId}`)).body.case;
    const request = await leadPgrc.post(`/cases/${caseId}/transfer`, {
      version: created.body.version,
      toBureau: 'RB',
      reason: 'T07 acceptance check: approved-intake question belongs to RB.',
    });
    const pendingView = await fresh(leadPgrc);
    const doubleRequest = await leadPgrc.post(`/cases/${caseId}/transfer`, {
      version: pendingView.version,
      toBureau: 'RB',
      reason: 'duplicate request attempt',
    });
    const reject = await leadRb.post(`/transfers/${request.body.transferId}/decision`, {
      version: pendingView.version,
      decision: 'reject',
      note: 'T07: rejecting first request to prove rejection keeps the original owner.',
    });
    const afterReject = await fresh(leadPgrc);
    const second = await leadPgrc.post(`/cases/${caseId}/transfer`, {
      version: afterReject.version,
      toBureau: 'RB',
      reason: 'T07: re-request after rejection.',
    });
    const pendingSecond = await fresh(leadPgrc);
    const accept = await leadRb.post(`/transfers/${second.body.transferId}/decision`, {
      version: pendingSecond.version,
      decision: 'accept',
      note: 'T07: accepting ownership for RB.',
      officerId: officerRb.user.id,
    });
    const afterAccept = (await leadRb.get(`/cases/${caseId}`)).body.case;
    const acceptAgain = await leadRb.post(`/transfers/${second.body.transferId}/decision`, {
      version: afterAccept.version,
      decision: 'accept',
      note: 'repeat acceptance attempt',
    });
    const history = (await leadRb.get(`/cases/${caseId}`)).body.history.map((h) => h.actionType);
    check(
      'T07',
      'Pending, rejected and accepted transfer each keep exactly one owner and are all recorded',
      request.status === 201 &&
        pendingView.bureau === 'PGRC' &&
        doubleRequest.status === 409 &&
        reject.status === 200 &&
        afterReject.bureau === 'PGRC' &&
        accept.status === 200 &&
        afterAccept.bureau === 'RB' &&
        afterAccept.assignedOfficerId === officerRb.user.id &&
        acceptAgain.status === 409 &&
        history.filter((h) => h === 'transfer_accepted').length === 1,
      `pending owner PGRC=${pendingView.bureau === 'PGRC'}, reject kept PGRC=${afterReject.bureau === 'PGRC'}, accepted owner ${afterAccept.bureau}, repeat accept HTTP ${acceptAgain.status}`
    );
  }

  /* ------------------------------------------------------------------ T08 */
  {
    const list = (await officerPgrc.get('/cases?pageSize=200')).body.cases;
    const noPolicy = list.find((c) => !c.expectedDisposalAt);
    const overdue = list.filter((c) => c.deadlineState === 'overdue');
    const approaching = list.filter((c) => c.deadlineState === 'approaching');
    check(
      'T08',
      'No policy means no invented deadline; configured approaching/overdue reminders follow the stored due time',
      noPolicy && noPolicy.expectedDisposalAt === null && overdue.length > 0 && approaching.length > 0,
      `no-deadline case ${noPolicy?.caseNumber} (state ${noPolicy?.deadlineState}), overdue ${overdue.length}, approaching ${approaching.length}`
    );
  }

  /* ------------------------------------------------------------------ T09 */
  {
    const created = await leadRb.post('/cases', {
      institutionId: kaveri.id,
      receivedAt: isoDaysAgo(40),
      sourceChannel: 'Letter',
      sourceReference: `T09/${Date.now()}`,
      category: 'Other',
      complaintSummary: 'T09 acceptance check: case to dispose and reopen while checking alert behaviour.',
      assignedOfficerId: officerRb.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
      nextAction: 'Record authorised disposition',
    });
    const caseId = created.body.id;
    const receivedAt = created.body.receivedAt;
    // PRD sequence: an assigned case is reviewed before it can be disposed, and a disposition needs
    // the structured outcome plus its decision reference.
    const transition = await leadRb.patch(`/cases/${caseId}`, {
      version: created.body.version,
      status: 'Under review',
      remarks: 'Review started for T09.',
      actionType: 'review_started',
    });
    const dispose = await leadRb.patch(`/cases/${caseId}`, {
      version: transition.body.version,
      status: 'Disposed',
      remarks: 'Disposition recorded for T09.',
      outcome: 'Upheld — corrective action directed',
      decisionReference: 'DEMO-DISP-T09',
      actionType: 'status_disposed',
    });
    const afterDispose = (await leadRb.get(`/cases/${caseId}`)).body;
    const reopen = await leadRb.post(`/cases/${caseId}/reopen`, {
      version: afterDispose.case.version,
      reason: 'T09 acceptance check: fresh evidence received, reopening for review.',
    });
    const afterReopen = (await leadRb.get(`/cases/${caseId}`)).body;
    const disposalEventPreserved = afterReopen.history.some((h) => h.actionType === 'status_disposed');
    const priorOutcomeKept =
      afterReopen.dispositions?.[0]?.outcome === 'Upheld — corrective action directed' &&
      afterReopen.dispositions?.[0]?.decisionReference === 'DEMO-DISP-T09';
    const coord = (await supervisor.get('/coordination')).body;
    const alert = coord.overlaps.find((a) => a.institution.permanentId === kaveri.permanentId);
    const activeBureaus = new Set(alert ? alert.cases.filter((c) => ['Received', 'Assigned', 'Under review', 'Awaiting response'].includes(c.status)).map((c) => c.bureau) : []);
    check(
      'T09',
      'Dispose and reopen keep the earlier outcome and original receipt time; alerts follow active state',
      dispose.status === 200 &&
        afterDispose.case.status === 'Disposed' &&
        afterDispose.case.disposedAt !== null &&
        afterDispose.case.outcome === 'Upheld — corrective action directed' &&
        reopen.status === 200 &&
        afterReopen.case.status === 'Under review' &&
        afterReopen.case.receivedAt === receivedAt &&
        disposalEventPreserved &&
        priorOutcomeKept &&
        activeBureaus.has('RB'),
      `disposed=${afterDispose.case.status}, outcome kept in disposition history=${priorOutcomeKept}, reopened=${afterReopen.case.status}, receipt preserved=${afterReopen.case.receivedAt === receivedAt}, prior disposal event kept=${disposalEventPreserved}`
    );
  }

  /* ------------------------------------------------------------------ T10 */
  {
    const key = `T10-${Date.now()}`;
    const payload = {
      institutionId: vaigai.id,
      receivedAt: isoDaysAgo(1),
      sourceChannel: 'Email',
      sourceReference: `T10/${key}`,
      category: 'Other',
      complaintSummary: 'T10 acceptance check: repeated submission with the same idempotency key must not create a second case.',
    };
    const first = await officerPgrc.post('/cases', payload, { 'Idempotency-Key': key });
    const second = await officerPgrc.post('/cases', payload, { 'Idempotency-Key': key });

    const importRef = `T10-REF-${Date.now()}`;
    const csv = [
      'institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact',
      // intentionally invalid row: no received date, no reference, no summary
      'AICTE-DEMO-1003,,,T10 register,,Fee / refund,,,DEMO-POL-30,',
      `AICTE-DEMO-1003,,2026-09-12,T10 register,${importRef},Fee / refund,"T10 acceptance check: repeat import must not duplicate this case.",,DEMO-POL-30,`,
      `AICTE-DEMO-1003,,2026-09-12,T10 register,${importRef},Fee / refund,"T10 acceptance check: repeat import must not duplicate this case.",,DEMO-POL-30,`,
    ].join('\n');
    const preview = await leadPgrc.post('/import/preview', { sourceSystem: 'T10 register', csvText: csv });
    const commit1 = await leadPgrc.post(`/import/${preview.body.batchId}/commit`);
    const preview2 = await leadPgrc.post('/import/preview', { sourceSystem: 'T10 register', csvText: csv });
    const commit2 = await leadPgrc.post(`/import/${preview2.body.batchId}/commit`);
    check(
      'T10',
      'Repeat import or retried mutation creates no duplicate case, transfer or notification',
      first.status === 201 &&
        second.status === 201 &&
        second.body.caseNumber === first.body.caseNumber &&
        commit1.body.accepted === 1 &&
        commit1.body.rejected === 1 &&
        commit1.body.skipped === 1 &&
        commit2.body.accepted === 0 &&
        commit2.body.rejected === 1 &&
        commit2.body.skipped === 2,
      `idempotent replay same case=${second.body.caseNumber === first.body.caseNumber}, first commit accepted ${commit1.body.accepted}/rejected ${commit1.body.rejected}/skipped ${commit1.body.skipped}, repeat accepted ${commit2.body.accepted}/skipped ${commit2.body.skipped}`
    );
  }

  /* ------------------------------------------------------------------ T11 */
  {
    const created = await leadPgrc.post('/cases', {
      institutionId: vaigai.id,
      receivedAt: isoDaysAgo(2),
      sourceChannel: 'Email',
      sourceReference: `T11/${Date.now()}`,
      category: 'Other',
      complaintSummary: 'T11 acceptance check: two editors submit the same record version.',
      assignedOfficerId: officerPgrc.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const version = created.body.version;
    const editorOne = await officerPgrc.post(`/cases/${created.body.id}/actions`, {
      version,
      actionType: 'internal_note',
      remarks: 'T11 editor one saves first.',
    });
    const editorTwo = await officerPgrc.post(`/cases/${created.body.id}/actions`, {
      version,
      actionType: 'internal_note',
      remarks: 'T11 editor two saves with the stale version.',
    });
    const latest = (await officerPgrc.get(`/cases/${created.body.id}`)).body;
    check(
      'T11',
      'Two editors saving the same version: one saves, the stale edit reports a conflict',
      editorOne.status === 201 && editorTwo.status === 409 && latest.case.version === version + 1,
      `first save ${editorOne.status}, stale save ${editorTwo.status}, version now ${latest.case.version}`
    );
  }

  /* ------------------------------------------------------------------ T12 */
  {
    const created = await leadPgrc.post('/cases', {
      institutionId: vaigai.id,
      receivedAt: isoDaysAgo(5),
      sourceChannel: 'Email',
      sourceReference: `T12/${Date.now()}`,
      category: 'Other',
      complaintSummary: 'T12 acceptance check: a failing audit write must roll back the associated mutation.',
      assignedOfficerId: officerPgrc.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const before = (await officerPgrc.get(`/cases/${created.body.id}`)).body;
    const invalidTransition = await officerPgrc.patch(`/cases/${created.body.id}`, {
      version: created.body.version,
      status: 'Closed',
      remarks: 'T12: invalid state change should be rejected.',
    });
    const injectOn = await admin.post('/system/inject-audit-failure', { on: true });
    const failingSave = await officerPgrc.post(`/cases/${created.body.id}/actions`, {
      version: created.body.version,
      actionType: 'internal_note',
      remarks: 'T12: this save must roll back with its audit event.',
    });
    await admin.post('/system/inject-audit-failure', { on: false });
    const after = (await officerPgrc.get(`/cases/${created.body.id}`)).body;
    const noEventPersisted = !after.history.some((h) => h.remarks?.startsWith('T12: this save must roll back'));
    check(
      'T12',
      'Failure during mutation and audit commit rolls back atomically; invalid state change rejected',
      invalidTransition.status === 422 && failingSave.status === 500 && after.case.version === before.case.version && noEventPersisted,
      `invalid transition HTTP ${invalidTransition.status}, inject=${injectOn.status}, injected failure HTTP ${failingSave.status}, version ${before.case.version}→${after.case.version}, no partial event=${noEventPersisted}`
    );
  }

  /* ---------------------------------------------- supplementary controls */
  {
    const anon = new Client('anon');
    const unauth = await anon.get('/cases');
    check('S01', 'Unauthenticated API read is refused', unauth.status === 401, `HTTP ${unauth.status}`);

    const noRole = new Client('forged');
    noRole.cookie = officerPgrc.cookie;
    const forgedRole = await noRole.post('/cases', {
      institutionId: vaigai.id,
      bureau: 'RB',
      receivedAt: isoDaysAgo(1),
      sourceChannel: 'Email',
      category: 'Other',
      complaintSummary: 'Client-side bureau claim must be ignored by the server.',
    });
    check('S02', 'A bureau or role claimed in the request body cannot widen scope', forgedRole.status === 403, `HTTP ${forgedRole.status}`);

    const someCase = (await supervisor.get('/cases?pageSize=1')).body.cases[0];
    const reviewerRead = await reviewer.get(`/cases/${someCase.id}`);
    const reviewerWrite = await reviewer.patch(`/cases/${someCase.id}`, { version: someCase.version, remarks: 'read-only reviewer write attempt' });
    check(
      'S03',
      'Read-only reviewer sees only granted records and cannot mutate a case',
      [403, 401].includes(reviewerRead.status) && [403, 401].includes(reviewerWrite.status),
      `read HTTP ${reviewerRead.status}, write HTTP ${reviewerWrite.status}`
    );

    // cross-case attachment access
    const caseA = (await officerPgrc.get('/cases?pageSize=1')).body.cases[0];
    const other = (await officerRb.get('/cases?pageSize=1')).body.cases[0];
    const forgedDownload = await officerPgrc.get(`/cases/${other.id}/attachments/00000000-0000-0000-0000-000000000000`);
    check('S04', 'Attachment download through another case is refused', [403, 404].includes(forgedDownload.status), `HTTP ${forgedDownload.status}`);

    // CSV formula escaping
    const created = await officerPgrc.post('/cases', {
      institutionId: vaigai.id,
      receivedAt: isoDaysAgo(1),
      sourceChannel: 'Email',
      sourceReference: `FORMULA/${Date.now()}`,
      category: 'Other',
      complaintSummary: 'Formula injection check: next action will start with an equals sign.',
      assignedOfficerId: officerPgrc.user.id,
      nextAction: '=SUM(1+1)',
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const exportRes = await fetch(`${BASE}/api/reports/export`, { headers: { Cookie: officerPgrc.cookie } });
    const csvText = await exportRes.text();
    check(
      'S05',
      'CSV export escapes spreadsheet formula-like values and carries snapshot/filter metadata',
      csvText.includes("'=SUM(1+1)") && csvText.startsWith('# CaseLink export snapshot='),
      `cell prefixed=${csvText.includes("'=SUM(1+1)")}, header=${csvText.slice(0, 40)}`
    );

    // report totals reconcile with drill-down
    const summary = (await officerPgrc.get('/reports/summary')).body;
    const overdueList = (await officerPgrc.get('/cases?overdue=1&pageSize=200')).body;
    const pendingList = (await officerPgrc.get('/cases?pending=1&pageSize=200')).body;
    check(
      'S06',
      'Report totals reconcile with the drill-down case lists',
      summary.totals.overdue === overdueList.total && summary.totals.pending === pendingList.total,
      `overdue ${summary.totals.overdue}/${overdueList.total}, pending ${summary.totals.pending}/${pendingList.total}`
    );

    // matching outage keeps baseline
    await admin.post('/system/matching-mode', { mode: 'unavailable' });
    const outageCreate = await officerPgrc.post('/cases', {
      institutionId: vaigai.id,
      receivedAt: isoDaysAgo(1),
      sourceChannel: 'Email',
      sourceReference: `OUTAGE/${Date.now()}`,
      category: 'Certificate / documentation',
      complaintSummary: 'Matching outage check: case must still save and institution overlap must still be detected.',
      assignedOfficerId: officerPgrc.user.id,
      deadlinePolicyId: 'DEMO-POL-30',
    });
    const coordDuringOutage = (await supervisor.get('/coordination')).body;
    await admin.post('/system/matching-mode', { mode: 'rule-based' });
    check(
      'S07',
      'Matching outage still saves the case, keeps rule-based overlap detection and shows matching status',
      outageCreate.status === 201 &&
        coordDuringOutage.matchingMode === 'unavailable' &&
        coordDuringOutage.overlaps.some((a) => a.institution.permanentId === vaigai.permanentId),
      `case saved ${outageCreate.status}, mode reported ${coordDuringOutage.matchingMode}`
    );
  }

  console.log(`\n${pass}/${results.length} checks passed.`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(` - ${f.id} ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
  await import('node:fs').then((fs) =>
    fs.writeFileSync(
      'test/acceptance-results.json',
      JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, total: results.length, results }, null, 2)
    )
  );
}

main().catch((err) => {
  console.error('Acceptance run crashed:', err);
  process.exitCode = 1;
});
