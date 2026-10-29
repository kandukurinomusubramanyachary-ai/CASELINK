/**
 * Shared coordination-privacy projections (Milestone 2).
 *
 * Every response that can mention two cases, or that was *stored* for a viewer whose scope may have
 * changed since, goes through one of these helpers. Nothing here decides authority — `domain.ts` does
 * that; these helpers decide **what may be shown** once authority has been established.
 *
 * Rules:
 *  - coordination metadata (institution, category, bureau, status, case number, dates) is visible under
 *    the metadata policy;
 *  - complaint-derived material (external references, complaint excerpts, contacts, attachment details,
 *    free-text reasons and remarks) requires content access to every case it mentions;
 *  - a nested object is never spread straight out of a database row.
 */
import { db } from './db.js';
import {
  canDecideRelationship,
  canReadCaseContent,
  canViewMetadata,
  getCase,
  type CaseRecord,
} from './domain.js';
import type { SessionUser } from './auth.js';

/**
 * Rows already in memory for one synchronous request, so a projection that mentions the same case many
 * times (a coordination page with hundreds of candidate pairs) reads each case once instead of once per
 * mention. The API is single-threaded and every handler is synchronous, so a request-scoped map cannot
 * leak between callers; `finally` always clears it.
 */
let requestCaseCache: Map<string, CaseRecord> | null = null;

export function withCaseCache<T>(cases: Map<string, CaseRecord>, run: () => T): T {
  const previous = requestCaseCache;
  requestCaseCache = cases;
  try {
    return run();
  } finally {
    requestCaseCache = previous;
  }
}

function cachedCase(id: string): CaseRecord {
  const cached = requestCaseCache?.get(id);
  if (cached) return cached;
  const loaded = getCase(id) as CaseRecord;
  requestCaseCache?.set(id, loaded);
  return loaded;
}

export const REDACTED = '[restricted — request a coordination grant to read this detail]';
export const NOT_IN_SCOPE = '[no longer available in your authorised scope]';

export interface StoredReason {
  rule: string;
  detail: string;
  sourceField: string;
}

/** Rules whose detail text quotes complaint-derived values (reference, wording, alias, contact…). */
const CONTENT_BEARING_RULES = new Set([
  'shared_external_reference',
  'topic_similarity',
  'reviewed_institution_alias',
  'same_category_detail',
]);

/** Safe, non-quoting description for each rule, used when the viewer cannot read the cases. */
const RULE_SUMMARY: Record<string, string> = {
  shared_external_reference: 'Both cases cite the same external reference (value withheld).',
  topic_similarity: 'Complaint wording is similar above the rule threshold (text withheld).',
  reviewed_institution_alias: 'Both complaints name a reviewed alias for this institution (alias withheld).',
  same_category: 'Both cases are filed under the same category.',
  different_category: 'The two cases are filed under different categories.',
  incident_period_overlap: 'The two cases were received inside the same 14-day window.',
  same_institution: 'Both cases belong to this canonical institution.',
  different_institution: 'The cases belong to different institutions.',
};

/**
 * Candidate/recommendation reasons. Full text only when the viewer can read the contents of **both**
 * cases the suggestion pairs; otherwise each reason is reduced to a rule summary with no quoted values.
 */
export function projectReasons(user: SessionUser, a: CaseRecord, b: CaseRecord, reasons: StoredReason[]) {
  const full = canReadCaseContent(user, a) && canReadCaseContent(user, b);
  if (full) return { redacted: false as const, reasons };
  return {
    redacted: true as const,
    reasons: reasons.map((r) => ({
      rule: r.rule,
      sourceField: CONTENT_BEARING_RULES.has(r.rule) ? 'withheld' : r.sourceField,
      detail: RULE_SUMMARY[r.rule] ?? 'A matching signal applies to these two cases (detail withheld).',
    })),
  };
}

export interface SuggestionRow {
  id: string;
  case_a_id: string;
  case_b_id: string;
  institution_id: string;
  kind: string;
  reasons_json: string;
  evidence_hash: string;
  rule_version: string;
  state: string;
  created_at: string;
  decision_reason: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
}

/**
 * One suggestion, projected for the caller. `canDecide` comes from the shared relationship policy and
 * requires content access to both cases — the interface simply renders what the server decides.
 */
