import { db, nextCaseNumber, nowIso, setting, uid } from './db.js';
import {
  ACTIVE_STATUSES,
  DISPOSITION_OUTCOMES,
  canDecideRelationship,
  canDecideTransfer,
  canManageCaseAccess,
  canModifyCase,
  canUploadEvidence,
  describeAuthority,
  getCase,
  isActiveStatus,
  isDispositionOutcome,
  isCompletedStatus,
  isValidTransition,
  regionAllows,
  requiresReopenOperation,
  relationshipDenialReason,
  transitionNeedsLead,
  validateCaseWorker,
  type CaseRecord,
  type Status,
} from './domain.js';
import { recordSecurityDenial } from './auth.js';
import { enqueue, notify, activeSessionUsers, caseNotificationDetail } from './worker.js';
import { notifyRecipientsFor, type NotificationDetail } from './privacy.js';
import { addCalendarDays, recomputeOverlap, recomputeSuggestions } from './rules.js';
import type { SessionUser } from './auth.js';
import { AppError } from './errors.js';

// Re-exported so existing importers keep one import site for the workflow error type.
export { AppError };

/**
 * A versioned write must affect exactly one row. Anything else means the record moved between the
 * read the user saw and the write we attempted, so nothing from this request may be kept.
 */
export function guardWrite(changed: number, what = 'This case'): void {
  if (changed !== 1) {
    throw new AppError(
      409,
      'stale_version',
      `${what} changed while you were saving. Review the latest record and re-apply your changes.`
    );
  }
}

export function assertVersion(c: CaseRecord, expected: unknown): void {
  if (expected === undefined || expected === null) {
    throw new AppError(422, 'validation_error', 'Save requires the record version you were shown.', {
      version: 'Missing record version.',
    });
  }
  if (Number(expected) !== c.version) {
    throw new AppError(
      409,
      'stale_version',
      `This case changed since you opened it (you have v${expected}, the record is v${c.version}). Review the latest record, then re-apply your changes.`,
      { version: 'Stale record version.' }
    );
  }
}

export interface EventInput {
  actor: SessionUser;
  caseId: string;
  actionType: string;
  remarks?: string | null;
  nextStep?: string | null;
  before?: unknown;
  after?: unknown;
  versionAfter: number;
  at?: string;
  /**
   * The other case of a two-case decision (relationship confirm/dismiss/revoke). The remarks quote the
   * reviewer's free text about both records, so history projection requires content access to this case
   * *and* the paired one (M7/A02).
   */
  pairedCaseId?: string | null;
}

/** Append-only business history. Always called inside the same transaction as the mutation it describes. */
/**
 * Both case versions of a two-case decision are mandatory. A client that does not track them is
 * refused, rather than silently allowed to decide against state the reviewer never saw (M7/A07).
 */
function requireBothVersions(expected: { caseA?: number | null; caseB?: number | null }): void {
  const missing: Record<string, string> = {};
  if (!Number.isInteger(expected.caseA)) missing.caseAVersion = 'Required: the version of case A you were shown.';
  if (!Number.isInteger(expected.caseB)) missing.caseBVersion = 'Required: the version of case B you were shown.';
  if (Object.keys(missing).length) {
    throw new AppError(422, 'validation_error', 'Send both case versions with the decision.', missing);
  }
}

