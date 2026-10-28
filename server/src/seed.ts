/**
 * Deterministic synthetic seed. Every institution, person, complaint and attachment reference here is
 * fictional demo data (SIH26264). No real AICTE record, complainant or identifier is used.
 */
import { db, nowIso, uid, nextCaseNumber, setting, putSetting } from './db.js';
import { hashPassword, type Role } from './auth.js';
import { RULE_VERSION_LABEL, addCalendarDays, recomputeOverlap, recomputeSuggestions } from './rules.js';
import { appendEvent } from './service.js';

/** Rotating demo outcomes so the seeded disposals look like real decisions. */
const DISPOSITION_OUTCOME_CYCLE = DISPOSITION_OUTCOMES.slice(0, 4) as string[];
import { DISPOSITION_OUTCOMES, type Status } from './domain.js';

const DEMO_PASSWORD = 'caselink-demo';
const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const days = (n: number): number => n * DAY;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface UserSeed {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  bureau: string | null;
  region: string | null;
}

const USERS: UserSeed[] = [
  { id: 'u-officer-pgrc', username: 'p.rao', displayName: 'Priya Rao', role: 'bureau_officer', bureau: 'PGRC', region: 'South' },
  { id: 'u-officer-rb', username: 's.iyer', displayName: 'Suresh Iyer', role: 'bureau_officer', bureau: 'RB', region: 'South' },
  { id: 'u-lead-pgrc', username: 'm.nair', displayName: 'Meera Nair', role: 'bureau_lead', bureau: 'PGRC', region: 'South' },
  { id: 'u-lead-rb', username: 'l.verma', displayName: 'Lalit Verma', role: 'bureau_lead', bureau: 'RB', region: 'South' },
  { id: 'u-supervisor', username: 'a.desai', displayName: 'Ananya Desai', role: 'supervisor', bureau: null, region: 'South' },
  { id: 'u-reviewer', username: 'r.khan', displayName: 'Rekha Khan', role: 'reviewer', bureau: null, region: 'South' },
  { id: 'u-admin', username: 'admin', displayName: 'System Administrator', role: 'admin', bureau: null, region: null },
  { id: 'u-officer-west', username: 'k.menon', displayName: 'Kiran Menon', role: 'bureau_officer', bureau: 'RB', region: 'West' },
  // West-region cohort: a genuine lead and supervisor in each bureau, so regional boundaries can be
  // tested between two real officers of the same rank in different regions (M1.1 regressions).
  { id: 'u-lead-pgrc-west', username: 's.bose', displayName: 'Sujata Bose', role: 'bureau_lead', bureau: 'PGRC', region: 'West' },
  { id: 'u-officer-pgrc-west', username: 'm.joshi', displayName: 'Mihir Joshi', role: 'bureau_officer', bureau: 'PGRC', region: 'West' },
  { id: 'u-lead-rb-west', username: 'r.pillai', displayName: 'Ravi Pillai', role: 'bureau_lead', bureau: 'RB', region: 'West' },
  { id: 'u-supervisor-west', username: 'v.kumar', displayName: 'Vidya Kumar', role: 'supervisor', bureau: null, region: 'West' },
  // National-scope supervisor: region null is the existing national-oversight policy, not a bypass.
  { id: 'u-supervisor-national', username: 'n.iyer', displayName: 'Nandita Iyer', role: 'supervisor', bureau: null, region: null },
];

const INSTITUTIONS = [
  { id: 'inst-a', permanentId: 'AICTE-DEMO-1001', name: 'Vaigai Institute of Technology', region: 'South' },
  { id: 'inst-b', permanentId: 'AICTE-DEMO-1002', name: 'Kaveri Polytechnic College', region: 'South' },
  { id: 'inst-c', permanentId: 'AICTE-DEMO-1003', name: 'Nila College of Engineering', region: 'South' },
  { id: 'inst-d', permanentId: 'AICTE-DEMO-1004', name: 'Tapti Institute of Management', region: 'South' },
  { id: 'inst-e', permanentId: 'AICTE-DEMO-1005', name: 'Palar Technical Campus', region: 'South' },
  { id: 'inst-f', permanentId: 'AICTE-DEMO-1006', name: 'Amaravathi College of Pharmacy', region: 'South' },
  { id: 'inst-g', permanentId: 'AICTE-DEMO-1007', name: 'Sundara Institute of Science', region: 'South' },
  { id: 'inst-h', permanentId: 'AICTE-DEMO-1008', name: 'Gomti College of Architecture', region: 'South' },
  { id: 'inst-i', permanentId: 'AICTE-DEMO-1009', name: 'Bhavani School of Design', region: 'South' },
  { id: 'inst-j', permanentId: 'AICTE-DEMO-1010', name: 'Sabarmati Engineering College', region: 'West' },
];

