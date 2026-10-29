import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type CaseRow, type CoordinationAlert, type Suggestion } from '../api';
import { useApp } from '../App';
import { useSharedRefresh } from '../refresh';
import { SuggestionModal } from './CaseWorkspace';
import { Card, DeadlineChip, EmptyState, ErrorNote, Loading, MaskedBadge, Notice, Pill, StatusPill, useToast } from '../ui';
import { fmtDate, fmtDateTime, relativeDays } from '../util';

export default function CoordinationScreen({ focus }: { focus?: string }) {
  const { session, refreshNotifications } = useApp();
  const { push } = useToast();
  const [data, setData] = useState<{ overlaps: CoordinationAlert[]; matchingMode: string; ruleVersion: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [active, setActive] = useState<string | null>(focus ?? null);
  const [review, setReview] = useState<Suggestion | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.coordination();
      setData(res);
      setError(null);
      setActive((current) => current ?? res.overlaps.find((a) => a.state === 'open')?.id ?? res.overlaps[0]?.id ?? null);
    } catch (err) {
      setError(err as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // M6: join the shared 10-second refresh cycle, so another officer's change appears without a reload.
  useSharedRefresh(load);

  useEffect(() => {
    if (focus) setActive(focus);
  }, [focus]);

  const overlaps = useMemo(() => {
    const items = data?.overlaps ?? [];
    return filter === 'open' ? items.filter((a) => a.state === 'open') : items;
  }, [data, filter]);

  const alert = overlaps.find((a) => a.id === active) ?? overlaps[0] ?? null;
  const nearestDeadline =
    overlaps
      .flatMap((a) => a.cases.map((c) => c.expectedDisposalAt))
      .filter((d): d is string => Boolean(d))
      .sort()[0] ?? null;

  if (error) return <ErrorNote error={error} onRetry={() => void load()} />;
  if (!data) {
    return (
      <Card title="Coordination review">
        <Loading label="Loading institution overlaps and match evidence…" rows={5} />
      </Card>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Coordination review</h1>
          <p className="page-sub">
            An institution overlap is a coordination signal, not a duplicate claim. A second, separate suggestion may indicate a related
            complaint. A reviewer with access to both records decides; nothing links or disposes automatically.
          </p>
        </div>
        <div className="page-actions">
          <div className="tabs" style={{ borderBottom: 0, marginBottom: 0 }}>
            <button type="button" className={filter === 'open' ? 'tab tab-active' : 'tab'} onClick={() => setFilter('open')}>
              Needs review
            </button>
            <button type="button" className={filter === 'all' ? 'tab tab-active' : 'tab'} onClick={() => setFilter('all')}>
              All institutions
            </button>
          </div>
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {data.matchingMode === 'unavailable' ? (
        <Notice tone="warn">
          <strong>Relationship matching is unavailable</strong>
          Institution overlap alerts keep running on the rule baseline. Cases and actions save normally while matching is paused.
        </Notice>
      ) : (
        <Notice tone="info">
          <strong>P0 rule engine {data.ruleVersion}</strong>
          Candidates need at least two independent evidence signals, one of them specific beyond the shared institution. Cross-institution
          duplicate candidates are blocked until an identity error is resolved.
        </Notice>
      )}

      <div className="split-wide" style={{ marginTop: 14 }}>
        <Card
          title={`Institution overlaps (${overlaps.length})`}
          subtitle="One alert per institution with at least two owning bureaus holding active cases."
        >
          {overlaps.length === 0 ? (
            <EmptyState
              title="No cross-bureau overlap needs review"
              body="An alert appears when at least two bureaus hold active cases at the same canonical institution. Disposed and closed cases stay visible in history but do not trigger it."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Institution</th>
                    <th>Bureaus</th>
                    <th>Cases</th>
                    <th>State</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {overlaps.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => setActive(a.id)}
                      style={{ cursor: 'pointer', background: a.id === alert?.id ? 'var(--accent-soft)' : undefined }}
                    >
                      <td>
                        <span className="cell-strong">{a.institution.name}</span>
                        <span className="cell-sub mono">{a.institution.permanentId}</span>
                      </td>
                      <td>
                        <span className="row" style={{ gap: 4 }}>
                          {a.bureaus.map((b) => (
                            <Pill key={b} tone="indigo">
                              {b}
                            </Pill>
                          ))}
                        </span>
                      </td>
                      <td className="num">{a.cases.length}</td>
                      <td>
                        <Pill tone={a.state === 'open' ? 'amber' : a.state === 'acknowledged' ? 'blue' : 'slate'} dot>
                          {a.state}
                        </Pill>
                      </td>
                      <td className="small muted">{fmtDateTime(a.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {alert ? (
          <div className="stack" style={{ gap: 14 }}>
            <Card
              title={alert.institution.name}
              subtitle={`${alert.institution.permanentId} · ${alert.institution.region} region · overlapping bureaus ${alert.bureaus.join(' + ')}`}
              actions={
                <>
                  <Pill tone={alert.state === 'open' ? 'amber' : 'blue'} dot>
                    {alert.state}
                  </Pill>
                  {alert.state === 'open' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        try {
                          await api.acknowledgeAlert(alert.id);
                          push({ tone: 'info', title: 'Overlap acknowledged', body: 'Acknowledgement records awareness, not resolution.' });
                          await load();
                          await refreshNotifications();
                        } catch (err) {
                          push({ tone: 'error', title: 'Could not acknowledge', body: (err as Error).message });
                        }
                      }}
                    >
                      Acknowledge
                    </button>
                  )}
                </>
              }
            >
              {alert.hiddenCaseCount > 0 && (
                <Notice tone="warn">
                  <strong>Minimum coordination signal</strong>
                  {alert.hiddenCaseCount} linked case(s) are outside your scope and are not listed here. Only permitted cases appear; private
                  complaint text is never exposed through an overlap explanation.
                </Notice>
              )}
              <ul className="coord-case-list">
                {alert.cases.map((c: CaseRow) => (
                  <li key={c.id}>
                    <div className="row-between">
                      <a className="case-number" href={`#/cases/${c.id}`}>
                        {c.caseNumber}
                      </a>
                      <span className="row" style={{ gap: 6 }}>
                        <Pill tone="indigo">{c.bureau}</Pill>
                        <StatusPill status={c.status} />
                        {c.access === 'restricted' && <MaskedBadge />}
                      </span>
                    </div>
                    <div className="coord-meta">
                      <span>{c.category}</span>
                      <span>Owner: {c.access === 'restricted' ? c.ownerRole : c.assignedOfficerName ?? 'Unassigned queue'}</span>
                      <span>
                        Deadline: <DeadlineChip state={c.deadlineState} />
                        {c.expectedDisposalAt ? ` ${fmtDate(c.expectedDisposalAt)}` : ''}
                      </span>
                      <span>Last action: {c.lastActionAt ? fmtDateTime(c.lastActionAt) : 'none recorded'}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="small muted">
                Coordination view fields only: institution, case reference, category, bureau, status, owner role and last action time.
                Complaint text, contact details and attachments stay restricted until a case grant permits access.
              </p>
            </Card>

            <Card
              title={`Candidate relationships (${alert.suggestions.length})`}
              subtitle="Each card lists its factual reasons and source fields. A suggestion is a ranking candidate, not proof of duplication or wrongdoing."
            >
              {alert.suggestions.length === 0 ? (
                <EmptyState
                  title="No related-case candidate right now"
                  body="The institution alert still stands: different issues at the same college still need a coordination decision."
                />
              ) : (
                <div className="stack">
                  {alert.suggestions.map((s) => (
                    <div key={s.id} className="evidence-card">
                      <div className="row-between">
                        <div className="row" style={{ gap: 6 }}>
                          <Pill tone={s.kind === 'Duplicate report' ? 'violet' : 'indigo'}>{s.kind}</Pill>
                          <Pill tone={s.state === 'open' ? 'amber' : s.state === 'accepted' ? 'green' : 'slate'}>{s.state}</Pill>
                          <span className="small muted">
                            {s.caseA.bureau} {s.caseA.caseNumber} ↔ {s.caseB.bureau} {s.caseB.caseNumber}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => setReview(s)}
                          disabled={s.state === 'accepted'}
                        >
                          {s.state === 'accepted' ? 'Decided' : 'Review'}
                        </button>
                      </div>
                      <ul className="reason-list" style={{ marginTop: 8 }}>
                        {s.reasons.map((r) => (
                          <li key={`${s.id}-${r.rule}`}>
                            <span className="rule-tag">{r.rule}</span>
                            <span className="small">{r.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="side-by-side" style={{ marginTop: 10 }}>
                        {[s.caseA, s.caseB].map((c) => (
                          <div key={c.id} className="compare-col">
                            <h4>
                              {c.bureau} · {c.caseNumber}
                            </h4>
                            <div className="small">
                              {c.category} · <StatusPill status={c.status} />
                            </div>
                            {c.summary ? (
                              <p className="small" style={{ marginTop: 6 }}>
                                {c.summary}
                              </p>
                            ) : (
                              <p className="small muted" style={{ marginTop: 6 }}>
                                Summary restricted — request a coordination grant to read it.
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                      {s.reasonsRedacted && (
                        <p className="small muted" style={{ marginTop: 8 }}>
                          Matching reasons are summarised here: the underlying reference values and wording stay restricted until you
                          have content access to both cases.
                        </p>
                      )}
                      {!s.canDecide && (
                        <p className="small muted" style={{ marginTop: 8 }}>
                          {s.requiresContentAccess
                            ? 'A decision needs current content access to both records. Request coordination access from the owning bureau lead or a supervisor.'
                            : 'This pair spans bureaus. A supervisor with access to both records records the decision.'}
                        </p>
                      )}
                      {s.decisionReason && (
                        <p className="small muted" style={{ marginTop: 8 }}>
                          Earlier decision: {s.decisionReason}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title={`Recorded relationships (${alert.relationships.length})`}>
              {alert.relationships.length === 0 ? (
                <p className="small muted">No reviewed relationship at this institution yet.</p>
              ) : (
                <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {alert.relationships.map((r) => (
                    <li key={r.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <Pill tone={r.type === 'Duplicate report' ? 'violet' : 'indigo'}>{r.type}</Pill>
                        <Pill tone={r.state === 'active' ? 'green' : 'slate'}>{r.state}</Pill>
                        <span className="small muted">
                          {r.caseA?.caseNumber ?? r.caseA?.id?.slice(0, 4) ?? 'restricted'} ↔ {r.caseB?.caseNumber ?? r.caseB?.id?.slice(0, 4) ?? 'restricted'}
                          {r.reviewerName ? ` · ${r.reviewerName}` : ''} · {r.decidedAt ? fmtDateTime(r.decidedAt) : ''}
                        </span>
                      </div>
                      <p className="small" style={{ marginTop: 4 }}>
                        {r.reason}
                      </p>
                      {r.revokedReason && <p className="small muted">Revoked: {r.revokedReason}</p>}
                      {r.state === 'active' && (
                        <div className="evidence-card m1-owner-handoff" style={{ marginTop: 12 }}>
                          <div className="row-between">
                            <strong>Next step: assign officers</strong>
                            <Pill tone="blue">Human assignment</Pill>
                          </div>
                          <p className="small muted" style={{ marginTop: 6 }}>
                            The relationship has been reviewed. The original complaints are still separate records.
                            Each owning bureau lead must confirm who handles their case; approving a link never
                            automatically assigns, transfers or disposes either complaint.
                          </p>
                          <div className="stack-sm" style={{ marginTop: 10 }}>
                            {[r.caseA, r.caseB].map((c, i) => (
                              <div key={c.id} className="row-between" style={{ gap: 8 }}>
                                <span className="small">
                                  {c.access === 'hidden' || !c.caseNumber ? (
                                    <span className="muted">Linked case {i + 1}: outside your permitted view</span>
                                  ) : (
                                    <>
                                      <a className="case-number" href={`#/cases/${c.id}`}>{c.caseNumber}</a>
                                      {' · '}{c.bureau} owning bureau
                                    </>
                                  )}
                                </span>
                                {c.access !== 'hidden' && c.caseNumber &&
                                 session.user?.role === 'bureau_lead' &&
                                 session.user.bureau === c.bureau &&
                                 (session.user.region == null || session.user.region === alert.institution.region) ? (
                                  <a className="btn btn-sm m1-assign-handoff" href={`#/cases/${c.id}`}>
                                    Open to assign
                                  </a>
                                ) : (
                                  <span className="small muted">Owning bureau lead assigns</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {r.state === 'active' && r.canRevoke && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            const reason = window.prompt('Reason for revoking this link (recorded with actor and time):');
                            if (!reason || reason.trim().length < 5) return;
                            try {
                              // Both case versions are required by the server: the decision is
                              // checked against the state the reviewer was shown (M7/A07).
                              await api.revokeRelationship(r.id, reason, r.caseA?.version, r.caseB?.version);
                              push({ tone: 'success', title: 'Link revoked', body: 'Both cases remain intact with their own owners and outcomes.' });
                              await load();
                            } catch (err) {
                              push({ tone: 'error', title: 'Could not revoke', body: (err as Error).message });
                            }
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : (
          <Card title="Select an institution">
            <EmptyState title="Nothing selected" body="Choose an institution overlap on the left to inspect permitted case references and match evidence." />
          </Card>
        )}
      </div>

      {review && (
        <SuggestionModal
          suggestion={review}
          onClose={() => setReview(null)}
          onSaved={async () => {
            setReview(null);
            push({
              tone: 'success',
              title: 'Relationship decision recorded',
              body: 'Reviewer, reason, evidence snapshot and rule version saved. Ownership and deadlines are unchanged.',
            });
            await load();
          }}
        />
      )}

      <p className="small muted" style={{ marginTop: 14 }}>
        An overlap stays unresolved until an officer records a coordination decision or the active-case condition ends.
        {nearestDeadline && (
          <>
            {' '}
            Nearest configured deadline in view: {fmtDate(nearestDeadline)} ({relativeDays(nearestDeadline)}).
          </>
        )}
      </p>
    </>
  );
}