export function appendEvent(input: EventInput): void {
  if (setting('inject_audit_failure', '0') === '1') {
    // Demo-only fault injection so the T12 rollback path can be demonstrated and tested.
    throw new Error('Injected audit-write failure (demo fault injection)');
  }
  db.prepare(
    `INSERT INTO action_events (id, case_id, actor_id, actor_bureau, at, action_type, remarks, next_step,
       before_json, after_json, version_after, paired_case_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    uid(),
    input.caseId,
    input.actor.id,
    input.actor.bureau,
    input.at ?? nowIso(),
    input.actionType,
    input.remarks ?? null,
    input.nextStep ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.versionAfter,
    input.pairedCaseId ?? null
  );
}

export function touchCase(caseId: string): void {
  db.prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ?').run(nowIso(), caseId);
}

export function enqueueCaseRecompute(institutionId: string | null): void {
  if (!institutionId) return;
  enqueue('recompute_overlap', { institutionId });
  enqueue('recompute_suggestions', { institutionId });
  enqueue('notify_overlap', { institutionId });
}

/* ---------------------------------------------------------------- creating */

export interface CreateCaseInput {
  institutionId?: string | null;
  intakeInstitutionText?: string | null;
  receivedAt: string;
  sourceChannel: string;
  sourceReference?: string | null;
  category: string;
  complaintSummary: string;
  bureau?: string;
  assignedOfficerId?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  deadlinePolicyId?: string | null;
  /**
   * The due time approved at import preview, when the caller is an import commit (M5/M7/A09). The
   * policy is still validated; this value is the one the officer actually reviewed.
   */
  expectedDisposalAt?: string | null;
  complainantContact?: string | null;
  status?: Status;
  /** Import provenance (M5): the source system and its normalised identity. */
  sourceSystem?: string | null;
  sourceIdentity?: string | null;
}

export function createCase(actor: SessionUser, input: CreateCaseInput): CaseRecord {
  const bureau = input.bureau ?? actor.bureau;
  if (!bureau) throw new AppError(403, 'access_denied', 'Select a bureau you belong to.');
  if (actor.role !== 'bureau_officer' && actor.role !== 'bureau_lead') {
    throw new AppError(403, 'access_denied', 'Only bureau officers and leads can register cases.');
  }
  if (bureau !== actor.bureau) {
    throw new AppError(403, 'access_denied', 'You can only register cases for your own bureau.');
  }
  const receivedMs = new Date(input.receivedAt).getTime();
  if (Number.isNaN(receivedMs)) throw new AppError(422, 'validation_error', 'Received date is not a valid date.', { receivedAt: 'Invalid date.' });
  if (receivedMs > Date.now() + 86_400_000) {
    throw new AppError(422, 'validation_error', 'Received date cannot be in the future.', { receivedAt: 'Cannot be in the future.' });
  }

  let institutionId: string | null = null;
  let triage: 'resolved' | 'unresolved' = 'resolved';
  if (input.institutionId) {
    const inst = db.prepare('SELECT id, region FROM institutions WHERE id = ?').get(input.institutionId) as
      | { id: string; region: string }
      | undefined;
    if (!inst) throw new AppError(422, 'validation_error', 'Unknown institution.', { institutionId: 'Institution not found.' });
    if (actor.region && inst.region !== actor.region) {
      throw new AppError(403, 'access_denied', 'That institution is outside your authorised region.');
    }
    institutionId = inst.id;
  } else {
    if (!input.intakeInstitutionText || input.intakeInstitutionText.trim().length < 3) {
      throw new AppError(422, 'validation_error', 'Select a confirmed institution or describe the unconfirmed one for triage.', {
        institutionId: 'Institution is required, or provide triage text.',
      });
    }
    triage = 'unresolved';
  }

  if (input.assignedOfficerId) {
    // Same policy as reassignment, import and transfer acceptance: active case worker, owning bureau,
    // and an authorised region for the case (M7/A04).
    const caseRegion = institutionId
      ? ((db.prepare('SELECT region FROM institutions WHERE id = ?').get(institutionId) as { region: string | null } | undefined)?.region ?? actor.region)
      : actor.region;
    validateCaseWorker(input.assignedOfficerId, { bureau, region: caseRegion });
  }
  if (input.assignedOfficerId && actor.role === 'bureau_officer' && input.assignedOfficerId !== actor.id) {
    throw new AppError(403, 'access_denied', 'Officers can only assign new cases to themselves.');
  }

  let expectedDisposalAt: string | null = null;
  let policyId: string | null = null;
  if (input.deadlinePolicyId) {
    const policy = db
      .prepare('SELECT id, calendar_days, active FROM deadline_policies WHERE id = ?')
      .get(input.deadlinePolicyId) as { id: string; calendar_days: number; active: number } | undefined;
    if (!policy || policy.active !== 1) {
      throw new AppError(422, 'validation_error', 'Unknown or inactive deadline policy.', { deadlinePolicyId: 'Policy unavailable.' });
    }
    policyId = policy.id;
    expectedDisposalAt = addCalendarDays(new Date(input.receivedAt).toISOString(), policy.calendar_days);
    // A caller that approved a specific due time (import commit) keeps that time.
    if (input.expectedDisposalAt) expectedDisposalAt = input.expectedDisposalAt;
  } else if (input.expectedDisposalAt) {
    // A due time without a policy is a contradiction: refused rather than stored without provenance.
    throw new AppError(422, 'validation_error', 'A disposal deadline needs a deadline policy. Nothing was invented.', {
      deadlinePolicyId: 'Required with a due time.',
    });
  }

  const status: Status = input.assignedOfficerId ? 'Assigned' : 'Received';
  const id = uid();
  const caseNumber = nextCaseNumber(bureau, input.receivedAt);
  const at = nowIso();
  db.prepare(
    `INSERT INTO cases (id, case_number, institution_id, intake_institution_text, triage_state, received_at, imported_at,
       source_channel, source_reference, category, complaint_summary, bureau, assigned_officer_id, status, next_action,
       next_action_due_at, expected_disposal_at, deadline_policy_id, complainant_contact, version, created_by, created_at, updated_at,
       source_system, source_identity)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    caseNumber,
    institutionId,
    input.intakeInstitutionText ?? null,
    triage,
    new Date(input.receivedAt).toISOString(),
    null,
    input.sourceChannel,
    input.sourceReference ?? null,
    input.category,
    input.complaintSummary,
    bureau,
    input.assignedOfficerId ?? null,
    status,
    input.nextAction ?? null,
    input.nextActionDueAt ?? null,
    expectedDisposalAt,
    policyId,
    input.complainantContact ?? null,
    1,
    actor.id,
    at,
    at,
    input.sourceSystem ?? null,
    input.sourceIdentity ?? null
  );
  appendEvent({
    actor,
    caseId: id,
    actionType: 'case_created',
    remarks: `Case registered from ${input.sourceChannel}.${triage === 'unresolved' ? ' Institution identity unresolved — held in triage.' : ''}`,
    nextStep: input.nextAction ?? null,
    after: { caseNumber, status, bureau, institutionId, triage },
    versionAfter: 1,
  });
  enqueueCaseRecompute(institutionId);
  return getCase(id) as CaseRecord;
}

/* ---------------------------------------------------------------- updating */

export interface UpdateCaseInput {
  version: number;
  actionType?: string;
  remarks?: string;
  nextStep?: string | null;
  category?: string;
  complaintSummary?: string;
  complainantContact?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  responseDueAt?: string | null;
  responseFromRole?: string | null;
  status?: Status;
  decisionReference?: string | null;
  /** Structured disposition outcome — required when recording Disposed (M3). */
  outcome?: string | null;
}

