import { db } from './db.js';
import { AppError } from './errors.js';
import type { Role, SessionUser } from './auth.js';

export const CATEGORIES = [
  'Certificate / documentation',
  'Infrastructure',
  'Fee / refund',
  'Academic governance',
  'Faculty / staffing',
  'Approval compliance',
  'Other',
] as const;

export const CHANNELS = ['Email', 'Letter', 'Portal export', 'Phone note', 'Walk-in', 'CSV import'] as const;

export const ACTIVE_STATUSES = ['Received', 'Assigned', 'Under review', 'Awaiting response'] as const;
export const STATUSES = [...ACTIVE_STATUSES, 'Disposed', 'Closed'] as const;
export type Status = (typeof STATUSES)[number];

export const RULE_VERSION = 'rules-p0-1.0';

export interface CaseRecord {
  id: string;
  case_number: string;
  institution_id: string | null;
  institution_name: string | null;
  institution_permanent_id: string | null;
  institution_region: string | null;
  intake_institution_text: string | null;
  triage_state: 'resolved' | 'unresolved';
  received_at: string;
  imported_at: string | null;
  source_channel: string;
  source_reference: string | null;
  category: string;
  complaint_summary: string;
  bureau: string;
  assigned_officer_id: string | null;
  assigned_officer_name: string | null;
  status: Status;
  next_action: string | null;
  next_action_due_at: string | null;
  expected_disposal_at: string | null;
  deadline_policy_id: string | null;
  response_due_at: string | null;
  response_from_role: string | null;
  complainant_contact: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  disposed_at: string | null;
  closed_at: string | null;
  reopened_at: string | null;
  escalation_open: number;
  escalation_reason: string | null;
  escalation_supervisor_id: string | null;
  escalation_opened_at: string | null;
  import_batch_id: string | null;
  /** Structured disposition outcome, current while the case is disposed (M3). */
  outcome: string | null;
  /** Decision reference recorded with the disposition (M3). */
  decision_reference: string | null;
  /** Provenance for imported cases (M5). */
  source_system: string | null;
  source_identity: string | null;
}

export const CASE_SELECT = `
  SELECT c.*, i.name AS institution_name, i.permanent_id AS institution_permanent_id,
         i.region AS institution_region, u.display_name AS assigned_officer_name
    FROM cases c
    LEFT JOIN institutions i ON i.id = c.institution_id
    LEFT JOIN users u ON u.id = c.assigned_officer_id`;

export function getCase(id: string): CaseRecord | undefined {
  return db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) as CaseRecord | undefined;
}

export function getCaseByNumber(num: string): CaseRecord | undefined {
  return db.prepare(`${CASE_SELECT} WHERE c.case_number = ?`).get(num) as CaseRecord | undefined;
}

export function lastActionAt(caseId: string): string | null {
  const row = db
    .prepare('SELECT at FROM action_events WHERE case_id = ? ORDER BY at DESC, rowid DESC LIMIT 1')
    .get(caseId) as { at: string } | undefined;
  return row?.at ?? null;
}

export function isActiveStatus(status: Status): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/* ------------------------------------------------------------------ scope */

export function inRegion(user: SessionUser, region: string | null): boolean {
  if (!user.region) return true; // national scope
  if (!region) return false;
  return user.region === region;
}

export interface Scope {
  contentIds: Set<string>;
  metadataIds: Set<string>;
  /** Institutions where this user's bureau has an active case (metadata visibility driver). */
  institutionsInBureau: Set<string>;
}

/**
 * Visibility, decided per record — no materialised id list.
 *
 * The earlier implementation answered `canViewContent`/`canViewMetadata` by building the *complete* set
 * of case ids the account may see, on every request. At reference scale (10 000 cases) that meant two
 * full scans and a 10 000-element JSON array bound into every list query, which is what made the mixed
 * concurrent list/read workload slow (M7/A14). The rules are unchanged; they are now expressed as
 * predicates over the case row, plus one bounded lookup (the institutions where the account's bureau
 * holds active cases) that is cached for the life of the request.
 */
const bureauInstitutionCache = new WeakMap<SessionUser, Set<string>>();

