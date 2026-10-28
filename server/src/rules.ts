import { db, nowIso, uid } from './db.js';
import {
  ACTIVE_STATUSES,
  RULE_VERSION,
  getCase,
  isActiveStatus,
  lastActionAt,
  type CaseRecord,
} from './domain.js';

export const RULE_VERSION_LABEL = RULE_VERSION;
export const APPROACHING_DAYS = 7;
/**
 * Wording-similarity threshold for the topic signal.
 *
 * Chosen by sweeping thresholds on the *tune* half of the frozen labelled set only (see
 * `npx tsx test/matching-eval.ts --sweep`): related-class recall on the tune split ran 100% at 0.25,
 * 97.5% at 0.30, 87.5% at 0.34, 67.5% at 0.42 and 50% at 0.46, with no false positives anywhere on
 * that split. 0.30 is the highest threshold that keeps almost all of the related pairs, so it is the
 * product value; the held-out families were then scored once, unchanged. This is a rule constant, not
 * a learned model: it is fitted to one synthetic set of 120 labelled pairs and carries no claim beyond
 * it. The environment override exists only so the sweep stays reproducible without editing code.
 *
 * The environment override exists only so the sweep stays reproducible without editing code.
 */
export const SIMILARITY_THRESHOLD = Number(process.env.CASELINK_MATCH_THRESHOLD ?? '0.30');

/* ------------------------------------------------------------- text rules */

const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','for','on','at','by','with','from','is','are','was','were','be','been',
  'this','that','these','those','it','its','as','has','have','had','not','no','but','if','then','than','so','we',
  'our','their','they','he','she','his','her','them','about','into','over','under','after','before','also','been',
  'college','institute','institution','university','student','students','complaint','complaints','said','has',
]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function bigrams(s: string): string[] {
  const norm = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: string[] = [];
  for (let i = 0; i < norm.length - 1; i += 1) out.push(norm.slice(i, i + 2));
  return out;
}

/** Dice coefficient, used only for "did you mean" institution suggestions (never an automatic merge). */
export function nameSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of B) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      overlap += 1;
      counts.set(g, n - 1);
    }
  }
  return (2 * overlap) / (A.length + B.length);
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/* ------------------------------------------------- institution overlap F8 */

export interface OverlapSummary {
  institutionId: string;
  caseIds: string[];
  bureaus: string[];
  alertId: string | null;
  state: 'none' | 'open' | 'acknowledged' | 'closed';
}