export function updateCase(actor: SessionUser, c: CaseRecord, input: UpdateCaseInput): CaseRecord {
  assertVersion(c, input.version);
  if (!canModifyCase(actor, c)) {
    recordSecurityDenial(actor.id, `case_update_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Only the owning officer or the bureau lead can update this case.');
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [];

  const guardedLeadFields = ['responseDueAt', 'responseFromRole', 'decisionReference'];
  for (const key of guardedLeadFields) {
    if ((input as unknown as Record<string, unknown>)[key] !== undefined && actor.role !== 'bureau_lead') {
      throw new AppError(403, 'access_denied', `Only a bureau lead can set ${key}.`);
    }
  }

  const assign = (column: string, value: unknown, label: string) => {
    const current = (c as unknown as Record<string, unknown>)[column];
    if (current !== value) {
      sets.push(`${column} = ?`);
      params.push(value);
      before[label] = current;
      after[label] = value;
    }
  };

  if (input.category !== undefined) assign('category', input.category, 'category');
  if (input.complaintSummary !== undefined) assign('complaint_summary', input.complaintSummary, 'complaintSummary');
  if (input.complainantContact !== undefined) assign('complainant_contact', input.complainantContact, 'complainantContact');
  // Next-action semantics: a field that is not submitted (`undefined`) leaves the stored value alone,
  // while an explicit `null` clears it. `nextStep` is the action-form alias of the same field.
  if (input.nextAction !== undefined) {
    assign('next_action', input.nextAction === null ? null : input.nextAction.trim() || null, 'nextAction');
  } else if (input.nextStep !== undefined) {
    assign('next_action', input.nextStep === null ? null : input.nextStep.trim() || null, 'nextStep');
  }
  if (input.nextActionDueAt !== undefined) {
    if (input.nextActionDueAt && Number.isNaN(new Date(input.nextActionDueAt).getTime())) {
      throw new AppError(422, 'validation_error', 'Next action due date is invalid.', { nextActionDueAt: 'Invalid date.' });
    }
    assign('next_action_due_at', input.nextActionDueAt || null, 'nextActionDueAt');
  }
  if (input.responseDueAt !== undefined) {
    if (input.responseDueAt && Number.isNaN(new Date(input.responseDueAt).getTime())) {
      throw new AppError(422, 'validation_error', 'Response due date is invalid.', { responseDueAt: 'Invalid date.' });
    }
    assign('response_due_at', input.responseDueAt || null, 'responseDueAt');
  }
  if (input.responseFromRole !== undefined) assign('response_from_role', input.responseFromRole, 'responseFromRole');

  if (input.status && input.status !== c.status) {
    // Reopening is protected: a disposed/closed case may only return to review through POST /reopen.
    if (requiresReopenOperation(c.status, input.status)) {
      recordSecurityDenial(actor.id, `reopen_bypass_denied case=${c.id} ${describeAuthority(actor)}`);
      throw new AppError(
        422,
        'use_reopen_operation',
        'A disposed or closed case is reopened through the protected reopening operation, with a reason and the current version — not through a general edit.',
        { status: 'Use the reopen action.' }
      );
    }
    if (!isValidTransition(c.status, input.status)) {
      throw new AppError(
        422,
        'invalid_transition',
        `"${c.status}" cannot move directly to "${input.status}".`,
        { status: 'Not a permitted next state.' }
      );
    }
    if (transitionNeedsLead(input.status) && actor.role !== 'bureau_lead') {
      throw new AppError(403, 'access_denied', `Recording a case as ${input.status} is a bureau lead action.`);
    }
    if (input.status === 'Awaiting response') {
      if (!input.responseDueAt && !c.response_due_at) {
        throw new AppError(422, 'validation_error', 'Awaiting response needs a response due date.', { responseDueAt: 'Required.' });
      }
      if (!input.responseFromRole && !c.response_from_role) {
        throw new AppError(422, 'validation_error', 'Awaiting response needs the recipient role.', { responseFromRole: 'Required.' });
      }
    }
    assign('status', input.status, 'status');
    if (input.status === 'Disposed') {
      // Structured, durable outcome + reference. Remarks never substitute for either field.
      const outcome = (input.outcome ?? '').trim();
      const reference = (input.decisionReference ?? '').trim();
      if (!outcome) {
        throw new AppError(422, 'validation_error', 'Choose the disposition outcome before disposing the case.', {
          outcome: 'Required for disposal.',
        });
      }
      if (!isDispositionOutcome(outcome)) {
        throw new AppError(422, 'validation_error', `Outcome must be one of: ${DISPOSITION_OUTCOMES.join(' | ')}`, {
          outcome: 'Unknown outcome.',
        });
      }
      if (reference.length < 4) {
        throw new AppError(422, 'validation_error', 'A disposition needs the decision reference issued for it.', {
          decisionReference: 'Required for disposal.',
        });
      }
      assign('outcome', outcome, 'outcome');
      assign('decision_reference', reference, 'decisionReference');
      sets.push('disposed_at = ?');
      params.push(nowIso());
    }
    if (input.status === 'Closed') {
      sets.push('closed_at = ?');
      params.push(nowIso());
    }
  }

  if (!sets.length) {
    // Note-only action: no case field changed, but the actor recorded an observation.
    // The version still advances and the event is committed in the same transaction as its audit trail.
    if (!input.remarks || input.remarks.trim().length < 3) {
      throw new AppError(422, 'validation_error', 'No changes were submitted. Add remarks to record a note.', {
        remarks: 'Required when no field changes.',
      });
    }
    db.prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?').run(nowIso(), c.id, c.version);
    const noted = getCase(c.id) as CaseRecord;
    appendEvent({
      actor,
      caseId: c.id,
      actionType: input.actionType ?? 'internal_note',
      remarks: input.remarks,
      nextStep: input.nextStep ?? noted.next_action,
      before: { version: c.version },
      after: { version: noted.version, noteOnly: true },
      versionAfter: noted.version,
    });
    return noted;
  }

  sets.push('version = version + 1', 'updated_at = ?');
  params.push(nowIso(), c.id);
  const changed = db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ? AND version = ?`).run(...params, c.version).changes;
  if (changed !== 1) {
    // Somebody else advanced the record between our read and our write: nothing was saved.
    throw new AppError(409, 'stale_version', 'This case changed while you were saving. Review the latest record and re-apply your changes.');
  }

  const refreshed = getCase(c.id) as CaseRecord;
  const statusChanged = Boolean(input.status && input.status !== c.status);
  // Canonical transition event: the event type describes the lifecycle change itself, so a user's note
  // category can never hide a disposition from reporting. The chosen category is preserved alongside it.
  const canonicalType = statusChanged
    ? `status_${input.status!.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    : 'case_updated';
  appendEvent({
    actor,
    caseId: c.id,
    actionType: canonicalType,
    remarks: input.remarks ?? null,
    nextStep: input.nextStep ?? refreshed.next_action,
    before,
    after: {
      ...after,
      version: refreshed.version,
      noteCategory: input.actionType ?? null,
      transition: statusChanged ? { from: c.status, to: input.status } : null,
    },
    versionAfter: refreshed.version,
  });
  if (statusChanged && input.status === 'Disposed') {
    // Durable disposition record; reopening never deletes or rewrites it.
    db.prepare(
      `INSERT INTO dispositions (id, case_id, outcome, decision_reference, note, actor_id, at, version_after)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      uid(),
      c.id,
      (input.outcome ?? '').trim(),
      (input.decisionReference ?? '').trim(),
      input.remarks ?? null,
      actor.id,
      nowIso(),
      refreshed.version
    );
  }
  if (statusChanged) enqueueCaseRecompute(refreshed.institution_id);
  return refreshed;
}