export function projectSuggestion(user: SessionUser, s: SuggestionRow) {
  const a = cachedCase(s.case_a_id);
  const b = cachedCase(s.case_b_id);
  const contentA = canReadCaseContent(user, a);
  const contentB = canReadCaseContent(user, b);
  const canSeeBoth = contentA && contentB;
  const reasons = projectReasons(user, a, b, JSON.parse(s.reasons_json) as StoredReason[]);
  const brief = (c: CaseRecord, content: boolean) => ({
    id: c.id,
    caseNumber: canViewMetadata(user, c) ? c.case_number : null,
    institutionName: c.institution_name,
    institutionPermanentId: c.institution_permanent_id,
    category: c.category,
    bureau: c.bureau,
    status: c.status,
    access: content ? ('full' as const) : ('restricted' as const),
    summary: content ? c.complaint_summary : null,
    // The version the reviewer is looking at, so a decision can be refused if either case moved.
    version: c.version,
  });
  return {
    id: s.id,
    kind: s.kind,
    state: s.state,
    ruleVersion: s.rule_version,
    // The evidence hash is a non-reversible fingerprint; it never carries complaint text.
    evidenceHash: canSeeBoth ? s.evidence_hash : null,
    createdAt: s.created_at,
    decisionReason: canSeeBoth ? s.decision_reason : s.decision_reason ? REDACTED : null,
    decidedBy: s.decided_by ?? null,
    decidedAt: s.decided_at ?? null,
    reasons: reasons.reasons,
    reasonsRedacted: reasons.redacted,
    caseA: brief(a, contentA),
    caseB: brief(b, contentB),
    canDecide: canDecideRelationship(user, a, b),
    requiresContentAccess: !canSeeBoth,
  };
}

export interface RelationshipRow {
  id: string;
  type: string;
  state: string;
  reason: string;
  reviewer_id?: string;
  reviewerName?: string | null;
  decided_at: string;
  case_a_id: string;
  case_b_id: string;
  revoked_reason?: string | null;
  revoked_at?: string | null;
  revokedByName?: string | null;
  evidence_json?: string;
  rule_version?: string;
}

/**
 * One stored relationship. The human decision reason, the revocation reason, the reviewer identity and
 * the evidence snapshot are complaint-derived, so they are shown only to a viewer who can read **both**
 * cases now — a stale response can never keep disclosing them after a revocation.
 */
export function projectRelationship(user: SessionUser, r: RelationshipRow) {
  const a = cachedCase(r.case_a_id);
  const b = cachedCase(r.case_b_id);
  const canSeeBoth = canReadCaseContent(user, a) && canReadCaseContent(user, b);
  let evidence: unknown = null;
  if (canSeeBoth && r.evidence_json) {
    try {
      evidence = JSON.parse(r.evidence_json);
    } catch {
      evidence = null;
    }
  }
  const brief = (c: CaseRecord) =>
    canViewMetadata(user, c)
      ? {
          id: c.id,
          caseNumber: c.case_number,
          institutionName: c.institution_name,
          category: c.category,
          bureau: c.bureau,
          status: c.status,
          version: c.version,
          access: canReadCaseContent(user, c) ? ('full' as const) : ('restricted' as const),
        }
      : { id: c.id, access: 'hidden' as const };
  return {
    id: r.id,
    type: r.type,
    state: r.state,
    decidedAt: r.decided_at,
    reviewerName: canSeeBoth ? (r.reviewerName ?? null) : null,
    reason: canSeeBoth ? r.reason : REDACTED,
    revokedReason: canSeeBoth ? (r.revoked_reason ?? null) : r.revoked_reason ? REDACTED : null,
    revokedAt: r.revoked_at ?? null,
    revokedByName: canSeeBoth ? (r.revokedByName ?? null) : null,
    evidence,
    ruleVersion: canSeeBoth ? (r.rule_version ?? null) : null,
    contentVisible: canSeeBoth,
    canRevoke: canSeeBoth && canDecideRelationship(user, a, b) && r.state === 'active',
    caseA: brief(a),
    caseB: brief(b),
  };
}

/** Relationship rows for an institution or a case, already filtered to pairs the caller may see. */
export function loadRelationshipRows(where: { institutionId?: string; caseId?: string }): RelationshipRow[] {
  const clause = where.institutionId
    ? `r.case_a_id IN (SELECT id FROM cases WHERE institution_id = @id)`
    : where.caseId
      ? `(r.case_a_id = @id OR r.case_b_id = @id)`
      : '1 = 1';
  if (!where.institutionId && !where.caseId) {
    return db
      .prepare(
        `SELECT r.id, r.type, r.state, r.reason, r.decided_at, r.case_a_id, r.case_b_id,
                r.revoked_reason, r.revoked_at, r.evidence_json, r.rule_version, r.reviewer_id,
                u.display_name AS reviewerName, ru.display_name AS revokedByName
           FROM relationships r
           JOIN users u ON u.id = r.reviewer_id
           LEFT JOIN users ru ON ru.id = r.revoked_by
          ORDER BY r.decided_at DESC`
      )
      .all() as RelationshipRow[];
  }
  return db
    .prepare(
      `SELECT r.id, r.type, r.state, r.reason, r.decided_at, r.case_a_id, r.case_b_id,
              r.revoked_reason, r.revoked_at, r.evidence_json, r.rule_version, r.reviewer_id,
              u.display_name AS reviewerName, ru.display_name AS revokedByName
         FROM relationships r
         JOIN users u ON u.id = r.reviewer_id
         LEFT JOIN users ru ON ru.id = r.revoked_by
        WHERE ${clause}
        ORDER BY r.decided_at DESC`
    )
    .all({ id: where.institutionId ?? where.caseId }) as RelationshipRow[];
}

