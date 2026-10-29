import { notifyLocalWrite, setRefreshSession } from './refresh';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TOKEN_KEY = 'caselink.token';

/**
 * Session token kept in memory, mirrored to localStorage where it is available. The API accepts it as a
 * Bearer token, so authentication survives preview frames and browser settings that block cookies.
 */
let authToken: string | null = (() => {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

// A page that reloads with a stored token is already signed in: tell the refresh scheduler, otherwise
// a reload would leave the shared 10-second cycle idle until the next sign-in.
setRefreshSession(Boolean(authToken));

/**
 * Broadcast channel for an expired or revoked session (M7/A19).
 *
 * A 401 is not "one request failed" — it means the browser may still be holding records that this
 * session is no longer allowed to read. The API client clears the token and announces the expiry; the
 * application unmounts every protected screen and returns to the sign-in form. Screens must not keep
 * cached case data when this fires.
 */
export const SESSION_EXPIRED_EVENT = 'caselink:session-expired';

function announceSessionExpired(): void {
  try {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  } catch {
    /* no window (tests): the caller still throws */
  }
}

export function setAuthToken(token: string | null): void {
  authToken = token;
  setRefreshSession(Boolean(token));
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: memory-only session */
  }
}

export function hasAuthToken(): boolean {
  return Boolean(authToken);
}

function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener('abort', cancel);
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try { res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    signal: controller.signal,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? JSON_HEADERS : {}),
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  }); } catch (error) {
    if (init?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    throw new ApiError(0, controller.signal.aborted ? 'request_timeout' : 'network_unavailable', controller.signal.aborted ? 'The server took too long to respond. Your unsaved input is still here. Please retry.' : 'Cannot connect to the server. Check the connection and retry; your unsaved input has been preserved.');
  } finally { clearTimeout(timeout); init?.signal?.removeEventListener('abort', cancel); }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let payload: unknown = null;
  let validJson = true;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    validJson = false;
    payload = { message: 'The server returned an unexpected response. Please retry.' };
  }
  if (res.ok && (!validJson || payload === null || typeof payload !== 'object')) throw new ApiError(502, 'invalid_response', 'The server returned an unexpected response. Please retry.');
  if (res.ok && init?.method && init.method !== 'GET') {
    // A successful write from this browser session refreshes every subscribed screen immediately (M6);
    // the notification result is deferred so the caller's own state update lands first.
    setTimeout(notifyLocalWrite, 0);
  }
  if (!res.ok) {
    const p = payload as { error?: string; message?: string; fields?: Record<string, string> };
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      const hadSession = authToken !== null;
      setAuthToken(null);
      if (hadSession) announceSessionExpired();
    }
    throw new ApiError(res.status, p?.error ?? 'error', p?.message ?? `Request failed (${res.status})`, p?.fields);
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export interface SessionInfo {
  authenticated: boolean;
  demoMode?: boolean;
  user?: { id: string; username: string; displayName: string; role: string; bureau: string | null; region: string | null };
  capabilities?: string[];
  demoAccounts?: { username: string; displayName: string; role: string; bureau: string | null; password: string }[];
  timezone?: string;
  ruleVersion?: string;
}

export interface CaseRow {
  id: string;
  caseNumber: string;
  institutionId: string | null;
  institutionName: string | null;
  institutionPermanentId: string | null;
  region: string | null;
  intakeInstitutionText?: string | null;
  triageState?: string;
  category: string;
  bureau: string;
  status: string;
  ownerRole: string;
  ownerName: string | null;
  assignedOfficerId?: string | null;
  assignedOfficerName?: string | null;
  receivedAt: string;
  lastActionAt: string | null;
  nextActionDueAt: string | null;
  expectedDisposalAt: string | null;
  escalationOpen: boolean;
  version: number;
  access: 'full' | 'restricted';
  redactedFields?: string[];
  complaintSummary?: string;
  nextAction?: string | null;
  sourceReference?: string | null;
  sourceChannel?: string;
  complainantContact?: string | null;
  responseDueAt?: string | null;
  responseFromRole?: string | null;
  disposedAt?: string | null;
  reopenedAt?: string | null;
  deadlineState: string;
  ageDays: number;
  processingDays: number | null;
  priority: { score: number; band: string; reasons: string[] };
  pendingTransfer: { id: string; toBureau: string; requestedAt: string } | null;
  createdAt?: string;
  updatedAt?: string;
  escalationReason?: string | null;
  escalationOpenedAt?: string | null;
  /** Structured disposition outcome + decision reference (present when content is visible). */
  outcome?: string | null;
  decisionReference?: string | null;
  /** Restricted view: whether a decision exists, never its text. */
  outcomeRecorded?: boolean;
  sourceSystem?: string | null;
  permissions: Record<string, boolean>;
}