const ALIASES = [
  { institutionId: 'inst-a', alias: 'Vaigai Tech', source: 'Reviewed from signed complaint letter' },
  { institutionId: 'inst-a', alias: 'VIT Vaigai', source: 'Reviewed from legacy register header' },
  { institutionId: 'inst-c', alias: 'Nila Engineering', source: 'Reviewed from LDAP export (synthetic)' },
  { institutionId: 'inst-g', alias: 'Sundara Science', source: 'Reviewed from site visit note' },
];

interface CaseSeed {
  key: string;
  institutionId: string | null;
  intakeInstitutionText?: string;
  bureau: string;
  category: string;
  summary: string;
  receivedDaysAgo: number;
  channel: string;
  sourceReference?: string;
  status: Status;
  officer?: string | null;
  nextAction?: string | null;
  nextActionInDays?: number | null;
  policyId?: string | null;
  contact?: string | null;
  escalation?: { reason: string; supervisorId: string };
  disposedDaysAgo?: number;
  closedDaysAgo?: number;
  reopenedDaysAgo?: number;
  response?: { dueInDays: number; fromRole: string };
}

const CASES: CaseSeed[] = [
  {
    key: 'pgrc-cert',
    institutionId: 'inst-a',
    bureau: 'PGRC',
    category: 'Certificate / documentation',
    summary:
      'Duplicate degree certificate not issued despite three written reminders from the student help desk. Student needs it for a state scholarship deadline.',
    receivedDaysAgo: 12,
    channel: 'Email',
    sourceReference: 'PGRC/2026/0412',
    status: 'Under review',
    officer: 'u-officer-pgrc',
    nextAction: 'Confirm certificate dispatch register entry with examination branch',
    nextActionInDays: 3,
    policyId: 'DEMO-POL-30',
    contact: 'demo.student.1@example.invalid (synthetic)',
  },
  {
    key: 'rb-cert',
    institutionId: 'inst-a',
    bureau: 'RB',
    category: 'Certificate / documentation',
    summary:
      'Duplicate degree certificate not issued despite written reminders from the student help desk; compliance reply sought from the principal on the 30-day certificate process.',
    receivedDaysAgo: 10,
    channel: 'Letter',
    sourceReference: 'RB/COMP/2026/0187',
    status: 'Assigned',
    officer: 'u-officer-rb',
    nextAction: 'Obtain principal compliance reply on duplicate certificate process',
    nextActionInDays: 5,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'pgrc-infra',
    institutionId: 'inst-a',
    bureau: 'PGRC',
    category: 'Infrastructure',
    summary:
      'Laboratory benches in block C are unstable and unsecured; students report cracked frames in two physics labs. No certificate or documentation issue involved.',
    receivedDaysAgo: 8,
    channel: 'Portal export',
    sourceReference: 'PGRC/2026/0431',
    status: 'Under review',
    officer: 'u-officer-pgrc',
    nextAction: 'Forward safety observation to institute works committee',
    nextActionInDays: 6,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'pgrc-fee',
    institutionId: 'inst-a',
    bureau: 'PGRC',
    category: 'Fee / refund',
    summary: 'Excess caution deposit refund of INR 8,500 not processed for the 2025-26 graduating batch.',
    receivedDaysAgo: 30,
    channel: 'Email',
    sourceReference: 'PGRC/2026/0388',
    status: 'Assigned',
    officer: 'u-officer-pgrc',
    nextAction: 'Seek accounts note on refund cycle',
    nextActionInDays: 2,
    policyId: 'DEMO-POL-45',
  },
  {
    key: 'pgrc-cert2',
    institutionId: 'inst-a',
    bureau: 'PGRC',
    category: 'Certificate / documentation',
    summary:
      'Transfer certificate withheld from a different student over an alleged library fine of INR 300; the student says the fine was already paid.',
    receivedDaysAgo: 11,
    channel: 'Email',
    sourceReference: 'PGRC/2026/0415',
    status: 'Assigned',
    officer: 'u-officer-pgrc',
    nextAction: 'Verify library fine receipt before any certificate action',
    nextActionInDays: 4,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'kaveri-identical',
    institutionId: 'inst-b',
    bureau: 'PGRC',
    category: 'Certificate / documentation',
    // Deliberate near-identical wording at a different institution: must never form a duplicate relationship.
    summary:
      'Duplicate degree certificate not issued despite three written reminders from the student help desk. Student needs it for a state scholarship deadline.',
    receivedDaysAgo: 9,
    channel: 'Email',
    sourceReference: 'PGRC/2026/0422',
    status: 'Assigned',
    officer: 'u-officer-pgrc',
    nextAction: 'Verify institute dispatch register',
    nextActionInDays: 4,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'overdue-pgrc',
    institutionId: 'inst-c',
    bureau: 'PGRC',
    category: 'Fee / refund',
    summary: 'Tuition fee refund of INR 42,000 pending after admission withdrawal in the first counselling round.',
    receivedDaysAgo: 45,
    channel: 'Letter',
    sourceReference: 'PGRC/2026/0321',
    status: 'Awaiting response',
    officer: 'u-officer-pgrc',
    nextAction: 'Chase institute accounts reply; escalate if silent for another week',
    nextActionInDays: -2,
    policyId: 'DEMO-POL-30',
    response: { dueInDays: -5, fromRole: 'Institute accounts department' },
  },
  {
    key: 'approaching-rb',
    institutionId: 'inst-d',
    bureau: 'RB',
    category: 'Approval compliance',
    summary: 'Institute admitted students in an unapproved new programme branch for the 2026-27 session.',
    receivedDaysAgo: 26,
    channel: 'Portal export',
    sourceReference: 'RB/COMP/2026/0201',
    status: 'Under review',
    officer: 'u-officer-rb',
    nextAction: 'Complete approved-intake verification with scrutiny cell',
    nextActionInDays: 4,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'no-deadline',
    institutionId: 'inst-e',
    bureau: 'PGRC',
    category: 'Academic governance',
    summary: 'Requested correction of internal assessment marks after revaluation order was issued.',
    receivedDaysAgo: 60,
    channel: 'Phone note',
    status: 'Assigned',
    officer: 'u-officer-pgrc',
    nextAction: 'Confirm revaluation order with academic section',
    nextActionInDays: 7,
    policyId: null,
  },
  {
    key: 'reopened-rb',
    institutionId: 'inst-f',
    bureau: 'RB',
    category: 'Faculty / staffing',
    summary: 'Shortage of approved faculty in the civil engineering department during the odd semester.',
    receivedDaysAgo: 70,
    channel: 'Letter',
    sourceReference: 'RB/COMP/2026/0142',
    status: 'Under review',
    officer: 'u-officer-rb',
    nextAction: 'Re-verify faculty list after fresh declaration',
    nextActionInDays: 5,
    policyId: 'DEMO-POL-45',
    disposedDaysAgo: 20,
    reopenedDaysAgo: 5,
  },
  {
    key: 'transfer-pending',
    institutionId: 'inst-g',
    bureau: 'PGRC',
    category: 'Approval compliance',
    summary: 'Institute continued a course beyond the approved intake without a revised approval letter.',
    receivedDaysAgo: 18,
    channel: 'Portal export',
    sourceReference: 'PGRC/2026/0405',
    status: 'Under review',
    officer: 'u-officer-pgrc',
    nextAction: 'Await Regulation Bureau view on approved intake',
    nextActionInDays: 6,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'transfer-accepted',
    institutionId: 'inst-h',
    bureau: 'RB',
    category: 'Infrastructure',
    summary: 'Workshop equipment reported missing after an inspection; institute has not submitted the inventory.',
    receivedDaysAgo: 22,
    channel: 'Email',
    sourceReference: 'RB/COMP/2026/0176',
    status: 'Assigned',
    officer: 'u-officer-rb',
    nextAction: 'Collect revised inventory statement',
    nextActionInDays: 8,
    policyId: 'DEMO-POL-45',
  },
  {
    key: 'escalated-rb',
    institutionId: 'inst-i',
    bureau: 'RB',
    category: 'Approval compliance',
    summary: 'Institute published admission advertisements before the approval letter was issued.',
    receivedDaysAgo: 34,
    channel: 'Letter',
    sourceReference: 'RB/COMP/2026/0199',
    status: 'Awaiting response',
    officer: 'u-officer-rb',
    nextAction: 'Await institute response on advertisement withdrawal',
    nextActionInDays: -1,
    policyId: 'DEMO-POL-30',
    response: { dueInDays: -3, fromRole: 'Institute public relations office' },
    escalation: { reason: 'Institute has not responded inside two configured response windows.', supervisorId: 'u-supervisor' },
  },
  {
    key: 'triage-unresolved',
    institutionId: null,
    intakeInstitutionText: 'Sri Ranga College (name given verbally, no permanent ID)',
    bureau: 'PGRC',
    category: 'Other',
    summary: 'Caller says a scholarship form was rejected without a stated reason; the institute name could not be confirmed.',
    receivedDaysAgo: 4,
    channel: 'Phone note',
    status: 'Received',
    officer: null,
    nextAction: 'Resolve institution identity before any overlap comparison',
    nextActionInDays: 2,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'west-region',
    institutionId: 'inst-j',
    bureau: 'RB',
    category: 'Approval compliance',
    summary: 'Regional office flagged an unapproved extension of a diploma programme in the western region.',
    receivedDaysAgo: 15,
    channel: 'Portal export',
    sourceReference: 'RB/COMP/2026/0210',
    status: 'Assigned',
    officer: 'u-officer-west',
    nextAction: 'Regional officer to confirm campus inspection date',
    nextActionInDays: 6,
    policyId: 'DEMO-POL-45',
  },
  {
    key: 'linked-a',
    institutionId: 'inst-g',
    bureau: 'PGRC',
    category: 'Fee / refund',
    summary: 'Refund of semester fee not credited after cancellation; institute cites a non-refundable component.',
    receivedDaysAgo: 16,
    channel: 'Email',
    sourceReference: 'PGRC/2026/0417',
    status: 'Under review',
    officer: 'u-officer-pgrc',
    nextAction: 'Compare refund clause with approved fee structure',
    nextActionInDays: 5,
    policyId: 'DEMO-POL-30',
  },
  {
    key: 'linked-b',
    institutionId: 'inst-g',
    bureau: 'PGRC',
    category: 'Fee / refund',
    summary: 'Semester fee refund not credited after cancellation; institute says a component is non-refundable.',
    receivedDaysAgo: 14,
    channel: 'Letter',
    sourceReference: 'PGRC/2026/0420',
    status: 'Assigned',
    officer: 'u-officer-pgrc',
    nextAction: 'Merge evidence pack for fee refund clause review',
    nextActionInDays: 9,
    policyId: 'DEMO-POL-30',
  },
];