/* -------------------------------------------------------------- assignment */

export function assignCase(
  actor: SessionUser,
  c: CaseRecord,
  officerId: string | null,
  reason: string,
  expectedVersion: unknown
): CaseRecord {
  if (actor.role !== 'bureau_lead' || c.bureau !== actor.bureau || !regionAllows(actor, c)) {
    recordSecurityDenial(actor.id, `assign_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Only the owning bureau lead can assign this case.');
  }
  if (officerId) {
    validateCaseWorker(officerId, { bureau: c.bureau, region: c.institution_region ?? actor.region, field: 'officerId' });
  } else if (isCompletedStatus(c.status)) {
    // Unassigning a disposed or closed case used to move it back to "Received", which is a reopen by
    // another name: no reason, no protected operation, no reopened event (M7/A03).
    throw new AppError(
      409,
      'reopen_requires_operation',
      'This case is disposed or closed. Reopen it first with the protected reopen operation, then change the owner.'
    );
  }
  const pending = db
    .prepare(`SELECT 1 FROM transfers WHERE case_id = ? AND state = 'pending'`)
    .get(c.id);
  if (pending && officerId === null) {
    throw new AppError(409, 'transfer_pending', 'A transfer is pending; the case cannot be left unowned.');
  }
  // Authorisation and input checks first, then the version the user actually saw.
  assertVersion(c, expectedVersion);
  const before = { assignedOfficerId: c.assigned_officer_id, status: c.status };
  // Only an "Assigned" case returns to the intake queue when its owner is cleared. Any other lifecycle
  // state is preserved, so an assignment change never rewrites the lifecycle.
  const nextStatus: Status = officerId ? (c.status === 'Received' ? 'Assigned' : c.status) : c.status === 'Assigned' ? 'Received' : c.status;
  const changed = db
    .prepare(
      `UPDATE cases SET assigned_officer_id = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
    )
    .run(officerId, nextStatus, nowIso(), c.id, c.version).changes;
  guardWrite(changed);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: officerId ? 'officer_assigned' : 'officer_unassigned',
    remarks: reason,
    before,
    after: { assignedOfficerId: officerId, status: nextStatus },
    versionAfter: refreshed.version,
  });
  if (officerId) {
    notify(
      officerId,
      'assignment',
      'case',
      c.id,
      `notif:assignment:${c.id}:${refreshed.version}:${officerId}`,
      `Case assigned: ${c.case_number}`,
      `You are now the owning officer. Next action: ${refreshed.next_action ?? 'not recorded'}.`,
      caseNotificationDetail(refreshed, { detailRecordedInCase: Boolean(refreshed.next_action) })
    );
  }
  enqueueCaseRecompute(refreshed.institution_id);
  return refreshed;
}

/* ---------------------------------------------------------------- transfer */

