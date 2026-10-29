import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { db, DATA_DIR, DB_PATH, UPLOAD_DIR, nowIso, uid, sha256, audit, nextCaseNumber, setting, putSetting, tx } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { registerM2Routes } from './m2.js';
import { registerM3Routes } from './m3.js';

/** The schema version this build writes into operator-facing notes. */
const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
import {
  attachSession,
  requireAuth,
  createSession,
  setSessionCookie,
  login,
  logout,
  sessionUserById,
  recordSecurityDenial,
  purgeExpiredSessions,
  type SessionUser,
} from './auth.js';
import {
  ACTIVE_STATUSES,
  CASE_SELECT,
  CATEGORIES,
  CHANNELS,
  DISPOSITION_OUTCOMES,
  STATUSES,
  canAcknowledgeCoordination,
  canDecideTransfer,
  canManageAdminConfig,
  canManageCaseAccess,
  canModifyCase,
  canReviewInstitutionConfig,
  canUploadEvidence,
  canViewContent,
  assignableOfficers,
  validateCaseWorker,
  canViewMetadata,
  describeAuthority,
  capabilities,
  caseGrants,
  fullCase,
  getCase,
  getCaseByNumber,
  visibilitySql,
  isActiveStatus,
  lastActionAt,
  maskCase,
  nextStatesFor,
  ownerRoleLabel,
  shapeCase,
  type CaseRecord,
  type Status,
} from './domain.js';
import {
  AppError,
  appendEvent,
  assertCanUploadEvidence,
  assertVersion,
  guardWrite,
  assignCase,
  changeDeadline,
  closeEscalation,
  createCase,
  decideRelationship,
  decideTransfer,
  escalateCase,
  grantCaseAccess,
  reopenCase,
  requestTransfer,
  resolveTriage,
  revokeCaseAccess,
  revokeRelationship,
  updateCase,
} from './service.js';
import {
  loadRelationshipRows,
  pendingTransfersFor,
  projectNotification,
  projectTransfer,
  type TransferRow,
  projectRelationship,
  projectSuggestion,
  withCaseCache,
  type NotificationRow,
  type SuggestionRow,
} from './privacy.js';
import {
  ageDays,
  deadlineState,
  evaluatePair,
  nameSimilarity,
  priorityOf,
  processingDays,
  recomputeOverlap,
  recomputeSuggestions,
  addCalendarDays,
  RULE_VERSION_LABEL,
} from './rules.js';
import { startWorker, runWorkerTick, drainJobs, workerState, jobHealth } from './worker.js';
import { sameOriginWrites, limitLogin } from './request-security.js';
import {
  IMPORT_COLUMNS,
  TEMPLATE_CSV,
  changedImportFields,
  csvCell,
  importIdentity,
  importRecordSnapshot,
  parseCalendarDate,
  parseCsv,
  toCsv,
  type ParsedImportRow,
} from './csv.js';
import { ensureSeed } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(here, '../../web/dist');
/**
 * Demo mode is opt-in. Passwordless fixture entry, the account switcher and demo password hints exist
 * only when CASELINK_DEMO=true is supplied explicitly; the default deployment requires sign-in.
 */
const DEMO_MODE = (process.env.CASELINK_DEMO ?? 'false') === 'true';
/**
 * Fault injection exists to prove transactional rollback. It is an administrator-only test hook and
 * is enabled by demo mode or an explicit CASELINK_TEST_HOOKS=true, never in a normal deployment.
 */
const TEST_HOOKS = DEMO_MODE || (process.env.CASELINK_TEST_HOOKS ?? 'false') === 'true';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use('/api', sameOriginWrites);
app.use(attachSession);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

/* ------------------------------------------------------------------ helpers */

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      Promise.resolve(fn(req, res)).catch(next);
    } catch (err) {
      next(err);
    }
  };

const idSchema = z.string().min(1).max(120);

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) fields[issue.path.join('.') || '_'] = issue.message;
    throw new AppError(422, 'validation_error', 'Some fields need attention.', fields);
  }
  return result.data;
}

function getCaseOr404(id: string): CaseRecord {
  const c = getCase(id) ?? getCaseByNumber(id);
  if (!c) throw new AppError(404, 'not_found', 'Case not found.');
  return c;
}

function requireMetadata(req: Request, c: CaseRecord): SessionUser {
  const user = req.user as SessionUser;
  if (!canViewMetadata(user, c)) {
    recordSecurityDenial(user.id, `metadata_read case=${c.id} role=${user.role} bureau=${user.bureau}`);
    throw new AppError(403, 'access_denied', 'You do not have permission to view this record.');
  }
  return user;
}

/** Shared guard: named permission on a case, with a security-denial entry on refusal. */
function requireCasePermission(req: Request, c: CaseRecord, permission: 'modify_case' | 'upload_evidence' | 'manage_access'): SessionUser {
  const user = req.user as SessionUser;
  const allowed =
    permission === 'modify_case'
      ? canModifyCase(user, c)
      : permission === 'upload_evidence'
        ? canUploadEvidence(user, c)
        : canManageCaseAccess(user, c);
  if (!allowed) {
    recordSecurityDenial(user.id, `${permission}_denied case=${c.id} ${describeAuthority(user)} caseBureau=${c.bureau}`);
    const message =
      permission === 'manage_access'
        ? 'You cannot manage access to this case. Only the owning bureau lead or a supervisor with oversight of this case may do so.'
        : permission === 'upload_evidence'
          ? 'Recording evidence requires case-worker authority. A read grant does not allow uploads.'
          : 'You do not have permission to change this case.';
    throw new AppError(403, 'access_denied', message);
  }
  return user;
}

/**
 * Shared guard for transfer decisions. The receiving lead does not own the case yet, so this asks the
 * transfer-decision question (target bureau + regional authority over the actual case) rather than the
 * owning-bureau mutation question. Applied before either accept or reject writes anything.
 */
function requireTransferDecision(user: SessionUser, transferId: string): { c: CaseRecord; toBureau: string } {
  const t = db
    .prepare('SELECT id, case_id AS caseId, to_bureau AS toBureau, state FROM transfers WHERE id = ?')
    .get(transferId) as { id: string; caseId: string; toBureau: string; state: string } | undefined;
  if (!t) throw new AppError(404, 'not_found', 'Transfer request not found.');
  const c = getCase(t.caseId) as CaseRecord;
  if (!canDecideTransfer(user, c, { toBureau: t.toBureau })) {
    recordSecurityDenial(
      user.id,
      `transfer_decision_denied transfer=${t.id} case=${c.id} region=${c.institution_region ?? 'unknown'} ` +
        `toBureau=${t.toBureau} ${describeAuthority(user)}`
    );
    throw new AppError(
      403,
      'access_denied',
      'Only a lead of the target bureau with authority over this case region can decide this transfer.'
    );
  }
  return { c, toBureau: t.toBureau };
}

/** Shared guard for system-wide configuration changes. */
function requireAdminConfig(req: Request): SessionUser {
  const user = req.user as SessionUser;
  if (!canManageAdminConfig(user)) {
    recordSecurityDenial(user.id, `admin_config_denied path=${req.path} ${describeAuthority(user)}`);
    throw new AppError(403, 'access_denied', 'System configuration changes require an administrator account.');
  }
  return user;
}

function requireContent(req: Request, c: CaseRecord): SessionUser {
  const user = req.user as SessionUser;
  if (!canViewContent(user, c)) {
    recordSecurityDenial(user.id, `content_read case=${c.id} role=${user.role} bureau=${user.bureau}`);
    throw new AppError(403, 'access_denied', 'Restricted case details are not available to your account. Request a coordination grant.');
  }
  return user;
}

function decorate(user: SessionUser, c: CaseRecord) {
  const shaped = shapeCase(user, c);
  const pr = priorityOf(c);
  const pendingTransfer = db
    .prepare(`SELECT id, to_bureau AS toBureau, requested_at AS requestedAt FROM transfers WHERE case_id = ? AND state = 'pending'`)
    .get(c.id) as { id: string; toBureau: string; requestedAt: string } | undefined;
  const caps = capabilities(user);
  return {
    ...shaped,
    deadlineState: deadlineState(c),
    ageDays: ageDays(c),
    processingDays: processingDays(c),
    priority: pr,
    lastActionAt: lastActionAt(c.id),
    pendingTransfer: pendingTransfer ?? null,
    // Interface hints derived from the same shared permission functions the routes enforce.
    permissions: {
      canUpdate: canModifyCase(user, c),
      canAssign: caps.includes('assign') && canModifyCase(user, c),
      canTransfer: caps.includes('transfer') && canModifyCase(user, c) && c.status !== 'Closed',
      canDispose:
        caps.includes('dispose') && canModifyCase(user, c) && (c.status === 'Under review' || c.status === 'Awaiting response'),
      canReopen: caps.includes('reopen') && canModifyCase(user, c) && (c.status === 'Disposed' || c.status === 'Closed'),
      canEscalate:
        caps.includes('escalate') && (canModifyCase(user, c) || (user.role === 'supervisor' && canViewMetadata(user, c))),
      canGrant: canManageCaseAccess(user, c),
      canUploadEvidence: canUploadEvidence(user, c),
      canViewContent: canViewContent(user, c),
      canResolveTriage: c.triage_state === 'unresolved' && canModifyCase(user, c),
    },
  };
}

const HISTORY_REDACTED = '[restricted — request a coordination grant to read history remarks]';

function historyFor(user: SessionUser, c: CaseRecord) {
  const rows = db
    .prepare(
      `SELECT e.id, e.at, e.action_type AS actionType, e.remarks, e.next_step AS nextStep, e.before_json AS beforeJson,
              e.after_json AS afterJson, e.version_after AS versionAfter, e.paired_case_id AS pairedCaseId,
              u.display_name AS actorName, e.actor_bureau AS actorBureau,
              u.role AS actorRole
         FROM action_events e JOIN users u ON u.id = e.actor_id
        WHERE e.case_id = ? ORDER BY e.at ASC, e.rowid ASC`
    )
    .all(c.id) as Record<string, unknown>[];
  const full = canViewContent(user, c);
  // A relationship decision writes the same free-text reason into both cases' histories. Such an event
  // is only readable when the caller can read *both* cases now, so revoking a grant cannot leave the
  // other record's reason visible here (M7/A02).
  const pairedReadable = (pairedId: unknown): boolean => {
    if (!pairedId) return false;
    const other = getCase(String(pairedId));
    return Boolean(other && canViewContent(user, other));
  };
  return rows.map((r) => {
    const relationshipEvent = ['relationship_confirmed', 'relationship_dismissed', 'relationship_revoked'].includes(String(r.actionType));
    const show = full && (r.pairedCaseId ? pairedReadable(r.pairedCaseId) : !relationshipEvent);
    return ({
    id: r.id,
    at: r.at,
    actionType: r.actionType,
    actorName: r.actorName,
    actorRole: r.actorRole,
    actorBureau: r.actorBureau,
    versionAfter: r.versionAfter,
    pairedCaseId: (r.pairedCaseId as string | null) ?? null,
    remarks: show ? r.remarks : r.remarks ? HISTORY_REDACTED : null,
    nextStep: show ? r.nextStep : null,
    before: show && r.beforeJson ? JSON.parse(String(r.beforeJson)) : null,
    after: show && r.afterJson ? JSON.parse(String(r.afterJson)) : null,
  });
  });
}

interface Filters {
  bureau?: string[];
  region?: string;
  category?: string[];
  status?: string[];
  receivedFrom?: string;
  receivedTo?: string;
  q?: string;
  institutionId?: string;
  mine?: boolean;
  unassigned?: boolean;
  overdue?: boolean;
  pending?: boolean;
  escalated?: boolean;
  triage?: boolean;
  page: number;
  pageSize: number;
  sort: 'received' | 'priority' | 'deadline' | 'updated';
}

function parseFilters(req: Request): Filters {
  const qs = req.query;
  const list = (v: unknown) =>
    typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  return {
    bureau: list(qs.bureau),
    region: typeof qs.region === 'string' && qs.region ? qs.region : undefined,
    category: list(qs.category),
    status: list(qs.status),
    receivedFrom: typeof qs.receivedFrom === 'string' && qs.receivedFrom ? qs.receivedFrom : undefined,
    receivedTo: typeof qs.receivedTo === 'string' && qs.receivedTo ? qs.receivedTo : undefined,
    q: typeof qs.q === 'string' && qs.q ? qs.q.trim() : undefined,
    institutionId: typeof qs.institutionId === 'string' && qs.institutionId ? qs.institutionId : undefined,
    mine: qs.mine === '1',
    unassigned: qs.unassigned === '1',
    overdue: qs.overdue === '1',
    pending: qs.pending === '1',
    escalated: qs.escalated === '1',
    triage: qs.triage === '1',
    page: Math.max(1, Number(qs.page ?? 1) || 1),
    pageSize: Math.min(200, Math.max(1, Number(qs.pageSize ?? 25) || 25)),
    sort: (['received', 'priority', 'deadline', 'updated'] as const).includes(qs.sort as never)
      ? (qs.sort as Filters['sort'])
      : 'received',
  };
}