/**
 * A stored notification is re-evaluated when it is read: notifications are created under the authority
 * that existed at delivery time, and a later revocation, transfer or scope change must not keep leaking
 * case detail. Only the title/body of an entity the caller may still see in the same form is returned.
 */
export interface NotificationDetail {
  caseNumber?: string | null;
  category?: string | null;
  bureau?: string | null;
  status?: string | null;
  deadline?: string | null;
  fromBureau?: string | null;
  toBureau?: string | null;
  institutionName?: string | null;
  institutionPermanentId?: string | null;
  caseReferences?: string | null;
  /** Free text exists somewhere in the record, but its value is not carried in the notification. */
  detailRecordedInCase?: boolean;
  escalationFlag?: boolean;
}

/**
 * The body of a notification for a reader who may see the coordination metadata but not the complaint
 * content. It is built from the structured `detail_json` stored with the notification — never from the
 * stored body, which may quote a next action, an escalation reason or a transfer reason (M7/A12).
 */
export function safeNotificationBody(kind: string, detail: NotificationDetail | null): string {
  if (!detail) {
    return `${NOT_IN_SCOPE} The related record is outside your content scope; ask for a coordination grant to read the detail.`;
  }
  const parts: string[] = [];
  if (detail.caseNumber) parts.push(`Case ${detail.caseNumber}`);
  if (detail.institutionName) {
    parts.push(`${detail.institutionName}${detail.institutionPermanentId ? ` (${detail.institutionPermanentId})` : ''}`);
  }
  if (detail.category) parts.push(`Category: ${detail.category}`);
  if (detail.bureau) parts.push(`Owning bureau: ${detail.bureau}`);
  if (detail.fromBureau && detail.toBureau) parts.push(`Ownership: ${detail.fromBureau} → ${detail.toBureau}`);
  if (detail.status) parts.push(`Lifecycle state: ${detail.status}`);
  if (detail.deadline) parts.push(`Configured disposal deadline: ${detail.deadline}`);
  if (detail.escalationFlag) parts.push('An escalation flag is open on this case.');
  if (detail.caseReferences) parts.push(`Case references: ${detail.caseReferences}`);
  if (kind === 'overlap') {
    parts.push('Open Coordination to review the permitted coordination metadata.');
  } else {
    parts.push('The complaint-derived detail is shown in the case record to readers with content access.');
  }
  return `${parts.join('. ')}.`;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  title: string;
  body: string;
  detail_json?: string | null;
  created_at: string;
  read_at: string | null;
  acknowledged_at: string | null;
}

/** The case a notification refers to, or null when the entity is not case-derived. */
export function notificationCaseId(entityType: string, entityId: string): string | null {
  if (entityType === 'case') return entityId;
  if (entityType === 'transfer') {
    return (
      (db.prepare('SELECT case_id FROM transfers WHERE id = ?').get(entityId) as { case_id: string } | undefined)?.case_id ??
      null
    );
  }
  return null;
}

/**
 * A stored notification is re-evaluated when it is read. Two separate permissions are applied:
 * metadata visibility decides *whether* the notice is shown at all, and content access decides *how
 * much* of it is shown. A notice whose case is out of scope is redacted; a notice whose case is in
 * scope but whose contents are not readable carries only the coordination facts.
 */