export function requestTransfer(
  actor: SessionUser,
  c: CaseRecord,
  toBureau: string,
  reason: string,
  idempotencyKey: string | undefined,
  expectedVersion: unknown
): { transferId: string } {
  if (actor.role !== 'bureau_lead' || c.bureau !== actor.bureau || !regionAllows(actor, c)) {
    recordSecurityDenial(actor.id, `transfer_request_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Only the owning bureau lead can request a transfer.');
  }
  if (!ACTIVE_STATUSES.includes(c.status as (typeof ACTIVE_STATUSES)[number])) {
    throw new AppError(422, 'invalid_transition', 'Only active cases can be transferred.');
  }
  if (toBureau === c.bureau) {
    throw new AppError(422, 'validation_error', 'Choose a different target bureau.', { toBureau: 'Must differ from the owning bureau.' });
  }
  if (!db.prepare('SELECT 1 FROM bureaus WHERE code = ?').get(toBureau)) {
    throw new AppError(422, 'validation_error', 'Unknown target bureau.', { toBureau: 'Unknown bureau.' });
  }
  const pending = db.prepare(`SELECT id FROM transfers WHERE case_id = ? AND state = 'pending'`).get(c.id);
  if (pending) throw new AppError(409, 'transfer_pending', 'This case already has a pending transfer.');
  assertVersion(c, expectedVersion);
  if (idempotencyKey) {
    const prior = db
      .prepare(`SELECT id FROM transfers WHERE case_id = ? AND idempotency_key = ?`)
      .get(c.id, idempotencyKey) as { id: string } | undefined;
    if (prior) return { transferId: prior.id };
  }
  const id = uid();
  db.prepare(
    `INSERT INTO transfers (id, case_id, from_bureau, to_bureau, reason, requested_by, requested_at, state, idempotency_key)
     VALUES (?,?,?,?,?,?,?, 'pending', ?)`
  ).run(id, c.id, c.bureau, toBureau, reason, actor.id, nowIso(), idempotencyKey ?? null);
  const bumped = db
    .prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .run(nowIso(), c.id, c.version).changes;
  guardWrite(bumped);
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'transfer_requested',
    remarks: reason,
    before: { bureau: c.bureau },
    after: { pendingTransferTo: toBureau, ownershipUnchanged: c.bureau },
    versionAfter: c.version + 1,
  });
  // Recipients: the target bureau's leads who may currently see this case at all. A lead outside the
  // case region is not told about it, and a lead without content access is shown the coordination
  // facts rather than the requester's free-text reason (M7/A01).
  const targets = notifyRecipientsFor(
    c,
    activeSessionUsers('bureau_lead').filter((u) => u.bureau === toBureau)
  );
  const detail = caseNotificationDetail(c, { fromBureau: c.bureau, toBureau, detailRecordedInCase: true });
  for (const t of targets) {
    notify(
      t.id,
      'transfer',
      'transfer',
      id,
      `notif:transfer:${id}:${t.id}`,
      `Transfer request: ${c.case_number}`,
      `${c.bureau} requests that ${toBureau} take ownership. Reason: ${reason}. Ownership stays with ${c.bureau} until you accept.`,
      detail
    );
  }
  return { transferId: id };
}

export function decideTransfer(
  actor: SessionUser,
  transferId: string,
  decision: 'accept' | 'reject',
  note: string,
  officerId: string | null,
  expectedCaseVersion: unknown
): { state: string; caseId: string } {
  const t = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId) as
    | {
        id: string;
        case_id: string;
        from_bureau: string;
        to_bureau: string;
        reason: string;
        state: string;
      }
    | undefined;
  if (!t) throw new AppError(404, 'not_found', 'Transfer request not found.');
  const c = getCase(t.case_id) as CaseRecord;
  // Shared rule: target-bureau lead *with authority over this case's region*. Enforced before either
  // the accept or the reject branch performs any write.
  if (!canDecideTransfer(actor, c, { toBureau: t.to_bureau })) {
    recordSecurityDenial(
      actor.id,
      `transfer_decision_denied transfer=${t.id} case=${c.id} region=${c.institution_region ?? 'unknown'} ` +
        `toBureau=${t.to_bureau} ${describeAuthority(actor)}`
    );
    throw new AppError(
      403,
      'access_denied',
      'Only a lead of the target bureau with authority over this case region can decide this transfer.'
    );
  }
  if (t.state !== 'pending') {
    throw new AppError(409, 'already_decided', 'This transfer request was already decided.');
  }
  // The decision is checked against the case version the reviewer saw, not a silently reloaded one.
  assertVersion(c, expectedCaseVersion);
  if (decision === 'reject') {
    db.prepare(
      `UPDATE transfers SET state = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND state = 'pending'`
    ).run(actor.id, nowIso(), note, t.id);
    touchCase(c.id);
    appendEvent({
      actor,
      caseId: c.id,
      actionType: 'transfer_rejected',
      remarks: note,
      after: { ownership: t.from_bureau },
      versionAfter: c.version + 1,
    });
    // Only leads who may currently see this case are told about it, and the free-text note reaches a
    // reader without content access only through the safe structured detail (M7/A01/A12).
    const lead = notifyRecipientsFor(
      c,
      activeSessionUsers('bureau_lead').filter((u) => u.bureau === t.from_bureau)
    );
    const rejectedDetail = caseNotificationDetail(c, { fromBureau: t.from_bureau, toBureau: t.to_bureau, detailRecordedInCase: true });
    for (const l of lead) {
      notify(
        l.id,
        'transfer',
        'transfer',
        t.id,
        `notif:transfer-reject:${t.id}:${l.id}`,
        `Transfer rejected: ${c.case_number}`,
        `Ownership stays with ${t.from_bureau}. Note: ${note}`,
        rejectedDetail
      );
    }
    return { state: 'rejected', caseId: c.id };
  }

  if (officerId) {
    // Exactly the same rule as intake and reassignment (M7/A04): one shared validator, so transfer
    // acceptance cannot accept an owner the other routes refuse.
    validateCaseWorker(officerId, {
      bureau: t.to_bureau,
      region: c.institution_region ?? actor.region,
      field: 'officerId',
    });
  }
  const changed = db
    .prepare(
      `UPDATE transfers SET state = 'accepted', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND state = 'pending'`
    )
    .run(actor.id, nowIso(), note, t.id).changes;
  if (changed !== 1) throw new AppError(409, 'already_decided', 'This transfer request was already decided.');

  const moved = db
    .prepare(
      `UPDATE cases SET bureau = ?, assigned_officer_id = ?, status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`
    )
    .run(t.to_bureau, officerId ?? null, officerId ? 'Assigned' : 'Received', nowIso(), c.id, c.version).changes;
  guardWrite(moved);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'transfer_accepted',
    remarks: note,
    before: { bureau: t.from_bureau, assignedOfficerId: c.assigned_officer_id },
    after: { bureau: t.to_bureau, assignedOfficerId: officerId ?? null, status: refreshed.status },
    versionAfter: refreshed.version,
  });
  const fromLeads = notifyRecipientsFor(
    refreshed,
    activeSessionUsers('bureau_lead').filter((u) => u.bureau === t.from_bureau)
  );
  const acceptedDetail = caseNotificationDetail(refreshed, {
    fromBureau: t.from_bureau,
    toBureau: t.to_bureau,
  });
  for (const l of fromLeads) {
    notify(
      l.id,
      'transfer',
      'transfer',
      t.id,
      `notif:transfer-accept:${t.id}:${l.id}`,
      `Transfer accepted: ${c.case_number}`,
      `Ownership moved to ${t.to_bureau}.`,
      acceptedDetail
    );
  }
  enqueueCaseRecompute(refreshed.institution_id);
  return { state: 'accepted', caseId: c.id };
}

/* -------------------------------------------------------------- escalation */

export function escalateCase(
  actor: SessionUser,
  c: CaseRecord,
  reason: string,
  supervisorId: string,
  expectedVersion: unknown
): CaseRecord {
  const owningBureauLead = actor.role === 'bureau_lead' && c.bureau === actor.bureau && regionAllows(actor, c);
  const coordinator = actor.role === 'supervisor' && regionAllows(actor, c);
  if (!owningBureauLead && !coordinator) {
    recordSecurityDenial(actor.id, `escalate_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'You cannot escalate a case outside your scope.');
  }
  const supervisor = db
    .prepare(`SELECT id, region FROM users WHERE id = ? AND role = 'supervisor' AND active = 1`)
    .get(supervisorId) as { id: string; region: string | null } | undefined;
  if (!supervisor) throw new AppError(422, 'validation_error', 'Choose an active supervisor.', { supervisorId: 'Unknown supervisor.' });
  // The responsible supervisor must actually be able to see the case: their region has to cover it.
  if (supervisor.region && c.institution_region && supervisor.region !== c.institution_region) {
    throw new AppError(422, 'validation_error', 'That supervisor is not authorised for this case region.', {
      supervisorId: 'Supervisor outside the case region.',
    });
  }
  if (c.escalation_open === 1) throw new AppError(409, 'already_escalated', 'An escalation is already open on this case.');
  assertVersion(c, expectedVersion);
  db.prepare(
    `UPDATE cases SET escalation_open = 1, escalation_reason = ?, escalation_supervisor_id = ?, escalation_opened_at = ?,
       version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
  ).run(reason, supervisorId, nowIso(), nowIso(), c.id, c.version);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'escalated',
    remarks: reason,
    after: { escalationOpen: true, supervisorId, lifecycleUnchanged: c.status },
    versionAfter: refreshed.version,
  });
  notify(
    supervisorId,
    'escalation',
    'case',
    c.id,
    `notif:escalation:${c.id}:${refreshed.escalation_opened_at}:${supervisorId}`,
    `Open escalation: ${c.case_number}`,
    `Escalation reason: ${reason}. Lifecycle state remains ${c.status}.`,
    caseNotificationDetail(refreshed, { escalationFlag: true, detailRecordedInCase: true })
  );
  return refreshed;
}

export function closeEscalation(actor: SessionUser, c: CaseRecord, note: string, expectedVersion: unknown): CaseRecord {
  if (c.escalation_open !== 1) throw new AppError(422, 'invalid_transition', 'No escalation is open on this case.');
  assertVersion(c, expectedVersion);
  const owningBureauLead = actor.role === 'bureau_lead' && c.bureau === actor.bureau && regionAllows(actor, c);
  const coordinator = actor.role === 'supervisor' && regionAllows(actor, c);
  if (!owningBureauLead && !coordinator) {
    recordSecurityDenial(actor.id, `escalation_close_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Only a supervisor or the owning bureau lead can close an escalation.');
  }
  db.prepare(
    `UPDATE cases SET escalation_open = 0, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
  ).run(nowIso(), c.id, c.version);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'escalation_closed',
    remarks: note,
    before: { escalationOpen: true, reason: c.escalation_reason },
    after: { escalationOpen: false, lifecycleUnchanged: c.status },
    versionAfter: refreshed.version,
  });
  return refreshed;
}

/* --------------------------------------------------------------- reopen F7 */

export function reopenCase(actor: SessionUser, c: CaseRecord, reason: string, expected: number): CaseRecord {
  assertVersion(c, expected);
  if (actor.role !== 'bureau_lead' || c.bureau !== actor.bureau || !regionAllows(actor, c)) {
    recordSecurityDenial(actor.id, `reopen_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Only the owning bureau lead can reopen a case.');
  }
  if (c.status !== 'Disposed' && c.status !== 'Closed') {
    throw new AppError(422, 'invalid_transition', 'Only a disposed or closed case can be reopened.');
  }
  const at = nowIso();
  const changed = db
    .prepare(
      `UPDATE cases SET status = 'Under review', reopened_at = ?, closed_at = NULL,
              outcome = NULL, decision_reference = NULL,
              version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`
    )
    .run(at, at, c.id, c.version).changes;
  if (changed !== 1) throw new AppError(409, 'stale_version', 'This case changed while you were reopening it.');
  // The historical disposition rows are never deleted or rewritten; they only note that the case was
  // reopened afterwards. `disposed_at` stays as the record of when it was disposed.
  db.prepare('UPDATE dispositions SET reopened_at = ? WHERE case_id = ? AND reopened_at IS NULL').run(at, c.id);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'reopened',
    remarks: reason,
    before: {
      status: c.status,
      disposedAt: c.disposed_at,
      closedAt: c.closed_at,
      receivedAt: c.received_at,
      outcome: c.outcome,
      decisionReference: c.decision_reference,
    },
    after: { status: 'Under review', receivedAtUnchanged: c.received_at, priorDispositionsPreserved: true },
    versionAfter: refreshed.version,
  });
  enqueueCaseRecompute(refreshed.institution_id);
  return refreshed;
}