/**
 * SQL predicate for a case query.
 *
 * The scope itself is a permission decision and is applied first, as a `json_each` list of the ids the
 * user may see; every business filter after it is expressed in SQL so a 10,000-case database is filtered
 * and paginated by the database rather than by loading every row into the process (M6). Free-text search
 * matches the complaint fields only for cases whose content the user may read, which keeps the
 * restricted-field rule intact.
 */
function caseScopeWhere(user: SessionUser, f: Filters) {
  // Visibility is a SQL predicate (M7/A14): the list no longer binds a 10 000-element id array on every
  // request. `contentSql` is used by the free-text search so restricted rows are never matched on their
  // complaint text.
  const metadataScope = visibilitySql(user, 'metadata');
  const contentSql = visibilitySql(user, 'content');
  const where: string[] = [metadataScope.sql];
  const params: unknown[] = [...metadataScope.params];

  if (f.bureau?.length) {
    where.push(`c.bureau IN (${f.bureau.map(() => '?').join(',')})`);
    params.push(...f.bureau);
  }
  if (f.region) {
    where.push('i.region = ?');
    params.push(f.region);
  }
  if (f.category?.length) {
    where.push(`c.category IN (${f.category.map(() => '?').join(',')})`);
    params.push(...f.category);
  }
  if (f.status?.length) {
    where.push(`c.status IN (${f.status.map(() => '?').join(',')})`);
    params.push(...f.status);
  }
  if (f.institutionId) {
    where.push('c.institution_id = ?');
    params.push(f.institutionId);
  }
  if (f.receivedFrom) {
    where.push('c.received_at >= ?');
    params.push(new Date(`${f.receivedFrom}T00:00:00.000Z`).toISOString());
  }
  if (f.receivedTo) {
    where.push('c.received_at <= ?');
    params.push(new Date(`${f.receivedTo}T23:59:59.999Z`).toISOString());
  }
  if (f.mine) {
    where.push('c.assigned_officer_id = ?');
    params.push(user.id);
  }
  if (f.unassigned) where.push('c.assigned_officer_id IS NULL');
  if (f.escalated) where.push('c.escalation_open = 1');
  if (f.triage) where.push("c.triage_state = 'unresolved'");
  if (f.pending) {
    where.push(`c.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);
    params.push(...ACTIVE_STATUSES);
  }
  if (f.overdue) {
    // Overdue is exactly "active and past the configured deadline": cases with no policy stay out.
    where.push(`c.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND c.expected_disposal_at IS NOT NULL AND c.expected_disposal_at < ?`);
    params.push(...ACTIVE_STATUSES, nowIso());
  }
  if (f.q) {
    const needle = `%${f.q.toLowerCase()}%`;
    const metadataMatch = [
      'lower(c.case_number)',
      "lower(COALESCE(i.name, ''))",
      "lower(COALESCE(i.permanent_id, ''))",
      "lower(COALESCE(c.intake_institution_text, ''))",
      'lower(c.category)',
      'lower(c.bureau)',
      'lower(c.status)',
    ]
      .map((col) => `${col} LIKE ?`)
      .join(' OR ');
    where.push(
      `((${metadataMatch}) OR (${contentSql.sql} AND (lower(COALESCE(c.complaint_summary, '')) LIKE ? OR lower(COALESCE(c.source_reference, '')) LIKE ?)))`
    );
    params.push(needle, needle, needle, needle, needle, needle, needle, ...contentSql.params, needle, needle);
  }
  return { where: where.join(' AND '), params };
}

/**
 * Matched case ids in display order.
 *
 * For a plain list page the ordering and the window are done by the database (`LIMIT`/`OFFSET`), so only
 * the page's rows are ever hydrated. Priority ordering is scored in one place (`rules.priorityOf`), so
 * that sort reads the lightweight ordering columns for the matched set and slices afterwards.
 */
function orderedCaseIds(user: SessionUser, f: Filters, window?: { limit: number; offset: number }): string[] {
  const { where, params } = caseScopeWhere(user, f);
  const orderSql =
    f.sort === 'received'
      ? 'c.received_at DESC, c.case_number DESC'
      : f.sort === 'updated'
        ? 'c.updated_at DESC, c.case_number DESC'
        : f.sort === 'deadline'
          ? "COALESCE(c.expected_disposal_at, '9999') ASC, c.received_at DESC"
          : 'c.received_at DESC';
  // A plain ordering can be paginated by the database.
  const sqlLimit = f.sort !== 'priority' && window ? ` LIMIT ${Math.max(0, window.limit)} OFFSET ${Math.max(0, window.offset)}` : '';
  const rows = db
    .prepare(
      `SELECT c.id, c.status, c.escalation_open, c.expected_disposal_at, c.received_at, c.updated_at, c.case_number
         FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id
        WHERE ${where} ORDER BY ${orderSql}${sqlLimit}`
    )
    .all(...params) as Pick<CaseRecord, 'id' | 'status' | 'escalation_open' | 'expected_disposal_at' | 'received_at' | 'updated_at' | 'case_number'>[];
  if (f.sort !== 'priority') return rows.map((r) => r.id);
  // Priority ordering stays in one place: rules.priorityOf decides the score, applied to the light rows.
  const now = new Date();
  const ordered = rows
    .map((row) => ({ id: row.id, score: priorityOf(row as CaseRecord, now).score, received: row.received_at }))
    .sort((a, b) => b.score - a.score || b.received.localeCompare(a.received))
    .map((r) => r.id);
  return window ? ordered.slice(window.offset, window.offset + window.limit) : ordered;
}

/** Total matched rows, counted by the database (never by fetching them). */
function countMatchingCases(user: SessionUser, f: Filters): number {
  const { where, params } = caseScopeWhere(user, f);
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;
}

function loadCasesByIds(ids: string[]): CaseRecord[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`${CASE_SELECT} WHERE c.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as CaseRecord[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is CaseRecord => Boolean(r));
}

/** One page of permitted, filtered cases: ordered, limited and counted by the database. */
function queryCases(user: SessionUser, f: Filters) {
  const start = (f.page - 1) * f.pageSize;
  const ids = orderedCaseIds(user, f, { limit: f.pageSize, offset: start });
  return { rows: loadCasesByIds(ids), total: countMatchingCases(user, f) };
}

/** Every matched case, for report aggregation and export (never used for a list page). */
function allMatchingCases(user: SessionUser, f: Filters): CaseRecord[] {
  return loadCasesByIds(orderedCaseIds(user, f));
}

function filtersEcho(f: Filters) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...f, page: undefined, pageSize: undefined })) {
    if (v !== undefined && v !== false) out[k] = v;
  }
  return out;
}

/**
 * Fingerprint of the request that produced an idempotent result. A replay must present the same
 * payload: reusing a key for a changed payload is a client error, not a cached success.
 * The idempotency key itself is excluded (it is the identity, not part of the request content).
 */
function requestFingerprint(req: Request): string {
  const body = { ...(req.body ?? {}) };
  delete body.idempotencyKey;
  return sha256(JSON.stringify({ method: req.method, path: req.originalUrl.split('?')[0], body }));
}

