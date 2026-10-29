import { db, nowIso, setting, uid } from './db.js';
import { ACTIVE_STATUSES, CASE_SELECT, getCase, isActiveStatus, type CaseRecord } from './domain.js';
import { APPROACHING_DAYS, deadlineState, recomputeOverlap, recomputeSuggestions, coordinatorRecipients } from './rules.js';
import { notifyRecipientsFor, type NotificationDetail } from './privacy.js';
import { sessionUserById, type SessionUser } from './auth.js';

export interface WorkerState {
  running: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastRunProcessed: number;
  runs: number;
  lastError: string | null;
  matchingMode: 'rule-based' | 'unavailable';
}

export const workerState: WorkerState = {
  running: false,
  intervalMs: 60_000,
  lastRunAt: null,
  lastRunProcessed: 0,
  runs: 0,
  lastError: null,
  matchingMode: 'rule-based',
};

/**
 * Deduplicated insert: rule + entity + threshold keep the same notification from repeating.
 *
 * `detail` carries the structured, non-quoting coordination facts (case number, category, bureau,
 * state, deadline). The stored title/body may quote complaint-derived text; a reader without content
 * access is shown the structured detail instead (M7/A12), so every content-bearing notification passes
 * its safe facts here.
 */
export function notify(
  userId: string,
  kind: string,
  entityType: string,
  entityId: string,
  dedupeKey: string,
  title: string,
  body: string,
  detail?: NotificationDetail
): boolean {
  const exists = db.prepare('SELECT 1 FROM notifications WHERE dedupe_key = ?').get(dedupeKey);
  if (exists) return false;
  db.prepare(
    `INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, dedupe_key, title, body, detail_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(uid(), userId, kind, entityType, entityId, dedupeKey, title, body, detail ? JSON.stringify(detail) : null, nowIso());
  return true;
}

/** The session view of every active account, used to filter recipients through the read policy. */
export function activeSessionUsers(role?: string): SessionUser[] {
  const rows = db
    .prepare(`SELECT id FROM users WHERE active = 1${role ? ' AND role = ?' : ''} ORDER BY username`)
    .all(...(role ? [role] : [])) as { id: string }[];
  return rows.map((r) => sessionUserById(r.id)).filter((u): u is SessionUser => Boolean(u));
}

/** Safe coordination facts for a case notification. */
export function caseNotificationDetail(c: CaseRecord, extra: Partial<NotificationDetail> = {}): NotificationDetail {
  return {
    caseNumber: c.case_number,
    category: c.category,
    bureau: c.bureau,
    status: c.status,
    deadline: c.expected_disposal_at,
    ...extra,
  };
}

export function enqueue(kind: string, payload: Record<string, unknown>, runAfter = nowIso()): void {
  // Opt-in, administrator-controlled fault injection: proves that the queued background work of a
  // mutation is inside the same transaction (so a failure rolls the whole change back).
  if (setting('inject_job_failure', '0') === '1') {
    throw new Error('Injected background-job failure (test hook)');
  }
  db.prepare(
    'INSERT INTO jobs (id, kind, payload_json, created_at, run_after) VALUES (?,?,?,?,?)'
  ).run(uid(), kind, JSON.stringify(payload), nowIso(), runAfter);
}

export function runJobs(): number {
  const jobs = db
    .prepare(`SELECT * FROM jobs WHERE state = 'pending' AND run_after <= ?
      AND (? = 'rule-based' OR kind <> 'recompute_suggestions') ORDER BY run_after LIMIT 200`)
    .all(nowIso(), workerState.matchingMode) as { id: string; kind: string; payload_json: string; attempts: number }[];
  let processed = 0;
  for (const job of jobs) {
    try {
      db.transaction(() => {
        const payload = JSON.parse(job.payload_json) as { institutionId?: unknown } | null;
        if (!payload || typeof payload.institutionId !== 'string' || !payload.institutionId) throw new Error('Invalid background-job payload');
        if (job.kind === 'recompute_overlap') recomputeOverlap(payload.institutionId);
        else if (job.kind === 'recompute_suggestions') recomputeSuggestions(payload.institutionId);
        else if (job.kind === 'notify_overlap') notifyOverlap(payload.institutionId);
        else throw new Error('Unknown background-job kind');
        // Job effects and completion commit together; a partial recomputation is never reported done.
        db.prepare(`UPDATE jobs SET state = 'done', completed_at = ?, last_error = NULL WHERE id = ?`).run(nowIso(), job.id);
      })();
      processed += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      db.prepare(
        `UPDATE jobs SET attempts = ?, last_error = ?, state = CASE WHEN ? >= 5 THEN 'failed' ELSE 'pending' END,
           run_after = ? WHERE id = ?`
      ).run(
        attempts,
        String((err as Error).message),
        attempts,
        new Date(Date.now() + Math.min(60_000, attempts * 5_000)).toISOString(),
        job.id
      );
      workerState.lastError = String((err as Error).message);
    }
  }
  workerState.lastError = jobHealth().lastError;
  return processed;
}

/** Durable queue health survives successful scans and process restarts. */
export function jobHealth(): {
  pendingJobs: number; retryingJobs: number; failedJobs: number; oldestPendingAt: string | null; lastError: string | null;
} {
  const counts = db.prepare(`SELECT
    COUNT(CASE WHEN state='pending' THEN 1 END) AS pendingJobs,
    COUNT(CASE WHEN state='pending' AND attempts>0 THEN 1 END) AS retryingJobs,
    COUNT(CASE WHEN state='failed' THEN 1 END) AS failedJobs,
    MIN(CASE WHEN state='pending' THEN created_at END) AS oldestPendingAt FROM jobs`).get() as {
      pendingJobs: number; retryingJobs: number; failedJobs: number; oldestPendingAt: string | null;
    };
  const failure = db.prepare(`SELECT last_error FROM jobs WHERE state IN ('pending','failed') AND last_error IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`).get() as { last_error: string } | undefined;
  return { ...counts, lastError: failure?.last_error ?? null };
}

function notifyOverlap(institutionId: string): void {
  const alert = db.prepare(`SELECT * FROM alerts WHERE dedupe_key = ?`).get(`overlap:${institutionId}`) as
    | { id: string; state: string; case_ids_json: string; bureaus_json: string }
    | undefined;
  if (!alert || alert.state === 'closed') return;
  const caseIds = JSON.parse(alert.case_ids_json) as string[];
  const bureaus = JSON.parse(alert.bureaus_json) as string[];
  const inst = db.prepare('SELECT name, permanent_id, region FROM institutions WHERE id = ?').get(institutionId) as
    | { name: string; permanent_id: string; region: string }
    | undefined;
  if (!inst) return;
  const refs = caseIds
    .map((id) => getCase(id)?.case_number)
    .filter(Boolean)
    .join(', ');
  // Recipients are region-scoped, exactly as the API is; overlap text carries case numbers only.
  for (const user of coordinatorRecipients(bureaus, inst.region)) {
    notify(
      user.id,
      'overlap',
      'alert',
      alert.id,
      `notif:overlap:${alert.id}:${caseIds.sort().join(',')}:${user.id}`,
      'Institution overlap needs review',
      `${inst.name} (${inst.permanent_id}) now has active cases in ${bureaus.join(' + ')}. Case references: ${refs}. Open Coordination to review permitted summaries.`,
      {
        institutionName: inst.name,
        institutionPermanentId: inst.permanent_id,
        caseReferences: refs,
      }
    );
  }
}

function scanDeadlines(): number {
  // Only cases that can actually produce a reminder are loaded: an active case whose configured deadline
  // is inside the approaching window (or already past). Hydrating every active case made one scheduled
  // pass cost ~2 s of blocked event loop on a 10 000-case database (M7/A14).
  const cutoff = new Date(Date.now() + APPROACHING_DAYS * 86_400_000).toISOString();
  // The projection joins the institution, so `institution_region` is the real region of the case.
  // Reading bare `cases` rows made it undefined and dropped every regional lead and supervisor from the
  // recipient list (M7/A11).
  // A narrow projection, not a hydrated case: the reminder only reads the reference, the deadline, the
  // owning bureau and the case's institution region. Selecting whole records here cost ~150 ms per pass.
  const active = db
    .prepare(
      `SELECT c.id, c.case_number, c.category, c.bureau, c.status, c.expected_disposal_at,
              c.assigned_officer_id, c.next_action, c.institution_id, i.region AS institution_region
         FROM cases c LEFT JOIN institutions i ON i.id = c.institution_id
        WHERE c.status IN ('Received','Assigned','Under review','Awaiting response')
          AND c.expected_disposal_at IS NOT NULL AND c.expected_disposal_at <= ?`
    )
    .all(cutoff) as unknown as CaseRecord[];
  // The candidate pools do not change inside one pass: load them once instead of per case.
  const supervisors = activeSessionUsers('supervisor');
  const leadsByBureau = new Map<string, SessionUser[]>();
  for (const lead of activeSessionUsers('bureau_lead')) {
    const list = leadsByBureau.get(lead.bureau ?? '') ?? [];
    list.push(lead);
    leadsByBureau.set(lead.bureau ?? '', list);
  }
  const officerCache = new Map<string, SessionUser | null>();
  // One read of the reminder keys already sent, instead of a dedupe query per case and recipient: an
  // overdue backlog of a few thousand cases made that the rest of the pass (M7/A14).
  const alreadySent = new Set(
    (db.prepare(`SELECT dedupe_key FROM notifications WHERE kind IN ('overdue','deadline','escalation')`).all() as {
      dedupe_key: string;
    }[]).map((r) => r.dedupe_key)
  );
  let created = 0;
  for (const c of active) {
    if (c.status === 'Disposed' || c.status === 'Closed') continue; // disposed cases stop reminders
    const state = deadlineState(c);
    if (state !== 'overdue' && state !== 'approaching') continue;
    // Recipients are chosen by the same visibility policy the read paths use: the assigned officer,
    // every supervisor whose region covers the case, and the owning bureau's lead(s). Each candidate is
    // then re-checked against the case, so an out-of-region account never receives a foreign case
    // number (M7/A11).
    let assigned: SessionUser[] = [];
    if (c.assigned_officer_id) {
      if (!officerCache.has(c.assigned_officer_id)) officerCache.set(c.assigned_officer_id, sessionUserById(c.assigned_officer_id));
      const officer = officerCache.get(c.assigned_officer_id);
      if (officer) assigned = [officer];
    }
    const candidates: SessionUser[] = [...assigned, ...supervisors, ...(leadsByBureau.get(c.bureau) ?? [])];
    const recipients = new Set<string>(notifyRecipientsFor(c, candidates).map((u) => u.id));
    const threshold = state === 'overdue' ? 'overdue' : 'due7';
    for (const userId of recipients) {
      const dedupeKey = `notif:${threshold}:${c.id}:${c.expected_disposal_at}:${userId}`;
      if (alreadySent.has(dedupeKey)) continue;
      const ok = notify(
        userId,
        state === 'overdue' ? 'overdue' : 'deadline',
        'case',
        c.id,
        dedupeKey,
        state === 'overdue' ? `Overdue: ${c.case_number}` : `Deadline approaching: ${c.case_number}`,
        state === 'overdue'
          ? `Disposal deadline ${c.expected_disposal_at} has passed under the configured DEMO policy. Next action: ${c.next_action ?? 'not recorded'}.`
          : `Disposal deadline ${c.expected_disposal_at} is within 7 days. Next action: ${c.next_action ?? 'not recorded'}.`,
        caseNotificationDetail(c, { detailRecordedInCase: Boolean(c.next_action) })
      );
      if (ok) {
        alreadySent.add(dedupeKey);
        created += 1;
      }
    }
  }
  const escalations = db
    .prepare(
      `${CASE_SELECT} WHERE c.escalation_open = 1 AND c.status IN ('Received','Assigned','Under review','Awaiting response')`
    )
    .all() as CaseRecord[];
  for (const c of escalations) {
    const supervisorId = c.escalation_supervisor_id;
    if (!supervisorId) continue;
    const dedupeKey = `notif:escalation:${c.id}:${c.escalation_opened_at}:${supervisorId}`;
    if (alreadySent.has(dedupeKey)) continue;
    const ok = notify(
      supervisorId,
      'escalation',
      'case',
      c.id,
      dedupeKey,
      `Open escalation: ${c.case_number}`,
      `Escalation reason: ${c.escalation_reason ?? 'not recorded'}. Lifecycle state remains ${c.status}.`,
      caseNotificationDetail(c, { escalationFlag: true, detailRecordedInCase: Boolean(c.escalation_reason) })
    );
    if (ok) {
      alreadySent.add(dedupeKey);
      created += 1;
    }
  }
  return created;
}

/**
 * Drains pending background work immediately (used right after a mutation so overlap alerts and
 * suggestions are visible in the same request cycle). The deadline scan stays on the 60s interval.
 */
export function drainJobs(): { processed: number } {
  return { processed: runJobs() };
}

/** One scheduled pass: pending background work, then deadline/escalation scan. Idempotent by dedupe key. */
export function runWorkerTick(): { processed: number; notifications: number } {
  const processed = runJobs();
  const notifications = scanDeadlines();
  workerState.lastRunAt = nowIso();
  workerState.lastRunProcessed = processed;
  workerState.runs += 1;
  workerState.lastError = jobHealth().lastError;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('worker_last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(workerState.lastRunAt);
  return { processed, notifications };
}

export function startWorker(): void {
  if (workerState.running) return;
  workerState.running = true;
  const tick = () => {
    try {
      runWorkerTick();
    } catch (err) {
      workerState.lastError = String((err as Error).message);
    }
  };
  tick();
  setInterval(tick, workerState.intervalMs).unref();
}

export { ACTIVE_STATUSES, isActiveStatus };