/* ---------------------------------------------------------- deadline change */

export function changeDeadline(
  actor: SessionUser,
  c: CaseRecord,
  expectedDisposalAt: string | null,
  reason: string,
  expectedVersion: unknown
): CaseRecord {
  if (actor.role !== 'bureau_lead' || c.bureau !== actor.bureau || !regionAllows(actor, c)) {
    recordSecurityDenial(actor.id, `deadline_change_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Deadline changes are a bureau lead action within your own bureau and region.');
  }
  if (expectedDisposalAt && Number.isNaN(new Date(expectedDisposalAt).getTime())) {
    throw new AppError(422, 'validation_error', 'Invalid deadline date.', { expectedDisposalAt: 'Invalid date.' });
  }
  assertVersion(c, expectedVersion);
  const changed = db
    .prepare(
      `UPDATE cases SET expected_disposal_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
    )
    .run(expectedDisposalAt, nowIso(), c.id, c.version).changes;
  guardWrite(changed);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'deadline_changed',
    remarks: reason,
    before: { expectedDisposalAt: c.expected_disposal_at },
    after: { expectedDisposalAt },
    versionAfter: refreshed.version,
  });
  return refreshed;
}

/** Evidence upload authority, checked before any file bytes are written. */
export function assertCanUploadEvidence(user: SessionUser, c: CaseRecord): void {
  if (!canUploadEvidence(user, c)) {
    recordSecurityDenial(user.id, `evidence_upload_denied case=${c.id} ${describeAuthority(user)}`);
    throw new AppError(
      403,
      'access_denied',
      'Recording evidence requires case-worker authority. A read grant does not allow uploads.'
    );
  }
}

/* ------------------------------------------------------------- triage (F1) */