function idempotent(
  req: Request,
  res: Response,
  scope: string,
  run: () => { status: number; body: unknown },
  /**
   * Called before a stored response is replayed. A replay must be re-authorised against the caller's
   * *current* authority: a cached body is not a permission to keep reading the record (M7/A06).
   */
  reauthorize?: (stored: Record<string, unknown>) => void
): void {
  const user = req.user as SessionUser;
  const key = (req.header('Idempotency-Key') ?? (req.body?.idempotencyKey as string | undefined))?.slice(0, 200);
  if (!key) {
    const result = run();
    drainJobs();
    res.status(result.status).json(result.body);
    return;
  }
  const fingerprint = requestFingerprint(req);
  const prior = db
    .prepare(
      'SELECT status_code, response_json, request_hash FROM idempotency_keys WHERE key = ? AND user_id = ? AND scope = ?'
    )
    .get(key, user.id, scope) as
    | { status_code: number; response_json: string; request_hash: string | null }
    | undefined;
  if (prior) {
    if (prior.request_hash && prior.request_hash !== fingerprint) {
      audit(user.id, 'idempotency_conflict', `${scope} key=${key}`);
      throw new AppError(
        409,
        'idempotency_conflict',
        'That idempotency key was already used for a different request. Use a new key for a new change.'
      );
    }
    const stored = JSON.parse(prior.response_json) as Record<string, unknown>;
    if (reauthorize) reauthorize(stored);
    res.setHeader('Idempotent-Replay', 'true');
    res.status(prior.status_code).json(stored);
    return;
  }
  // The mutation, its business event, its pending background work and the idempotency record commit
  // together; queued jobs are only drained once that transaction has committed.
  const result = tx(() => {
    const outcome = run();
    if (outcome.status < 400) {
      db.prepare(
        `INSERT INTO idempotency_keys (key, user_id, scope, status_code, response_json, request_hash, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(key, user.id, scope, outcome.status, JSON.stringify(outcome.body), fingerprint, nowIso());
    }
    return outcome;
  });
  drainJobs();
  res.setHeader('Idempotency-Key', key);
  res.status(result.status).json(result.body);
}

/* -------------------------------------------------------------------- auth */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: nowIso() });
});

/** Search uses the same case scopes as lists; private history also requires both sides of paired events. */
app.get('/api/search', requireAuth, wrap((req, res) => {
  const query = parseOrThrow(z.string().trim().min(2).max(200), req.query.q);
  const user = req.user as SessionUser;
  const cases = queryCases(user, { q: query, page: 1, pageSize: 10, sort: 'updated' });
  const content = visibilitySql(user, 'content');
  const paired = visibilitySql(user, 'content', 'other');
  const needle = `%${query.toLowerCase()}%`;
  const history = db.prepare(`
    SELECT e.id, e.case_id AS caseId, c.case_number AS caseNumber,
      e.action_type AS actionType, e.at, u.display_name AS actorName
    FROM action_events e JOIN cases c ON c.id = e.case_id
      LEFT JOIN institutions i ON i.id = c.institution_id JOIN users u ON u.id = e.actor_id
    WHERE (${content.sql}) AND ((e.paired_case_id IS NULL AND e.action_type NOT IN
      ('relationship_confirmed','relationship_dismissed','relationship_revoked')) OR EXISTS (
      SELECT 1 FROM cases other LEFT JOIN institutions i ON i.id = other.institution_id
      WHERE other.id = e.paired_case_id AND (${paired.sql})
    )) AND (lower(e.id) LIKE ? OR lower(replace(e.action_type,'_',' ')) LIKE ? OR lower(u.display_name) LIKE ?
      OR lower(COALESCE(e.remarks,'')) LIKE ? OR lower(COALESCE(e.next_step,'')) LIKE ?
      OR lower(COALESCE(e.before_json,'')) LIKE ? OR lower(COALESCE(e.after_json,'')) LIKE ?)
    ORDER BY e.at DESC, e.rowid DESC LIMIT 11
  `).all(...content.params, ...paired.params, ...Array(7).fill(needle)) as { id: string; caseId: string; caseNumber: string; actionType: string; at: string; actorName: string }[];
  res.json({
    results: [
      ...cases.rows.map(c => ({ id: c.id, kind: 'case', title: c.case_number, detail: `${c.institution_name ?? c.intake_institution_text ?? 'Unresolved institution'} · ${c.bureau} · ${c.status}`, url: `/cases/${c.id}` })),
      ...history.slice(0, 10).map(event => ({ id: event.id, kind: 'history', title: `${event.caseNumber} · ${event.actionType.replace(/_/g, ' ')}`, detail: `${event.actorName} · Event ${event.id}`, at: event.at, url: `/cases/${event.caseId}?event=${event.id}` })),
    ],
    more: cases.total > 10 || history.length > 10,
    snapshotAt: nowIso(),
  });
}));

app.post(
  '/api/auth/login',
  limitLogin,
  wrap((req, res) => {
    const body = parseOrThrow(
      z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(256) }),
      req.body
    );
    const user = login(body.username, body.password);
    if (!user) throw new AppError(401, 'invalid_credentials', 'Username or password is incorrect.');
    const token = createSession(user.id);
    setSessionCookie(res, token);
    // The token is also returned in the body so the interface can authenticate with an
    // Authorization header when the browser blocks or drops the session cookie.
    res.json({ user: publicUser(user), capabilities: capabilities(user), token });
  })
);

/**
 * Demo auto-entry. Exists only while CASELINK_DEMO is on: it issues a session for one of the synthetic
 * accounts without a password so reviewers land directly in the workspace. It is disabled outright in a
 * non-demo deployment, and every use is written to the security log.
 */
app.post(
  '/api/auth/demo-login',
  wrap((req, res) => {
    if (!DEMO_MODE) {
      throw new AppError(403, 'access_denied', 'Direct demo sign-in is disabled in this environment.');
    }
    const body = parseOrThrow(z.object({ username: z.string().min(1).max(60) }), req.body);
    const row = db
      .prepare('SELECT id FROM users WHERE lower(username) = lower(?) AND active = 1')
      .get(body.username) as { id: string } | undefined;
    if (!row) throw new AppError(404, 'not_found', 'No active demo account with that username.');
    const user = sessionUserById(row.id);
    if (!user) throw new AppError(404, 'not_found', 'No active demo account with that username.');
    const token = createSession(user.id);
    setSessionCookie(res, token);
    audit(user.id, 'demo_login', `direct entry as ${user.role}${user.bureau ? ` (${user.bureau})` : ''}`);
    res.json({ user: publicUser(user), capabilities: capabilities(user), token, demoMode: true });
  })
);

app.post(
  '/api/auth/logout',
  wrap((req, res) => {
    logout(req, res);
    res.json({ ok: true });
  })
);

function publicUser(user: SessionUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    bureau: user.bureau,
    region: user.region,
    grantedCaseCount: user.grantedCaseIds.length,
  };
}

app.get(
  '/api/session',
  wrap((req, res) => {
    if (!req.user) return res.json({ authenticated: false, demoMode: DEMO_MODE, demoAccounts: DEMO_MODE ? demoAccounts() : [] });
    res.json({
      authenticated: true,
      demoMode: DEMO_MODE,
      user: publicUser(req.user),
      capabilities: capabilities(req.user),
      demoAccounts: DEMO_MODE ? demoAccounts() : [],
      timezone: 'Asia/Kolkata',
      ruleVersion: RULE_VERSION_LABEL,
    });
  })
);

function demoAccounts() {
  return (db.prepare(`SELECT username, display_name AS displayName, role, bureau FROM users WHERE active = 1 AND password_hash IS NOT NULL AND username IN ('p.rao','s.iyer','m.nair','l.verma','a.desai','admin') ORDER BY role, username`).all() as {
    username: string;
    displayName: string;
    role: string;
    bureau: string | null;
  }[]).map((u) => ({ ...u, password: 'caselink-demo' }));
}

app.get('/api/meta', (_req, res) => {
  res.json({
    categories: CATEGORIES,
    channels: CHANNELS,
    statuses: STATUSES,
    activeStatuses: ACTIVE_STATUSES,
    ruleVersion: RULE_VERSION_LABEL,
    timezone: 'Asia/Kolkata',
    policies: db.prepare('SELECT * FROM deadline_policies WHERE active = 1').all(),
    bureaus: db.prepare('SELECT * FROM bureaus').all(),
    regions: (db.prepare('SELECT DISTINCT region FROM institutions ORDER BY region').all() as { region: string }[]).map((r) => r.region),
  });
});

app.get(
  '/api/users',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const requested = typeof req.query.bureau === 'string' && req.query.bureau ? req.query.bureau : null;
    if (requested && !canManageAdminConfig(user) && requested !== user.bureau) {
      recordSecurityDenial(user.id, `user_directory_scope_denied requested=${requested} ${describeAuthority(user)}`);
      throw new AppError(403, 'access_denied', 'You can only list accounts inside your own bureau.');
    }
    const bureau = requested ?? user.bureau;
    const rows = db
      .prepare(
        `SELECT id, username, display_name AS displayName, role, bureau, region, active
           FROM users WHERE active = 1 AND (? IS NULL OR bureau = ? OR role IN ('supervisor','admin')) ORDER BY display_name`
      )
      .all(bureau ?? null, bureau ?? null);
    res.json({ users: rows });
  })
);

app.get(
  '/api/system/status',
  requireAuth,
  wrap((req, res) => {
    const user = req.user;
    const health = jobHealth();
    res.json({
      demoMode: DEMO_MODE,
      environment: 'DEMO — synthetic institutions, people and attachments only',
      matchingMode: workerState.matchingMode,
      ruleVersion: RULE_VERSION_LABEL,
      worker: {
        intervalSeconds: workerState.intervalMs / 1000,
        lastRunAt: workerState.lastRunAt,
        runs: workerState.runs,
        ...health,
        lastError: (health.lastError || workerState.lastError) ? 'Background work failed; administrator review required.' : null,
      },
      deadlinePolicy: db.prepare('SELECT * FROM deadline_policies WHERE active = 1').all(),
      database: path.basename(DB_PATH),
      seededAt: setting('seeded_at', 'not seeded'),
      signedInAs: user ? publicUser(user) : null,
      serverTime: nowIso(),
      timezone: 'Asia/Kolkata',
    });
  })
);

app.post(
  '/api/system/worker/tick',
  requireAuth,
  wrap((req, res) => {
    requireAdminConfig(req);
    const result = runWorkerTick();
    res.json({ ...result, lastRunAt: workerState.lastRunAt });
  })
);

app.post(
  '/api/system/inject-audit-failure',
  requireAuth,
  wrap((req, res) => {
    requireAdminConfig(req);
    if (!TEST_HOOKS) throw new AppError(403, 'access_denied', 'Fault injection is only available in a demo or test environment.');
    const body = parseOrThrow(
      z.object({ on: z.boolean(), target: z.enum(['audit', 'job', 'publish']).optional() }),
      req.body
    );
    // `publish` fails the file-publication step of an evidence upload *after* the record commit, which
    // is the only way to prove the compensating rollback (M7/A05).
    const key =
      body.target === 'job' ? 'inject_job_failure' : body.target === 'publish' ? 'inject_publish_failure' : 'inject_audit_failure';
    putSetting(key, body.on ? '1' : '0');
    audit((req.user as SessionUser).id, 'fault_injection', `${key}=${body.on ? 'on' : 'off'}`);
    res.json({ [key]: body.on, testHooks: TEST_HOOKS });
  })
);

/**
 * Run the evidence-publication reconciliation on demand (administrator-only, test hooks only).
 *
 * The same routine runs at start-up; this endpoint exists so a regression suite can prove what the
 * operator's restart would do without restarting the process, and is refused on a normal instance.
 */
app.post(
  '/api/system/reconcile-uploads',
  requireAuth,
  wrap((req, res) => {
    requireAdminConfig(req);
    if (!TEST_HOOKS) throw new AppError(403, 'access_denied', 'Reconciliation is only available in a demo or test environment.');
    const result = reconcileUploads();
    audit((req.user as SessionUser).id, 'upload_reconciled', JSON.stringify(result));
    res.json(result);
  })
);

app.post(
  '/api/system/matching-mode',
  requireAuth,
  wrap((req, res) => {
    requireAdminConfig(req);
    const body = parseOrThrow(z.object({ mode: z.enum(['rule-based', 'unavailable']) }), req.body);
    workerState.matchingMode = body.mode;
    audit((req.user as SessionUser).id, 'matching_mode_changed', body.mode);
    res.json({ matchingMode: workerState.matchingMode, note: body.mode === 'unavailable' ? 'Relationship suggestions paused; institution overlap alerts keep running.' : 'Rule-based matching restored.' });
  })
);

/* ------------------------------------------------------------ institutions */

app.get(
  '/api/institutions',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const institutions = db
      .prepare('SELECT id, permanent_id AS permanentId, name, region FROM institutions ORDER BY name')
      .all() as { id: string; permanentId: string; name: string; region: string }[];
    const scope = visibilitySql(user, 'metadata');
    const perInst = new Map<string, { total: number; active: number; bureaus: Set<string> }>();
    {
      const rows = db
        .prepare(
          `SELECT c.institution_id, c.bureau, c.status FROM cases c
             LEFT JOIN institutions i ON i.id = c.institution_id
            WHERE (${scope.sql}) AND c.institution_id IS NOT NULL`
        )
        .all(...(scope.params as never[])) as { institution_id: string | null; bureau: string; status: Status }[];
      for (const r of rows) {
        if (!r.institution_id) continue;
        const entry = perInst.get(r.institution_id) ?? { total: 0, active: 0, bureaus: new Set<string>() };
        entry.total += 1;
        if (isActiveStatus(r.status)) {
          entry.active += 1;
          entry.bureaus.add(r.bureau);
        }
        perInst.set(r.institution_id, entry);
      }
    }
    const items = institutions
      .filter((i) => (q ? `${i.name} ${i.permanentId}`.toLowerCase().includes(q) : true))
      .filter((i) => (user.region ? i.region === user.region || perInst.has(i.id) : true))
      .map((i) => {
        const stats = perInst.get(i.id);
        const alert = db.prepare('SELECT id, state FROM alerts WHERE dedupe_key = ?').get(`overlap:${i.id}`) as
          | { id: string; state: string }
          | undefined;
        return {
          ...i,
          visibleCases: stats?.total ?? 0,
          activeCases: stats?.active ?? 0,
          bureaus: stats ? [...stats.bureaus].sort() : [],
          overlapState: alert?.state ?? 'none',
          overlapId: alert?.id ?? null,
        };
      });
    res.json({ institutions: items, total: items.length });
  })
);

app.get(
  '/api/institutions/resolve',
  requireAuth,
  wrap((req, res) => {
    const name = String(req.query.name ?? '').trim();
    if (name.length < 3) return res.json({ suggestions: [] });
    const rows = db.prepare('SELECT id, permanent_id AS permanentId, name, region FROM institutions').all() as {
      id: string;
      permanentId: string;
      name: string;
      region: string;
    }[];
    const aliasRows = db.prepare('SELECT institution_id, alias FROM institution_aliases').all() as {
      institution_id: string;
      alias: string;
    }[];
    const suggestions = rows
      .map((i) => {
        const aliasScore = Math.max(
          0,
          ...aliasRows.filter((a) => a.institution_id === i.id).map((a) => nameSimilarity(name, a.alias))
        );
        const score = Math.max(nameSimilarity(name, i.name), aliasScore);
        return { ...i, score: Math.round(score * 100) / 100, suggestionOnly: true as const };
      })
      .filter((i) => i.score >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    res.json({
      suggestions,
      note: 'Name similarity is a suggestion only. Confirm the AICTE Permanent ID before saving; unresolved identities stay in triage.',
    });
  })
);

app.get(
  '/api/institutions/:id',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const inst = db
      .prepare('SELECT id, permanent_id AS permanentId, name, region, created_at AS createdAt FROM institutions WHERE id = ?')
      .get(req.params.id) as
      | { id: string; permanentId: string; name: string; region: string; createdAt: string }
      | undefined;
    if (!inst) throw new AppError(404, 'not_found', 'Institution not found.');
    const aliases = db
      .prepare(
        `SELECT a.id, a.alias, a.source, a.reviewed_at AS reviewedAt, u.display_name AS reviewedBy
           FROM institution_aliases a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.institution_id = ? ORDER BY a.alias`
      )
      .all(inst.id);
    const cases = db
      .prepare(`${CASE_SELECT} WHERE c.institution_id = ? ORDER BY c.received_at DESC`)
      .all(inst.id) as CaseRecord[];
    const visible = cases.filter((c) => canViewMetadata(user, c));
    const alert = db.prepare('SELECT * FROM alerts WHERE dedupe_key = ?').get(`overlap:${inst.id}`) as
      | { id: string; state: string; case_ids_json: string; bureaus_json: string; updated_at: string }
      | undefined;
    const activeBureaus = [...new Set(visible.filter((c) => isActiveStatus(c.status)).map((c) => c.bureau))].sort();
    res.json({
      institution: inst,
      aliases,
      cases: visible.map((c) => decorate(user, c)),
      hiddenCaseCount: cases.length - visible.length,
      overlap: {
        state: alert?.state ?? 'none',
        alertId: alert?.id ?? null,
        bureaus: alert ? JSON.parse(alert.bureaus_json) : activeBureaus,
        caseIds: alert ? JSON.parse(alert.case_ids_json) : [],
        updatedAt: alert?.updated_at ?? null,
        activeBureaus,
      },
      suggestions: (
        db
          .prepare(
            `SELECT * FROM suggestions WHERE institution_id = ? AND state IN ('open','outdated') ORDER BY created_at DESC`
          )
          .all(inst.id) as unknown as SuggestionRow[]
      )
        .filter((s) => canViewMetadata(user, { id: s.case_a_id }) && canViewMetadata(user, { id: s.case_b_id }))
        .map((s) => projectSuggestion(user, s)),
      relationships: loadRelationshipRows({ institutionId: inst.id })
        .filter((r) => canViewMetadata(user, { id: r.case_a_id }) && canViewMetadata(user, { id: r.case_b_id }))
        .map((r) => projectRelationship(user, r)),
    });
  })
);

app.post(
  '/api/institutions/:id/aliases',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const institution = db.prepare('SELECT id, region FROM institutions WHERE id = ?').get(req.params.id) as
      | { id: string; region: string }
      | undefined;
    if (!institution) throw new AppError(404, 'not_found', 'Institution not found.');
    if (!canReviewInstitutionConfig(user, institution.region)) {
      recordSecurityDenial(user.id, `alias_review_denied institution=${req.params.id} ${describeAuthority(user)}`);
      throw new AppError(403, 'access_denied', 'Reviewing institution aliases requires a lead or supervisor in that region.');
    }
    const body = parseOrThrow(z.object({ alias: z.string().min(3).max(160), source: z.string().min(3).max(120) }), req.body);
    const inst = db.prepare('SELECT id FROM institutions WHERE id = ?').get(req.params.id);
    if (!inst) throw new AppError(404, 'not_found', 'Institution not found.');
    const id = uid();
    db.prepare(
      `INSERT INTO institution_aliases (id, institution_id, alias, source, reviewed_by, reviewed_at) VALUES (?,?,?,?,?,?)`
    ).run(id, req.params.id, body.alias.trim(), body.source.trim(), user.id, nowIso());
    audit(user.id, 'alias_reviewed', `${req.params.id} :: ${body.alias}`);
    res.status(201).json({ id });
  })
);

/* ------------------------------------------------------------------- cases */

const createSchema = z.object({
  institutionId: idSchema.nullish(),
  intakeInstitutionText: z.string().max(200).nullish(),
  receivedAt: z.string().min(8),
  sourceChannel: z.string().min(3),
  sourceReference: z.string().max(120).nullish(),
  category: z.string().min(3),
  complaintSummary: z.string().min(10, 'Describe the complaint in at least 10 characters.').max(5000),
  bureau: z.string().optional(),
  assignedOfficerId: idSchema.nullish(),
  nextAction: z.string().max(300).nullish(),
  nextActionDueAt: z.string().nullish(),
  deadlinePolicyId: z.string().nullish(),
  complainantContact: z.string().max(200).nullish(),
  idempotencyKey: z.string().max(200).optional(),
});

app.post(
  '/api/cases',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    if (!['bureau_officer', 'bureau_lead'].includes(user.role)) {
      throw new AppError(403, 'access_denied', 'Only bureau staff can register cases.');
    }
    const body = parseOrThrow(createSchema, req.body);
    if (!(CATEGORIES as readonly string[]).includes(body.category)) {
      throw new AppError(422, 'validation_error', 'Unknown category.', { category: 'Choose a listed category.' });
    }
    if (!(CHANNELS as readonly string[]).includes(body.sourceChannel)) {
      throw new AppError(422, 'validation_error', 'Unknown source channel.', { sourceChannel: 'Choose a listed channel.' });
    }
    idempotent(
      req,
      res,
      'case_create',
      () => {
        const created = tx(() => createCase(user, body as never));
        return { status: 201, body: decorate(user, getCase(created.id) as CaseRecord) };
      },
      // Replay re-authorisation: the stored body carries complaint text, so the caller must still be
      // able to read that record now (bureau, region, grants) — not merely be a bureau account.
      (stored) => {
        const id = typeof stored.id === 'string' ? stored.id : null;
        const existing = id ? getCase(id) : undefined;
        if (!existing) throw new AppError(404, 'not_found', 'That record is no longer available.');
        if (!canViewMetadata(user, existing) || !canViewContent(user, existing)) {
          recordSecurityDenial(user.id, `idempotent_replay_denied case=${existing.id} ${describeAuthority(user)}`);
          throw new AppError(403, 'access_denied', 'You can no longer read that record, so the replay is refused.');
        }
      }
    );
  })
);

app.get(
  '/api/cases',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const filters = parseFilters(req);
    const { rows, total } = queryCases(user, filters);
    res.json({
      cases: rows.map((c) => decorate(user, c)),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
      filters: filtersEcho(filters),
      snapshotAt: nowIso(),
      visibleCount: total,
    });
  })
);

app.get(
  '/api/cases/:id',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireMetadata(req, c);
    const content = canViewContent(user, c);
    // Relationship rows go through the shared projection: the decision reason, reviewer identity and
    // evidence snapshot are complaint-derived and need content access to both cases.
    const relationships = loadRelationshipRows({ caseId: c.id });
    const related = relationships.map((r) => {
      const projected = projectRelationship(user, r);
      const otherId = r.case_a_id === c.id ? r.case_b_id : r.case_a_id;
      const other = getCase(otherId) as CaseRecord;
      return {
        ...projected,
        case: canViewMetadata(user, other) ? shapeCase(user, other) : { id: other.id, access: 'hidden' as const },
      };
    });
    const suggestions = db
      .prepare(`SELECT * FROM suggestions WHERE (case_a_id = ? OR case_b_id = ?) AND state IN ('open','outdated')`)
      .all(c.id, c.id) as Record<string, unknown>[];
    // Transfer rows are projected, never spread: ownership movement is coordination metadata, while the
    // requesting lead's reason and the deciding lead's note need content access to this case (M7/A01).
    const transfers = (
      db
        .prepare(
          `SELECT t.*, ru.display_name AS requestedByName, du.display_name AS decidedByName FROM transfers t
             LEFT JOIN users ru ON ru.id = t.requested_by LEFT JOIN users du ON du.id = t.decided_by
            WHERE t.case_id = ? ORDER BY t.requested_at DESC`
        )
        .all(c.id) as TransferRow[]
    ).map((t) => projectTransfer(user, c, t));
    const attachments = content
      ? db
          .prepare(
            `SELECT a.id, a.original_name AS originalName, a.mime, a.size, a.sha256, a.uploaded_at AS uploadedAt, u.display_name AS uploadedBy
               FROM attachments a JOIN users u ON u.id = a.uploaded_by
              WHERE a.case_id = ? AND a.state = 'ready' ORDER BY a.uploaded_at`
          )
          .all(c.id)
      : [];
    // The owner picker offers exactly the accounts the server will accept (M7/A04).
    const allowedOfficers = assignableOfficers(c.bureau, c.institution_region ?? user.region);
    const supervisors = db
      .prepare(`SELECT id, display_name AS displayName FROM users WHERE active = 1 AND role = 'supervisor' ORDER BY display_name`)
      .all();
    res.json({
      case: decorate(user, c),
      history: historyFor(user, c),
      relationships: related,
      suggestions: suggestions
        .map((s) => s as unknown as SuggestionRow)
        .filter(
          (s) => canViewMetadata(user, getCase(s.case_a_id) as CaseRecord) && canViewMetadata(user, getCase(s.case_b_id) as CaseRecord)
        )
        .map((s) => projectSuggestion(user, s)),
      transfers,
      attachments,
      grants: canManageCaseAccess(user, c)
        ? caseGrants(c.id)
        : content
          ? caseGrants(c.id).filter((g) => (g as { userId: string }).userId === user.id)
          : [],
      options: { officers: allowedOfficers, supervisors, outcomes: [...DISPOSITION_OUTCOMES] },
      nextStates: optionsFor(c.status),
      // Structured disposition history: durable, never rewritten by a reopen. Text is content-gated.
      dispositions: dispositionHistory(c.id, content),
      canViewContent: content,
    });
  })
);

/** Disposition records for a case, newest first. Free text and references need content access. */
function dispositionHistory(caseId: string, content: boolean) {
  const rows = db
    .prepare(
      `SELECT d.id, d.outcome, d.decision_reference AS decisionReference, d.note, d.at, d.reopened_at AS reopenedAt,
              d.version_after AS versionAfter, u.display_name AS actorName
         FROM dispositions d JOIN users u ON u.id = d.actor_id
        WHERE d.case_id = ? ORDER BY d.at DESC, d.rowid DESC`
    )
    .all(caseId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    outcome: content ? r.outcome : 'withheld',
    decisionReference: content ? r.decisionReference : null,
    note: content ? r.note : null,
    actorName: r.actorName,
    versionAfter: r.versionAfter,
    reopenedAt: r.reopenedAt,
    structured: true,
    withheld: !content,
  }));
}

/** The interface's next-state list comes from the one lifecycle matrix in `domain.ts`. */
function optionsFor(status: Status): Status[] {
  return nextStatesFor(status);
}

/** Suggestion projection is shared with the privacy module (M2). */
function shapeSuggestion(user: SessionUser, row: SuggestionRow) {
  return projectSuggestion(user, row);
}

app.patch(
  '/api/cases/:id',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(
      z.object({
        version: z.number().int(),
        status: z.enum(STATUSES as unknown as [string, ...string[]]).optional(),
        category: z.string().optional(),
        complaintSummary: z.string().min(10).max(5000).optional(),
        complainantContact: z.string().max(200).nullish(),
        nextAction: z.string().max(300).nullish(),
        nextActionDueAt: z.string().nullish(),
        responseDueAt: z.string().nullish(),
        responseFromRole: z.string().max(120).nullish(),
        remarks: z.string().max(2000).optional(),
        nextStep: z.string().max(300).nullish(),
        decisionReference: z.string().max(120).nullish(),
        outcome: z.string().max(120).nullish(),
        actionType: z.string().max(60).optional(),
      }),
      req.body
    );
    const updated = tx(() => updateCase(user, c, body as never));
    drainJobs();
    res.json(decorate(user, updated));
  })
);

app.post(
  '/api/cases/:id/actions',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(
      // Strict: the action form has no lifecycle field. A client that tries to move the status through
      // it (e.g. to reopen a disposed case) is rejected here instead of being silently ignored.
      z.object({
        version: z.number().int(),
        actionType: z.string().min(3).max(60),
        remarks: z.string().min(3).max(2000),
        nextStep: z.string().max(300).nullish(),
        nextActionDueAt: z.string().nullish(),
      }).strict(),
      req.body
    );
    if (body.version !== c.version) {
      throw new AppError(409, 'stale_version', `This case changed since you opened it (you have v${body.version}, the record is v${c.version}).`, {
        version: 'Stale record version.',
      });
    }
    const saved = tx(() =>
      updateCase(user, c, {
        version: body.version,
        remarks: body.remarks,
        actionType: body.actionType,
        // `undefined` = not submitted (keep the stored next action); `null` = clear it explicitly.
        nextStep: body.nextStep,
        nextActionDueAt: body.nextActionDueAt ?? undefined,
      })
    );
    drainJobs();
    res.status(201).json({ case: decorate(user, getCase(saved.id) as CaseRecord), history: historyFor(user, getCase(saved.id) as CaseRecord) });
  })
);

app.post(
  '/api/cases/:id/assign',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(
      z.object({ version: z.number().int(), officerId: idSchema.nullable(), reason: z.string().min(3).max(500) }),
      req.body
    );
    // Version, mutation and its business event commit together or not at all.
    const updated = tx(() => assignCase(user, c, body.officerId, body.reason, body.version));
    drainJobs();
    res.json(decorate(user, updated));
  })
);

app.post(
  '/api/cases/:id/transfer',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(
      z.object({
        version: z.number().int(),
        toBureau: z.string().min(2).max(12),
        reason: z.string().min(5).max(500),
        idempotencyKey: z.string().max(200).optional(),
      }),
      req.body
    );
    // The replay is checked against the caller's *current* authority (checked above and re-checked by
    // the service) and the request body's fingerprint, so a changed payload cannot reuse a key.
    idempotent(req, res, `transfer_request:${c.id}`, () => {
      const { transferId } = tx(() => requestTransfer(user, c, body.toBureau, body.reason, body.idempotencyKey, body.version));
      return { status: 201, body: { transferId, case: decorate(user, getCase(c.id) as CaseRecord) } };
    });
  })
);

app.post(
  '/api/transfers/:id/decision',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const body = parseOrThrow(
      z.object({
        version: z.number().int(),
        decision: z.enum(['accept', 'reject']),
        note: z.string().min(3).max(500),
        officerId: idSchema.nullish(),
        idempotencyKey: z.string().max(200).optional(),
      }),
      req.body
    );
    requireTransferDecision(user, req.params.id);
    idempotent(req, res, `transfer_decision:${req.params.id}`, () => {
      const result = tx(() =>
        decideTransfer(user, req.params.id, body.decision, body.note, body.officerId ?? null, body.version)
      );
      const c = getCase(result.caseId) as CaseRecord;
      return { status: 200, body: { ...result, case: canViewMetadata(user, c) ? decorate(user, c) : null } };
    });
  })
);

app.post(
  '/api/cases/:id/escalate',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireMetadata(req, c);
    const body = parseOrThrow(
      z.object({ version: z.number().int(), reason: z.string().min(5).max(500), supervisorId: idSchema }),
      req.body
    );
    res.json(decorate(user, tx(() => escalateCase(user, c, body.reason, body.supervisorId, body.version))));
  })
);

app.post(
  '/api/cases/:id/escalation/close',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireMetadata(req, c);
    const body = parseOrThrow(z.object({ version: z.number().int(), note: z.string().min(3).max(500) }), req.body);
    res.json(decorate(user, tx(() => closeEscalation(user, c, body.note, body.version))));
  })
);

app.post(
  '/api/cases/:id/reopen',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(z.object({ version: z.number().int(), reason: z.string().min(5).max(500) }), req.body);
    res.json(decorate(user, tx(() => reopenCase(user, c, body.reason, body.version))));
  })
);

app.post(
  '/api/cases/:id/deadline',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(
      z.object({ version: z.number().int(), expectedDisposalAt: z.string().nullable(), reason: z.string().min(5).max(500) }),
      req.body
    );
    res.json(decorate(user, tx(() => changeDeadline(user, c, body.expectedDisposalAt, body.reason, body.version))));
  })
);

app.post(
  '/api/cases/:id/triage',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireCasePermission(req, c, 'modify_case');
    const body = parseOrThrow(
      z.object({ version: z.number().int(), institutionId: idSchema, reason: z.string().min(5).max(500) }),
      req.body
    );
    const updated = tx(() => resolveTriage(user, c, body.institutionId, body.reason, body.version));
    drainJobs();
    res.json(decorate(user, updated));
  })
);

app.post(
  '/api/cases/:id/grants',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireMetadata(req, c);
    requireCasePermission(req, c, 'manage_access');
    const body = parseOrThrow(
      z.object({
        version: z.number().int(),
        userId: idSchema,
        note: z.string().min(3).max(300),
        revoke: z.boolean().optional(),
      }),
      req.body
    );
    const updated = tx(() => {
      if (body.revoke) revokeCaseAccess(user, c, body.userId, body.note, body.version);
      else grantCaseAccess(user, c, body.userId, body.note, body.version);
      return getCase(c.id) as CaseRecord;
    });
    res.json({ grants: caseGrants(c.id), case: decorate(user, updated) });
  })
);

/**
 * Evidence upload — a two-phase publication, not a commit-then-hope.
 *
 *   1. bytes are written to a staging file;
 *   2. one transaction inserts the attachment row as `publishing`, appends the history event against the
 *      new case version and bumps that version;
 *   3. only after that commit is the staged file renamed into place;
 *   4. the row is marked `ready` in a second short transaction.
 *
 * A row that is not `ready` is never listed and never downloadable, so an upload can never report a
 * saved file whose bytes are not readable. If the rename fails, the first transaction is compensated
 * (row removed, version restored by the compensating delete, staged file deleted) and the caller gets a
 * failure — the state after the failed request is exactly the state before it. Interrupted work is
 * reconciled at start-up (`reconcileUploads`). The version the uploader saw is required (M7/A05/A07).
 */
app.post(
  '/api/cases/:id/attachments',
  requireAuth,
  upload.single('file'),
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireContent(req, c);
    assertCanUploadEvidence(user, c);
    const file = req.file;
    if (!file) throw new AppError(422, 'validation_error', 'Choose a file to upload.');
    // Multipart fields arrive as strings, so the version is coerced before validation.
    const body = parseOrThrow(
      z.object({ version: z.coerce.number().int().optional() }).passthrough(),
      req.body ?? {}
    );
    // Every supported client supplies the version it saw; omitting it is refused rather than treated
    // as "no check".
    if (body.version === undefined) {
      throw new AppError(422, 'validation_error', 'Upload evidence against the case version you were shown.', {
        version: 'Required.',
      });
    }
    if (body.version !== c.version) {
      throw new AppError(409, 'stale_version', 'This case changed while you were uploading. Reload it and try again.');
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE case_id = ?').get(c.id) as { n: number }).n;
    if (count >= 5) throw new AppError(422, 'attachment_limit', 'A case accepts at most five evidence files.');
    if (file.size > 10 * 1024 * 1024) throw new AppError(413, 'file_too_large', 'Each file must be 10 MB or smaller.');
    const magic = file.buffer.subarray(0, 8);
    let mime = '';
    if (magic.subarray(0, 5).toString('latin1') === '%PDF-') mime = 'application/pdf';
    else if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47) mime = 'image/png';
    else if (magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) mime = 'image/jpeg';
    if (!mime) throw new AppError(422, 'invalid_type', 'Only PDF, PNG and JPEG evidence is accepted.');
    const hash = sha256(file.buffer);
    const storedName = `${c.id}-${hash.slice(0, 16)}${mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg'}`;
    const stagedName = `.staging-${uid()}-${storedName}`;
    const stagedPath = path.join(UPLOAD_DIR, stagedName);
    const finalPath = path.join(UPLOAD_DIR, storedName);
    fs.writeFileSync(stagedPath, file.buffer);
    const id = uid();
    const savedVersion = c.version + 1;
    try {
      tx(() => {
        db.prepare(
          `INSERT INTO attachments (id, case_id, original_name, mime, size, sha256, stored_name, uploaded_by, uploaded_at, state)
           VALUES (?,?,?,?,?,?,?,?,?, 'publishing')`
        ).run(id, c.id, file.originalname.slice(0, 200), mime, file.size, hash, storedName, user.id, nowIso());
        // The event belongs to the version this upload produces, not the one before it.
        appendEvent({
          actor: user,
          caseId: c.id,
          actionType: 'evidence_uploaded',
          remarks: `${file.originalname} (${mime}, ${(file.size / 1024).toFixed(0)} KB, sha256 ${hash.slice(0, 12)}…)`,
          versionAfter: savedVersion,
        });
        const changed = db
          .prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
          .run(nowIso(), c.id, c.version).changes;
        guardWrite(changed);
      });
    } catch (err) {
      // Nothing was committed: drop the staged bytes so the failure leaves no orphan file.
      fs.rmSync(stagedPath, { force: true });
      throw err;
    }
    try {
      // Opt-in, administrator-controlled publication fault: proves the compensation path below.
      if (setting('inject_publish_failure', '0') === '1') {
        throw new Error('Injected evidence-publication failure (test hook)');
      }
      // An identical file already in place (same hash, another row referencing it) is kept as it is —
      // never overwritten or removed.
      if (!fs.existsSync(finalPath)) fs.renameSync(stagedPath, finalPath);
      else fs.rmSync(stagedPath, { force: true });
    } catch (err) {
      // Publication failed after the record was written. Compensate the record, the event and the case
      // version so the operator sees a failure and the case is byte-for-byte where it was.
      try {
        tx(() => {
          db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
          db.prepare(
            `DELETE FROM action_events WHERE id = (SELECT id FROM action_events
                WHERE case_id = ? AND action_type = 'evidence_uploaded' AND version_after = ?
                ORDER BY rowid DESC LIMIT 1)`
          ).run(c.id, savedVersion);
          db.prepare('UPDATE cases SET version = ?, updated_at = ? WHERE id = ? AND version = ?').run(
            c.version,
            nowIso(),
            c.id,
            savedVersion
          );
        });
      } finally {
        fs.rmSync(stagedPath, { force: true });
      }
      recordSecurityDenial(user.id, `evidence_publish_failed case=${c.id} name=${stagedName}`);
      throw new AppError(500, 'publish_failed', 'The evidence file could not be stored. Nothing was saved.');
    }
    const published = db
      .prepare(`UPDATE attachments SET state = 'ready' WHERE id = ? AND state = 'publishing'`)
      .run(id).changes;
    if (published !== 1) {
      // Another process reconciled this row while we published; the file is now referenced by nothing.
      const referenced = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE stored_name = ?').get(storedName) as { n: number };
      if (referenced.n === 0) fs.rmSync(finalPath, { force: true });
      throw new AppError(500, 'publish_failed', 'The evidence file could not be stored. Nothing was saved.');
    }
    res.status(201).json({ id, mime, size: file.size, sha256: hash, version: savedVersion });
  })
);

/**
 * Remove an evidence file. The row goes first (inside the transaction) and the bytes are deleted only
 * when no other attachment row still references them, so a shared file is never pulled out from under
 * a surviving record.
 */
app.delete(
  '/api/cases/:id/attachments/:attachmentId',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireContent(req, c);
    assertCanUploadEvidence(user, c);
    const version = Number(req.query.version);
    if (!Number.isInteger(version)) {
      throw new AppError(422, 'validation_error', 'Deleting evidence requires the case version you were shown.', {
        version: 'Missing record version.',
      });
    }
    const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND case_id = ?').get(req.params.attachmentId, c.id) as
      | { id: string; stored_name: string; original_name: string }
      | undefined;
    if (!att) throw new AppError(404, 'not_found', 'Attachment not found.');
    assertVersion(c, version);
    const removed = tx(() => {
      const changes = db.prepare('DELETE FROM attachments WHERE id = ? AND case_id = ?').run(att.id, c.id).changes;
      guardWrite(changes, 'This evidence file');
      appendEvent({
        actor: user,
        caseId: c.id,
        actionType: 'evidence_removed',
        remarks: `${att.original_name} removed from this case.`,
        after: { attachmentId: att.id },
        versionAfter: c.version + 1,
      });
      return db
        .prepare('UPDATE cases SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        .run(nowIso(), c.id, c.version).changes;
    });
    guardWrite(removed);
    const stillReferenced = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE stored_name = ?').get(att.stored_name) as {
      n: number;
    };
    const fileDeleted = stillReferenced.n === 0;
    if (fileDeleted) fs.rmSync(path.join(UPLOAD_DIR, att.stored_name), { force: true });
    res.json({ ok: true, fileDeleted, stillReferenced: stillReferenced.n });
  })
);

app.get(
  '/api/cases/:id/attachments/:attachmentId',
  requireAuth,
  wrap((req, res) => {
    const c = getCaseOr404(req.params.id);
    const user = requireContent(req, c);
    const att = db
      .prepare(`SELECT * FROM attachments WHERE id = ? AND case_id = ? AND state = 'ready'`)
      .get(req.params.attachmentId, c.id) as { stored_name: string; original_name: string; mime: string } | undefined;
    if (!att) throw new AppError(404, 'not_found', 'Attachment not found.');
    audit(user.id, 'attachment_download', `${c.id}/${req.params.attachmentId}`);
    res.setHeader('Content-Type', att.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${att.original_name.replace(/[^\w.\- ]/g, '_')}"`);
    res.sendFile(path.join(UPLOAD_DIR, att.stored_name));
  })
);

/* -------------------------------------------------------------- my work */

app.get(
  '/api/my-work',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    // One query, filtered by the database: My work needs the active queues of the cases this account may
    // see, not every visible case ever recorded (M7/A14 — a supervisor previously hydrated the whole
    // database on every refresh tick).
    const active = ACTIVE_STATUSES.map(() => '?').join(',');
    const scope = visibilitySql(user, 'metadata');
    const all = db
      .prepare(
        `${CASE_SELECT}
          WHERE (${scope.sql})
            AND (c.status IN (${active}) OR c.triage_state = 'unresolved' OR c.escalation_open = 1)
          ORDER BY c.received_at DESC`
      )
      .all(...(scope.params as never[]), ...ACTIVE_STATUSES) as CaseRecord[];
    const now = new Date();
    const assigned = all.filter((c) => c.assigned_officer_id === user.id && isActiveStatus(c.status));
    const unassigned = all.filter((c) => !c.assigned_officer_id && isActiveStatus(c.status) && c.bureau === user.bureau);
    const overdue = all.filter((c) => isActiveStatus(c.status) && deadlineState(c, now) === 'overdue');
    const approaching = all.filter((c) => isActiveStatus(c.status) && deadlineState(c, now) === 'approaching');
    const escalated = all.filter((c) => c.escalation_open === 1 && isActiveStatus(c.status));
    const triage = all.filter((c) => c.triage_state === 'unresolved');
    // Pending transfers are filtered through the read policy, so a case outside the viewer's region is
    // not listed here even when the bureau matches (M7/A01).
    const pendingTransfers = pendingTransfersFor(user);
    const sortByPriority = (a: CaseRecord, b: CaseRecord) => priorityOf(b, now).score - priorityOf(a, now).score;
    res.json({
      user: publicUser(user),
      assigned: assigned.sort(sortByPriority).map((c) => decorate(user, c)),
      unassigned: unassigned.sort(sortByPriority).map((c) => decorate(user, c)),
      overdue: overdue.sort(sortByPriority).map((c) => decorate(user, c)),
      approaching: approaching.sort(sortByPriority).map((c) => decorate(user, c)),
      escalated: escalated.map((c) => decorate(user, c)),
      triage: triage.map((c) => decorate(user, c)),
      pendingTransfers,
      counts: {
        assigned: assigned.length,
        unassigned: unassigned.length,
        overdue: overdue.length,
        approaching: approaching.length,
        escalated: escalated.length,
        triage: triage.length,
      },
    });
  })
);

