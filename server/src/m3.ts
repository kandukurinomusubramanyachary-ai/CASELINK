/**
 * M3 — Supervisor Review.
 * Requires a specific M2 handoff to the current supervisor. Read authority is
 * re-evaluated for both cases (and protected evidence) on every request.
 * This module never writes relationships, suggestions or case histories.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { db, nowIso, uid, tx, audit, UPLOAD_DIR } from './db.js';
import { requireAuth, recordSecurityDenial, type SessionUser } from './auth.js';
import { canViewContent, getCase, regionAllows, type CaseRecord } from './domain.js';
import { AppError } from './errors.js';

type Handler = (req: Request, res: Response) => void;
const handle = (fn: Handler) => (req: Request, res: Response, next: NextFunction): void => {
  try { fn(req, res); } catch (error) { next(error); }
};
type ReviewState = 'pending' | 'needs_review' | 'awaiting_evidence' | 'accepted';
type ReviewAction = 'accept' | 'needs_review' | 'request_evidence' | 'resume';
interface Handoff {
  id: string; suggestion_id: string; supervisor_id: string;
  sent_by: string; reason: string; sent_at: string;
  case_a_id: string; case_b_id: string; reasons_json: string;
  suggestion_state: string; rule_version: string;
}
interface Review {
  id: string; state: ReviewState; version: number; updated_at: string;
  note: string | null; accepted_at: string | null;
}
function deny(user: SessionUser): never {
  recordSecurityDenial(user.id, 'm3_review_access_denied');
  // Do not disclose pair identifiers, handoff existence or record contents.
  throw new AppError(404, 'not_found', 'Review not found.');
}
function supervisor(req: Request): SessionUser {
  const user = req.user as SessionUser;
  if (user.role !== 'supervisor') {
    recordSecurityDenial(user.id, 'm3_supervisor_role_denied');
    throw new AppError(403, 'access_denied', 'A supervisor account is required.');
  }
  return user;
}
function pairAuthorized(user: SessionUser, h: Handoff): { a: CaseRecord; b: CaseRecord } {
  const a = getCase(h.case_a_id);
  const b = getCase(h.case_b_id);
  if (!a || !b || !regionAllows(user, a) || !regionAllows(user, b) ||
      !canViewContent(user, a) || !canViewContent(user, b)) deny(user);
  return { a, b };
}
const handoffSql = `SELECT h.*, s.case_a_id, s.case_b_id, s.reasons_json,
  s.state AS suggestion_state, s.rule_version
  FROM m2_review_handoffs h JOIN suggestions s ON s.id = h.suggestion_id`;
function loadHandoff(user: SessionUser, id: string): { handoff: Handoff; a: CaseRecord; b: CaseRecord } {
  const handoff = db.prepare(handoffSql + ' WHERE h.id = ? AND h.supervisor_id = ?')
    .get(id, user.id) as Handoff | undefined;
  if (!handoff) deny(user);
  return { handoff, ...pairAuthorized(user, handoff) };
}
function currentReview(handoffId: string): Review | null {
  return (db.prepare('SELECT * FROM m3_reviews WHERE handoff_id = ?')
    .get(handoffId) as Review | undefined) ?? null;
}
function caseSummary(c: CaseRecord) {
  return {
    id: c.id, caseNumber: c.case_number, institutionName: c.institution_name,
    region: c.institution_region, bureau: c.bureau, category: c.category,
    status: c.status, version: c.version, receivedAt: c.received_at,
    summary: c.complaint_summary,
  };
}
function timeline(user: SessionUser, c: CaseRecord) {
  const events = db.prepare(`SELECT e.id, e.at, e.action_type AS actionType, e.remarks,
    e.paired_case_id AS pairedCaseId, e.version_after AS versionAfter,
    u.display_name AS actorName FROM action_events e JOIN users u ON u.id = e.actor_id
    WHERE e.case_id = ? ORDER BY e.at, e.rowid`).all(c.id) as Array<{
      id: string; at: string; actionType: string; remarks: string | null;
      pairedCaseId: string | null; versionAfter: number; actorName: string;
    }>;
  return events.map(e => {
    // An event mentioning a *third* case needs access to that case too.
    const other = e.pairedCaseId ? getCase(e.pairedCaseId) : null;
    return {
      id: e.id, at: e.at, actionType: e.actionType,
      actorName: e.actorName, versionAfter: e.versionAfter,
      remarks: e.pairedCaseId && (!other || !canViewContent(user, other)) ? null : e.remarks,
    };
  });
}
function attachments(c: CaseRecord) {
  return db.prepare(`SELECT id, original_name AS originalName, mime, size,
    uploaded_at AS uploadedAt FROM attachments WHERE case_id = ? AND state = 'ready'
    ORDER BY uploaded_at DESC`).all(c.id);
}
function reviewEvents(handoffId: string) {
  return db.prepare(`SELECT e.id, e.action, e.reason, e.at, u.display_name AS actorName,
    e.from_state AS fromState, e.to_state AS toState, e.version_after AS versionAfter
    FROM m3_review_events e JOIN users u ON u.id = e.actor_id
    WHERE e.handoff_id = ? ORDER BY e.at, e.rowid`).all(handoffId);
}
function detail(user: SessionUser, id: string) {
  const { handoff: h, a, b } = loadHandoff(user, id);
  let reasons: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(h.reasons_json);
    if (Array.isArray(parsed)) reasons = parsed;
  } catch { /* Historical malformed evidence is treated as unavailable, not invented. */ }
  return {
    id: h.id, suggestionId: h.suggestion_id, ruleVersion: h.rule_version,
    suggestionState: h.suggestion_state, sentAt: h.sent_at, handoffReason: h.reason,
    review: currentReview(h.id) ?? { id: null, state: 'pending', version: 0, note: null, accepted_at: null },
    comparison: { reasons, method: 'Deterministic rule signals; not AI confidence or probability.' },
    caseA: { ...caseSummary(a), attachments: attachments(a), history: timeline(user, a) },
    caseB: { ...caseSummary(b), attachments: attachments(b), history: timeline(user, b) },
    auditEvents: reviewEvents(h.id),
  };
}