export function resolveTriage(
  actor: SessionUser,
  c: CaseRecord,
  institutionId: string,
  reason: string,
  expectedVersion: unknown
): CaseRecord {
  if (!['bureau_lead', 'bureau_officer'].includes(actor.role) || c.bureau !== actor.bureau || !regionAllows(actor, c)) {
    recordSecurityDenial(actor.id, `triage_denied case=${c.id} ${describeAuthority(actor)}`);
    throw new AppError(403, 'access_denied', 'Only staff in the owning bureau can resolve institution identity.');
  }
  const inst = db.prepare('SELECT id, region FROM institutions WHERE id = ?').get(institutionId) as
    | { id: string; region: string }
    | undefined;
  if (!inst) throw new AppError(422, 'validation_error', 'Unknown institution.');
  if (actor.region && inst.region !== actor.region) throw new AppError(403, 'access_denied', 'Institution outside your region.');
  // Triage answers "which institution is this?" for an *unresolved* intake. Using it on a resolved case
  // silently rewrote an identity that people had already been coordinating on, and left the previous
  // institution's overlap alert pointing at a case that had moved (M7/A13).
  if (c.triage_state !== 'unresolved') {
    throw new AppError(
      409,
      'invalid_state',
      'This case already has a confirmed institution. Use a correction that records the previous institution, or leave it as it is.'
    );
  }
  assertVersion(c, expectedVersion);
  const previousInstitutionId = c.institution_id;
  const changed = db
    .prepare(
      `UPDATE cases SET institution_id = ?, triage_state = 'resolved', version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
    )
    .run(inst.id, nowIso(), c.id, c.version).changes;
  guardWrite(changed);
  const refreshed = getCase(c.id) as CaseRecord;
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'triage_resolved',
    remarks: reason,
    before: { intakeInstitutionText: c.intake_institution_text, institutionId: previousInstitutionId },
    after: { institutionId: inst.id, previousInstitutionId },
    versionAfter: refreshed.version,
  });
  // Both institutions change: the case joins the new one and leaves the old one.
  enqueueCaseRecompute(inst.id);
  if (previousInstitutionId && previousInstitutionId !== inst.id) enqueueCaseRecompute(previousInstitutionId);
  return refreshed;
}

/* ------------------------------------------------------------ case grants  */

/**
 * Grant content access. Authority comes from canManageCaseAccess (owning-bureau lead inside their
 * region, or supervisor inside their oversight region) — never from the actor's metadata visibility
 * and never from a content grant they already hold.
 */
export function grantCaseAccess(
  actor: SessionUser,
  c: CaseRecord,
  userId: string,
  note: string,
  expectedVersion: unknown
): void {
  if (!canManageCaseAccess(actor, c)) {
    recordSecurityDenial(actor.id, `grant_denied case=${c.id} ${describeAuthority(actor)} caseBureau=${c.bureau}`);
    throw new AppError(
      403,
      'access_denied',
      'You cannot manage access to this case. Only the owning bureau lead or a supervisor with oversight of this case may do so.'
    );
  }
  const target = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(userId) as
    | { id: string; role: string; active: number }
    | undefined;
  if (!target || target.active !== 1) throw new AppError(422, 'validation_error', 'Unknown or inactive account.');
  assertVersion(c, expectedVersion);
  const existing = db.prepare('SELECT id, revoked_at FROM case_grants WHERE case_id = ? AND user_id = ?').get(c.id, userId) as
    | { id: string; revoked_at: string | null }
    | undefined;
  if (existing) {
    db.prepare(`UPDATE case_grants SET revoked_at = NULL, granted_by = ?, granted_at = ?, note = ? WHERE id = ?`).run(
      actor.id,
      nowIso(),
      note,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO case_grants (id, case_id, user_id, granted_by, granted_at, note) VALUES (?,?,?,?,?,?)`
    ).run(uid(), c.id, userId, actor.id, nowIso(), note);
  }
  const changed = db
    .prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .run(nowIso(), c.id, c.version).changes;
  guardWrite(changed);
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'access_granted',
    remarks: note,
    after: { userId },
    versionAfter: c.version + 1,
  });
}