const GENERATED_TEMPLATES: { category: string; summary: string }[] = [
  { category: 'Certificate / documentation', summary: 'Migration certificate not issued after clearance of all dues.' },
  { category: 'Infrastructure', summary: 'Drinking water purifier on the second floor has been out of service for three weeks.' },
  { category: 'Fee / refund', summary: 'Additional fee charged under an unlisted head at the time of admission confirmation.' },
  { category: 'Academic governance', summary: 'Practical examination schedule published two days before the exam date.' },
  { category: 'Faculty / staffing', summary: 'Guest faculty assigned to core theory subjects without an approved roster.' },
  { category: 'Approval compliance', summary: 'Institute brochure lists a laboratory facility that was not inspected.' },
  { category: 'Other', summary: 'General request for a written status update on an earlier representation.' },
];

function insertCase(seed: CaseSeed): string {
  const id = uid();
  const receivedAt = iso(days(seed.receivedDaysAgo));
  const caseNumber = nextCaseNumber(seed.bureau, receivedAt);
  const policy = seed.policyId
    ? (db.prepare('SELECT calendar_days FROM deadline_policies WHERE id = ?').get(seed.policyId) as
        | { calendar_days: number }
        | undefined)
    : undefined;
  const expected = policy ? addCalendarDays(receivedAt, policy.calendar_days) : null;
  const nextActionDue = seed.nextActionInDays !== null && seed.nextActionInDays !== undefined
    ? new Date(Date.now() + days(seed.nextActionInDays)).toISOString()
    : null;
  const responseDue = seed.response ? new Date(Date.now() + days(seed.response.dueInDays)).toISOString() : null;
  const disposedAt = seed.disposedDaysAgo ? iso(days(seed.disposedDaysAgo)) : null;
  const seedNumber = Number(caseNumber.replace(/\D/g, '')) || 0;
  const closedAt = seed.closedDaysAgo ? iso(days(seed.closedDaysAgo)) : null;
  const reopenedAt = seed.reopenedDaysAgo ? iso(days(seed.reopenedDaysAgo)) : null;
  const createdAt = iso(days(seed.receivedDaysAgo + 0.2));
  db.prepare(
    `INSERT INTO cases (id, case_number, institution_id, intake_institution_text, triage_state, received_at, imported_at,
       source_channel, source_reference, category, complaint_summary, bureau, assigned_officer_id, status, next_action,
       next_action_due_at, expected_disposal_at, deadline_policy_id, response_due_at, response_from_role, complainant_contact,
       version, created_by, created_at, updated_at, disposed_at, closed_at, reopened_at,
       outcome, decision_reference)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    caseNumber,
    seed.institutionId,
    seed.intakeInstitutionText ?? null,
    seed.institutionId ? 'resolved' : 'unresolved',
    receivedAt,
    null,
    seed.channel,
    seed.sourceReference ?? null,
    seed.category,
    seed.summary,
    seed.bureau,
    seed.officer ?? null,
    seed.status,
    seed.nextAction ?? null,
    nextActionDue,
    expected,
    seed.policyId ?? null,
    responseDue,
    seed.response?.fromRole ?? null,
    seed.contact ?? null,
    1,
    seed.officer ?? 'u-admin',
    createdAt,
    createdAt,
    disposedAt,
    closedAt,
    reopenedAt,
    // Current-outcome fields are cleared by a reopening; the disposition row keeps the history.
    seed.disposedDaysAgo && !seed.reopenedDaysAgo
      ? DISPOSITION_OUTCOME_CYCLE[seedNumber % DISPOSITION_OUTCOME_CYCLE.length]
      : null,
    seed.disposedDaysAgo && !seed.reopenedDaysAgo ? `DEMO-DISP-${caseNumber}` : null
  );
  const actor = USERS.find((u) => u.id === (seed.officer ?? 'u-admin')) as UserSeed;
  appendEvent({
    actor: { ...actor, grantedCaseIds: [] },
    caseId: id,
    actionType: 'case_created',
    remarks: `Case registered from ${seed.channel}.`,
    nextStep: seed.nextAction ?? null,
    after: { caseNumber, status: seed.status, bureau: seed.bureau },
    versionAfter: 1,
    at: createdAt,
  });
  if (seed.officer) {
    appendEvent({
      actor: { ...USERS.find((u) => u.id === 'u-lead-pgrc')!, grantedCaseIds: [] },
      caseId: id,
      actionType: 'officer_assigned',
      remarks: 'Owner assigned at intake review.',
      after: { assignedOfficerId: seed.officer },
      versionAfter: 1,
      at: createdAt,
    });
  }
  if (seed.disposedDaysAgo) {
    appendEvent({
      actor: { ...USERS.find((u) => u.role === 'bureau_lead' && u.bureau === seed.bureau)!, grantedCaseIds: [] },
      caseId: id,
      actionType: 'status_disposed',
      remarks: 'Disposition recorded: institute submitted compliance evidence (demo fixture).',
      after: { status: 'Disposed', decisionReference: `DEMO-DISP-${caseNumber}` },
      versionAfter: 2,
      at: iso(days(seed.disposedDaysAgo)),
    });
  }
  if (seed.disposedDaysAgo) {
    // Structured disposition record (M3): outcome + decision reference survive reload and reopening.
    db.prepare(
      `INSERT INTO dispositions (id, case_id, outcome, decision_reference, note, actor_id, at, version_after, reopened_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      uid(),
      id,
      DISPOSITION_OUTCOME_CYCLE[seedNumber % DISPOSITION_OUTCOME_CYCLE.length],
      `DEMO-DISP-${caseNumber}`,
      'Disposition recorded: institute submitted compliance evidence (demo fixture).',
      (USERS.find((u) => u.role === 'bureau_lead' && u.bureau === seed.bureau) as UserSeed).id,
      iso(days(seed.disposedDaysAgo)),
      2,
      seed.reopenedDaysAgo ? iso(days(seed.reopenedDaysAgo)) : null
    );
  }
  if (seed.reopenedDaysAgo) {
    appendEvent({
      actor: { ...USERS.find((u) => u.role === 'bureau_lead' && u.bureau === seed.bureau)!, grantedCaseIds: [] },
      caseId: id,
      actionType: 'reopened',
      remarks: 'Fresh evidence received; reopening for review. Earlier outcome preserved.',
      before: { status: 'Disposed' },
      after: { status: 'Under review' },
      versionAfter: 3,
      at: iso(days(seed.reopenedDaysAgo)),
    });
  }
  return id;
}

