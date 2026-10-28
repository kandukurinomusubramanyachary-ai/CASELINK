import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CaseRow } from '../api';
import { useApp } from '../App';
import { useSharedRefresh } from '../refresh';
import { CaseTable } from '../components/CaseTable';
import { Card, EmptyState, ErrorNote, Field, Loading, Modal, Notice, Pill, Stat, useToast } from '../ui';
import { fmtDate, fmtDateTime } from '../util';

export function InstitutionsScreen() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const res = await api.institutions(term);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q), 200);
    return () => clearTimeout(t);
  }, [q, load]);
  // M6: the directory is shared state (new cases move active/overdue counts), so it joins the cycle.
  useSharedRefresh(() => load(q));

  const items: any[] = data?.institutions ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Institutions</h1>
          <p className="page-sub">
            Canonical directory keyed on a synthetic AICTE Permanent ID. Name matching is a suggestion only; unresolved identities stay in
            triage until a reviewer confirms them.
          </p>
        </div>
      </div>

      <Card>
        <div className="toolbar">
          <Field label="Search institution name or permanent ID" htmlFor="inst-q">
            <input
              id="inst-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. Vaigai or AICTE-DEMO-1001"
              autoComplete="off"
            />
          </Field>
          <div className="spacer" />
          <span className="small muted">{items.length} institution(s) visible in your scope</span>
        </div>
      </Card>

      <ErrorNote error={error} onRetry={() => void load(q)} />

      <Card title="Directory">
        {loading && !data ? (
          <Loading label="Loading institutions…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={q ? 'No institution matches that search' : 'No institutions in your scope'}
            body={
              q
                ? 'Try a shorter term, or search by the AICTE Permanent ID. A fuzzy name match never merges records automatically.'
                : 'The directory is empty for your region. Ask a supervisor to review your scope.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Institution</th>
                  <th scope="col">Region</th>
                  <th scope="col">Visible cases</th>
                  <th scope="col">Active bureaus</th>
                  <th scope="col">Coordination signal</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <a href={`#/institutions/${i.id}`} className="cell-strong">
                        {i.name}
                      </a>
                      <span className="cell-sub mono">{i.permanentId}</span>
                    </td>
                    <td>{i.region}</td>
                    <td className="num">
                      {i.visibleCases} total · {i.activeCases} active
                    </td>
                    <td>
                      {i.bureaus.length > 1 ? (
                        <div className="row" style={{ gap: 4 }}>
                          {i.bureaus.map((b: string) => (
                            <Pill key={b} tone="indigo">
                              {b}
                            </Pill>
                          ))}
                        </div>
                      ) : i.bureaus.length === 1 ? (
                        <Pill tone="slate">{i.bureaus[0]}</Pill>
                      ) : (
                        <span className="muted small">none active</span>
                      )}
                    </td>
                    <td>
                      {i.overlapState === 'open' ? (
                        <Pill tone="amber" dot>
                          Overlap needs review
                        </Pill>
                      ) : i.overlapState === 'acknowledged' ? (
                        <Pill tone="blue" dot>
                          Acknowledged
                        </Pill>
                      ) : i.overlapState === 'closed' ? (
                        <Pill tone="slate">Closed</Pill>
                      ) : (
                        <Pill tone="slate">No cross-bureau overlap</Pill>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <a className="btn btn-sm" href={`#/institutions/${i.id}`}>
                        Open profile
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export function InstitutionDetailScreen({ id }: { id: string }) {
  const { session, go } = useApp();
  const { push } = useToast();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [aliasOpen, setAliasOpen] = useState(false);
  const canReview = ['bureau_lead', 'supervisor'].includes(session.user!.role);

  const load = useCallback(async () => {
    try {
      setData(await api.institution(id));
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);
  // M6: the profile is shared state too — a case raised by another bureau at this institution must
  // appear here without a reload, on the same ten-second cycle as the directory.
  useSharedRefresh(load);

  if (error) return <ErrorNote error={error} onRetry={() => void load()} />;
  if (!data) {
    return (
      <Card title="Institution profile">
        <Loading label="Loading institution, aliases and case history…" />
      </Card>
    );
  }

  const inst = data.institution;
  const cases: CaseRow[] = data.cases;
  const active = cases.filter((c) => ['Received', 'Assigned', 'Under review', 'Awaiting response'].includes(c.status));
  const bureaus = [...new Set(active.map((c) => c.bureau))];
  const crossBureau = bureaus.length > 1;
  const openSuggestions = data.suggestions.filter((s: any) => s.state === 'open');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">
            <a href="#/institutions">Institutions</a> / {inst.name}
          </div>
          <h1>{inst.name}</h1>
          <p className="page-sub">
            Canonical ID <span className="mono">{inst.permanentId}</span> · {inst.region} region. Internal institution UUID{' '}
            <span className="mono small">{inst.id}</span> is kept separate from the external identifier.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
          {canReview && (
            <button type="button" className="btn" onClick={() => setAliasOpen(true)}>
              Review an alias
            </button>
          )}
          {data.overlap.alertId && (
            <button type="button" className="btn btn-primary" onClick={() => go(`/coordination/${data.overlap.alertId}`)}>
              Open coordination review
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Visible cases" value={cases.length} hint={data.hiddenCaseCount ? `${data.hiddenCaseCount} outside your scope` : 'All in your scope'} tone="blue" />
        <Stat label="Active cases" value={active.length} hint="Received, Assigned, Under review, Awaiting response" tone="indigo" />
        <Stat label="Active bureaus" value={bureaus.length} hint={bureaus.join(' · ') || 'none'} tone={crossBureau ? 'amber' : 'slate'} />
        <Stat
          label="Overlap state"
          value={data.overlap.state === 'none' ? 'None' : data.overlap.state}
          hint={data.overlap.state === 'open' ? 'Cross-bureau coordination signal is open' : 'Institution-level alert'}
          tone={data.overlap.state === 'open' ? 'amber' : 'slate'}
        />
      </div>

      {crossBureau ? (
        <Notice tone="warn">
          <strong>Cross-bureau coordination signal</strong>
          {bureaus.join(' and ')} both own active cases at this institution. Different issues at the same college still need a
          coordination decision — a shared institution is never evidence of duplication by itself.
        </Notice>
      ) : (
        <Notice tone="info">
          <strong>No cross-bureau overlap right now</strong>
          An institution-level alert is created when at least two owning bureaus hold active cases here. Historical cases stay visible but do
          not independently trigger the alert.
        </Notice>
      )}

      <Card title="Case history across permitted bureaus" subtitle="Coordination metadata is shown for cases outside your content scope.">
        <CaseTable
          cases={cases}
          emptyMessage="No cases are visible at this institution for your account."
          actions={(c) => (
            <>
              <a className="btn btn-sm" href={`#/cases/${c.id}`}>
                Open
              </a>
              {data.overlap.alertId && (
                <button type="button" className="btn btn-sm" onClick={() => go(`/coordination/${data.overlap.alertId}`)}>
                  Review
                </button>
              )}
            </>
          )}
        />
      </Card>

      <div className="split">
        <Card title="Reviewed aliases" subtitle="Aliases are stored against this institution after review; fuzzy matching only suggests.">
          {data.aliases.length === 0 ? (
            <p className="muted small">No reviewed aliases yet.</p>
          ) : (
            <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.aliases.map((a: any) => (
                <li key={a.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                  <span>
                    <strong>{a.alias}</strong>
                    <span className="cell-sub">{a.source}</span>
                  </span>
                  <span className="small muted">
                    {a.reviewedBy ?? 'reviewer'} · {fmtDate(a.reviewedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Related-case suggestions" subtitle="Rule-based candidates for this institution. A reviewer decides; nothing links automatically.">
          {openSuggestions.length === 0 ? (
            <p className="muted small">No open suggestions right now. Dismissed suggestions stay suppressed until the evidence changes.</p>
          ) : (
            <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {openSuggestions.slice(0, 6).map((s: any) => (
                <li key={s.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                  <span>
                    <Pill tone={s.kind === 'Duplicate report' ? 'violet' : 'indigo'}>{s.kind}</Pill>{' '}
                    <span className="small muted">
                      {s.caseA?.caseNumber ?? s.caseA?.id?.slice(0, 4) ?? '—'} ↔ {s.caseB?.caseNumber ?? s.caseB?.id?.slice(0, 4) ?? '—'}
                    </span>
                  </span>
                  {data.overlap.alertId && (
                    <button type="button" className="btn btn-sm" onClick={() => go(`/coordination/${data.overlap.alertId}`)}>
                      Review
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {aliasOpen && (
        <AliasModal
          institutionId={inst.id}
          onClose={() => setAliasOpen(false)}
          onSaved={async () => {
            setAliasOpen(false);
            push({ tone: 'success', title: 'Alias recorded', body: 'The alias is now stored against this institution with reviewer and time.' });
            await load();
          }}
        />
      )}
    </>
  );
}

function AliasModal({ institutionId, onClose, onSaved }: { institutionId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [alias, setAlias] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Review a name variant"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || alias.trim().length < 3 || source.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.addAlias(institutionId, alias, source);
                await onSaved();
              } catch (err) {
                setError(err as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save reviewed alias'}
          </button>
        </>
      }
    >
      <p className="small muted">
        An alias is evidence for related-case suggestions, never an automatic merge. Record where the variant came from so a later reviewer
        can audit it.
      </p>
      <Field label="Alias" required>
        <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. Vaigai Tech" />
      </Field>
      <Field label="Source of the variant" required>
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. signed complaint letter, legacy register header" />
      </Field>
      <ErrorNote error={error} />
    </Modal>
  );
}