export function revokeCaseAccess(
  actor: SessionUser,
  c: CaseRecord,
  userId: string,
  note: string,
  expectedVersion: unknown
): void {
  if (!canManageCaseAccess(actor, c)) {
    recordSecurityDenial(actor.id, `revoke_denied case=${c.id} ${describeAuthority(actor)} caseBureau=${c.bureau}`);
    throw new AppError(
      403,
      'access_denied',
      'You cannot manage access to this case. Only the owning bureau lead or a supervisor with oversight of this case may do so.'
    );
  }
  const existing = db.prepare('SELECT id FROM case_grants WHERE case_id = ? AND user_id = ? AND revoked_at IS NULL').get(c.id, userId) as
    | { id: string }
    | undefined;
  if (!existing) {
    throw new AppError(422, 'validation_error', 'That account has no active grant on this case.');
  }
  assertVersion(c, expectedVersion);
  const revoked = db
    .prepare(`UPDATE case_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowIso(), existing.id).changes;
  guardWrite(revoked, 'This access grant');
  const changed = db
    .prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
    .run(nowIso(), c.id, c.version).changes;
  guardWrite(changed);
  appendEvent({
    actor,
    caseId: c.id,
    actionType: 'access_revoked',
    remarks: note,
    after: { userId },
    versionAfter: c.version + 1,
  });
}

/* ----------------------------------------------------- relationship decisions */

export function decideRelationship(
  actor: SessionUser,
  suggestionId: string,
  decision: 'Related issue' | 'Duplicate report' | 'Separate issues',
  reason: string,
  expected: { caseA?: number | null; caseB?: number | null } = {}
): { relationshipId: string | null } {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId) as
    | {
        id: string;
        case_a_id: string;
        case_b_id: string;
        institution_id: string;
        kind: string;
        reasons_json: string;
        evidence_hash: string;
        rule_version: string;
        state: string;
      }
    | undefined;
  if (!s) throw new AppError(404, 'not_found', 'Suggestion not found.');
  if (s.state === 'dismissed' || s.state === 'accepted') {
    throw new AppError(409, 'already_decided', 'This suggestion was already decided.');
  }
  if (!['open', 'outdated'].includes(s.state)) {
    throw new AppError(409, 'invalid_state', 'This suggestion is not awaiting a decision.');
  }
  const a = getCase(s.case_a_id) as CaseRecord;
  const b = getCase(s.case_b_id) as CaseRecord;
  // One shared policy for confirm, dismiss and revoke: role + region + current content access to both
  // cases + a lead's own-bureau restriction. Server records only — never the client's canDecide flag.
  if (!canDecideRelationship(actor, a, b)) {
    recordSecurityDenial(
      actor.id,
      `relationship_decision_denied suggestion=${s.id} cases=${a.id},${b.id} ${describeAuthority(actor)}`
    );
    throw new AppError(403, 'access_denied', relationshipDenialReason(actor, a, b));
  }
  // Authority is decided before the request body is validated: an unauthorised caller is refused for
  // what it is (403), and never learns which fields the workflow would have required.
  // A decision changes both cases, so both versions are mandatory — omitting them used to skip the
  // check entirely (M7/A07).
  requireBothVersions(expected);
  if (!reason || reason.trim().length < 5) {
    throw new AppError(422, 'validation_error', 'Record a reason for the relationship decision.', { reason: 'Required.' });
  }
  // A linking decision touches both cases, so it is validated against the version of each case the
  // reviewer was shown before anything is written.
  assertVersion(a, expected.caseA as number);
  assertVersion(b, expected.caseB as number);
  const snapshot = {
    suggestionId: s.id,
    kind: s.kind,
    reasons: JSON.parse(s.reasons_json),
    evidenceHash: s.evidence_hash,
    ruleVersion: s.rule_version,
    caseA: { caseNumber: a.case_number, category: a.category, bureau: a.bureau },
    caseB: { caseNumber: b.case_number, category: b.category, bureau: b.bureau },
    institutionId: s.institution_id,
  };
  if (decision === 'Separate issues') {
    const decided = db
      .prepare(
        `UPDATE suggestions SET state = 'dismissed', decided_by = ?, decided_at = ?, decision_reason = ?
          WHERE id = ? AND state IN ('open','outdated')`
      )
      .run(actor.id, nowIso(), reason, s.id).changes;
    guardWrite(decided, 'This suggestion');
    for (const c of [a, b]) {
      touchCase(c.id);
      appendEvent({
        actor,
        caseId: c.id,
        actionType: 'relationship_dismissed',
        remarks: reason,
        after: { pairedWith: c.id === a.id ? b.case_number : a.case_number, decision },
        versionAfter: c.version + 1,
        pairedCaseId: c.id === a.id ? b.id : a.id,
      });
    }
    return { relationshipId: null };
  }
  const id = uid();
  db.prepare(
    `INSERT INTO relationships (id, case_a_id, case_b_id, type, reason, reviewer_id, reviewer_role, evidence_json,
       rule_version, decided_at, state, suggestion_id) VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)`
  ).run(
    id,
    a.id,
    b.id,
    decision,
    reason,
    actor.id,
    actor.role,
    JSON.stringify(snapshot),
    s.rule_version,
    nowIso(),
    s.id
  );
  const decided = db
    .prepare(
      `UPDATE suggestions SET state = 'accepted', decided_by = ?, decided_at = ?, decision_reason = ?
        WHERE id = ? AND state IN ('open','outdated')`
    )
    .run(actor.id, nowIso(), reason, s.id).changes;
  guardWrite(decided, 'This suggestion');
  for (const c of [a, b]) {
    touchCase(c.id);
    appendEvent({
      actor,
      caseId: c.id,
      actionType: 'relationship_confirmed',
      remarks: reason,
      after: {
        relationshipId: id,
        type: decision,
        linkedCase: c.id === a.id ? b.case_number : a.case_number,
        ownershipUnchanged: true,
      },
      versionAfter: c.version + 1,
      pairedCaseId: c.id === a.id ? b.id : a.id,
    });
  }
  return { relationshipId: id };
}

export function revokeRelationship(
  actor: SessionUser,
  relationshipId: string,
  reason: string,
  expected: { caseA?: number | null; caseB?: number | null } = {}
): void {
  const r = db.prepare('SELECT * FROM relationships WHERE id = ?').get(relationshipId) as
    | { id: string; case_a_id: string; case_b_id: string; state: string; suggestion_id: string | null }
    | undefined;
  if (!r) throw new AppError(404, 'not_found', 'Relationship not found.');
  const a = getCase(r.case_a_id) as CaseRecord;
  const b = getCase(r.case_b_id) as CaseRecord;
  // Identical authority to the decision that created the link.
  if (!canDecideRelationship(actor, a, b)) {
    recordSecurityDenial(
      actor.id,
      `relationship_revoke_denied relationship=${r.id} cases=${a.id},${b.id} ${describeAuthority(actor)}`
    );
    throw new AppError(403, 'access_denied', relationshipDenialReason(actor, a, b));
  }
  requireBothVersions(expected);
  if (!reason || reason.trim().length < 5) {
    throw new AppError(422, 'validation_error', 'Record a reason for revoking the link.', { reason: 'Required.' });
  }
  if (r.state !== 'active') throw new AppError(409, 'already_revoked', 'This relationship is already revoked.');
  assertVersion(a, expected.caseA as number);
  assertVersion(b, expected.caseB as number);
  const revoked = db
    .prepare(
      `UPDATE relationships SET state = 'revoked', revoked_by = ?, revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND state = 'active'`
    )
    .run(actor.id, nowIso(), reason, r.id).changes;
  guardWrite(revoked, 'This relationship');
  if (r.suggestion_id) {
    db.prepare(`UPDATE suggestions SET state = 'dismissed', decision_reason = ? WHERE id = ? AND state IN ('open','outdated','accepted')`).run(
      reason,
      r.suggestion_id
    );
  }
  for (const c of [a, b]) {
    const bumped = db
      .prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
      .run(nowIso(), c.id, c.version).changes;
    guardWrite(bumped);
    appendEvent({
      actor,
      caseId: c.id,
      actionType: 'relationship_revoked',
      remarks: reason,
      after: { relationshipId: r.id, casesIntact: true, ownershipUnchanged: true },
      versionAfter: c.version + 1,
      pairedCaseId: c.id === a.id ? b.id : a.id,
    });
  }
}

/* ------------------------------------------------------- suggestion refresh */

export function refreshInstitution(institutionId: string): void {
  recomputeOverlap(institutionId);
  recomputeSuggestions(institutionId);
}