/**
 * A request for evidence is delivered to active owning bureau leads through
 * CaseLink's existing protected notification inbox. Each notice refers to
 * only one authorized case; never copy the pair or supervisor's cross-case note.
 */
function notifyEvidenceRequest(handoffId: string, cases: CaseRecord[], version: number, at: string): number {
  let sent=0;
  for (const c of cases) {
    const leads=db.prepare(
      "SELECT id FROM users WHERE role='bureau_lead' AND active=1 AND bureau=? "+
      "AND (region IS NULL OR region=?)"
    ).all(c.bureau,c.institution_region) as Array<{id:string}>;
    for (const recipient of leads) {
      const result=db.prepare(
        'INSERT OR IGNORE INTO notifications '+
        '(id,user_id,kind,entity_type,entity_id,dedupe_key,title,body,detail_json,created_at) '+
        'VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(
        uid(),recipient.id,'Supervisor evidence request','case',c.id,
        'm3-evidence:'+handoffId+':'+version+':'+c.id+':'+recipient.id,
        'Additional evidence requested for '+c.case_number,
        'A supervisor requested additional supporting evidence for this case. Review the record and upload any new supporting documents in its existing case workspace.',
        JSON.stringify({caseNumber:c.case_number,category:c.category,bureau:c.bureau}),
        at
      );
      sent+=result.changes;
    }
  }
  return sent;
}

