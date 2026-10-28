import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, downloadCsv, type CaseRow } from '../api';
import { useApp } from '../App';
import { useSharedRefresh } from '../refresh';
import { CaseTable } from '../components/CaseTable';
import { Card, EmptyState, ErrorNote, Field, Loading, Modal, Notice, Pill, useToast } from '../ui';
import { casesBackHash, dateInput, fmtDateTime, queryFrom, rememberCasesHash, toIsoFromInput } from '../util';
import { Icon } from '../components/Icon';

interface FilterState {
  q: string;
  bureau: string[];
  status: string[];
  category: string[];
  region: string;
  receivedFrom: string;
  receivedTo: string;
  mine: boolean;
  unassigned: boolean;
  overdue: boolean;
  pending: boolean;
  escalated: boolean;
  triage: boolean;
  sort: string;
  page: number;
  pageSize: number;
}

function fromQuery(query: URLSearchParams): FilterState {
  const list = (key: string) => (query.get(key) ? query.get(key)!.split(',') : []);
  return {
    q: query.get('q') ?? '',
    bureau: list('bureau'),
    status: list('status'),
    category: list('category'),
    region: query.get('region') ?? '',
    receivedFrom: query.get('receivedFrom') ?? '',
    receivedTo: query.get('receivedTo') ?? '',
    mine: query.get('mine') === '1',
    unassigned: query.get('unassigned') === '1',
    overdue: query.get('overdue') === '1',
    pending: query.get('pending') === '1',
    escalated: query.get('escalated') === '1',
    triage: query.get('triage') === '1',
    sort: query.get('sort') ?? 'received',
    page: Number(query.get('page') ?? 1) || 1,
    pageSize: Number(query.get('pageSize') ?? 25) || 25,
  };
}