/* ----------------------------------------------------------- coordination */

/**
 * How many candidate pairs the coordination page carries per institution. A busy institution can queue
 * thousands of pairs; rendering all of them on every poll made the page megabytes wide and, because the
 * API is one process, delayed unrelated list/read requests behind it (M7/A14). The recent ones are
 * returned with an explicit total so the interface never implies the list is complete.
 */
const COORDINATION_SUGGESTIONS_PER_OVERLAP = 25;

app.get(
  '/api/coordination',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const alerts = db
      .prepare(`SELECT * FROM alerts WHERE kind = 'Institution overlap' ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC`)
      .all() as {
      id: string;
      institution_id: string;
      state: string;
      case_ids_json: string;
      bureaus_json: string;
      created_at: string;
      updated_at: string;
      acknowledged_at: string | null;
    }[];
    const institutionIds = [...new Set(alerts.map((a) => a.institution_id))];
    const suggestionsByInstitution = new Map<string, SuggestionRow[]>();
    if (institutionIds.length) {
      const rows = db
        .prepare(
          `SELECT * FROM suggestions
            WHERE state IN ('open','outdated','accepted')
              AND institution_id IN (SELECT value FROM json_each(?))
            ORDER BY created_at DESC`
        )
        .all(JSON.stringify(institutionIds)) as unknown as SuggestionRow[];
      for (const row of rows) {
        const list = suggestionsByInstitution.get(row.institution_id) ?? [];
        list.push(row);
        suggestionsByInstitution.set(row.institution_id, list);
      }
    }
    const relationshipsByInstitution = new Map<string, ReturnType<typeof projectRelationship>[]>();
    for (const institutionId of institutionIds) {
      relationshipsByInstitution.set(
        institutionId,
        loadRelationshipRows({ institutionId }).map((r) => projectRelationship(user, r))
      );
    }
    // One read for every case the page mentions (alert rows, candidate pairs and stored links), so a
    // projection is never a database round trip per mention.
    const mentioned = new Set<string>();
    for (const alert of alerts) for (const id of JSON.parse(alert.case_ids_json) as string[]) mentioned.add(id);
    for (const rows of suggestionsByInstitution.values()) {
      for (const row of rows) {
        mentioned.add(row.case_a_id);
        mentioned.add(row.case_b_id);
      }
    }
    const caseCache = new Map(loadCasesByIds([...mentioned]).map((c) => [c.id, c]));

    const items = withCaseCache(caseCache, () =>
      alerts
        .map((a) => {
          const caseIds = JSON.parse(a.case_ids_json) as string[];
          const visibleCaseIds = caseIds.filter((id) => {
            const row = caseCache.get(id);
            return Boolean(row && canViewMetadata(user, row));
          });
          if (!visibleCaseIds.length) return null;
          const inst = db.prepare('SELECT id, name, permanent_id AS permanentId, region FROM institutions WHERE id = ?').get(a.institution_id) as {
            id: string;
            name: string;
            permanentId: string;
            region: string;
          };
          const cases = visibleCaseIds.map((id) => decorate(user, caseCache.get(id) as CaseRecord));
          const allSuggestions = suggestionsByInstitution.get(a.institution_id) ?? [];
          const visibleSuggestions = allSuggestions.filter((s) => {
            const rowA = caseCache.get(s.case_a_id);
            const rowB = caseCache.get(s.case_b_id);
            return Boolean(rowA && rowB && canViewMetadata(user, rowA) && canViewMetadata(user, rowB));
          });
          return {
            id: a.id,
            state: a.state,
            institution: inst,
            bureaus: JSON.parse(a.bureaus_json),
            createdAt: a.created_at,
            updatedAt: a.updated_at,
            acknowledgedAt: a.acknowledged_at,
            cases,
            visibleCaseIds,
            hiddenCaseCount: caseIds.length - visibleCaseIds.length,
            suggestions: visibleSuggestions
              .slice(0, COORDINATION_SUGGESTIONS_PER_OVERLAP)
              .map((s) => projectSuggestion(user, s)),
            suggestionsTotal: visibleSuggestions.length,
            suggestionsShown: Math.min(visibleSuggestions.length, COORDINATION_SUGGESTIONS_PER_OVERLAP),
            relationships: relationshipsByInstitution.get(a.institution_id) ?? [],
            matchingMode: workerState.matchingMode,
          };
        })
        .filter(Boolean)
    );
    res.json({ overlaps: items, matchingMode: workerState.matchingMode, ruleVersion: RULE_VERSION_LABEL });
  })
);