function activeCasesForInstitution(institutionId: string): CaseRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM cases WHERE institution_id = ? AND triage_state = 'resolved'
        AND status IN ('Received','Assigned','Under review','Awaiting response')
        ORDER BY received_at ASC`
    )
    .all(institutionId) as CaseRecord[];
  return rows;
}

/**
 * FR08 baseline: >= 2 owning bureaus with active cases at one canonical institution
 * creates/updates exactly one institution-level coordination alert.
 * Historical (Disposed/Closed) cases never independently trigger it.
 */
export function recomputeOverlap(institutionId: string): OverlapSummary {
  const cases = activeCasesForInstitution(institutionId);
  const bureaus = [...new Set(cases.map((c) => c.bureau))].sort();
  const dedupeKey = `overlap:${institutionId}`;
  const existing = db.prepare('SELECT * FROM alerts WHERE dedupe_key = ?').get(dedupeKey) as
    | { id: string; state: string; case_ids_json: string; bureaus_json: string }
    | undefined;

  if (bureaus.length >= 2) {
    const caseIds = cases.map((c) => c.id);
    if (existing) {
      db.prepare(
        `UPDATE alerts SET case_ids_json = ?, bureaus_json = ?, updated_at = ?,
                state = CASE WHEN state = 'closed' THEN 'open' ELSE state END
          WHERE id = ?`
      ).run(JSON.stringify(caseIds), JSON.stringify(bureaus), nowIso(), existing.id);
      return {
        institutionId,
        caseIds,
        bureaus,
        alertId: existing.id,
        state: existing.state as OverlapSummary['state'],
      };
    }
    const id = uid();
    db.prepare(
      `INSERT INTO alerts (id, kind, institution_id, dedupe_key, case_ids_json, bureaus_json, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'open', ?, ?)`
    ).run(id, 'Institution overlap', institutionId, dedupeKey, JSON.stringify(caseIds), JSON.stringify(bureaus), nowIso(), nowIso());
    return { institutionId, caseIds, bureaus, alertId: id, state: 'open' };
  }

  if (existing && existing.state !== 'closed') {
    db.prepare(`UPDATE alerts SET state = 'closed', updated_at = ? WHERE id = ?`).run(nowIso(), existing.id);
    return { institutionId, caseIds: cases.map((c) => c.id), bureaus, alertId: existing.id, state: 'closed' };
  }
  return { institutionId, caseIds: cases.map((c) => c.id), bureaus, alertId: existing?.id ?? null, state: existing ? 'closed' : 'none' };
}

/* ------------------------------------------------- related-case rules F9 */

export interface SuggestionCandidate {
  kind: 'Duplicate report' | 'Related issue';
  reasons: { rule: string; detail: string; sourceField: string }[];
  evidenceHash: string;
  similarity: number;
  ruleVersion: string;
}

/**
 * P0 deterministic candidate evidence. Same canonical institution is mandatory:
 * different institution IDs block a duplicate suggestion entirely (identity error must be resolved first).
 */
export function evaluatePair(a: CaseRecord, b: CaseRecord): SuggestionCandidate | null {
  if (!a.institution_id || !b.institution_id) return null;
  if (a.triage_state !== 'resolved' || b.triage_state !== 'resolved') return null;
  // A different institution ID blocks a duplicate suggestion outright: identity error must be resolved first.
  if (a.institution_id !== b.institution_id) return null;

  const reasons: SuggestionCandidate['reasons'] = [];
  const signals = new Set<string>();
  let score = 0;

  const sharedRef =
    a.source_reference && b.source_reference && a.source_reference.trim().toLowerCase() === b.source_reference.trim().toLowerCase()
      ? a.source_reference
      : null;
  if (sharedRef) {
    reasons.push({ rule: 'shared_external_reference', detail: `Both cases cite external reference "${sharedRef}".`, sourceField: 'source_reference' });
    signals.add('reference');
    score += 0.6;
  }

  const aliasRows = db
    .prepare('SELECT alias FROM institution_aliases WHERE institution_id = ?')
    .all(a.institution_id) as { alias: string }[];
  const matchedAlias = aliasRows.find(({ alias }) => {
    const needle = alias.toLowerCase();
    return a.complaint_summary.toLowerCase().includes(needle) && b.complaint_summary.toLowerCase().includes(needle);
  });
  if (matchedAlias) {
    reasons.push({
      rule: 'reviewed_institution_alias',
      detail: `Both complaints name the reviewed alias "${matchedAlias.alias}".`,
      sourceField: 'institution_alias',
    });
    signals.add('alias');
    score += 0.15;
  }

  const gap = daysBetween(a.received_at, b.received_at);
  if (gap <= 14) {
    reasons.push({
      rule: 'incident_period_overlap',
      detail: `Received ${gap.toFixed(0)} day(s) apart, inside the 14-day incident window.`,
      sourceField: 'received_at',
    });
    signals.add('period');
    score += 0.1;
  }

  const similarity = Math.round(jaccard(tokens(a.complaint_summary), tokens(b.complaint_summary)) * 100) / 100;
  if (a.category === b.category) {
    reasons.push({ rule: 'same_category', detail: `Both cases are filed under "${a.category}".`, sourceField: 'category' });
    signals.add('category');
    score += 0.15;
  } else {
    reasons.push({
      rule: 'different_category',
      detail: `Different categories ("${a.category}" vs "${b.category}") — a shared institution alone is not duplication.`,
      sourceField: 'category',
    });
  }
  if (similarity >= SIMILARITY_THRESHOLD) {
    reasons.push({
      rule: 'topic_similarity',
      detail: `Complaint wording similarity ${similarity.toFixed(2)} (rule threshold ${SIMILARITY_THRESHOLD}).`,
      sourceField: 'complaint_summary',
    });
    signals.add('topic');
    score += similarity;
  }

  // At least two independent signals, and at least one of them specific beyond the shared institution.
  const strong = signals.has('reference') || signals.has('alias') || signals.has('category') || signals.has('topic');
  if (signals.size < 2 || !strong) return null;

  const kind: SuggestionCandidate['kind'] =
    sharedRef || (a.category === b.category && similarity >= 0.34) ? 'Duplicate report' : 'Related issue';

  const evidenceHash = hashEvidence([sharedRef ?? '', matchedAlias?.alias ?? '', String(gap), String(similarity), kind, a.category, b.category]);
  return { kind, reasons, evidenceHash, similarity, ruleVersion: RULE_VERSION };
}

function hashEvidence(parts: string[]): string {
  let h = 0;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export interface SuggestionRecord {
  id: string;
  case_a_id: string;
  case_b_id: string;
  institution_id: string;
  kind: 'Duplicate report' | 'Related issue';
  reasons_json: string;
  evidence_hash: string;
  rule_version: string;
  state: 'open' | 'dismissed' | 'outdated' | 'accepted';
  dedupe_key: string;
  created_at: string;
}

/**
 * Recompute suggestions for one institution.
 * Rejected suggestions stay suppressed for identical evidence; changed evidence marks the old row
 * outdated and opens a fresh candidate instead of re-nagging on every page load.
 */
export function recomputeSuggestions(institutionId: string): { created: number; suppressed: number } {
  const cases = db
    .prepare(
      `SELECT * FROM cases WHERE institution_id = ? AND triage_state = 'resolved'
        AND status IN ('Received','Assigned','Under review','Awaiting response','Disposed','Closed')`
    )
    .all(institutionId) as CaseRecord[];

  let created = 0;
  let suppressed = 0;
  for (let i = 0; i < cases.length; i += 1) {
    for (let j = i + 1; j < cases.length; j += 1) {
      const a = cases[i];
      const b = cases[j];
      if (!isActiveStatus(a.status) && !isActiveStatus(b.status)) continue;
      const candidate = evaluatePair(a, b);
      if (!candidate) continue;
      const [first, second] = a.id < b.id ? [a, b] : [b, a];

      const decided = db
        .prepare(
          `SELECT 1 FROM relationships WHERE state = 'active' AND
             ((case_a_id = ? AND case_b_id = ?) OR (case_a_id = ? AND case_b_id = ?))`
        )
        .get(first.id, second.id, second.id, first.id);
      if (decided) continue;

      const priorRows = db
        .prepare('SELECT * FROM suggestions WHERE case_a_id = ? AND case_b_id = ? ORDER BY created_at DESC')
        .all(first.id, second.id) as SuggestionRecord[];
      if (priorRows.some((r) => r.evidence_hash === candidate.evidenceHash)) {
        suppressed += 1;
        continue;
      }
      for (const prior of priorRows) {
        if (prior.state === 'open' || prior.state === 'dismissed') {
          db.prepare(`UPDATE suggestions SET state = 'outdated' WHERE id = ?`).run(prior.id);
        }
      }
      const dedupeKey = `sugg:${first.id}:${second.id}:${candidate.kind}:${candidate.evidenceHash}`;
      const exists = db.prepare('SELECT 1 FROM suggestions WHERE dedupe_key = ?').get(dedupeKey);
      if (exists) continue;
      db.prepare(
        `INSERT INTO suggestions (id, institution_id, case_a_id, case_b_id, kind, reasons_json, evidence_hash,
           rule_version, state, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`
      ).run(
        uid(),
        institutionId,
        first.id,
        second.id,
        candidate.kind,
        JSON.stringify(candidate.reasons),
        candidate.evidenceHash,
        candidate.ruleVersion,
        dedupeKey,
        nowIso()
      );
      created += 1;
    }
  }
  return { created, suppressed };
}

/* ------------------------------------------------------ deadline handling */

export type DeadlineState = 'no_deadline' | 'on_track' | 'approaching' | 'overdue' | 'not_applicable';

export function deadlineState(c: Pick<CaseRecord, 'expected_disposal_at' | 'status'>, now = new Date()): DeadlineState {
  if (!isActiveStatus(c.status as CaseRecord['status'])) return 'not_applicable';
  if (!c.expected_disposal_at) return 'no_deadline'; // never invent an SLA
  const due = new Date(c.expected_disposal_at).getTime();
  if (due < now.getTime()) return 'overdue';
  if (due - now.getTime() <= APPROACHING_DAYS * 86_400_000) return 'approaching';
  return 'on_track';
}

export function ageDays(c: Pick<CaseRecord, 'received_at'>, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(c.received_at).getTime()) / 86_400_000));
}

export function processingDays(c: Pick<CaseRecord, 'received_at' | 'disposed_at'>, now = new Date()): number | null {
  if (!c.disposed_at) return null;
  return Math.max(0, Math.floor((new Date(c.disposed_at).getTime() - new Date(c.received_at).getTime()) / 86_400_000));
}

export function addCalendarDays(fromIso: string, days: number): string {
  return new Date(new Date(fromIso).getTime() + days * 86_400_000).toISOString();
}

/* ------------------------------------------------------------ prioritising */

export interface Priority {
  score: number;
  band: 'Critical' | 'High' | 'Normal';
  reasons: string[];
}

/** Transparent factors only: open escalation, breached deadline, approaching deadline, case age. */
export function priorityOf(c: CaseRecord, now = new Date()): Priority {
  const reasons: string[] = [];
  let score = 0;
  if (c.escalation_open === 1) {
    score += 40;
    reasons.push('Open escalation recorded');
  }
  const ds = deadlineState(c, now);
  if (ds === 'overdue') {
    score += 30;
    reasons.push('Configured disposal deadline breached');
  } else if (ds === 'approaching') {
    score += 15;
    reasons.push('Disposal deadline approaching (within 7 days)');
  }
  const age = ageDays(c, now);
  if (age >= 90 && isActiveStatus(c.status)) {
    score += 10;
    reasons.push(`Case age ${age} days`);
  }
  if (!c.assigned_officer_id && isActiveStatus(c.status)) {
    score += 5;
    reasons.push('No owning officer assigned');
  }
  return { score, band: score >= 40 ? 'Critical' : score >= 20 ? 'High' : 'Normal', reasons };
}

export function institutionCaseHistory(institutionId: string): CaseRecord[] {
  return db
    .prepare(`SELECT * FROM cases WHERE institution_id = ? ORDER BY received_at DESC`)
    .all(institutionId) as CaseRecord[];
}

/**
 * Coordination recipients for an institution overlap (Milestone 2).
 *
 * Selection follows the same regional policy the API enforces: leads of the involved bureaus and
 * supervisors are only notified when the institution sits inside their authorised region (`region`
 * null = national oversight). The previous version notified every supervisor nationally and every lead
 * of the involved bureaus regardless of region, which disclosed out-of-region case references.
 */
export function coordinatorRecipients(bureaus: string[], institutionRegion: string | null): { id: string }[] {
  if (!institutionRegion) {
    // Unresolved region: fall back to the involved bureaus' leads and national supervisors only.
    return db
      .prepare(
        `SELECT DISTINCT id FROM users WHERE active = 1 AND (
           (role = 'bureau_lead' AND bureau IN (SELECT value FROM json_each(?)))
           OR (role = 'supervisor' AND region IS NULL)
         )`
      )
      .all(JSON.stringify(bureaus)) as { id: string }[];
  }
  return db
    .prepare(
      `SELECT DISTINCT id FROM users WHERE active = 1 AND (region IS NULL OR region = ?) AND (
         (role = 'bureau_lead' AND bureau IN (SELECT value FROM json_each(?)))
         OR role = 'supervisor'
       )`
    )
    .all(institutionRegion, JSON.stringify(bureaus)) as { id: string }[];
}
