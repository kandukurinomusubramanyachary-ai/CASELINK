const TZ = 'Asia/Kolkata';

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} IST`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** yyyy-mm-dd for <input type="date">, in the display timezone. */
export function dateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function toIsoFromInput(value: string, endOfDay = false): string | null {
  if (!value) return null;
  const suffix = endOfDay ? 'T23:59:59+05:30' : 'T10:00:00+05:30';
  const d = new Date(`${value}${suffix}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${Math.abs(diff)} days ago`;
}

export const STATUS_TONE: Record<string, string> = {
  Received: 'slate',
  Assigned: 'blue',
  'Under review': 'indigo',
  'Awaiting response': 'amber',
  Disposed: 'green',
  Closed: 'grey',
};

export const DEADLINE_LABEL: Record<string, string> = {
  no_deadline: 'No deadline configured',
  on_track: 'On track',
  approaching: 'Approaching',
  overdue: 'Overdue',
  not_applicable: 'Not applicable',
};

export function deadlineTone(state: string): string {
  return state === 'overdue' ? 'red' : state === 'approaching' ? 'amber' : state === 'no_deadline' ? 'slate' : 'green';
}

export function actionLabel(type: string): string {
  const map: Record<string, string> = {
    case_created: 'Case registered',
    case_updated: 'Case updated',
    officer_assigned: 'Officer assigned',
    officer_unassigned: 'Owner cleared',
    transfer_requested: 'Transfer requested',
    transfer_accepted: 'Transfer accepted',
    transfer_rejected: 'Transfer rejected',
    escalated: 'Escalation opened',
    escalation_closed: 'Escalation closed',
    reopened: 'Case reopened',
    deadline_changed: 'Deadline changed',
    triage_resolved: 'Institution identity resolved',
    relationship_confirmed: 'Relationship confirmed',
    relationship_revoked: 'Relationship revoked',
    relationship_dismissed: 'Marked as separate issues',
    access_granted: 'Case access granted',
    access_revoked: 'Case access revoked',
    evidence_uploaded: 'Evidence uploaded',
    status_assigned: 'Status: Assigned',
    status_under_review: 'Status: Under review',
    status_awaiting_response: 'Status: Awaiting response',
    status_disposed: 'Status: Disposed',
    status_closed: 'Status: Closed',
    status_received: 'Status: Received',
  };
  return map[type] ?? type.replace(/_/g, ' ');
}

export function roleLabel(role: string): string {
  return (
    {
      bureau_officer: 'Bureau officer',
      bureau_lead: 'Bureau lead',
      supervisor: 'Supervisor',
      reviewer: 'Read-only reviewer',
      admin: 'System administrator',
    }[role] ?? role
  );
}

export function bureauName(code: string | null | undefined): string {
  if (!code) return 'All bureaus';
  return { RB: 'Regulation Bureau', PGRC: 'Public Grievance Redressal Cell' }[code] ?? code;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function classNames(...items: (string | false | null | undefined)[]): string {
  return items.filter(Boolean).join(' ');
}

export function queryFrom(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return params.toString();
}

/*
 * The case list keeps its filters in the URL hash. Opening a single case and coming back would
 * otherwise drop them, so the last list address is remembered for the session and used by the
 * "Cases" breadcrumb and the access-denied back button.
 */
const CASES_HASH_KEY = 'caselink.casesHash';

export function rememberCasesHash(hash: string): void {
  try {
    sessionStorage.setItem(CASES_HASH_KEY, hash);
  } catch {
    /* storage can be unavailable in a locked-down frame; the breadcrumb then falls back to the list */
  }
}

export function casesBackHash(): string {
  try {
    const stored = sessionStorage.getItem(CASES_HASH_KEY);
    if (stored && stored.startsWith('/cases')) return stored;
  } catch {
    /* ignore */
  }
  return '/cases';
}