export function projectNotification(user: SessionUser, n: NotificationRow) {
  const base = {
    id: n.id,
    kind: n.kind,
    entityType: n.entity_type,
    entityId: n.entity_id,
    createdAt: n.created_at,
    readAt: n.read_at,
    acknowledgedAt: n.acknowledged_at,
    redacted: false,
    contentVisible: false,
    title: n.title,
    body: n.body,
  };

  let detail: NotificationDetail | null = null;
  if (n.detail_json) {
    try {
      detail = JSON.parse(n.detail_json) as NotificationDetail;
    } catch {
      detail = null;
    }
  }

  const permitted = (entityType: string, entityId: string): boolean => {
    const caseId = notificationCaseId(entityType, entityId);
    if (caseId) {
      const c = cachedCase(caseId);
      return Boolean(c && canViewMetadata(user, c));
    }
    if (entityType === 'alert') {
      const alert = db.prepare('SELECT case_ids_json, institution_id FROM alerts WHERE id = ?').get(entityId) as
        | { case_ids_json: string; institution_id: string | null }
        | undefined;
      if (!alert) return false;
      const ids = JSON.parse(alert.case_ids_json) as string[];
      return ids.some((id) => {
        const c = cachedCase(id);
        return Boolean(c && canViewMetadata(user, c));
      });
    }
    // Unknown entity types are treated as personal notices (they carry no case projection).
    return true;
  };

  if (!permitted(n.entity_type, n.entity_id)) {
    return {
      ...base,
      redacted: true,
      title: 'Notice no longer available in your scope',
      body: `${NOT_IN_SCOPE} The related record is outside your current bureau, region or grants.`,
    };
  }

  const caseId = notificationCaseId(n.entity_type, n.entity_id);
  if (!caseId) return base; // personal notice: nothing case-derived to withhold
  const c = cachedCase(caseId);
  const content = Boolean(c && canReadCaseContent(user, c));
  if (content) return { ...base, contentVisible: true };
  return {
    ...base,
    contentVisible: false,
    body: safeNotificationBody(n.kind, detail),
  };
}

/* ------------------------------------------------------- transfer projection */

export interface TransferRow {
  id: string;
  case_id: string;
  from_bureau: string;
  to_bureau: string;
  reason: string;
  requested_at: string;
  requestedBy?: string | null;
  requestedByName?: string | null;
  state: string;
  decided_at?: string | null;
  decision_note?: string | null;
  decidedByName?: string | null;
}

/**
 * A transfer row as the caller may see it. Ownership movement (bureaux, state, dates) is coordination
 * metadata; the requesting lead's free-text reason and the deciding lead's note are complaint-derived,
 * so they need content access to the case (M7/A01).
 */
export function projectTransfer(user: SessionUser, c: CaseRecord, t: TransferRow) {
  const content = canReadCaseContent(user, c);
  return {
    id: t.id,
    caseId: t.case_id,
    fromBureau: t.from_bureau,
    toBureau: t.to_bureau,
    state: t.state,
    requestedAt: t.requested_at,
    requestedByName: t.requestedByName ?? null,
    decidedAt: t.decided_at ?? null,
    decidedByName: t.decidedByName ?? null,
    contentVisible: content,
    reason: content ? t.reason : t.reason ? REDACTED : null,
    decisionNote: content ? (t.decision_note ?? null) : t.decision_note ? REDACTED : null,
  };
}

/**
 * Pending transfers for one viewer's My work queue. A transfer is shown only when the viewer may see
 * the case at all (metadata at least): bureau membership alone is not enough, because a case can be
 * outside the viewer's region (M7/A01).
 */
export function pendingTransfersFor(user: SessionUser) {
  const rows = db
    .prepare(
      `SELECT t.id, t.case_id, t.from_bureau, t.to_bureau, t.reason, t.requested_at, t.state,
              t.decided_at, t.decision_note, ru.display_name AS requestedByName, du.display_name AS decidedByName
         FROM transfers t
         LEFT JOIN users ru ON ru.id = t.requested_by
         LEFT JOIN users du ON du.id = t.decided_by
        WHERE t.state = 'pending' AND (t.to_bureau = ? OR t.from_bureau = ?)
        ORDER BY t.requested_at DESC`
    )
    .all(user.bureau ?? '', user.bureau ?? '') as TransferRow[];
  return rows
    .map((t) => {
      const c = cachedCase(t.case_id);
      if (!c || !canViewMetadata(user, c)) return null;
      const projected = projectTransfer(user, c, t);
      return {
        ...projected,
        caseNumber: c.case_number,
        category: c.category,
        bureau: c.bureau,
        status: c.status,
        region: c.institution_region ?? null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

/**
 * Users who may be told about this case at all: the recipient must currently be able to see the case's
 * coordination metadata (role + bureau + authorised region), which is the same rule the read paths use.
 * Free-text notification bodies are only ever rendered for a recipient with content access, so the
 * recipients list can safely include metadata-only readers.
 */
export function notifyRecipientsFor(c: CaseRecord, candidates: SessionUser[]): SessionUser[] {
  return candidates.filter((candidate) => canViewMetadata(candidate, c));
}