export function registerM3Routes(app: Express): void {
  app.get('/api/m3/reviews', requireAuth, handle((req, res) => {
    const user = supervisor(req);
    const handoffs = db.prepare(handoffSql +
      ' WHERE h.supervisor_id = ? ORDER BY h.sent_at DESC LIMIT 300').all(user.id) as Handoff[];
    const items = handoffs.flatMap(h => {
      const a = getCase(h.case_a_id);
      const b = getCase(h.case_b_id);
      if (!a || !b || !regionAllows(user, a) || !regionAllows(user, b) ||
          !canViewContent(user, a) || !canViewContent(user, b)) return [];
      const review = currentReview(h.id);
      return [{
        id: h.id, suggestionId: h.suggestion_id, sentAt: h.sent_at,
        state: review?.state ?? 'pending', version: review?.version ?? 0,
        caseA: { id: a.id, caseNumber: a.case_number, category: a.category },
        caseB: { id: b.id, caseNumber: b.case_number, category: b.category },
      }];
    });
    res.json({ reviews: items, total: items.length, truncated: handoffs.length === 300 });
  }));

  app.get('/api/m3/reviews/:id', requireAuth, handle((req, res) => {
    const user = supervisor(req);
    res.json(detail(user, req.params.id));
  }));

  app.post('/api/m3/reviews/:id/actions', requireAuth, handle((req, res) => {
    const user = supervisor(req);
    // Check authorization before validation, preventing review-field probing.
    const { handoff: h } = loadHandoff(user, req.params.id);
    const parsed = z.object({
      action: z.enum(['accept','needs_review','request_evidence','resume']),
      reason: z.string().trim().min(10).max(1000),
      expectedVersion: z.number().int().min(0),
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError(422, 'validation_error', 'Provide an action, a reason of at least 10 characters and the review version.');
    const { action, reason, expectedVersion } = parsed.data;
    const outcome = tx(() => {
      // Recheck inside the transaction, including current case grants.
      const { handoff: latest, a, b } = loadHandoff(user, h.id);
      if (latest.suggestion_state !== 'open' && action === 'accept')
        throw new AppError(409, 'candidate_changed', 'Candidate is no longer open.');
      const prior = currentReview(h.id);
      const state = prior?.state ?? 'pending';
      const version = prior?.version ?? 0;
      if (version !== expectedVersion)
        throw new AppError(409, 'stale_review', 'Review was updated by another request. Reload before continuing.');
      if (state === 'accepted')
        throw new AppError(409, 'review_complete', 'An accepted review cannot be changed here.');
      if (action === 'resume' && !['needs_review','awaiting_evidence'].includes(state))
        throw new AppError(409, 'invalid_transition', 'Only held reviews may resume.');
      const to: ReviewState =
        action === 'accept' ? 'accepted' :
        action === 'needs_review' ? 'needs_review' :
        action === 'request_evidence' ? 'awaiting_evidence' : 'pending';
      const at = nowIso();
      const changed = prior
        ? db.prepare(`UPDATE m3_reviews SET state=?, note=?, version=version+1, updated_at=?,
            accepted_at=? WHERE id=? AND version=?`)
            .run(to,reason,at,to==='accepted'?at:null,prior.id,version).changes
        : db.prepare(`INSERT INTO m3_reviews
            (id,handoff_id,state,note,version,updated_at,accepted_at) VALUES (?,?,?,?,?,?,?)`)
            .run(uid(),h.id,to,reason,1,at,to==='accepted'?at:null).changes;
      if (changed !== 1) throw new AppError(409, 'stale_review', 'Concurrent update refused.');
      db.prepare(`INSERT INTO m3_review_events
        (id,handoff_id,actor_id,action,reason,from_state,to_state,at,version_after)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(uid(),h.id,user.id,action,reason,state,to,at,version+1);
      const notificationsSent=action==='request_evidence' ?
        notifyEvidenceRequest(h.id,[a,b],version+1,at) : 0;
      audit(user.id, 'm3_review_' + action,
        'handoff=' + h.id + ' version=' + (version+1) + ' notifications=' + notificationsSent);
      return { state: to, version: version + 1, updatedAt: at, notificationsSent };
    });
    res.json({ ...outcome, detail: detail(user, h.id) });
  }));

  // Byte access is independently permission checked; knowledge of an evidence ID is insufficient.
  app.get('/api/m3/reviews/:id/evidence/:attachmentId', requireAuth, handle((req, res) => {
    const user = supervisor(req);
    const { a, b } = loadHandoff(user, req.params.id);
    const file = db.prepare(`SELECT case_id, stored_name, original_name, mime, state
      FROM attachments WHERE id = ? AND case_id IN (?,?) AND state = 'ready'`)
      .get(req.params.attachmentId, a.id, b.id) as {
        case_id: string; stored_name: string; original_name: string; mime: string; state: string;
      } | undefined;
    if (!file) throw new AppError(404, 'not_found', 'Evidence not found.');
    if (path.basename(file.stored_name) !== file.stored_name)
      throw new AppError(500, 'invalid_storage', 'Stored evidence path is invalid.');
    const absolute = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(absolute)) throw new AppError(404, 'not_found', 'Evidence is not available.');
    const previews = new Set(['application/pdf','image/png','image/jpeg','image/webp','text/plain']);
    const contentType = previews.has(file.mime) ? file.mime : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${previews.has(file.mime)?'inline':'attachment'}; filename="${file.original_name.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    audit(user.id, 'm3_evidence_viewed', 'handoff=' + req.params.id + ' evidence=' + req.params.attachmentId);
    res.sendFile(absolute);
  }));
}
