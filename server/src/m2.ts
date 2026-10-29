/**
 * M2: read-only, access-scoped candidate discovery and supervisor handoff.
 * No relationship mutations or automatic merges are performed here.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db, uid, nowIso, audit, tx } from './db.js';
import { requireAuth, recordSecurityDenial, sessionUserById, type SessionUser } from './auth.js';
import { canViewMetadata, canViewContent, getCase, type CaseRecord } from './domain.js';
import { projectSuggestion, withCaseCache, type SuggestionRow } from './privacy.js';
import { workerState } from './worker.js';
import { RULE_VERSION_LABEL } from './rules.js';
import { AppError } from './errors.js';

type Handler = (req: Request, res: Response) => void;
const handle = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try { fn(req, res); } catch (error) { next(error); }
};

function bounds(req: Request) {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new AppError(422, 'validation_error', 'Page must be positive and page size between 1 and 50.');
  }
  return { page, pageSize };
}
function recordFor(s: SuggestionRow, cache: Map<string, CaseRecord>) {
  const a = cache.get(s.case_a_id);
  const b = cache.get(s.case_b_id);
  return a && b ? { a, b } : null;
}
function visibleRows(user: SessionUser) {
  const rows = db.prepare("SELECT * FROM suggestions WHERE state IN ('open','outdated','accepted') ORDER BY created_at DESC, id DESC")
    .all() as SuggestionRow[];
  const ids = new Set<string>();
  rows.forEach((r) => { ids.add(r.case_a_id); ids.add(r.case_b_id); });
  const cache = new Map<string, CaseRecord>();
  // SQLite's variable count may be lower than the total case count; load in bounded batches.
  const all = [...ids];
  for (let i = 0; i < all.length; i += 400) {
    const batch = all.slice(i, i + 400);
    const placeholders = batch.map(() => '?').join(',');
    const records = db.prepare('SELECT * FROM cases WHERE id IN (' + placeholders + ')').all(...batch) as CaseRecord[];
    // The shared domain loader adds institution projection columns; use it for policy decisions.
    records.forEach((c) => {
      const full = getCase(c.id);
      if (full) cache.set(c.id, full);
    });
  }
  return {
    cache,
    rows: rows.filter((r) => {
      const pair = recordFor(r, cache);
      return Boolean(pair && canViewMetadata(user, pair.a) && canViewMetadata(user, pair.b));
    }),
  };
}
function factors(row: SuggestionRow, full: boolean) {
  const reasons = JSON.parse(row.reasons_json) as { rule: string; detail: string; sourceField: string }[];
  const positive = reasons.filter((r) => r.rule !== 'different_category');
  // The existing deterministic engine stores a Jaccard wording value when its threshold is met.
  // It is NOT a probability, AI accuracy, or calibrated duplicate confidence.
  const lexical = reasons.find((r) => r.rule === 'topic_similarity')?.detail.match(/similarity (0(?:\.\d+)?|1(?:\.0+)?) \(/);
  return {
    evidenceSignals: positive.length,
    lexicalJaccard: full && lexical ? Number(lexical[1]) : null,
    semanticSimilarity: null,
    scoringNote: 'Rule-based evidence signals; lexical Jaccard is a wording overlap, not confidence.',
  };
}
function project(user: SessionUser, row: SuggestionRow, cache: Map<string, CaseRecord>) {
  const pair = recordFor(row, cache)!;
  const full = canViewContent(user, pair.a) && canViewContent(user, pair.b);
  const projected = projectSuggestion(user, row);
  const sent = db.prepare('SELECT COUNT(*) AS n FROM m2_review_handoffs WHERE suggestion_id = ?')
    .get(row.id) as { n: number };
  return { ...projected, ...factors(row, full), handoffCount: sent.n };
}
function authorizedPair(user: SessionUser, id: string) {
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as SuggestionRow | undefined;
  if (!row) throw new AppError(404, 'not_found', 'Candidate not found.');
  const a = getCase(row.case_a_id);
  const b = getCase(row.case_b_id);
  // 404 rather than disclosing whether a suggestion exists outside a caller's scope.
  if (!a || !b || !canViewMetadata(user, a) || !canViewMetadata(user, b)) {
    recordSecurityDenial(user.id, 'm2_candidate_read_denied');
    throw new AppError(404, 'not_found', 'Candidate not found.');
  }
  return { row, a, b };
}
function supervisors(a: CaseRecord, b: CaseRecord, user: SessionUser) {
  const rows = db.prepare("SELECT id, display_name AS displayName FROM users WHERE role = 'supervisor' AND active = 1 ORDER BY display_name")
    .all() as { id: string; displayName: string }[];
  return rows.filter((r) => {
    if (r.id === user.id) return false;
    // Build a complete session principal, including current grants; a partial DB row would bypass
    // the source-of-truth policy shape and can throw on grantedCaseIds.
    const supervisor = sessionUserById(r.id);
    return Boolean(supervisor && canViewMetadata(supervisor, a) && canViewMetadata(supervisor, b));
  });
}
export function registerM2Routes(app: Express) {
  app.get('/api/m2/suggestions', requireAuth, handle((req, res) => {
    const user = req.user as SessionUser;
    const { page, pageSize } = bounds(req);
    const search = String(req.query.search ?? '').trim().toLowerCase().slice(0, 100);
    const state = String(req.query.state ?? 'open');
    const category = String(req.query.category ?? '');
    const caseId = String(req.query.caseId ?? '');
    const sort = String(req.query.sort ?? 'signals');
    if (!['open','outdated','accepted','all'].includes(state) || !['signals','recent','wording'].includes(sort)) {
      throw new AppError(422, 'validation_error', 'Invalid filter or sort.');
    }
    const { rows, cache } = visibleRows(user);
    const projected = withCaseCache(cache, () => rows.map((r) => project(user, r, cache)));
    const filtered = projected.filter((s) => {
      if (state !== 'all' && s.state !== state) return false;
      if (category && s.caseA.category !== category && s.caseB.category !== category) return false;
      if (caseId && s.caseA.id !== caseId && s.caseB.id !== caseId) return false;
      if (!search) return true;
      const fields = [
        s.caseA.caseNumber, s.caseB.caseNumber,
        s.caseA.institutionName, s.caseB.institutionName,
        s.caseA.category, s.caseB.category,
        s.caseA.summary, s.caseB.summary,
      ];
      return fields.some((x) => x && String(x).toLowerCase().includes(search));
    });
    filtered.sort((a, b) =>
      sort === 'recent'
        ? b.createdAt.localeCompare(a.createdAt)
        : sort === 'wording'
          ? (b.lexicalJaccard ?? -1) - (a.lexicalJaccard ?? -1) || b.evidenceSignals - a.evidenceSignals
          : b.evidenceSignals - a.evidenceSignals || (b.lexicalJaccard ?? -1) - (a.lexicalJaccard ?? -1) ||
              b.createdAt.localeCompare(a.createdAt)
    );
    const total = filtered.length;
    const pages = Math.ceil(total / pageSize);
    res.json({
      rows: filtered.slice((page - 1) * pageSize, page * pageSize),
      page, pageSize, pages, total,
      counts: {
        visibleCandidates: rows.length,
        awaitingReview: rows.filter((s) => s.state === 'open').length,
        sentForReview: projected.filter((s) => s.handoffCount > 0).length,
      },
      matchingMode: workerState.matchingMode,
      ruleVersion: RULE_VERSION_LABEL,
      categoryOptions: [...new Set(projected.flatMap((s) => [s.caseA.category, s.caseB.category]))].sort(),
    });
  }));
  app.get('/api/m2/suggestions/:id', requireAuth, handle((req, res) => {
    const user = req.user as SessionUser;
    const { row, a, b } = authorizedPair(user, req.params.id);
    const cache = new Map([[a.id, a], [b.id, b]]);
    res.json({
      candidate: withCaseCache(cache, () => project(user, row, cache)),
      supervisors: canViewContent(user, a) && canViewContent(user, b) && row.state === 'open'
        ? supervisors(a, b, user) : [],
    });
  }));
  app.post('/api/m2/suggestions/:id/handoff', requireAuth, handle((req, res) => {
    const user = req.user as SessionUser;
    const body = z.object({
      supervisorId: z.string().uuid(),
      reason: z.string().trim().min(10).max(800),
      caseAVersion: z.number().int().positive(),
      caseBVersion: z.number().int().positive(),
    }).safeParse(req.body);
    if (!body.success) throw new AppError(422, 'validation_error', 'Provide a valid supervisor, reason and both case versions.');
    const { row, a, b } = authorizedPair(user, req.params.id);
    if (!['bureau_officer','bureau_lead','supervisor'].includes(user.role) ||
        !canViewContent(user, a) || !canViewContent(user, b)) {
      recordSecurityDenial(user.id, 'm2_handoff_denied');
      throw new AppError(403, 'access_denied', 'Content access to both cases and an officer role are required.');
    }
    if (row.state !== 'open') throw new AppError(409, 'stale_candidate', 'Only open candidates can be submitted.');
    if (a.version !== body.data.caseAVersion || b.version !== body.data.caseBVersion) {
      throw new AppError(409, 'stale_version', 'One of the cases has changed. Reopen the comparison before submitting.');
    }
    if (!supervisors(a, b, user).some((s) => s.id === body.data.supervisorId)) {
      recordSecurityDenial(user.id, 'm2_handoff_supervisor_denied');
      throw new AppError(403, 'access_denied', 'That supervisor does not have the required regional visibility.');
    }
    const result = tx(() => {
      const previous = db.prepare('SELECT id FROM m2_review_handoffs WHERE suggestion_id = ? AND supervisor_id = ?')
        .get(row.id, body.data.supervisorId) as { id: string } | undefined;
      if (previous) throw new AppError(409, 'already_sent', 'This candidate has already been sent to that supervisor.');
      const id = uid();
      const at = nowIso();
      db.prepare('INSERT INTO m2_review_handoffs (id, suggestion_id, sent_by, supervisor_id, reason, sent_at) VALUES (?,?,?,?,?,?)')
        .run(id, row.id, user.id, body.data.supervisorId, body.data.reason, at);
      db.prepare('INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, dedupe_key, title, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uid(), body.data.supervisorId, 'm2_handoff', 'suggestion', row.id, 'm2-handoff:' + id,
          'Overlap candidate sent for review',
          'An officer requested review of a possible complaint relationship. Case-content access is checked separately.', at);
      audit(user.id, 'm2_handoff_sent', 'suggestion=' + row.id + ' supervisor=' + body.data.supervisorId);
      return { handoffId: id, sentAt: at, state: 'sent_for_review' };
    });
    res.status(201).json(result);
  }));
}