registerM2Routes(app);
registerM3Routes(app);

app.post(
  '/api/alerts/:id/acknowledge',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const alert = db
      .prepare(
        `SELECT a.id, a.state, a.case_ids_json, i.region AS institution_region
           FROM alerts a LEFT JOIN institutions i ON i.id = a.institution_id
          WHERE a.id = ?`
      )
      .get(req.params.id) as
      | { id: string; state: string; case_ids_json: string; institution_region: string | null }
      | undefined;
    if (!alert) throw new AppError(404, 'not_found', 'Alert not found.');
    const alertCaseIds = JSON.parse(alert.case_ids_json) as string[];
    // Authorised against the alert's own institution region and its listed cases — never by role alone.
    if (!canAcknowledgeCoordination(user, { institutionRegion: alert.institution_region, caseIds: alertCaseIds })) {
      recordSecurityDenial(
        user.id,
        `alert_acknowledge_denied alert=${alert.id} region=${alert.institution_region ?? 'unknown'} ${describeAuthority(user)}`
      );
      throw new AppError(403, 'access_denied', 'This coordination alert is outside your authorised region.');
    }
    db.prepare(`UPDATE alerts SET state = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?`).run(
      user.id,
      nowIso(),
      nowIso(),
      alert.id
    );
    audit(user.id, 'alert_acknowledged', alert.id);
    res.json({ ok: true, state: 'acknowledged' });
  })
);

