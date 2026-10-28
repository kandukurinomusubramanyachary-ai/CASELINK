import { CATEGORIES } from './domain.js';

export const IMPORT_COLUMNS = [
  'institution_permanent_id',
  'institution_name_if_unconfirmed',
  'received_date',
  'source_system',
  'source_reference',
  'category',
  'complaint_summary',
  'assigned_officer_username',
  'policy_id',
  'complainant_contact',
] as const;

export const TEMPLATE_CSV = `${IMPORT_COLUMNS.join(',')}
AICTE-DEMO-1001,,2026-09-12,Legacy grievance register,LGR/2026/0051,Certificate / documentation,Duplicate retention certificate was not issued after six reminders.,,, 
,,2026-09-14,Legacy grievance register,LGR/2026/0064,Infrastructure,"Laboratory benches unsafe in block C, reported twice.",,, 
`;

/** Minimal RFC4180-ish parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      /* ignore */
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Normalised import identity: the source system, the owning bureau and the external reference define
 * one imported record. Case, whitespace, surrounding spaces and empty values are normalised here so the
 * preview, the commit and the unique database index all agree on what "the same record" means.
 */
export function importIdentity(sourceSystem: string, bureau: string, reference: string): string | null {
  const sys = (sourceSystem ?? '').trim().toLowerCase();
  const ref = (reference ?? '').trim().toLowerCase();
  const own = (bureau ?? '').trim();
  if (!sys || !ref || !own) return null;
  return `${sys}|${own}|${ref}`;
}

export interface ParsedImportRow {
  lineNumber: number;
  values: Record<string, string>;
  status: 'valid' | 'triage' | 'rejected' | 'duplicate' | 'conflict';
  errors: string[];
  note?: string;
  /** Normalised (source system, owning bureau, external reference) identity for this row. */
  identity?: string | null;
  /** Deadline policy resolved at preview time — part of the batch's policy snapshot. */
  policyId?: string | null;
  /** Human label for the deadline that will be applied, e.g. "No deadline configured". */
  deadlineLabel?: string;
  /** Policy version and day count the preview approved, so a later change is a disclosed conflict. */
  policyVersion?: string | null;
  policyCalendarDays?: number | null;
  /** Due time computed at preview time from those values — the value the officer reviewed. */
  expectedDisposalAt?: string | null;
}

/**
 * A calendar date that must exist: 2026-02-30 is refused, not rolled over into March.
 * Returns the instant used for intake (09:30 Asia/Kolkata on that day), or null when the value is not a
 * real date.
 */
export function parseCalendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test((value ?? '').trim())) return null;
  const [y, m, d] = value.trim().split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 9, 30));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) return null;
  return new Date(`${value.trim()}T09:30:00+05:30`);
}

/**
 * The canonical record an import row describes, used to decide whether a repeat is *unchanged* or is a
 * changed record with the same identity. Every imported field participates, so a changed institution,
 * date, assignment, policy or contact is a conflict for a human to review — never a silent overwrite and
 * never mislabelled as "unchanged" (M7/A08).
 */
export function importRecordSnapshot(row: {
  values: Record<string, string>;
  policyId?: string | null;
}): Record<string, string> {
  const v = row.values;
  return {
    institution: (v.institution_permanent_id || '').trim().toLowerCase(),
    intakeName: (v.institution_name_if_unconfirmed || '').trim().toLowerCase(),
    received: (v.received_date || '').trim(),
    category: (v.category || '').trim(),
    summary: (v.complaint_summary || '').trim(),
    officer: (v.assigned_officer_username || '').trim().toLowerCase(),
    policy: (row.policyId ?? v.policy_id ?? '').trim(),
    contact: (v.complainant_contact || '').trim().toLowerCase(),
  };
}

/** Fields that differ between the previewed row and what is already stored, in readable terms. */
export function changedImportFields(imported: Record<string, string>, stored: Record<string, string>): string[] {
  const labels: Record<string, string> = {
    institution: 'institution (permanent ID)',
    intakeName: 'unconfirmed institution name',
    received: 'received date',
    category: 'category',
    summary: 'complaint summary',
    officer: 'assigned officer',
    policy: 'deadline policy',
    contact: 'complainant contact',
  };
  return Object.keys(labels).filter((key) => (imported[key] ?? '') !== (stored[key] ?? '')).map((key) => labels[key]);
}

export function categoryList(): readonly string[] {
  return CATEGORIES;
}

/** Spreadsheet formula injection guard for CSV output. */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const dangerous = /^[=+\-@\t\r]/.test(raw);
  const escaped = raw.replace(/"/g, '""');
  const prefixed = dangerous ? `'${escaped}` : escaped;
  return /[",\n\r]/.test(prefixed) || dangerous ? `"${prefixed}"` : prefixed;
}

export function toCsv(header: string[], rows: (unknown[])[]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}