export function ensureSeed(force = false): boolean {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (existing.n > 0 && !force) return false;

  const seedTx = db.transaction(() => {
    if (force) {
      for (const table of [
        'notifications','alerts','suggestions','relationships','transfers','action_events','case_grants','attachments',
        'dispositions','migration_notes','idempotency_keys','security_log','jobs','cases','import_batches',
        'institution_aliases','institutions','deadline_policies','sessions','users','bureaus','sequences','settings',
      ]) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    }

    db.prepare('INSERT INTO bureaus (code, name, description) VALUES (?,?,?)').run(
      'RB',
      'Regulation Bureau',
      'Approval compliance and regulation cases (fictional unit names for the prototype).'
    );
    db.prepare('INSERT INTO bureaus (code, name, description) VALUES (?,?,?)').run(
      'PGRC',
      'Public Grievance Redressal Cell',
      'Grievance intake and redressal coordination.'
    );

    const pw = hashPassword(DEMO_PASSWORD);
    for (const u of USERS) {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, display_name, role, bureau, region, active, created_at)
         VALUES (?,?,?,?,?,?,?,1,?)`
      ).run(u.id, u.username, pw, u.displayName, u.role, u.bureau, u.region, nowIso());
    }

    db.prepare(
      `INSERT INTO deadline_policies (id, name, version, calendar_days, basis, is_demo, active, note)
       VALUES (?,?,?,?,?,1,1,?)`
    ).run(
      'DEMO-POL-30',
      'DEMO policy — 30 calendar days (prototype only)',
      'v1',
      30,
      'calendar_days',
      'Prototype fixture. Not an official AICTE service level; sponsor approval required before any real use.'
    );
    db.prepare(
      `INSERT INTO deadline_policies (id, name, version, calendar_days, basis, is_demo, active, note)
       VALUES (?,?,?,?,?,1,1,?)`
    ).run(
      'DEMO-POL-45',
      'DEMO policy — 45 calendar days (prototype only)',
      'v1',
      45,
      'calendar_days',
      'Prototype fixture. Business-day calendars, pause rules and retrospective changes remain sponsor decisions.'
    );

    for (const inst of INSTITUTIONS) {
      db.prepare('INSERT INTO institutions (id, permanent_id, name, region, created_at) VALUES (?,?,?,?,?)').run(
        inst.id,
        inst.permanentId,
        inst.name,
        inst.region,
        iso(days(400))
      );
    }
    for (const a of ALIASES) {
      db.prepare(
        'INSERT INTO institution_aliases (id, institution_id, alias, source, reviewed_by, reviewed_at) VALUES (?,?,?,?,?,?)'
      ).run(uid(), a.institutionId, a.alias, a.source, 'u-lead-rb', iso(days(120)));
    }

    const ids: Record<string, string> = {};
    for (const c of CASES) ids[c.key] = insertCase(c);

    // A committed import batch so the provenance path is visible in the demo.
    const batchId = uid();
    db.prepare(
      `INSERT INTO import_batches (id, bureau, source_system, created_by, created_at, state, total, accepted, rejected, skipped, rows_json)
       VALUES (?,?,?,?,?, 'committed', 3, 2, 1, 0, ?)`
    ).run(
      batchId,
      'PGRC',
      'Legacy grievance register (synthetic)',
      'u-lead-pgrc',
      iso(days(20)),
      JSON.stringify([
        { lineNumber: 2, status: 'valid', errors: [], values: { source_reference: 'LGR/2026/0051' } },
        { lineNumber: 3, status: 'valid', errors: [], values: { source_reference: 'LGR/2026/0064' } },
        { lineNumber: 4, status: 'rejected', errors: ['category must be one of the configured list'], values: { source_reference: 'LGR/2026/0070' } },
      ])
    );
    const imported = [
      {
        ref: 'LGR/2026/0051',
        institutionId: 'inst-c',
        summary: 'Legacy register row: hostel mess contract awarded without a published tender note.',
        category: 'Other',
      },
      {
        ref: 'LGR/2026/0064',
        institutionId: 'inst-d',
        summary: 'Legacy register row: laboratory equipment purchase bill pending settlement since last semester.',
        category: 'Infrastructure',
      },
    ];
    for (const row of imported) {
      const id = uid();
      const receivedAt = iso(days(21));
      const caseNumber = nextCaseNumber('PGRC', receivedAt);
      db.prepare(
        `INSERT INTO cases (id, case_number, institution_id, triage_state, received_at, imported_at, source_channel, source_reference,
           category, complaint_summary, bureau, assigned_officer_id, status, next_action, expected_disposal_at, deadline_policy_id,
           version, created_by, created_at, updated_at, import_batch_id)
         VALUES (?,?,?, 'resolved', ?,?,?,?,?,?, 'PGRC', 'u-officer-pgrc', 'Assigned', 'Review imported record and confirm ownership',
           ?, 'DEMO-POL-30', 1, 'u-lead-pgrc', ?, ?, ?)`
      ).run(
        id,
        caseNumber,
        row.institutionId,
        receivedAt,
        iso(days(20)),
        'CSV import',
        row.ref,
        row.category,
        row.summary,
        addCalendarDays(receivedAt, 30),
        iso(days(20)),
        iso(days(20)),
        batchId
      );
      appendEvent({
        actor: { ...(USERS.find((u) => u.id === 'u-lead-pgrc') as UserSeed), grantedCaseIds: [] },
        caseId: id,
        actionType: 'case_created',
        remarks: `Imported from legacy register (batch ${batchId.slice(0, 8)}).`,
        after: { caseNumber, sourceReference: row.ref },
        versionAfter: 1,
        at: iso(days(20)),
      });
    }

    // Pending transfer: PGRC case awaits RB decision; ownership must stay with PGRC until accepted.
    const pendingTransferId = uid();
    db.prepare(
      `INSERT INTO transfers (id, case_id, from_bureau, to_bureau, reason, requested_by, requested_at, state, idempotency_key)
       VALUES (?,?,?,?,?,?,?, 'pending', ?)`
    ).run(
      pendingTransferId,
      ids['transfer-pending'],
      'PGRC',
      'RB',
      'Approved-intake question is a Regulation Bureau matter; PGRC would like RB to own the case.',
      'u-lead-pgrc',
      iso(days(2)),
      `seed-transfer-${ids['transfer-pending']}`
    );
    appendEvent({
      actor: { ...(USERS.find((u) => u.id === 'u-lead-pgrc') as UserSeed), grantedCaseIds: [] },
      caseId: ids['transfer-pending'],
      actionType: 'transfer_requested',
      remarks: 'Approved-intake question belongs with the Regulation Bureau.',
      after: { pendingTransferTo: 'RB', ownershipUnchanged: 'PGRC' },
      versionAfter: 2,
      at: iso(days(2)),
    });

    // Accepted transfer: previously PGRC-owned, now RB-owned.
    const acceptedId = uid();
    db.prepare(
      `INSERT INTO transfers (id, case_id, from_bureau, to_bureau, reason, requested_by, requested_at, state, decided_by, decided_at, decision_note)
       VALUES (?,?,?,?,?,?,?, 'accepted', ?,?,?)`
    ).run(
      acceptedId,
      ids['transfer-accepted'],
      'PGRC',
      'RB',
      'Inventory irregularity sits with Regulation Bureau inspection follow-up.',
      'u-lead-pgrc',
      iso(days(12)),
      'u-lead-rb',
      iso(days(11)),
      'Accepted; RB will own the inspection follow-up.'
    );
    appendEvent({
      actor: { ...(USERS.find((u) => u.id === 'u-lead-rb') as UserSeed), grantedCaseIds: [] },
      caseId: ids['transfer-accepted'],
      actionType: 'transfer_accepted',
      remarks: 'Accepted; RB will own the inspection follow-up.',
      before: { bureau: 'PGRC' },
      after: { bureau: 'RB' },
      versionAfter: 3,
      at: iso(days(11)),
    });

    if (CASES.find((c) => c.key === 'escalated-rb')?.escalation) {
      appendEvent({
        actor: { ...(USERS.find((u) => u.id === 'u-officer-rb') as UserSeed), grantedCaseIds: [] },
        caseId: ids['escalated-rb'],
        actionType: 'escalated',
        remarks: 'Institute has not responded inside two configured response windows.',
        after: { escalationOpen: true, supervisorId: 'u-supervisor', lifecycleUnchanged: 'Awaiting response' },
        versionAfter: 2,
        at: iso(days(3)),
      });
    }

    // Explicit grants so the supervisor can read both case files of the cross-bureau certificate pair.
    // A supervisor sees coordination metadata by default; content still needs a reviewed grant.
    for (const [caseKey, note] of [
      ['pgrc-cert', 'Coordinating the RB/PGRC certificate overlap (PGRC file).'],
      ['rb-cert', 'Coordinating the RB/PGRC certificate overlap (RB file).'],
    ] as [string, string][]) {
      db.prepare(
        `INSERT INTO case_grants (id, case_id, user_id, granted_by, granted_at, note) VALUES (?,?,?,?,?,?)`
      ).run(uid(), ids[caseKey], 'u-supervisor', caseKey === 'pgrc-cert' ? 'u-lead-pgrc' : 'u-lead-rb', iso(days(6)), note);
    }

    // Volume: additional synthetic records so reports and workload look realistic.
    const rand = mulberry32(20261027);
    for (let i = 0; i < 54; i += 1) {
      const tpl = GENERATED_TEMPLATES[Math.floor(rand() * GENERATED_TEMPLATES.length)];
      const inst = INSTITUTIONS[Math.floor(rand() * INSTITUTIONS.length)];
      const bureau = rand() > 0.5 ? 'PGRC' : 'RB';
      const officer = bureau === 'PGRC' ? 'u-officer-pgrc' : 'u-officer-rb';
      const age = Math.floor(rand() * 40) + 1;
      const roll = rand();
      const status: Status = roll > 0.82 ? 'Disposed' : roll > 0.7 ? 'Awaiting response' : roll > 0.4 ? 'Under review' : 'Assigned';
      insertCase({
        key: `gen-${i}`,
        institutionId: inst.id,
        bureau,
        category: tpl.category,
        summary: `${tpl.summary} (Synthetic fixture ${1000 + i}; fictional institution ${inst.permanentId}.)`,
        receivedDaysAgo: age,
        channel: 'Email',
        sourceReference: `${bureau}/SYN/2026/${1000 + i}`,
        status,
        officer,
        nextAction: 'Confirm next step with the institute single point of contact',
        nextActionInDays: Math.floor(rand() * 14) - 3,
        policyId: rand() > 0.1 ? (rand() > 0.22 ? 'DEMO-POL-45' : 'DEMO-POL-30') : null,
        disposedDaysAgo: status === 'Disposed' ? Math.max(1, Math.floor(age / 3)) : undefined,
        response: status === 'Awaiting response' ? { dueInDays: Math.floor(rand() * 20) - 6, fromRole: 'Institute nodal officer' } : undefined,
      });
    }

    for (const inst of INSTITUTIONS) {
      recomputeOverlap(inst.id);
      recomputeSuggestions(inst.id);
    }

    // Reviewer decisions on the seeded pairs.
    const findSuggestion = (a: string, b: string, kind: string) => {
      const [x, y] = a < b ? [a, b] : [b, a];
      return db
        .prepare(`SELECT id FROM suggestions WHERE case_a_id = ? AND case_b_id = ? AND kind = ? AND state = 'open'`)
        .get(x, y, kind) as { id: string } | undefined;
    };
    const related = findSuggestion(ids['linked-a'], ids['linked-b'], 'Duplicate report') ??
      findSuggestion(ids['linked-a'], ids['linked-b'], 'Related issue');
    if (related) {
      db.prepare(
        `INSERT INTO relationships (id, case_a_id, case_b_id, type, reason, reviewer_id, reviewer_role, evidence_json,
           rule_version, decided_at, state, suggestion_id) VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)`
      ).run(
        uid(),
        ids['linked-a'],
        ids['linked-b'],
        'Related issue',
        'Same refund clause challenge for the same semester at the same institution; keep both cases open and share the evidence pack.',
        'u-lead-pgrc',
        'bureau_lead',
        JSON.stringify({
          suggestionId: related.id,
          ruleVersion: RULE_VERSION_LABEL,
          evidenceHash: 'seed',
          reasons: [{ rule: 'same_category', detail: 'Both cases are fee-refund disputes for the same institution.' }],
        }),
        RULE_VERSION_LABEL,
        iso(days(9)),
        related.id
      );
      db.prepare(`UPDATE suggestions SET state = 'accepted', decided_by = 'u-lead-pgrc', decided_at = ?, decision_reason = ? WHERE id = ?`).run(
        iso(days(9)),
        'Same refund clause challenge; both cases stay open.',
        related.id
      );
    }
    const dismissed = findSuggestion(ids['pgrc-cert'], ids['pgrc-cert2'], 'Duplicate report') ??
      findSuggestion(ids['pgrc-cert'], ids['pgrc-cert2'], 'Related issue');
    if (dismissed) {
      db.prepare(`UPDATE suggestions SET state = 'dismissed', decided_by = 'u-lead-pgrc', decided_at = ?, decision_reason = ? WHERE id = ?`).run(
        iso(days(7)),
        'Two different students and two different certificates: separate issues at the same institution. No relationship recorded.',
        dismissed.id
      );
    }

    putSetting('seeded_at', nowIso());
    putSetting('demo_label', 'DEMO — synthetic records only');
  });
  seedTx();
  return true;
}

if (process.argv[1]?.includes('seed.ts')) {
  const force = process.argv.includes('--force');
  const did = ensureSeed(force);
  console.log(did ? 'Seeded CaseLink demo data.' : 'Database already contains data; nothing to do (use --force to reseed).');
}