app.post(
  '/api/suggestions/:id/decision',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const body = parseOrThrow(
      z.object({
        decision: z.enum(['Related issue', 'Duplicate report', 'Separate issues']),
        reason: z.string().min(5).max(1000),
        caseAVersion: z.number().int().optional(),
        caseBVersion: z.number().int().optional(),
      }),
      req.body
    );
    const result = tx(() =>
      decideRelationship(user, req.params.id, body.decision, body.reason, {
        caseA: body.caseAVersion,
        caseB: body.caseBVersion,
      })
    );
    drainJobs();
    res.json(result);
  })
);

app.post(
  '/api/relationships/:id/revoke',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const body = parseOrThrow(
      z.object({
        reason: z.string().min(5).max(500),
        caseAVersion: z.number().int().optional(),
        caseBVersion: z.number().int().optional(),
      }),
      req.body
    );
    tx(() =>
      revokeRelationship(user, req.params.id, body.reason, { caseA: body.caseAVersion, caseB: body.caseBVersion })
    );
    res.json({ ok: true });
  })
);

app.get(
  '/api/relationships',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    res.json({
      // Only pairs whose case identifiers the caller may see are listed at all; the rest of the
      // projection (reason, reviewer, evidence) is decided per row by the shared privacy helper.
      relationships: loadRelationshipRows({})
        .filter((r) => canViewMetadata(user, { id: r.case_a_id }) && canViewMetadata(user, { id: r.case_b_id }))
        .map((r) => projectRelationship(user, r)),
    });
  })
);

/* --------------------------------------------------- alerts & notifications */

app.get(
  '/api/notifications',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const rows = db
      .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`)
      .all(user.id) as NotificationRow[];
    // A stored notification was written under the authority that existed at delivery time. Re-evaluate
    // it now, so a revoked grant, a transfer or a region change cannot keep leaking case detail.
    const notifications = rows.map((n) => projectNotification(user, n));
    res.json({
      notifications,
      unread: rows.filter((n) => !n.read_at).length,
      redactedCount: notifications.filter((n) => n.redacted).length,
      workerLastRun: workerState.lastRunAt,
    });
  })
);

app.post(
  '/api/notifications/:id/read',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(nowIso(), req.params.id, user.id);
    res.json({ ok: true });
  })
);

app.post(
  '/api/notifications/:id/acknowledge',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?), acknowledged_at = ? WHERE id = ? AND user_id = ?').run(
      nowIso(),
      nowIso(),
      req.params.id,
      user.id
    );
    res.json({ ok: true, note: 'Acknowledgement records awareness, not resolution.' });
  })
);

/* ---------------------------------------------------------------- reports */

/** The columns the report aggregates actually read — never a hydrated case record. */
interface SummaryRow {
  status: Status;
  bureau: string;
  category: string;
  assigned_officer_id: string | null;
  assigned_officer_name: string | null;
  expected_disposal_at: string | null;
  received_at: string;
  disposed_at: string | null;
  escalation_open: number;
  triage_state: string;
  outcome: string | null;
}

/**
 * Light rows for report aggregation (M7/A14). The summary only ever counts things, so it reads the
 * columns those counts use instead of hydrating every matched case. Hydrating 10 000 full records per
 * dashboard request cost ~700 ms of event-loop time, and because the whole API is one process that
 * blocked ordinary list and read requests behind it under mixed load.
 */
function summaryRows(user: SessionUser, f: Filters): SummaryRow[] {
  const { where, params } = caseScopeWhere(user, f);
  return db
    .prepare(
      `SELECT c.status, c.bureau, c.category, c.assigned_officer_id, c.expected_disposal_at, c.received_at,
              c.disposed_at, c.escalation_open, c.triage_state, c.outcome, u.display_name AS assigned_officer_name
         FROM cases c
         LEFT JOIN institutions i ON i.id = c.institution_id
         LEFT JOIN users u ON u.id = c.assigned_officer_id
        WHERE ${where}`
    )
    .all(...params) as SummaryRow[];
}

/** The matched set as a SQL subquery, so period counts are restricted in the database (no id array). */
function matchedCaseIdsSql(user: SessionUser, f: Filters): { sql: string; params: unknown[] } {
  const { where, params } = caseScopeWhere(user, f);
  return {
    sql: `SELECT c.id FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id WHERE ${where}`,
    params,
  };
}

function reportData(user: SessionUser, f: Filters) {
  const rows = summaryRows(user, f);
  const now = new Date();
  const nowMs = now.getTime();
  const nowStamp = now.toISOString();
  // Deadlines are stored as canonical ISO-8601 UTC strings, which order lexicographically exactly as they
  // order in time; comparing them avoids constructing two Date objects per row.
  const active = (r: SummaryRow) => isActiveStatus(r.status as Status);
  const overdue = (r: SummaryRow) => active(r) && Boolean(r.expected_disposal_at) && (r.expected_disposal_at as string) < nowStamp;
  const daysBetween = (fromIso: string, toMs: number) => Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 86_400_000));
  const pendingRows = rows.filter(active);
  const overdueRows = pendingRows.filter(overdue);
  const periodStart = f.receivedFrom ? new Date(`${f.receivedFrom}T00:00:00.000Z`).toISOString() : '0000';
  const periodEnd = f.receivedTo ? new Date(`${f.receivedTo}T23:59:59.999Z`).toISOString() : '9999';
  const matched = matchedCaseIdsSql(user, f);
  const countIn = (sql: string) =>
    (db.prepare(sql).get(periodStart, periodEnd, ...matched.params) as { n: number }).n;
  const transferred = countIn(
    `SELECT COUNT(*) AS n FROM transfers WHERE state = 'accepted' AND decided_at BETWEEN ? AND ?
       AND case_id IN (${matched.sql})`
  );
  const disposals = countIn(
    `SELECT COUNT(*) AS n FROM action_events WHERE action_type = 'status_disposed' AND at BETWEEN ? AND ?
       AND case_id IN (${matched.sql})`
  );
  // Structured disposition records in the period, and legacy disposed/closed cases that predate the
  // structured outcome (flagged, never given an invented outcome).
  const structured = countIn(
    `SELECT COUNT(*) AS n FROM dispositions WHERE at BETWEEN ? AND ? AND case_id IN (${matched.sql})`
  );
  const legacyDisposed = rows.filter((r) => (r.status === 'Disposed' || r.status === 'Closed') && !r.outcome).length;
  const ageing = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of pendingRows) {
    const age = daysBetween(r.received_at, nowMs);
    if (age <= 30) ageing['0-30'] += 1;
    else if (age <= 60) ageing['31-60'] += 1;
    else if (age <= 90) ageing['61-90'] += 1;
    else ageing['90+'] += 1;
  }
  const byStatus: Record<string, number> = {};
  for (const s of STATUSES) byStatus[s] = 0;
  const byBureau: Record<string, { total: number; pending: number; overdue: number }> = {};
  const byCategory: Record<string, number> = {};
  const workload: Record<string, { officer: string; bureau: string; pending: number; overdue: number }> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byBureau[r.bureau] = byBureau[r.bureau] ?? { total: 0, pending: 0, overdue: 0 };
    byBureau[r.bureau].total += 1;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    if (!active(r)) continue;
    byBureau[r.bureau].pending += 1;
    const late = overdue(r);
    if (late) byBureau[r.bureau].overdue += 1;
    const key = r.assigned_officer_id ?? `unassigned:${r.bureau}`;
    workload[key] = workload[key] ?? {
      officer: r.assigned_officer_name ?? 'Unassigned queue',
      bureau: r.bureau,
      pending: 0,
      overdue: 0,
    };
    workload[key].pending += 1;
    if (late) workload[key].overdue += 1;
  }
  const completed = rows.filter((r) => r.disposed_at).map((r) => daysBetween(r.received_at, Date.parse(r.disposed_at as string)));
  const avgProcessing = completed.length ? Math.round((completed.reduce((a, b) => a + b, 0) / completed.length) * 10) / 10 : null;
  return {
    snapshotAt: nowIso(),
    timezone: 'Asia/Kolkata',
    filters: filtersEcho(f),
    totals: {
      current: rows.length,
      pending: pendingRows.length,
      overdue: overdueRows.length,
      escalated: rows.filter((r) => r.escalation_open === 1).length,
      transferred,
      disposalsInPeriod: disposals,
      structuredDisposalsInPeriod: structured,
      legacyDisposedWithoutOutcome: legacyDisposed,
      currentlyDisposed: rows.filter((r) => r.status === 'Disposed').length,
      closed: rows.filter((r) => r.status === 'Closed').length,
      triageQueue: rows.filter((r) => r.triage_state === 'unresolved').length,
      noDeadlineConfigured: pendingRows.filter((r) => !r.expected_disposal_at).length,
      avgProcessingDays: avgProcessing,
    },
    byStatus,
    byBureau,
    byCategory,
    ageing,
    workload: Object.values(workload).sort((a, b) => b.pending - a.pending),
    definitions: {
      pending: 'Received, Assigned, Under review and Awaiting response cases.',
      overdue: 'Pending cases whose configured disposal due time is earlier than the snapshot time.',
      transferred: 'Accepted transfer events in the selected period — not an extra lifecycle state.',
      escalated: 'Cases with an open escalation flag, counted alongside their lifecycle state.',
      disposalThroughput:
        'Disposition events recorded in the period (canonical status_disposed events, whatever note category the officer chose), labelled separately from the number of cases that are currently disposed.',
      structuredDisposals:
        'Disposition records in the period that carry a structured outcome and a decision reference.',
      legacyDisposals:
        'Cases disposed or closed before structured outcomes existed. Shown as a count and flagged in migration notes; no outcome is inferred for them.',
      averageProcessing:
        'Mean days from receipt to disposition for cases that carry a disposal time; null when there are none. Not a throughput measure.',
      deadline: 'Overdue means past the configured disposal deadline. Cases with no policy applied are counted separately as "No deadline configured".',
      timezone: 'Aggregations use Asia/Kolkata for period boundaries and "today" comparisons.',
    },
    ruleVersion: RULE_VERSION_LABEL,
  };
}

app.get(
  '/api/reports/summary',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    res.json(reportData(user, parseFilters(req)));
  })
);

const EXPORT_FIELDS = [
  'case_number',
  'institution_permanent_id',
  'institution_name',
  'region',
  'category',
  'bureau',
  'status',
  'outcome',
  'decision_reference',
  'owner',
  'received_at_utc',
  'received_at_ist',
  'expected_disposal_utc',
  'deadline_state',
  'next_action',
  'escalation_open',
  'last_action_at_utc',
  'processing_days',
];

app.get(
  '/api/reports/export',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    const filters = parseFilters(req);
    const allFiltered = allMatchingCases(user, { ...filters, page: 1, pageSize: 100000 });
    const rows = allFiltered.map((c) => {
      const content = canViewContent(user, c);
      return [
        c.case_number,
        c.institution_permanent_id ?? '',
        c.institution_name ?? c.intake_institution_text ?? '',
        c.institution_region ?? '',
        c.category,
        c.bureau,
        c.status,
        // Structured disposition fields: content-gated like the rest of the complaint-derived material.
        content ? (c.outcome ?? '') : '[restricted]',
        content ? (c.decision_reference ?? '') : '[restricted]',
        content ? (c.assigned_officer_name ?? 'Unassigned queue') : '[restricted]',
        c.received_at,
        istString(c.received_at),
        c.expected_disposal_at ?? 'No deadline configured',
        deadlineState(c),
        content ? c.next_action ?? '' : '[restricted]',
        c.escalation_open ? 'yes' : 'no',
        lastActionAt(c.id) ?? '',
        processingDays(c) ?? '',
      ];
    });
    const header = [`# CaseLink export snapshot=${nowIso()} timezone=Asia/Kolkata filters=${JSON.stringify(filtersEcho(filters))}`, ...[]];
    const csv = [header.join('\n'), toCsv(EXPORT_FIELDS, rows)].join('\n');
    audit(user.id, 'report_export', `rows=${rows.length} filters=${JSON.stringify(filtersEcho(filters))}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="caselink-report-${Date.now()}.csv"`);
    res.send(csv);
  })
);