export default function CasesScreen({ initialQuery }: { initialQuery: URLSearchParams }) {
  const { meta, session } = useApp();
  const { push } = useToast();
  const [filters, setFilters] = useState<FilterState>(() => fromQuery(initialQuery));
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(initialQuery.get('new') === '1');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The address bar is written by this screen; remember the value so an externally supplied hash can
  // be told apart from our own write (see the adoption effect below).
  const hashWrittenHere = useRef('');

  const query = useMemo(() => queryFrom(filters as unknown as Record<string, unknown>), [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.cases(query);
      setData(res);
      setError(null);
      window.history.replaceState(null, '', `#/cases${query ? `?${query}` : ''}`);
      hashWrittenHere.current = query;
      // Remember the filtered address so opening a case and returning keeps the same rows.
      rememberCasesHash(`/cases${query ? `?${query}` : ''}`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * M7 fix: the list keeps its filters in the URL, so a hash the screen did not produce itself — the
   * browser's Back/Forward buttons, a pasted filtered link, or a link from a report — must be adopted.
   * Without this the screen kept showing the previous filter's rows while the address bar claimed a
   * different query.
   */
  const incomingHash = initialQuery.toString();
  useEffect(() => {
    if (incomingHash === hashWrittenHere.current) return; // the address bar already matches what we wrote
    const fromHash = new URLSearchParams(incomingHash);
    const incoming = queryFrom(fromQuery(fromHash) as unknown as Record<string, unknown>);
    hashWrittenHere.current = incomingHash;
    setFilters((prev) => (queryFrom(prev as unknown as Record<string, unknown>) === incoming ? prev : fromQuery(fromHash)));
  }, [incomingHash]);
  // M6: join the shared 10-second refresh cycle, so another officer's change appears without a reload.
  useSharedRefresh(load);

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' || key === 'pageSize' ? (value as number) : 1 }));

  const toggleIn = (key: 'bureau' | 'status' | 'category', value: string) =>
    setFilters((prev) => {
      const list = prev[key];
      return { ...prev, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value], page: 1 };
    });

  const activeFilterChips = [
    filters.q && `search “${filters.q}”`,
    ...filters.bureau.map((b) => `bureau ${b}`),
    ...filters.status.map((s) => `status ${s}`),
    ...filters.category.map((c) => `category ${c}`),
    filters.region && `region ${filters.region}`,
    filters.receivedFrom && `from ${filters.receivedFrom}`,
    filters.receivedTo && `to ${filters.receivedTo}`,
    filters.mine && 'assigned to me',
    filters.unassigned && 'unassigned',
    filters.overdue && 'overdue',
    filters.pending && 'pending only',
    filters.escalated && 'escalated',
    filters.triage && 'triage queue',
  ].filter(Boolean) as string[];

  const rows: CaseRow[] = data?.cases ?? [];
  const canCreate = ['bureau_officer', 'bureau_lead'].includes(session.user!.role);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cases</h1>
          <p className="page-sub">
            Permission-filtered results. Filters and pagination persist in the URL so a case can be opened from a filtered report and the
            list state survives the return.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={exporting}
            aria-busy={exporting}
            onClick={async () => {
              setExporting(true);
              setError(null);
              try {
                await downloadCsv(api.exportUrl(query), `caselink-cases-${Date.now()}.csv`);
                push({ tone: 'success', title: 'Export prepared', body: 'Only permitted rows and fields are included, with snapshot time and filters.' });
              } catch (err) {
                setError(err as ApiError);
              } finally { setExporting(false); }
            }}
          >
            {exporting ? 'Preparing export…' : 'Export CSV'}
          </button>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              Register a case
            </button>
          )}
        </div>
      </div>

      <Card title="Filters" className={`case-filters${filtersExpanded ? ' filters-open' : ''}`} actions={<button type="button" className="btn btn-ghost btn-sm" aria-expanded={filtersExpanded} aria-controls="case-filter-fields" onClick={() => setFiltersExpanded(value => !value)}><Icon name="filter" size={17} />{filtersExpanded ? 'Fewer filters' : 'More filters'}{activeFilterChips.length > 0 && <span className="pill pill-slate">{activeFilterChips.length}</span>}<Icon name="chevron" size={14} /></button>}>
        <div className="toolbar">
          <Field label="Search" htmlFor="case-q" hint="Institution name, permanent ID, case number">
            <input
              id="case-q"
              value={filters.q}
              onChange={(e) => set('q', e.target.value)}
              placeholder="Search…"
              autoComplete="off"
            />
          </Field>
          <Field label="Region">
            <select value={filters.region} onChange={(e) => set('region', e.target.value)}>
              <option value="">All regions</option>
              {(meta?.regions ?? []).map((r: string) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Received from">
            <input type="date" value={filters.receivedFrom} onChange={(e) => set('receivedFrom', e.target.value)} />
          </Field>
          <Field label="Received to">
            <input type="date" value={filters.receivedTo} onChange={(e) => set('receivedTo', e.target.value)} />
          </Field>
          <Field label="Sort">
            <select value={filters.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="received">Newest first</option>
              <option value="priority">Priority</option>
              <option value="deadline">Deadline</option>
              <option value="updated">Recently updated</option>
            </select>
          </Field>
          <Field label="Rows">
            <select value={filters.pageSize} onChange={(e) => set('pageSize', Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div id="case-filter-fields" className="advanced-filters" hidden={!filtersExpanded}>
        <fieldset>
          <legend>Bureau</legend>
          <div className="row">
            {(meta?.bureaus ?? []).map((b: any) => (
              <label key={b.code} className="check">
                <input type="checkbox" checked={filters.bureau.includes(b.code)} onChange={() => toggleIn('bureau', b.code)} />
                {b.code} — {b.name}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Lifecycle status</legend>
          <div className="row">
            {(meta?.statuses ?? []).map((s: string) => (
              <label key={s} className="check">
                <input type="checkbox" checked={filters.status.includes(s)} onChange={() => toggleIn('status', s)} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Category</legend>
          <div className="row">
            {(meta?.categories ?? []).map((c: string) => (
              <label key={c} className="check">
                <input type="checkbox" checked={filters.category.includes(c)} onChange={() => toggleIn('category', c)} />
                {c}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Quick views</legend>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={filters.mine} onChange={(e) => set('mine', e.target.checked)} /> Assigned to me
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.unassigned} onChange={(e) => set('unassigned', e.target.checked)} /> Unassigned
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.overdue} onChange={(e) => set('overdue', e.target.checked)} /> Overdue (configured
              deadline)
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.pending} onChange={(e) => set('pending', e.target.checked)} /> Pending only
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.escalated} onChange={(e) => set('escalated', e.target.checked)} /> Escalated
            </label>
            <label className="check">
              <input type="checkbox" checked={filters.triage} onChange={(e) => set('triage', e.target.checked)} /> Triage queue
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setFilters(fromQuery(new URLSearchParams()))}
            >
              Clear all filters
            </button>
          </div>
        </fieldset>

        </div>
        {activeFilterChips.length > 0 && (
          <div className="filter-summary">
            <strong>Applied:</strong>
            {activeFilterChips.map((chip) => (
              <Pill key={chip} tone="blue">
                {chip}
              </Pill>
            ))}
          </div>
        )}
      </Card>

      <ErrorNote error={error} onRetry={() => void load()} />

      <Card
        title={data ? `${data.total} case(s)` : 'Cases'}
        subtitle={data ? `Snapshot ${fmtDateTime(data.snapshotAt)} · permission-filtered before counting and pagination` : undefined}
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        }
      >
        {loading && !data ? (
          <Loading label="Loading cases…" rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={activeFilterChips.length ? 'No results for these filters' : 'No cases yet'}
            body={
              activeFilterChips.length
                ? 'Filters are narrow but nothing matches. Clear a filter, or check that the case is inside your bureau, region and grants.'
                : 'Register the first case for your bureau, or import an existing register from CSV.'
            }
            action={
              <>
                {canCreate && (
                  <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                    Register a case
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setFilters(fromQuery(new URLSearchParams()))}>
                  Clear filters
                </button>
              </>
            }
          />
        ) : (
          <>
            <CaseTable cases={rows} />
            <div className="pager" style={{ marginTop: 12 }}>
              <span>
                Page {data.page} of {data.pageCount}
              </span>
              <button type="button" className="btn btn-sm" disabled={data.page <= 1} onClick={() => set('page', data.page - 1)}>
                Previous
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={data.page >= data.pageCount}
                onClick={() => set('page', data.page + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </Card>

      {createOpen && (
        <CreateCaseModal
          onClose={() => setCreateOpen(false)}
          onSaved={async (created) => {
            setCreateOpen(false);
            push({ tone: 'success', title: 'Case registered', body: `${created.caseNumber} saved with server timestamp.` });
            await load();
            window.location.hash = `#/cases/${created.id}`;
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------- create a case */

function CreateCaseModal({ onClose, onSaved }: { onClose: () => void; onSaved: (c: CaseRow) => Promise<void> }) {
  const { meta, session } = useApp();
  const user = session.user!;
  const [idemKey] = useState(() => `create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [institutionQuery, setInstitutionQuery] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [institutionId, setInstitutionId] = useState<string | null>(null);
  const [triageText, setTriageText] = useState('');
  const [receivedAt, setReceivedAt] = useState(dateInput(new Date().toISOString()));
  const [sourceChannel, setSourceChannel] = useState('Email');
  const [sourceReference, setSourceReference] = useState('');
  const [category, setCategory] = useState(meta?.categories?.[0] ?? 'Other');
  const [summary, setSummary] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [policyId, setPolicyId] = useState(meta?.policies?.[0]?.id ?? '');
  const [assignToSelf, setAssignToSelf] = useState(true);
  const [contact, setContact] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolveNote, setResolveNote] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const defaults = useRef({ receivedAt, category, policyId });
  const dirty = Boolean(institutionQuery || institutionId || triageText || sourceReference || summary || nextAction || contact || sourceChannel !== 'Email' || !assignToSelf || receivedAt !== defaults.current.receivedAt || category !== defaults.current.category || policyId !== defaults.current.policyId);
  const requestClose = () => { if (busy) return; if (dirty) setDiscardOpen(true); else onClose(); };

  useEffect(() => {
    if (institutionQuery.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await api.resolveInstitution(institutionQuery);
        setSuggestions(res.suggestions);
        setResolveNote(res.note);
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [institutionQuery]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCase(
        {
          institutionId,
          intakeInstitutionText: institutionId ? null : triageText,
          receivedAt: toIsoFromInput(receivedAt) ?? new Date().toISOString(),
          sourceChannel,
          sourceReference: sourceReference || null,
          category,
          complaintSummary: summary,
          assignedOfficerId: assignToSelf ? user.id : null,
          nextAction: nextAction || null,
          deadlinePolicyId: policyId || null,
          complainantContact: contact || null,
        },
        idemKey
      );
      await onSaved(created);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <><Modal
      title="Register a complaint case"
      onClose={requestClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={requestClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save case'}
          </button>
        </>
      }
    >
      <Notice tone="info">
        <strong>Scope</strong>
        A case is created in your own bureau ({user.bureau}) and region. Identifiers are generated on the server; a rejected save keeps your
        text so nothing is lost.
      </Notice>

      <Field label="Institution" hint="Search the confirmed directory by name or AICTE Permanent ID. A fuzzy match is a suggestion only." required>
        <input
          value={institutionQuery}
          onChange={(e) => {
            setInstitutionQuery(e.target.value);
            setInstitutionId(null);
          }}
          placeholder="Start typing an institution name or AICTE-DEMO-…"
          autoComplete="off"
        />
      </Field>

      {suggestions.length > 0 && (
        <div className="stack-sm">
          <span className="small muted">Suggestions (not automatic matches):</span>
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              className="demo-account"
              onClick={() => {
                setInstitutionId(s.id);
                setInstitutionQuery(`${s.name} — ${s.permanentId}`);
                setSuggestions([]);
              }}
            >
              <span>
                <span className="who">{s.name}</span>
                <br />
                <span className="role mono">{s.permanentId}</span>
              </span>
              <Pill tone={s.score >= 0.75 ? 'green' : 'amber'}>match {s.score}</Pill>
            </button>
          ))}
          <span className="small muted">{resolveNote}</span>
        </div>
      )}

      {institutionId ? (
        <Pill tone="green">Confirmed institution selected</Pill>
      ) : (
        <Field
          label="…or hold in triage"
          hint="If the identity cannot be confirmed, the case stays in triage and is excluded from automatic institution overlap checks until resolved."
          error={error?.fields?.institutionId}
        >
          <input value={triageText} onChange={(e) => setTriageText(e.target.value)} placeholder="Describe the unconfirmed institution" />
        </Field>
      )}

      <div className="form-grid">
        <Field label="Received date" required error={error?.fields?.receivedAt}>
          <input type="date" value={receivedAt} max={dateInput(new Date().toISOString())} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
        <Field label="Source channel" required>
          <select value={sourceChannel} onChange={(e) => setSourceChannel(e.target.value)}>
            {(meta?.channels ?? []).map((c: string) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source reference" hint="Register or letter reference when available">
          <input value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} placeholder="e.g. PGRC/2026/0455" />
        </Field>
        <Field label="Category" required>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {(meta?.categories ?? []).map((c: string) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Complaint summary" required error={error?.fields?.complaintSummary} hint="Stored and displayed as plain text. Original wording is preserved.">
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} />
        </Field>
        <Field label="Next action">
          <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="What happens next?" />
        </Field>
        <Field label="Deadline policy" hint="DEMO policy only — no official SLA is implied. Choose 'none' to track age without marking overdue.">
          <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            <option value="">No deadline configured</option>
            {(meta?.policies ?? []).map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Complainant contact (restricted, optional)">
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Synthetic contact only" />
        </Field>
        <label className="check">
          <input type="checkbox" checked={assignToSelf} onChange={(e) => setAssignToSelf(e.target.checked)} /> Assign the case to me
        </label>
      </div>

      <ErrorNote error={error} />
    </Modal>
    {discardOpen && <Modal title="Discard unsaved case?" onClose={() => setDiscardOpen(false)} footer={<><button type="button" className="btn" onClick={() => setDiscardOpen(false)}>Keep editing</button><button type="button" className="btn btn-danger" onClick={onClose}>Discard draft</button></>}><p>This case has not been saved. Discarding removes only the changes in this form; it does not delete any case history.</p></Modal>}
    </>
  );
}