/** Institutions where this account's bureau holds at least one active, identity-resolved case. */
export function institutionsForBureau(user: SessionUser): Set<string> {
  if (!user.bureau) return new Set();
  const cached = bureauInstitutionCache.get(user);
  if (cached) return cached;
  const active = ACTIVE_STATUSES.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT institution_id FROM cases
        WHERE bureau = ? AND triage_state = 'resolved' AND institution_id IS NOT NULL
          AND status IN (${active})`
    )
    .all(user.bureau, ...ACTIVE_STATUSES) as { institution_id: string }[];
  const set = new Set(rows.map((r) => r.institution_id));
  bureauInstitutionCache.set(user, set);
  return set;
}

type VisibilityCase = {
  id: string;
  bureau?: string | null;
  institution_id?: string | null;
  institution_region?: string | null;
};

/**
 * A caller may hold only the case id. The visibility rules need the row's bureau and institution, so a
 * partial object is resolved to the stored record once (an indexed lookup), never guessed.
 */
function completeCase(c: VisibilityCase): VisibilityCase {
  if (c.bureau !== undefined) return c;
  const row = db
    .prepare(
      `SELECT c.id, c.bureau, c.institution_id, i.region AS institution_region
         FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id WHERE c.id = ?`
    )
    .get(c.id) as VisibilityCase | undefined;
  return row ?? c;
}

/** Complaint content: the owning bureau inside its region, or an explicit grant. Admin: grants only. */
function contentRule(user: SessionUser, raw: VisibilityCase): boolean {
  const c = completeCase(raw);
  if (user.role === 'admin') return user.grantedCaseIds.includes(c.id);
  if (user.grantedCaseIds.includes(c.id)) return true;
  if (!user.bureau || c.bureau !== user.bureau) return false;
  // An unresolved intake has no institution yet, so its region is the owning bureau's to judge.
  if (c.institution_id === null || c.institution_id === undefined) return true;
  return inRegion(user, c.institution_region ?? null);
}

/** Coordination metadata: content, supervision inside the region, or a case whose institution the
 *  account's bureau is already working on. */
function metadataRule(user: SessionUser, raw: VisibilityCase): boolean {
  const c = completeCase(raw);
  if (contentRule(user, c)) return true;
  if (user.role === 'admin') return false;
  if (user.role === 'supervisor') return inRegion(user, c.institution_region ?? null);
  if (!user.bureau || !c.institution_id) return false;
  if (!inRegion(user, c.institution_region ?? null)) return false;
  return institutionsForBureau(user).has(c.institution_id);
}

/**
 * The same visibility rules as SQL, for lists, counts, reports and exports. `alias` is the case table
 * alias in the caller's query; the predicate never contains user input.
 */
export function visibilitySql(
  user: SessionUser,
  kind: 'content' | 'metadata',
  alias = 'c'
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const regionOk = `(${alias}.institution_id IS NULL OR ? IS NULL OR i.region = ?)`;

  if (kind === 'content' || user.role === 'admin') {
    if (user.role === 'admin') {
      const grants = user.grantedCaseIds;
      if (!grants.length) return { sql: '0 = 1', params: [] };
      return { sql: `${alias}.id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(grants)] };
    }
    parts.push(`(${alias}.bureau = ? AND ${regionOk})`);
    params.push(user.bureau, user.region, user.region);
    if (user.grantedCaseIds.length) {
      parts.push(`${alias}.id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(user.grantedCaseIds));
    }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  // metadata
  const content = visibilitySql(user, 'content', alias);
  parts.push(content.sql);
  params.push(...content.params);
  if (user.role === 'supervisor') {
    parts.push(`(i.region IS NOT NULL AND (? IS NULL OR i.region = ?))`);
    params.push(user.region, user.region);
  } else if (user.bureau) {
    // Cases at an institution where this bureau is already working, inside the account's region.
    parts.push(
      `(${alias}.institution_id IS NOT NULL AND (i.region IS NOT NULL AND (? IS NULL OR i.region = ?))
        AND ${alias}.institution_id IN (SELECT institution_id FROM cases
              WHERE bureau = ? AND triage_state = 'resolved' AND institution_id IS NOT NULL
                AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})))`
    );
    params.push(user.region, user.region, user.bureau, ...ACTIVE_STATUSES);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** Full id sets. Kept for the few places that genuinely need them (granted-only admin lists, tests). */
export function getScope(user: SessionUser): Scope {
  const contentIds = new Set(
    (
      db
        .prepare(
          `SELECT c.id FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id WHERE ${visibilitySql(user, 'content').sql}`
        )
        .all(...(visibilitySql(user, 'content').params as never[])) as { id: string }[]
    ).map((r) => r.id)
  );
  const metadataIds = new Set(
    (
      db
        .prepare(
          `SELECT c.id FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id WHERE ${visibilitySql(user, 'metadata').sql}`
        )
        .all(...(visibilitySql(user, 'metadata').params as never[])) as { id: string }[]
    ).map((r) => r.id)
  );
  return { contentIds, metadataIds, institutionsInBureau: institutionsForBureau(user) };
}

export function canViewContent(user: SessionUser, c: { id: string }): boolean {
  return contentRule(user, c as VisibilityCase);
}

export function canViewMetadata(user: SessionUser, c: { id: string }): boolean {
  return metadataRule(user, c as VisibilityCase);
}

/** Explicit per-user grant rows for the workspace panel. */
export function caseGrants(caseId: string) {
  return db
    .prepare(
      `SELECT g.id, g.user_id AS userId, u.display_name AS userName, u.role, g.granted_at AS grantedAt,
              g.note, g.revoked_at AS revokedAt, gu.display_name AS grantedByName
         FROM case_grants g JOIN users u ON u.id = g.user_id LEFT JOIN users gu ON gu.id = g.granted_by
        WHERE g.case_id = ? ORDER BY g.granted_at DESC`
    )
    .all(caseId);
}

export type Capability =
  | 'create_case'
  | 'update_case'
  | 'assign'
  | 'transfer'
  | 'decide_transfer'
  | 'dispose'
  | 'reopen'
  | 'escalate'
  | 'decide_relationship'
  | 'import'
  | 'manage_admin_config'
  | 'manage_users'
  | 'view_reports'
  | 'resolve_triage';

/**
 * Coarse role-level capability list, used for navigation and interface hints only.
 * Case-level authority is decided by the permission functions below — never by this list.
 */
export function capabilities(user: SessionUser): Capability[] {
  const caps = new Set<Capability>(['view_reports']);
  switch (user.role) {
    case 'bureau_officer':
      caps.add('create_case').add('update_case').add('resolve_triage');
      break;
    case 'bureau_lead':
      caps.add('create_case').add('update_case').add('assign').add('transfer').add('decide_transfer');
      caps.add('dispose').add('reopen').add('escalate').add('decide_relationship').add('import');
      caps.add('resolve_triage');
      break;
    case 'supervisor':
      caps.add('decide_relationship').add('escalate');
      break;
    case 'reviewer':
      break;
    case 'admin':
      caps.add('manage_users').add('manage_admin_config');
      break;
  }
  if (user.role === 'bureau_officer') caps.add('transfer');
  return [...caps];
}

/**
 * The one place that decides whether an account may own a case.
 *
 * Intake, reassignment, CSV import and transfer acceptance all call this, so a case can never be
 * handed to a suspended account, an account outside the owning bureau, a role that is not a case
 * worker, or an officer whose authorised region does not cover the case (M7/A04).
 *
 * `region` is the case's institution region when it has one. An unresolved-identity intake has no
 * institution yet, so it inherits the registering account's region as its working region.
 */
export interface AssigneeCandidate {
  id: string;
  display_name: string;
  role: Role;
  bureau: string | null;
  region: string | null;
  active: number;
}

export function validateCaseWorker(
  officerId: string,
  expected: { bureau: string; region: string | null; field?: string }
): AssigneeCandidate {
  const field = expected.field ?? 'assignedOfficerId';
  const officer = db
    .prepare('SELECT id, display_name, role, bureau, region, active FROM users WHERE id = ?')
    .get(officerId) as AssigneeCandidate | undefined;
  if (!officer || officer.active !== 1) {
    throw new AppError(422, 'validation_error', 'Selected owner is not an active account.', { [field]: 'Unknown or inactive account.' });
  }
  if (officer.role !== 'bureau_officer' && officer.role !== 'bureau_lead') {
    throw new AppError(422, 'validation_error', 'Only a bureau officer or bureau lead can own a case.', {
      [field]: 'Not a case worker.',
    });
  }
  if (officer.bureau !== expected.bureau) {
    throw new AppError(422, 'validation_error', 'The chosen owner belongs to another bureau; a case is always owned by a case worker of its own bureau.', {
      [field]: 'Wrong bureau.',
    });
  }
  if (expected.region && officer.region && officer.region !== expected.region) {
    throw new AppError(422, 'validation_error', 'The chosen owner is not authorised for this case region.', {
      [field]: 'Owner outside the case region.',
    });
  }
  return officer;
}

/** Accounts offered as owners: the same policy, applied as a query so the interface cannot mislead. */
export function assignableOfficers(bureau: string, region: string | null) {
  const rows = db
    .prepare(
      `SELECT id, display_name AS displayName, region FROM users
        WHERE active = 1 AND bureau = ? AND role IN ('bureau_officer','bureau_lead') ORDER BY display_name`
    )
    .all(bureau) as { id: string; displayName: string; region: string | null }[];
  return rows
    .filter((r) => !region || !r.region || r.region === region)
    .map((r) => ({ id: r.id, displayName: r.displayName }));
}

/* ---------------------------------------------------------------------------
 * Permission model (Milestone 1)
 *
 * Five distinct questions, each answered from the authenticated account only
 * (role, bureau, authorised region, approved grants) plus the record itself:
 *
 *   view_coordination_metadata  — see the institution / case number / category / bureau /
 *                                 status / owner role / deadlines of a restricted case
 *   read_content                — read complaint text, contact, evidence, history remarks
 *   modify_case                 — change lifecycle state, assign, transfer, escalate, reopen,
 *                                 deadline, triage, relationships
 *   upload_evidence             — add evidence files to a case
 *   manage_access               — grant or revoke case-content access
 *   manage_admin_config         — system-wide configuration changes
 *
 * A content-read grant answers exactly one of these: read_content. It never implies write
 * authority, evidence upload or access management. Client-supplied roles, bureaus or regions
 * are never consulted.
 * ------------------------------------------------------------------------ */

export type CasePermission =
  | 'view_coordination_metadata'
  | 'read_content'
  | 'modify_case'
  | 'upload_evidence'
  | 'manage_access';

/** Region check that also handles unresolved-intake cases (no institution yet). */
export function regionAllows(user: SessionUser, c: { institution_region?: string | null; triage_state?: string; bureau?: string }): boolean {
  if (c.institution_region) return inRegion(user, c.institution_region);
  // Unresolved identity: region is unknown, so only the owning bureau may act.
  return Boolean(user.bureau) && c.bureau === user.bureau;
}

/** Coordination metadata (restricted view). */
export function canViewCoordinationMetadata(user: SessionUser, c: { id: string }): boolean {
  return canViewMetadata(user, c);
}

/** Reader of restricted case contents — bureau membership or an approved explicit grant. */
export function canReadCaseContent(user: SessionUser, c: { id: string }): boolean {
  return canViewContent(user, c);
}

/**
 * Mutation authority: role + owning bureau + region, on top of read access.
 * A grant widens reading only, so a granted officer/lead from another bureau still cannot modify.
 */
export function canModifyCase(user: SessionUser, c: CaseRecord): boolean {
  if (!canReadCaseContent(user, c)) return false;
  if (!regionAllows(user, c)) return false;
  switch (user.role) {
    case 'bureau_lead':
      return c.bureau === user.bureau;
    case 'bureau_officer':
      return c.bureau === user.bureau && c.assigned_officer_id === user.id;
    default:
      // supervisor, reviewer and administrator are not case workers
      return false;
  }
}

/** Evidence upload follows modification authority — never read grants or reviewer roles. */
export function canUploadEvidence(user: SessionUser, c: CaseRecord): boolean {
  if (!canModifyCase(user, c)) return false;
  return ['Received', 'Assigned', 'Under review', 'Awaiting response', 'Disposed', 'Closed'].includes(c.status);
}

/**
 * Access management: deliberately independent of metadata visibility and of the actor's own grants.
 *  - bureau lead: only cases owned by their bureau and inside their authorised region
 *  - supervisor: any case inside their oversight region, including cross-bureau coordination
 *  - officer, reviewer, administrator: never
 */
export function canManageCaseAccess(user: SessionUser, c: CaseRecord): boolean {
  if (!regionAllows(user, c)) return false;
  if (user.role === 'bureau_lead') return c.bureau === user.bureau;
  if (user.role === 'supervisor') return true;
  return false;
}

/** System-wide configuration (worker control, matching mode, fault injection, identity settings). */
export function canManageAdminConfig(user: SessionUser): boolean {
  return user.role === 'admin';
}

/** Bureau leads and supervisors may review institution aliases, inside their own region. */
export function canReviewInstitutionConfig(user: SessionUser, institutionRegion: string | null): boolean {
  if (!['bureau_lead', 'supervisor'].includes(user.role)) return false;
  return institutionRegion ? inRegion(user, institutionRegion) : !user.region;
}

/** May the caller modify shared coordination state (alert acknowledgement) they can see? */
export interface CoordinationAlertRef {
  /** Institutions named by the alert; the alert's own region decides regional authority. */
  institutionRegion: string | null;
  /** Every case the alert lists (not only the ones the caller can see). */
  caseIds: string[];
}

/**
 * Acknowledging an overlap alert changes **shared** coordination state, so it is authorised against the
 * alert itself — its institution's region and the cases it lists — and never by the caller's role alone.
 *
 *  - bureau officer / bureau lead / supervisor only: reviewers, administrators and any other role never
 *    change shared acknowledgement state (they may still acknowledge their own notifications);
 *  - the alert's institution must sit inside the caller's authorised region (`region` null = the
 *    existing national-oversight policy, which is preserved);
 *  - at least one case on the alert must be inside the caller's coordination scope, which is itself
 *    bureau- and region-limited. A regional supervisor has no such scope outside their region, so the
 *    previous "any supervisor with a non-empty region" bypass is gone.
 */
export function canAcknowledgeCoordination(user: SessionUser, alert: CoordinationAlertRef): boolean {
  if (!['bureau_officer', 'bureau_lead', 'supervisor'].includes(user.role)) return false;
  if (alert.institutionRegion && !inRegion(user, alert.institutionRegion)) return false;
  const scope = getScope(user);
  return alert.caseIds.some((id) => scope.metadataIds.has(id));
}

/** Single entry point used by routes and services to ask a named question. */
export function hasCasePermission(user: SessionUser, c: CaseRecord, permission: CasePermission): boolean {
  switch (permission) {
    case 'view_coordination_metadata':
      return canViewCoordinationMetadata(user, c);
    case 'read_content':
      return canReadCaseContent(user, c);
    case 'modify_case':
      return canModifyCase(user, c);
    case 'upload_evidence':
      return canUploadEvidence(user, c);
    case 'manage_access':
      return canManageCaseAccess(user, c);
  }
}

/** Human-readable reason fragment used in security-denial log entries. */
export function describeAuthority(user: SessionUser): string {
  return `role=${user.role} bureau=${user.bureau ?? 'none'} region=${user.region ?? 'national'} grants=${user.grantedCaseIds.length}`;
}

/** Backwards-compatible alias: modification authority. */
export const canMutateCase = canModifyCase;

/**
 * Transfer decision authority. The receiving lead does not own the case yet, so an owning-bureau guard
 * would be wrong: authority comes from being a lead of the **target** bureau *and* having regional
 * authority over the actual case. A content grant, a foreign region or a client-supplied bureau never
 * satisfies this.
 */
export function canDecideTransfer(
  user: SessionUser,
  c: Pick<CaseRecord, 'institution_region' | 'case_number'>,
  transfer: { toBureau: string }
): boolean {
  if (user.role !== 'bureau_lead') return false;
  if (user.bureau !== transfer.toBureau) return false;
  if (c.institution_region) return inRegion(user, c.institution_region);
  // Unresolved institution identity: no region is recorded on the case, so the target bureau's own
  // lead decides from their intake queue (national accounts keep national authority).
  return true;
}

export function canAssign(user: SessionUser, c: CaseRecord): boolean {
  return user.role === 'bureau_lead' && c.bureau === user.bureau && regionAllows(user, c);
}

/**
 * Relationship decision authority (Milestone 2) — one policy for confirming, dismissing and revoking.
 *
 *  - lead or supervisor only: officers, reviewers and administrators never decide a relationship;
 *  - **current** content access to *both* cases: a read-only role holding both grants still cannot
 *    decide, and a decision can never be taken on a pair the actor can only see as coordination
 *    metadata;
 *  - regional authority over both cases;
 *  - a bureau lead may only decide pairs where both cases belong to their own bureau; a pair that spans
 *    bureaus follows the supervisor coordination policy.
 *
 * Client-supplied roles, bureaus, regions and the interface's own `canDecide` flag are never consulted.
 */
export function canDecideRelationship(user: SessionUser, a: CaseRecord, b: CaseRecord): boolean {
  if (user.role !== 'bureau_lead' && user.role !== 'supervisor') return false;
  if (!regionAllows(user, a) || !regionAllows(user, b)) return false;
  if (!canReadCaseContent(user, a) || !canReadCaseContent(user, b)) return false;
  if (user.role === 'bureau_lead') return a.bureau === user.bureau && b.bureau === user.bureau;
  return true;
}

/** Revocation of a stored link uses exactly the same authority as the decision that created it. */
export const canRevokeRelationship = canDecideRelationship;

/** Reason a relationship decision is refused, for the denial log and the API message. */
export function relationshipDenialReason(user: SessionUser, a: CaseRecord, b: CaseRecord): string {
  if (user.role !== 'bureau_lead' && user.role !== 'supervisor') {
    return 'Relationship decisions need a bureau lead or supervisor account.';
  }
  if (!regionAllows(user, a) || !regionAllows(user, b)) {
    return 'At least one case in this pair is outside your authorised region.';
  }
  if (!canReadCaseContent(user, a) || !canReadCaseContent(user, b)) {
    return 'You need current content access to both cases before deciding their relationship. Request coordination access from the owning bureau lead or a supervisor.';
  }
  if (user.role === 'bureau_lead' && !(a.bureau === user.bureau && b.bureau === user.bureau)) {
    return 'This pair spans bureaus. A supervisor with access to both cases records the decision.';
  }
  return 'You do not have authority to decide this relationship.';
}

export function ownerRoleLabel(officerId: string | null): string {
  if (!officerId) return 'Unassigned queue';
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(officerId) as { role: Role } | undefined;
  if (!row) return 'Unassigned queue';
  return {
    bureau_officer: 'Bureau officer',
    bureau_lead: 'Bureau lead',
    supervisor: 'Supervisor',
    reviewer: 'Read-only reviewer',
    admin: 'Administrator',
  }[row.role];
}

/** Coordination-safe projection: no complaint text, no contact, no attachments, no free-text history. */
export function maskCase(user: SessionUser, c: CaseRecord) {
  return {
    id: c.id,
    caseNumber: c.case_number,
    institutionId: c.institution_id,
    institutionName: c.institution_name,
    institutionPermanentId: c.institution_permanent_id,
    region: c.institution_region,
    category: c.category,
    bureau: c.bureau,
    status: c.status,
    ownerRole: ownerRoleLabel(c.assigned_officer_id),
    ownerName: null,
    receivedAt: c.received_at,
    lastActionAt: lastActionAt(c.id),
    nextActionDueAt: c.next_action_due_at,
    expectedDisposalAt: c.expected_disposal_at,
    escalationOpen: c.escalation_open === 1,
    // Coordination metadata only: that a decision exists, never its text or reference.
    outcomeRecorded: Boolean(c.outcome),
    version: c.version,
    access: 'restricted' as const,
    redactedFields: ['complaintSummary', 'complainantContact', 'attachments', 'historyRemarks', 'sourceReference'],
    grantable: canManageCaseAccess(user, c),
  };
}

export function fullCase(c: CaseRecord) {
  return {
    id: c.id,
    caseNumber: c.case_number,
    institutionId: c.institution_id,
    institutionName: c.institution_name,
    institutionPermanentId: c.institution_permanent_id,
    region: c.institution_region,
    intakeInstitutionText: c.intake_institution_text,
    triageState: c.triage_state,
    receivedAt: c.received_at,
    importedAt: c.imported_at,
    sourceChannel: c.source_channel,
    sourceReference: c.source_reference,
    category: c.category,
    complaintSummary: c.complaint_summary,
    bureau: c.bureau,
    assignedOfficerId: c.assigned_officer_id,
    assignedOfficerName: c.assigned_officer_name,
    status: c.status,
    nextAction: c.next_action,
    nextActionDueAt: c.next_action_due_at,
    expectedDisposalAt: c.expected_disposal_at,
    deadlinePolicyId: c.deadline_policy_id,
    responseDueAt: c.response_due_at,
    responseFromRole: c.response_from_role,
    complainantContact: c.complainant_contact,
    version: c.version,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    disposedAt: c.disposed_at,
    closedAt: c.closed_at,
    reopenedAt: c.reopened_at,
    escalationOpen: c.escalation_open === 1,
    escalationReason: c.escalation_reason,
    escalationSupervisorId: c.escalation_supervisor_id,
    escalationOpenedAt: c.escalation_opened_at,
    outcome: c.outcome,
    decisionReference: c.decision_reference,
    sourceSystem: c.source_system,
    access: 'full' as const,
  };
}

export function shapeCase(user: SessionUser, c: CaseRecord) {
  return canViewContent(user, c) ? fullCase(c) : maskCase(user, c);
}

/* ------------------------------------------------------- state transitions */

/**
 * The one lifecycle matrix (M3). PRD sequence:
 *   Received → Assigned → Under review → Awaiting response | Disposed
 *   Awaiting response → Under review | Disposed
 *   Disposed → Closed
 * Reopening a Disposed/Closed case returns it to Under review, but only through the protected
 * reopening operation (owning bureau lead, reason, current version) — never through a generic edit,
 * an action form or any other route.
 */
export const TRANSITIONS: Record<Status, Status[]> = {
  Received: ['Assigned'],
  Assigned: ['Under review', 'Awaiting response', 'Received'],
  'Under review': ['Awaiting response', 'Disposed'],
  'Awaiting response': ['Under review', 'Disposed'],
  Disposed: ['Closed'],
  Closed: [],
};

/** Reopening is a separate, protected operation: Disposed/Closed → Under review. */
export const REOPEN_FROM: Status[] = ['Disposed', 'Closed'];
export const REOPEN_TO: Status = 'Under review';

export function isValidTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** True when this status change is only permitted through the protected reopen operation. */
export function requiresReopenOperation(from: Status, to: Status): boolean {
  return REOPEN_FROM.includes(from) && to === REOPEN_TO;
}

/** True when a case is in a completed state that can only be left through the protected reopening. */
export function isCompletedStatus(status: Status): boolean {
  return REOPEN_FROM.includes(status);
}

/** Every legal next state for the interface, including the protected reopening path. */
export function nextStatesFor(from: Status): Status[] {
  const base = [...TRANSITIONS[from]];
  if (REOPEN_FROM.includes(from)) base.push(REOPEN_TO);
  return base;
}

export function transitionNeedsLead(to: Status): boolean {
  return to === 'Disposed' || to === 'Closed';
}

/** Recording a disposition needs a structured outcome and a decision reference (M3). */
export const DISPOSITION_OUTCOMES = [
  'Upheld — corrective action directed',
  'Closed — no action required',
  'Closed — referred to another authority',
  'Withdrawn by complainant',
  'Other',
] as const;
export type DispositionOutcome = (typeof DISPOSITION_OUTCOMES)[number];

export function isDispositionOutcome(value: string): value is DispositionOutcome {
  return (DISPOSITION_OUTCOMES as readonly string[]).includes(value);
}