function istString(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/* ----------------------------------------------------------------- import */

app.get('/api/import/template', requireAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="caselink-import-template.csv"');
  res.send(TEMPLATE_CSV);
});

interface ImportPayload {
  sourceSystem: string;
  csvText: string;
}

/** Counts shown in the preview and stored on the batch. */
function importCounts(rows: ParsedImportRow[]) {
  return {
    accepted: rows.filter((r) => r.status === 'valid' || r.status === 'triage').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    skipped: rows.filter((r) => r.status === 'duplicate' || r.status === 'conflict').length,
    duplicates: rows.filter((r) => r.status === 'duplicate').length,
    conflicts: rows.filter((r) => r.status === 'conflict').length,
    triage: rows.filter((r) => r.status === 'triage').length,
  };
}

/** Fingerprint of the normalised batch input: preview and commit must agree on it. */
function importInputHash(sourceSystem: string, bureau: string, rows: ParsedImportRow[]): string {
  const normalised = rows.map((r) => ({
    line: r.lineNumber,
    identity: r.identity ?? importIdentity(r.values.source_system || sourceSystem, bureau, r.values.source_reference),
    status: r.status,
    category: r.values.category,
    summary: r.values.complaint_summary,
    received: r.values.received_date,
    policy: r.policyId ?? null,
  }));
  return sha256(JSON.stringify({ sourceSystem: sourceSystem.trim().toLowerCase(), bureau, normalised }));
}

function validateImport(
  user: SessionUser,
  payload: ImportPayload
): { rows: ParsedImportRow[]; blocked?: string; policySnapshot: Record<string, string> } {
  const table = parseCsv(payload.csvText);
  if (!table.length) return { rows: [], blocked: 'The file has no rows.', policySnapshot: {} };
  const header = table[0].map((h) => h.trim());
  const missing = IMPORT_COLUMNS.filter((col) => col !== 'institution_name_if_unconfirmed' && !header.includes(col));
  if (missing.length) return { rows: [], blocked: `Missing required column(s): ${missing.join(', ')}`, policySnapshot: {} };
  const dataRows = table.slice(1);
  if (dataRows.length > 500) {
    return { rows: [], blocked: 'A batch is limited to 500 rows. Split the file and import again.', policySnapshot: {} };
  }

  const policies = db
    .prepare('SELECT id, name, version, calendar_days FROM deadline_policies WHERE active = 1')
    .all() as { id: string; name: string; version: string; calendar_days: number }[];
  const policySnapshot: Record<string, string> = {};
  for (const p of policies) policySnapshot[p.id] = `${p.name} (${p.version}, ${p.calendar_days} calendar days)`;

  // The first row for an identity inside the file, so a later row with the same identity can be judged
  // on its content rather than on the key alone (M7/A08).
  const seenIdentity = new Map<string, { lineNumber: number; snapshot: Record<string, string> }>();
  const rows: ParsedImportRow[] = dataRows.map((cells, idx) => {
    const values: Record<string, string> = {};
    header.forEach((h, i) => {
      values[h] = (cells[i] ?? '').trim();
    });
    const errors: string[] = [];
    const received = values.received_date;
    // A calendar date must exist: 2026-02-30 is refused instead of being rolled into March (M7/A10).
    const receivedDate = received ? parseCalendarDate(received) : null;
    if (!received) errors.push('received_date is required.');
    else if (!receivedDate) errors.push('received_date must be a real calendar date in YYYY-MM-DD form.');
    else if (receivedDate.getTime() > Date.now()) errors.push('received_date cannot be in the future.');
    if (!values.source_system) errors.push('source_system is required for import provenance.');
    if (!values.source_reference) errors.push('source_reference is required so repeats cannot create duplicates.');
    if (!(CATEGORIES as readonly string[]).includes(values.category)) {
      errors.push(`category must be one of: ${CATEGORIES.join(' | ')}`);
    }
    if (!values.complaint_summary || values.complaint_summary.length < 10) {
      errors.push('complaint_summary needs at least 10 characters.');
    }

    let institutionId: string | null = null;
    let triage = false;
    if (values.institution_permanent_id) {
      const inst = db.prepare('SELECT id, region FROM institutions WHERE permanent_id = ?').get(values.institution_permanent_id) as
        | { id: string; region: string }
        | undefined;
      if (!inst) errors.push(`institution_permanent_id ${values.institution_permanent_id} is not in the directory.`);
      else if (user.region && inst.region !== user.region) errors.push('institution is outside your authorised region.');
      else institutionId = inst.id;
    } else if (values.institution_name_if_unconfirmed) {
      triage = true;
    } else {
      errors.push('Provide institution_permanent_id, or institution_name_if_unconfirmed to hold the row in triage.');
    }

    // Assignment in a file is validated by the same policy as intake and reassignment (M7/A04):
    // active case worker, owning bureau, and an authorised region for the row's institution.
    let officerId: string | null = null;
    if (values.assigned_officer_username) {
      const officer = db.prepare('SELECT id FROM users WHERE username = ?').get(values.assigned_officer_username) as
        | { id: string }
        | undefined;
      if (!officer) errors.push(`assigned_officer_username ${values.assigned_officer_username} not found.`);
      else {
        const rowRegion = institutionId
          ? ((db.prepare('SELECT region FROM institutions WHERE id = ?').get(institutionId) as { region: string | null } | undefined)
              ?.region ?? user.region)
          : user.region;
        try {
          validateCaseWorker(officer.id, { bureau: user.bureau ?? '', region: rowRegion, field: 'assigned_officer_username' });
          officerId = officer.id;
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
    }
    if (values.policy_id && !policies.some((p) => p.id === values.policy_id)) {
      errors.push(`policy_id ${values.policy_id} is not an active deadline policy.`);
    }

    // Deadline: only a policy named in the file is applied. A blank policy is an explicit
    // "No deadline configured" — the importer never invents or silently defaults a deadline.
    const policyId = values.policy_id || null;
    const policy = policyId ? policies.find((p) => p.id === policyId) : undefined;
    const deadlineLabel = policyId ? (policySnapshot[policyId] ?? policyId) : 'No deadline configured';
    // The previewed due time is *bound*: the commit either applies these approved values or reports a
    // conflict asking for a new preview (M7/A09).
    const policyVersion = policy?.version ?? null;
    const policyCalendarDays = policy?.calendar_days ?? null;
    const expectedDisposalAt =
      receivedDate && policyCalendarDays !== null ? addCalendarDays(receivedDate.toISOString(), policyCalendarDays) : null;

    const identity = importIdentity(values.source_system || payload.sourceSystem, user.bureau ?? '', values.source_reference);

    let status: ParsedImportRow['status'] = 'valid';
    let note: string | undefined;
    // Validate first: a rejected row never reserves the dedupe key.
    if (errors.length) {
      status = 'rejected';
    } else if (!identity) {
      status = 'rejected';
      errors.push('The row has no usable import identity (source system, bureau and reference are required).');
    } else {
      const existing = db
        .prepare(
          `SELECT id, case_number, category, complaint_summary, received_at, institution_id, source_reference,
                  assigned_officer_id, deadline_policy_id, complainant_contact, intake_institution_text
             FROM cases WHERE source_identity = ?`
        )
        .get(identity) as
        | {
            id: string;
            case_number: string;
            category: string;
            complaint_summary: string;
            received_at: string;
            institution_id: string | null;
            source_reference: string | null;
            assigned_officer_id: string | null;
            deadline_policy_id: string | null;
            complainant_contact: string | null;
            intake_institution_text: string | null;
          }
        | undefined;
      const snapshot = importRecordSnapshot({ values, policyId });
      const firstInBatch = seenIdentity.get(identity);
      const inBatchChanges = firstInBatch ? changedImportFields(snapshot, firstInBatch.snapshot) : [];
      if (firstInBatch) {
        if (inBatchChanges.length) {
          status = 'conflict';
          note = `Reference ${values.source_reference} appears earlier in this batch (line ${firstInBatch.lineNumber}) with different content: ${inBatchChanges.join(', ')}. The two rows describe different complaints under one identity — resolve the reference, nothing is imported for this row and nothing is overwritten.`;
        } else {
          status = 'duplicate';
          note = `Unchanged duplicate of line ${firstInBatch.lineNumber}: same identity and same content; the first row is imported once and this row is skipped.`;
        }
      } else if (existing) {
        const storedInstitution = existing.institution_id
          ? ((db.prepare('SELECT permanent_id FROM institutions WHERE id = ?').get(existing.institution_id) as
              | { permanent_id: string }
              | undefined)?.permanent_id ?? '')
          : '';
        const storedOfficer = existing.assigned_officer_id
          ? ((db.prepare('SELECT username FROM users WHERE id = ?').get(existing.assigned_officer_id) as
              | { username: string }
              | undefined)?.username ?? '')
          : '';
        const stored = {
          institution: storedInstitution.trim().toLowerCase(),
          intakeName: (existing.intake_institution_text ?? '').trim().toLowerCase(),
          received: String(existing.received_at ?? '').slice(0, 10),
          category: existing.category ?? '',
          summary: existing.complaint_summary ?? '',
          officer: storedOfficer.trim().toLowerCase(),
          policy: existing.deadline_policy_id ?? '',
          contact: (existing.complainant_contact ?? '').trim().toLowerCase(),
        };
        const differences = changedImportFields(snapshot, stored);
        status = differences.length ? 'conflict' : 'duplicate';
        note = differences.length
          ? `Same identity as ${existing.case_number} but different content (${differences.join(', ')}) — held for human review, never overwritten.`
          : `Unchanged duplicate: already imported as ${existing.case_number}; no new case is created and the existing record is not overwritten.`;
      } else if (triage) {
        status = 'triage';
        note = 'Institution identity unresolved — the case will be held in triage and excluded from overlap checks.';
      }
      if (!firstInBatch) seenIdentity.set(identity, { lineNumber: idx + 2, snapshot });
    }
    return {
      lineNumber: idx + 2,
      values,
      status,
      errors,
      note,
      identity,
      policyId,
      deadlineLabel,
      policyVersion,
      policyCalendarDays,
      expectedDisposalAt,
    };
  });
  return { rows, policySnapshot };
}

app.post(
  '/api/import/preview',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    if (!capabilities(user).includes('import')) {
      throw new AppError(403, 'access_denied', 'CSV import is a bureau lead action.');
    }
    const body = parseOrThrow(
      z.object({ sourceSystem: z.string().min(2).max(80), csvText: z.string().min(10).max(2_000_000) }),
      req.body
    );
    const { rows, blocked, policySnapshot } = validateImport(user, body);
    if (blocked) throw new AppError(422, 'validation_error', blocked, { csvText: blocked });
    const id = uid();
    const counts = importCounts(rows);
    const inputHash = importInputHash(body.sourceSystem, user.bureau ?? '', rows);
    db.prepare(
      `INSERT INTO import_batches (id, bureau, source_system, created_by, created_at, state, total, accepted, rejected, skipped,
         rows_json, input_hash, policy_snapshot_json)
       VALUES (?,?,?,?,?, 'previewed', ?,?,?,?,?,?,?)`
    ).run(
      id,
      user.bureau,
      body.sourceSystem,
      user.id,
      nowIso(),
      rows.length,
      counts.accepted,
      counts.rejected,
      counts.skipped,
      JSON.stringify(rows),
      inputHash,
      JSON.stringify(policySnapshot)
    );
    res.json({
      batchId: id,
      rows,
      counts,
      sourceSystem: body.sourceSystem,
      policySnapshot,
      inputHash,
      note: 'Nothing is saved yet. Review the rows and commit the batch. The preview and the commit are bound to this normalised input.',
    });
  })
);