export interface DispositionRecord {
  id: string;
  at: string;
  outcome: string;
  decisionReference: string | null;
  note: string | null;
  actorName: string;
  versionAfter: number;
  reopenedAt: string | null;
  structured: boolean;
  withheld: boolean;
}

export interface HistoryEvent {
  id: string;
  at: string;
  actionType: string;
  actorName: string;
  actorRole: string;
  actorBureau: string | null;
  versionAfter: number;
  remarks: string | null;
  nextStep: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface Suggestion {
  id: string;
  kind: string;
  state: string;
  ruleVersion: string;
  evidenceHash: string | null;
  createdAt: string;
  decisionReason: string | null;
  reasons: { rule: string; detail: string; sourceField: string }[];
  reasonsRedacted: boolean;
  caseA: { id: string; caseNumber: string | null; category: string; bureau: string; status: string; access: string; summary: string | null; version: number };
  caseB: { id: string; caseNumber: string | null; category: string; bureau: string; status: string; access: string; summary: string | null; version: number };
  canDecide: boolean;
  /** True when at least one case in the pair is outside the caller's content scope. */
  requiresContentAccess: boolean;
}

export interface CaseDetail {
  case: CaseRow;
  history: HistoryEvent[];
  relationships: {
    id: string;
    type: string;
    state: string;
    reason: string;
    reviewerName: string | null;
    decidedAt: string;
    revokedReason: string | null;
    contentVisible: boolean;
    canRevoke: boolean;
    case: CaseRow;
  }[];
  suggestions: Suggestion[];
  // Scoped projection (M7/A01): the reason and decision note are null/[restricted] for a reader without
  // content access, and `contentVisible` says which of the two this is.
  transfers: {
    id: string;
    caseId: string;
    fromBureau: string;
    toBureau: string;
    state: string;
    requestedAt: string;
    requestedByName: string | null;
    decidedAt: string | null;
    decidedByName: string | null;
    reason: string | null;
    decisionNote: string | null;
    contentVisible: boolean;
  }[];
  attachments: { id: string; originalName: string; mime: string; size: number; sha256: string; uploadedAt: string; uploadedBy: string }[];
  grants: { id: string; userId: string; userName: string; role: string; grantedAt: string; note: string; revokedAt: string | null; grantedByName: string }[];
  options: {
    officers: { id: string; displayName: string }[];
    supervisors: { id: string; displayName: string }[];
    outcomes: string[];
  };
  nextStates: string[];
  dispositions: DispositionRecord[];
  canViewContent: boolean;
}


export type M2Candidate = Suggestion & {
  caseA: Suggestion['caseA'] & { institutionName: string; institutionPermanentId: string };
  caseB: Suggestion['caseB'] & { institutionName: string; institutionPermanentId: string };
  evidenceSignals: number;
  lexicalJaccard: number | null;
  semanticSimilarity: null;
  scoringNote: string;
  handoffCount: number;
};
export interface M2Queue {
  rows: M2Candidate[];
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  counts: { visibleCandidates: number; awaitingReview: number; sentForReview: number };
  matchingMode: string;
  ruleVersion: string;
  categoryOptions: string[];
}
export interface M2Detail {
  candidate: M2Candidate;
  supervisors: { id: string; displayName: string }[];
}

export interface CoordinationAlert {
  id: string;
  state: string;
  institution: { id: string; name: string; permanentId: string; region: string };
  bureaus: string[];
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  cases: CaseRow[];
  visibleCaseIds: string[];
  hiddenCaseCount: number;
  suggestions: Suggestion[];
  relationships: {
    id: string;
    type: string;
    state: string;
    reason: string;
    decidedAt: string | null;
    reviewerName: string | null;
    revokedReason: string | null;
    revokedAt?: string | null;
    canRevoke?: boolean;
    contentVisible?: boolean;
    ruleVersion?: string | null;
    caseA: { id: string; caseNumber?: string | null; bureau?: string; access: string; version?: number };
    caseB: { id: string; caseNumber?: string | null; bureau?: string; access: string; version?: number };
  }[];
  matchingMode: string;
}

export async function downloadFile(url: string, filename: string): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { credentials: 'include', headers: authHeaders() }); }
  catch { throw new ApiError(0, 'network_unavailable', 'The file could not be prepared because the server is unavailable. Retry when the connection is restored.'); }
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'The file could not be prepared. Please retry; your current filters have been preserved.');
  if (/text\/html|application\/json/.test(res.headers.get('Content-Type') ?? '')) throw new ApiError(502, 'invalid_response', 'The server returned an unexpected file response. Please retry.');
  const blob = await res.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  const objectUrl = link.href;
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export const api = {
  search: (query: string, signal?: AbortSignal) => request<{ results: { id: string; kind: string; title: string; detail: string; url: string; at?: string }[]; more: boolean; snapshotAt: string }>(`/search?q=${encodeURIComponent(query)}`, { signal }),
  session: () => get<SessionInfo>('/session'),
  login: async (username: string, password: string) => {
    const res = await post<{ user: SessionInfo['user']; capabilities: string[]; token?: string }>('/auth/login', {
      username,
      password,
    });
    if (res.token) setAuthToken(res.token);
    return res;
  },
  demoLogin: async (username: string) => {
    const res = await post<{ user: SessionInfo['user']; capabilities: string[]; token?: string }>('/auth/demo-login', {
      username,
    });
    if (res.token) setAuthToken(res.token);
    return res;
  },
  logout: async () => {
    const res = await post<{ ok: true }>('/auth/logout');
    setAuthToken(null);
    return res;
  },
  meta: () =>
    get<{
      categories: string[];
      channels: string[];
      statuses: string[];
      activeStatuses: string[];
      policies: { id: string; name: string; version: string; calendar_days: number; basis: string; note: string }[];
      bureaus: { code: string; name: string; description: string }[];
      regions: string[];
      ruleVersion: string;
    }>('/meta'),
  myWork: () => get<any>('/my-work'),
  institutions: (q = '') => get<{ institutions: any[]; total: number }>(`/institutions${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  institution: (id: string) => get<any>(`/institutions/${id}`),
  resolveInstitution: (name: string) => get<{ suggestions: any[]; note: string }>(`/institutions/resolve?name=${encodeURIComponent(name)}`),
  addAlias: (id: string, alias: string, source: string) => post<{ id: string }>(`/institutions/${id}/aliases`, { alias, source }),
  cases: (query: string) => get<any>(`/cases${query ? `?${query}` : ''}`),
  caseDetail: (id: string) => get<CaseDetail>(`/cases/${id}`),
  createCase: (body: Record<string, unknown>, idempotencyKey?: string) =>
    request<CaseRow>('/cases', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  updateCase: (id: string, body: Record<string, unknown>) => patch<CaseRow>(`/cases/${id}`, body),
  addAction: (id: string, body: Record<string, unknown>) => post<{ case: CaseRow; history: HistoryEvent[] }>(`/cases/${id}/actions`, body),
  assign: (id: string, version: number, officerId: string | null, reason: string) =>
    post<CaseRow>(`/cases/${id}/assign`, { version, officerId, reason }),
  // Every mutation sends the record version the officer was looking at, so a stale screen is refused
  // with 409 instead of silently overwriting somebody else's change.
  requestTransfer: (id: string, version: number, toBureau: string, reason: string, idempotencyKey: string) =>
    post<{ transferId: string; case: CaseRow }>(`/cases/${id}/transfer`, { version, toBureau, reason, idempotencyKey }),
  decideTransfer: (
    transferId: string,
    version: number,
    decision: 'accept' | 'reject',
    note: string,
    officerId?: string | null
  ) => post<any>(`/transfers/${transferId}/decision`, { version, decision, note, officerId }),
  escalate: (id: string, version: number, reason: string, supervisorId: string) =>
    post<CaseRow>(`/cases/${id}/escalate`, { version, reason, supervisorId }),
  closeEscalation: (id: string, version: number, note: string) =>
    post<CaseRow>(`/cases/${id}/escalation/close`, { version, note }),
  reopen: (id: string, version: number, reason: string) => post<CaseRow>(`/cases/${id}/reopen`, { version, reason }),
  changeDeadline: (id: string, version: number, expectedDisposalAt: string | null, reason: string) =>
    post<CaseRow>(`/cases/${id}/deadline`, { version, expectedDisposalAt, reason }),
  resolveTriage: (id: string, version: number, institutionId: string, reason: string) =>
    post<CaseRow>(`/cases/${id}/triage`, { version, institutionId, reason }),
  grants: (id: string, version: number, userId: string, note: string, revoke = false) =>
    post<any>(`/cases/${id}/grants`, { version, userId, note, revoke }),
  upload: (id: string, version: number, file: File) => {
    const form = new FormData();
    form.append('version', String(version));
    form.append('file', file);
    return request<{ id: string; mime: string; size: number; sha256: string }>(`/cases/${id}/attachments`, { method: 'POST', body: form });
  },
  deleteAttachment: (id: string, version: number, attachmentId: string) =>
    request<{ ok: true; fileDeleted: boolean; stillReferenced: number }>(
      `/cases/${id}/attachments/${attachmentId}?version=${version}`,
      { method: 'DELETE' }
    ),
  attachmentUrl: (caseId: string, attachmentId: string) => `/api/cases/${caseId}/attachments/${attachmentId}`,
  downloadAttachment: (caseId: string, attachmentId: string, filename: string) =>
    downloadFile(`/api/cases/${caseId}/attachments/${attachmentId}`, filename),
  m2Queue: (query: URLSearchParams) => get<M2Queue>('/m2/suggestions?' + query.toString()),
  m2Detail: (id: string) => get<M2Detail>('/m2/suggestions/' + encodeURIComponent(id)),
  m2Handoff: (id: string, supervisorId: string, reason: string, caseAVersion: number, caseBVersion: number) =>
    post<{ handoffId: string; sentAt: string; state: string }>('/m2/suggestions/' + encodeURIComponent(id) + '/handoff',
      { supervisorId, reason, caseAVersion, caseBVersion }),
  coordination: () => get<{ overlaps: CoordinationAlert[]; matchingMode: string; ruleVersion: string }>('/coordination'),
  acknowledgeAlert: (id: string) => post<{ ok: true }>(`/alerts/${id}/acknowledge`),
  decideSuggestion: (id: string, decision: string, reason: string, caseAVersion?: number, caseBVersion?: number) =>
    post<any>(`/suggestions/${id}/decision`, { decision, reason, caseAVersion, caseBVersion }),
  relationships: () => get<{ relationships: any[] }>('/relationships'),
  revokeRelationship: (id: string, reason: string, caseAVersion?: number, caseBVersion?: number) =>
    post<{ ok: true }>(`/relationships/${id}/revoke`, { reason, caseAVersion, caseBVersion }),
  notifications: () => get<any>('/notifications'),
  markRead: (id: string) => post<{ ok: true }>(`/notifications/${id}/read`),
  acknowledge: (id: string) => post<{ ok: true }>(`/notifications/${id}/acknowledge`),
  reportSummary: (query: string) => get<any>(`/reports/summary${query ? `?${query}` : ''}`),
  exportUrl: (query: string) => `/api/reports/export${query ? `?${query}` : ''}`,
  importPreview: (sourceSystem: string, csvText: string) => post<any>('/import/preview', { sourceSystem, csvText }),
  importCommit: (batchId: string) => post<any>(`/import/${batchId}/commit`),
  templateUrl: () => '/api/import/template',
  systemStatus: () => get<any>('/system/status'),
  workerTick: () => post<any>('/system/worker/tick'),
  matchingMode: (mode: 'rule-based' | 'unavailable') => post<any>('/system/matching-mode', { mode }),
  users: (bureau?: string) => get<{ users: any[] }>(`/users${bureau ? `?bureau=${bureau}` : ''}`),
};

export async function downloadCsv(url: string, filename: string): Promise<void> {
  return downloadFile(url, filename);
}