app.post(
  '/api/import/:batchId/commit',
  requireAuth,
  wrap((req, res) => {
    const user = req.user as SessionUser;
    if (!capabilities(user).includes('import')) throw new AppError(403, 'access_denied', 'CSV import is a bureau lead action.');
    const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(req.params.batchId) as
      | {
          id: string;
          bureau: string;
          source_system: string;
          created_by: string;
          state: string;
          rows_json: string;
          input_hash: string | null;
          policy_snapshot_json: string | null;
          result_json: string | null;
        }
      | undefined;
    if (!batch) throw new AppError(404, 'not_found', 'Import batch not found.');
    if (batch.bureau !== user.bureau) throw new AppError(403, 'access_denied', 'This batch belongs to another bureau.');
    // Idempotent retry: a committed batch returns the recorded outcome and its stored counts, and
    // creates nothing further.
    if (batch.state === 'committed') {
      const prior = batch.result_json ? JSON.parse(batch.result_json) : null;
      res.setHeader('Idempotent-Replay', 'true');
      res.json({ ...(prior ?? {}), batchId: batch.id, replayed: true });
      return;
    }
    const rows = JSON.parse(batch.rows_json) as ParsedImportRow[];
    const policySnapshot = batch.policy_snapshot_json ? (JSON.parse(batch.policy_snapshot_json) as Record<string, string>) : {};
    // The batch is bound to the normalised input that was previewed: if the stored rows no longer hash
    // to the recorded input, the batch is refused rather than committed against a different file.
    if (batch.input_hash && importInputHash(batch.source_system, batch.bureau, rows) !== batch.input_hash) {
      throw new AppError(409, 'batch_changed', 'This batch no longer matches the previewed input. Preview the file again.');
    }

    // Policy drift (M7/A09): the preview approved specific policy values and due times. If a policy has
    // been edited since, the batch is refused as a whole so the officer previews again — a commit never
    // silently applies parameters nobody reviewed.
    const policyDrift: { lineNumber: number; reference: string; approved: string; current: string }[] = [];
    for (const row of rows) {
      if (row.status === 'rejected' || !row.policyId) continue;
      const current = db.prepare('SELECT version, calendar_days FROM deadline_policies WHERE id = ?').get(row.policyId) as
        | { version: string; calendar_days: number }
        | undefined;
      if (!current) {
        policyDrift.push({
          lineNumber: row.lineNumber,
          reference: row.values.source_reference,
          approved: `${row.policyId} v${row.policyVersion} / ${row.policyCalendarDays} days`,
          current: 'policy no longer active',
        });
      } else if (current.version !== row.policyVersion || current.calendar_days !== row.policyCalendarDays) {
        policyDrift.push({
          lineNumber: row.lineNumber,
          reference: row.values.source_reference,
          approved: `${row.policyId} v${row.policyVersion} / ${row.policyCalendarDays} days`,
          current: `v${current.version} / ${current.calendar_days} days`,
        });
      }
    }
    if (policyDrift.length) {
      throw new AppError(
        409,
        'policy_changed',
        'A deadline policy changed after this preview. Nothing was imported — preview the file again so the deadlines you approve are the deadlines that are stored.',
        { policyDrift: JSON.stringify(policyDrift.slice(0, 20)) }
      );
    }

    const created: string[] = [];
    const failed: { lineNumber: number; error: string }[] = [];
    const skips: { lineNumber: number; reason: string; kind: string }[] = [];
    const newConflicts: { lineNumber: number; caseNumber: string; reason: string }[] = [];

    for (const row of rows) {
      if (row.status === 'rejected') {
        failed.push({ lineNumber: row.lineNumber, error: row.errors.join(' ') });
        continue;
      }
      if (row.status === 'duplicate' || row.status === 'conflict') {
        skips.push({ lineNumber: row.lineNumber, reason: row.note ?? row.status, kind: row.status });
        continue;
      }
      const identity =
        row.identity ?? importIdentity(row.values.source_system || batch.source_system, batch.bureau, row.values.source_reference);
      if (!identity) {
        failed.push({ lineNumber: row.lineNumber, error: 'The row has no usable import identity.' });
        continue;
      }
      // Re-check at commit time: a reference that became a duplicate after the preview is disclosed as
      // a new conflict instead of creating a second case or silently overwriting the existing one.
      const existing = db.prepare('SELECT case_number FROM cases WHERE source_identity = ?').get(identity) as
        | { case_number: string }
        | undefined;
      if (existing) {
        newConflicts.push({
          lineNumber: row.lineNumber,
          caseNumber: existing.case_number,
          reason: `Reference ${row.values.source_reference} was imported as ${existing.case_number} after this preview; the row was not imported.`,
        });
        skips.push({
          lineNumber: row.lineNumber,
          reason: `Already imported as ${existing.case_number} (conflict detected at commit).`,
          kind: 'conflict',
        });
        continue;
      }
      try {
        const officer = row.values.assigned_officer_username
          ? (db.prepare('SELECT id FROM users WHERE username = ?').get(row.values.assigned_officer_username) as { id: string } | undefined)
          : undefined;
        const inst = row.values.institution_permanent_id
          ? (db.prepare('SELECT id FROM institutions WHERE permanent_id = ?').get(row.values.institution_permanent_id) as
              | { id: string }
              | undefined)
          : undefined;
        const policyId = row.policyId ?? (row.values.policy_id || null);
        const c = tx(() =>
          createCase(user, {
            institutionId: inst?.id ?? null,
            intakeInstitutionText: inst ? null : row.values.institution_name_if_unconfirmed,
            receivedAt: new Date(`${row.values.received_date}T09:30:00+05:30`).toISOString(),
            sourceChannel: 'CSV import',
            sourceReference: row.values.source_reference,
            sourceSystem: row.values.source_system || batch.source_system,
            sourceIdentity: identity,
            category: row.values.category,
            complaintSummary: row.values.complaint_summary,
            assignedOfficerId: officer?.id ?? null,
            // No policy in the file means "No deadline configured" — never a silent default. When a
            // policy was named, the due time approved at preview is the one stored.
            deadlinePolicyId: policyId,
            expectedDisposalAt: row.expectedDisposalAt ?? null,
            complainantContact: row.values.complainant_contact || null,
            nextAction: 'Review imported record and confirm ownership',
          })
        );
        tx(() => {
          db.prepare('UPDATE cases SET imported_at = ?, import_batch_id = ? WHERE id = ?').run(nowIso(), batch.id, c.id);
        });
        created.push(c.case_number);
      } catch (err) {
        const message = (err as Error).message ?? 'Unknown error';
        if (/UNIQUE constraint failed:.*source_identity|UNIQUE constraint failed: cases.source_identity/.test(message)) {
          // The unique index is the last line of defence against a duplicate identity.
          newConflicts.push({
            lineNumber: row.lineNumber,
            caseNumber: '—',
            reason: 'Another import committed the same identity while this batch was being written; the row was not imported.',
          });
          skips.push({ lineNumber: row.lineNumber, reason: 'Concurrent duplicate identity (unique index).', kind: 'conflict' });
        } else {
          failed.push({ lineNumber: row.lineNumber, error: message });
        }
      }
    }
    const result = {
      batchId: batch.id,
      createdCaseNumbers: created,
      accepted: created.length,
      rejected: failed.length,
      skipped: skips.length,
      failures: failed,
      skips,
      newConflicts,
      policySnapshot,
      replayed: false,
    };
    db.prepare(`UPDATE import_batches SET state = 'committed', accepted = ?, rejected = ?, skipped = ?, result_json = ? WHERE id = ?`).run(
      created.length,
      failed.length,
      skips.length,
      JSON.stringify(result),
      batch.id
    );
    drainJobs();
    audit(user.id, 'import_committed', `${batch.id} created=${created.length} conflicts=${newConflicts.length}`);
    res.json(result);
  })
);

/* -------------------------------------------------------------- static SPA */

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send('CaseLink API is running. Build the interface with `npm run build`.');
  });
}

/* ------------------------------------------------------------ error mapping */

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  // body-parser errors carry the submitted body. Never log that object or echo complaint content.
  const parserError = err as { type?: string } | null;
  if (parserError?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: 'Send a valid JSON request body.' });
    return;
  }
  if (parserError?.type === 'entity.too.large') {
    res.status(413).json({ error: 'request_too_large', message: 'The request body exceeds the size limit.' });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message, fields: err.fields });
    return;
  }
  if (err instanceof multer.MulterError) {
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 422).json({ error: 'upload_error', message: err.message });
    return;
  }
  const message = (err as Error)?.message ?? 'Unexpected error';
  if (/UNIQUE constraint failed/.test(message)) {
    res.status(409).json({ error: 'conflict', message: 'That record already exists (unique constraint).' });
    return;
  }
  console.error('[caselink] unhandled request error', { name: (err as Error)?.name ?? 'Error', code: (err as { code?: string })?.code ?? 'unknown' });
  res.status(500).json({ error: 'server_error', message: 'The server could not complete that request. Refresh the record before retrying.' });
});

/**
 * Start-up reconciliation of evidence publication (M7/A05).
 *
 * A process that dies between the staging write and the rename, or between the rename and the `ready`
 * mark, leaves either a non-published row or an unreferenced file. Both are resolved here, before the
 * instance serves a request:
 *   - a row still in `publishing` with no readable file is deleted together with its history event and
 *     the case version is put back, so the case is where it was before the interrupted request;
 *   - a row in `publishing` whose file *is* readable is completed (marked ready);
 *   - unreferenced files in the upload directory are removed — never a file another row references.
 */
function reconcileUploads(): { completed: number; rolledBack: number; orphanFiles: number } {
  let completed = 0;
  let rolledBack = 0;
  const pending = db.prepare(`SELECT * FROM attachments WHERE state <> 'ready'`).all() as {
    id: string;
    case_id: string;
    stored_name: string;
  }[];
  for (const row of pending) {
    if (fs.existsSync(path.join(UPLOAD_DIR, row.stored_name))) {
      db.prepare(`UPDATE attachments SET state = 'ready' WHERE id = ?`).run(row.id);
      completed += 1;
      continue;
    }
    tx(() => {
      const event = db
        .prepare(
          `SELECT id, version_after FROM action_events
            WHERE case_id = ? AND action_type = 'evidence_uploaded'
            ORDER BY rowid DESC LIMIT 1`
        )
        .get(row.case_id) as { id: string; version_after: number } | undefined;
      db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
      if (event) {
        db.prepare('DELETE FROM action_events WHERE id = ?').run(event.id);
        db.prepare('UPDATE cases SET version = version - 1 WHERE id = ? AND version = ?').run(row.case_id, event.version_after);
      }
      db.prepare('INSERT INTO migration_notes (id, version, at, subject, detail) VALUES (?,?,?,?,?)').run(
        uid(),
        CURRENT_SCHEMA_VERSION,
        nowIso(),
        `interrupted upload rolled back: ${row.id}`,
        `The bytes of attachment ${row.stored_name} were never published, so the record, its history event and the case version were rolled back at start-up.`
      );
    });
    rolledBack += 1;
  }
  let orphanFiles = 0;
  if (fs.existsSync(UPLOAD_DIR)) {
    const referenced = new Set(
      (db.prepare('SELECT stored_name FROM attachments').all() as { stored_name: string }[]).map((r) => r.stored_name)
    );
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const full = path.join(UPLOAD_DIR, name);
      if (referenced.has(name)) continue;
      if (!fs.statSync(full).isFile()) continue;
      fs.rmSync(full, { force: true });
      orphanFiles += 1;
    }
  }
  return { completed, rolledBack, orphanFiles };
}

/* --------------------------------------------------------------------- boot */

const seeded = DEMO_MODE ? ensureSeed() : false;
purgeExpiredSessions();
const reconciled = reconcileUploads();
if (reconciled.completed || reconciled.rolledBack || reconciled.orphanFiles) {
  console.log(
    `[caselink] upload reconciliation: completed=${reconciled.completed} rolledBack=${reconciled.rolledBack} orphanFiles=${reconciled.orphanFiles}`
  );
}
startWorker();
const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => {
  console.log(`CaseLink listening on http://0.0.0.0:${port} (demo=${DEMO_MODE}, data=${DATA_DIR}, seeded=${seeded})`);
});
