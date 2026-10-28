import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, downloadFile, type CaseDetail, type CaseRow, type Suggestion } from '../api';
import { useApp } from '../App';
import { useSharedRefresh } from '../refresh';
import { Icon } from '../components/Icon';
import { CasePrintView } from '../components/CasePrintView';
import {
  Card,
  CopyButton,
  DeadlineChip,
  EmptyState,
  ErrorNote,
  Field,
  Loading,
  MaskedBadge,
  Modal,
  Notice,
  Pill,
  PriorityChip,
  StatusPill,
  useToast,
} from '../ui';
import {
  actionLabel,
  bytes,
  casesBackHash,
  dateInput,
  fmtDate,
  fmtDateTime,
  relativeDays,
  roleLabel,
  toIsoFromInput,
} from '../util';

export default function CaseWorkspace({ id }: { id: string }) {
  const { go, session } = useApp();
  const { push } = useToast();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const focusedEvent = useRef('');

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api.caseDetail(id);
      setDetail(res);
      setFetchedAt(new Date().toISOString());
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    } finally { setRefreshing(false); }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);
  // M6: join the shared 10-second refresh cycle, so another officer's change appears without a reload.
  useSharedRefresh(load);
  useEffect(() => {
    const event = new URLSearchParams(window.location.hash.split('?')[1]).get('event');
    const key = `${id}:${event}`;
    if (!event || !detail || focusedEvent.current === key) return;
    const element = document.getElementById(`event-${event}`);
    if (element) { focusedEvent.current = key; element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'center' }); }
  }, [detail, id]);

  const onSaved = async (message: string) => {
    push({ tone: 'success', title: message, body: 'Saved with a server timestamp and an append-only history event.' });
    await load();
  };

  if (error && error.code === 'access_denied') {
    return (
      <div className="denied">
        <h2>Access denied</h2>
        <p>
          This record is outside your bureau, region and case grants, or the URL was changed by hand. Permission checks run on the server for
          every read and write, including exports and downloads.
        </p>
        <div className="empty-action">
          <button type="button" className="btn" onClick={() => go(casesBackHash())}>
            Back to cases
          </button>
        </div>
      </div>
    );
  }
  if (error && !detail) return <ErrorNote error={error} onRetry={() => void load()} />;
  if (!detail) {
    return (
      <Card title="Case workspace">
        <Loading label="Loading case, ownership, evidence and history…" rows={6} />
      </Card>
    );
  }

  const c = detail.case;
  const perms = c.permissions;
  const masked = !detail.canViewContent;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">
            <a href={`#${casesBackHash()}`}>Cases</a> / {c.caseNumber}
          </div>
          <h1 className="row" style={{ gap: 10 }}>
            <span className="case-number" style={{ fontSize: 20 }}>
              {c.caseNumber}
            </span>
            <StatusPill status={c.status} />
            <PriorityChip priority={c.priority} />
            {c.escalationOpen && <Pill tone="red">Escalation open</Pill>}
            {c.triageState === 'unresolved' && <Pill tone="amber">Triage</Pill>}
            {masked && <MaskedBadge />}
          </h1>
          <p className="page-sub">
            {c.institutionName ? (
              <a href={`#/institutions/${c.institutionId}`}>{c.institutionName}</a>
            ) : (
              <span>{c.intakeInstitutionText ?? 'Institution unresolved'}</span>
            )}{' '}
            · {c.institutionPermanentId ?? 'no permanent ID'} · {c.category} · {c.bureau} · version {c.version}
          </p>
          {fetchedAt && <p className="freshness">Last fetched {fmtDateTime(fetchedAt)} · recorded actions retain their own timestamps</p>}
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={refreshing} aria-busy={refreshing} onClick={() => void load()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn" onClick={() => window.print()}><Icon name="print" size={18} />Print evidence</button>
          <CopyButton value={c.id} label="Copy case ID" />
          {c.pendingTransfer && (
            <Pill tone="violet" title="Ownership stays with the current bureau until the target lead decides">
              Transfer to {c.pendingTransfer.toBureau} pending
            </Pill>
          )}
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="stat">
          <span className="stat-label">Current owner</span>
          <span className="stat-value" style={{ fontSize: 16 }}>
            {masked ? c.ownerRole : c.assignedOfficerName ?? 'Unassigned queue'}
          </span>
          <span className="stat-hint">{c.bureau} · {roleLabel(session.user!.role)} view</span>
        </div>
        <div className="stat">
          <span className="stat-label">Next action</span>
          <span className="stat-value" style={{ fontSize: 14 }}>
            {c.nextAction ?? (masked ? 'Restricted' : 'Not recorded')}
          </span>
          <span className="stat-hint">{c.nextActionDueAt ? `due ${fmtDate(c.nextActionDueAt)} (${relativeDays(c.nextActionDueAt)})` : 'no due date'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Disposal deadline</span>
          <span className="stat-value" style={{ fontSize: 14 }}>
            <DeadlineChip state={c.deadlineState} />
          </span>
          <span className="stat-hint">{c.expectedDisposalAt ? fmtDate(c.expectedDisposalAt) : 'No deadline configured — age tracked only'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Age / processing</span>
          <span className="stat-value" style={{ fontSize: 16 }}>
            {c.ageDays} days
          </span>
          <span className="stat-hint">
            {c.processingDays !== null ? `disposed after ${c.processingDays} days` : 'processing duration pending disposal'}
          </span>
        </div>
      </div>

      {conflict && (
        <Notice tone="danger">
          <strong>Someone saved a newer version</strong>
          {conflict.message} Your text is still in the form. Reload the latest record, review the difference, then save again.
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                await load();
                setConflict(null);
              }}
            >
              Reload latest record
            </button>
          </div>
        </Notice>
      )}

      {masked && (
        <Notice tone="warn">
          <strong>Restricted case — coordination metadata only</strong>
          You can see the institution, case reference, category, bureau, status, owner role and last action time. Complaint text, contact
          details, attachments and history remarks need an explicit case grant. Ask a bureau lead or supervisor to grant access if
          coordination requires it.
        </Notice>
      )}

      <div className="split">
        <div className="stack" style={{ gap: 14 }}>
          <Card
            title="Complaint record"
            actions={<CopyButton value={c.caseNumber} label="Copy case number" />}
          >
            {masked ? (
              <div className="restricted-block">
                <strong>Complaint text is restricted</strong>
                The summary, source reference, complainant contact and attachments are hidden for this account. Only approved coordination
                metadata is exposed, and notifications never include complaint excerpts.
              </div>
            ) : (
              <>
                <div className="summary-text">{c.complaintSummary}</div>
                <dl className="kv">
                  <dt>Received</dt>
                  <dd>
                    {fmtDateTime(c.receivedAt)} <span className="muted small">(stored {c.receivedAt})</span>
                  </dd>
                  <dt>Source channel</dt>
                  <dd>{c.sourceChannel}</dd>
                  <dt>Source reference</dt>
                  <dd className="mono">{c.sourceReference ?? '—'}</dd>
                  <dt>Source system</dt>
                  <dd>{c.sourceSystem ?? '—'}</dd>
                  <dt>Complainant contact</dt>
                  <dd>{c.complainantContact ?? '—'} <span className="pill pill-violet">restricted field</span></dd>
                  {c.responseDueAt && (
                    <>
                      <dt>Response due</dt>
                      <dd>
                        {fmtDateTime(c.responseDueAt)} — from {c.responseFromRole}
                      </dd>
                    </>
                  )}
                  {c.disposedAt && (
                    <>
                      <dt>Disposed at</dt>
                      <dd>{fmtDateTime(c.disposedAt)}</dd>
                      <dt>Outcome</dt>
                      <dd>{c.outcome ?? <span className="muted">Not recorded (legacy disposal — see disposition history)</span>}</dd>
                      <dt>Decision reference</dt>
                      <dd className="mono">{c.decisionReference ?? '—'}</dd>
                    </>
                  )}
                  {c.reopenedAt && (
                    <>
                      <dt>Reopened at</dt>
                      <dd>{fmtDateTime(c.reopenedAt)} <span className="muted small">(earlier outcome kept in history)</span></dd>
                    </>
                  )}
                </dl>
              </>
            )}
          </Card>

          {perms.canUpdate && (
            <ActionCard
              caseRow={c}
              nextStates={detail.nextStates}
              outcomes={detail.options.outcomes}
              onSaved={() => onSaved('Action recorded')}
              onConflict={(err) => setConflict(err)}
            />
          )}

          {perms.canResolveTriage && (
            <TriageCard caseRow={c} onSaved={() => onSaved('Institution identity resolved')} />
          )}

          {(detail.dispositions.length > 0 || c.status === 'Disposed' || c.status === 'Closed') && (
            <Card
              title="Disposition record"
              subtitle="Structured outcome and decision reference for each disposal. A reopening adds to this list; it never rewrites or removes it."
            >
              {detail.dispositions.length === 0 ? (
                <EmptyState
                  title="No structured disposition recorded"
                  body="This case was disposed or closed before structured outcomes were captured. The record is flagged rather than filled in with a guessed outcome."
                />
              ) : (
                <ol className="timeline">
                  {detail.dispositions.map((d) => (
                    <li key={d.id}>
                      <div className="tl-head">
                        <span className="tl-type">{d.outcome}</span>
                        <span className="tl-meta">
                          {d.actorName} · {fmtDateTime(d.at)} · v{d.versionAfter}
                          {d.reopenedAt ? ` · reopened ${fmtDateTime(d.reopenedAt)}` : ''}
                        </span>
                      </div>
                      <div className="tl-body mono">{d.decisionReference ?? '—'}</div>
                      {d.note && <div className="tl-meta">{d.note}</div>}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}

          <Card title="Action history" subtitle="Append-only business history: actor, bureau, server time, type, remarks, next step and before/after values.">
            {detail.history.length === 0 ? (
              <EmptyState title="No history yet" body="Actions appear here as they are recorded." />
            ) : (
              <ol className="timeline">
                {[...detail.history].reverse().map((h) => (
                  <li key={h.id} id={`event-${h.id}`} tabIndex={-1}>
                    <div className="tl-head">
                      <span className="tl-type">{actionLabel(h.actionType)}</span>
                      <span className="tl-meta">
                        {h.actorName} ({roleLabel(h.actorRole)}
                        {h.actorBureau ? ` · ${h.actorBureau}` : ''}) · {fmtDateTime(h.at)} · v{h.versionAfter}
                      </span>
                    </div>
                    {h.remarks && <div className="tl-body">{h.remarks}</div>}
                    {h.nextStep && <div className="tl-meta">Next step: {h.nextStep}</div>}
                    <details className="event-details"><summary className="small muted">Event ID and authorized JSON</summary><div className="event-copy"><code>{h.id}</code><CopyButton value={h.id} label="Copy event ID" /><CopyButton value={JSON.stringify({ id: h.id, at: h.at, actionType: h.actionType, actorName: h.actorName, remarks: h.remarks, before: h.before, after: h.after }, null, 2)} label="Copy event JSON" /></div></details>
                    {(h.before || h.after) && (
                      <div className="tl-diff">
                        {h.before &&
                          Object.entries(h.before).map(([k, v]) => (
                            <span key={`b-${k}`} className="diff-chip">
                              {k}: {String(v ?? '—')} →
                            </span>
                          ))}
                        {h.after &&
                          Object.entries(h.after).map(([k, v]) => (
                            <span key={`a-${k}`} className="diff-chip">
                              {k}: {String(v ?? '—')}
                            </span>
                          ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          {perms.canAssign && <AssignCard caseRow={c} onSaved={() => onSaved('Owner updated')} options={detail.options.officers} />}

          {(perms.canTransfer || c.pendingTransfer) && (
            <TransferCard caseRow={c} onSaved={() => onSaved('Transfer updated')} />
          )}

          {perms.canEscalate && (
            <EscalationCard caseRow={c} supervisors={detail.options.supervisors} onSaved={() => onSaved('Escalation updated')} />
          )}

          {perms.canReopen && <ReopenCard caseRow={c} onSaved={() => onSaved('Case reopened')} />}

          {(session.user!.role === 'bureau_lead' || session.user!.role === 'supervisor') && (
            <DeadlineCard caseRow={c} onSaved={() => onSaved('Deadline updated')} />
          )}

          {!masked && (
            <EvidenceCard detail={detail} caseRow={c} onSaved={() => onSaved('Evidence updated')} />
          )}

          <RelatedCard detail={detail} />

          {perms.canGrant && (
            <GrantsCard detail={detail} onSaved={() => onSaved('Access updated')} />
          )}

          <Card title="Record versions">
            <dl className="kv">
              <dt>Case version</dt>
              <dd>v{c.version}</dd>
              <dt>Created</dt>
              <dd>{fmtDateTime(c.createdAt)}</dd>
              <dt>Last updated</dt>
              <dd>{fmtDateTime(c.updatedAt)}</dd>
              <dt>Internal UUID</dt>
              <dd className="mono small">{c.id}</dd>
            </dl>
            <p className="small muted">
              Every mutation submits the version you were shown. A stale version returns a conflict instead of overwriting a newer decision.
            </p>
          </Card>
        </div>
      </div>
      <CasePrintView detail={detail} />
    </>
  );
}

/* ------------------------------------------------------------- components */

/**
 * The status picker must not offer the protected reopening path: disposing/reopening goes through its
 * own guarded operation, so `Under review` is filtered out of the generic action form for a
 * disposed or closed case. The server rejects it with `use_reopen_operation` regardless.
 */
function editableNextStates(status: string, nextStates: string[]): string[] {
  if (status === 'Disposed' || status === 'Closed') return nextStates.filter((s) => s !== 'Under review');
  return nextStates;
}

function ActionCard({
  caseRow,
  nextStates,
  outcomes,
  onSaved,
  onConflict,
}: {
  caseRow: CaseRow;
  nextStates: string[];
  outcomes: string[];
  onSaved: () => void;
  onConflict: (e: ApiError) => void;
}) {
  const [actionType, setActionType] = useState('Review completed');
  const [remarks, setRemarks] = useState('');
  // The next action starts pre-filled with what the case already carries, so a note that does not touch
  // it cannot erase it. Only an edited field is sent, and clearing it is an explicit choice (M7/A18).
  const [nextStep, setNextStep] = useState(caseRow.nextAction ?? '');
  const [nextStepTouched, setNextStepTouched] = useState(false);
  const [nextActionDueAt, setNextActionDueAt] = useState('');
  const [status, setStatus] = useState('');
  const [responseDueAt, setResponseDueAt] = useState('');
  const [responseFromRole, setResponseFromRole] = useState('');
  const [decisionReference, setDecisionReference] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateCase(caseRow.id, {
        version: caseRow.version,
        actionType: actionType.replace(/\s+/g, '_').toLowerCase(),
        remarks,
        // Omitted when untouched (the server keeps the stored value); an explicit null when the officer
        // empties a field they edited, which is the only way it can be cleared.
        nextStep: nextStepTouched ? nextStep.trim() || null : undefined,
        nextActionDueAt: nextActionDueAt ? toIsoFromInput(nextActionDueAt) : undefined,
        status: status || undefined,
        responseDueAt: status === 'Awaiting response' && responseDueAt ? toIsoFromInput(responseDueAt) : undefined,
        responseFromRole: status === 'Awaiting response' ? responseFromRole : undefined,
        decisionReference: status === 'Disposed' ? decisionReference : undefined,
        outcome: status === 'Disposed' ? outcome : undefined,
      });
      setRemarks('');
      setNextStepTouched(false);
      setStatus('');
      setDecisionReference('');
      setOutcome('');
      onSaved();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409) onConflict(apiErr);
      setError(apiErr);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Record an action"
      subtitle="A rejected save keeps everything you typed and explains the field or permission problem."
    >
      <div className="form-grid">
        <Field label="Action type" required>
          <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
            {['Review completed', 'Institute contacted', 'Response received', 'Document verified', 'Internal note', 'Other'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lifecycle change" hint="Only permitted next states are listed. Reopening a disposed case has its own protected action.">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Keep current status ({caseRow.status})</option>
            {editableNextStates(caseRow.status, nextStates).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <div className="span-2">
          <Field label="Remarks" required error={error?.fields?.remarks} hint="Recorded in the append-only history. Plain text only.">
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} placeholder="What happened, and what evidence supports it?" />
          </Field>
        </div>
        <Field
          label="Next step"
          hint={
            nextStepTouched
              ? 'This replaces the stored next action. Empty it to clear it deliberately.'
              : 'Unchanged. Edit it to replace the stored next action.'
          }
        >
          <input
            value={nextStep}
            onChange={(e) => {
              setNextStep(e.target.value);
              setNextStepTouched(true);
            }}
            placeholder="What happens next?"
          />
        </Field>
        <Field label="Next action due">
          <input type="date" value={nextActionDueAt} onChange={(e) => setNextActionDueAt(e.target.value)} />
        </Field>
        {status === 'Awaiting response' && (
          <>
            <Field label="Response due" required error={error?.fields?.responseDueAt}>
              <input type="date" value={responseDueAt} onChange={(e) => setResponseDueAt(e.target.value)} />
            </Field>
            <Field label="Response expected from" required error={error?.fields?.responseFromRole}>
              <input value={responseFromRole} onChange={(e) => setResponseFromRole(e.target.value)} placeholder="e.g. Institute nodal officer" />
            </Field>
            <div className="span-2">
              <Notice tone="info">
                Awaiting response does not pause any configured deadline. The disposal clock keeps running.
              </Notice>
            </div>
          </>
        )}
        {status === 'Disposed' && (
          <>
            <Field label="Disposition outcome" required error={error?.fields?.outcome}>
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">Choose an outcome…</option>
                {outcomes.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Decision / outcome reference" required error={error?.fields?.decisionReference} hint="Structured fields, not free remarks: they stay with the case after a reopening.">
              <input value={decisionReference} onChange={(e) => setDecisionReference(e.target.value)} placeholder="e.g. DEMO-DISP-2026-0041" />
            </Field>
            <div className="span-2">
              <Notice tone="info">A disposition needs both fields. Remarks are the narrative; they never stand in for the outcome or reference.</Notice>
            </div>
          </>
        )}
      </div>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || remarks.trim().length < 3} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save action'}
        </button>
      </div>
    </Card>
  );
}

function AssignCard({
  caseRow,
  options,
  onSaved,
}: {
  caseRow: CaseRow;
  options: { id: string; displayName: string }[];
  onSaved: () => void;
}) {
  const [officerId, setOfficerId] = useState(caseRow.assignedOfficerId ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Ownership">
      <dl className="kv">
        <dt>Owning bureau</dt>
        <dd>{caseRow.bureau}</dd>
        <dt>Owner</dt>
        <dd>{caseRow.assignedOfficerName ?? 'Unassigned queue'}</dd>
      </dl>
      <Field label="Assign to" hint="Only officers in this bureau are listed.">
        <select value={officerId} onChange={(e) => setOfficerId(e.target.value)}>
          <option value="">Clear owner (assignment queue)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason" required error={error?.fields?.reason}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is ownership changing?" />
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || reason.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.assign(caseRow.id, caseRow.version, officerId || null, reason);
              setReason('');
              onSaved();
            } catch (err) {
              setError(err as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Update owner'}
        </button>
      </div>
    </Card>
  );
}

function TransferCard({ caseRow, onSaved }: { caseRow: CaseRow; onSaved: () => void }) {
  const { meta, session } = useApp();
  const [toBureau, setToBureau] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const user = session.user!;
  const canDecide = caseRow.pendingTransfer && user.role === 'bureau_lead' && user.bureau === caseRow.pendingTransfer.toBureau;

  return (
    <Card title="Transfer ownership" subtitle="The original bureau stays responsible while a request is pending. Acceptance is atomic.">
      {caseRow.pendingTransfer ? (
        <div className="stack-sm">
          <Notice tone="warn">
            <strong>Request pending → {caseRow.pendingTransfer.toBureau}</strong>
            Requested {fmtDateTime(caseRow.pendingTransfer.requestedAt)}. Ownership remains with {caseRow.bureau} until the target lead
            decides.
          </Notice>
          {canDecide && (
            <>
              <Field label="Decision note">
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Recorded on the transfer and in history" />
              </Field>
              <ErrorNote error={error} />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || note.trim().length < 3}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api.decideTransfer(caseRow.pendingTransfer!.id, caseRow.version, 'accept', note);
                      onSaved();
                    } catch (err) {
                      setError(err as ApiError);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Accept transfer
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || note.trim().length < 3}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api.decideTransfer(caseRow.pendingTransfer!.id, caseRow.version, 'reject', note);
                      onSaved();
                    } catch (err) {
                      setError(err as ApiError);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Reject transfer
                </button>
              </div>
            </>
          )}
        </div>
      ) : caseRow.permissions.canTransfer ? (
        <div className="stack-sm">
          <Field label="Target bureau">
            <select value={toBureau} onChange={(e) => setToBureau(e.target.value)}>
              <option value="">Select bureau…</option>
              {(meta?.bureaus ?? [])
                .filter((b: any) => b.code !== caseRow.bureau)
                .map((b: any) => (
                  <option key={b.code} value={b.code}>
                    {b.code} — {b.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Reason" required error={error?.fields?.toBureau ?? error?.fields?.reason}>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why should the other bureau own this case?" />
          </Field>
          <ErrorNote error={error} />
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !toBureau || reason.trim().length < 5}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.requestTransfer(caseRow.id, caseRow.version, toBureau, reason, `transfer-${caseRow.id}-${Date.now()}`);
                  setReason('');
                  setToBureau('');
                  onSaved();
                } catch (err) {
                  setError(err as ApiError);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Requesting…' : 'Request transfer'}
            </button>
          </div>
        </div>
      ) : (
        <p className="small muted">Only the owning bureau lead can request a transfer.</p>
      )}
    </Card>
  );
}

function EscalationCard({
  caseRow,
  supervisors,
  onSaved,
}: {
  caseRow: CaseRow;
  supervisors: { id: string; displayName: string }[];
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [supervisorId, setSupervisorId] = useState(supervisors[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Card title="Escalation">
      {caseRow.escalationOpen ? (
        <div className="stack-sm">
          <Notice tone="danger">
            <strong>Open escalation</strong>
            {caseRow.escalationReason}
            <div className="small">Lifecycle state is unchanged ({caseRow.status}). Escalation is a flag, not a state.</div>
          </Notice>
          <Field label="Resolution note">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Acknowledgement / completion note" />
          </Field>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={note.trim().length < 3}
              onClick={async () => {
                try {
                  await api.closeEscalation(caseRow.id, caseRow.version, note);
                  setNote('');
                  onSaved();
                } catch (err) {
                  setError(err as ApiError);
                }
              }}
            >
              Record escalation complete
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-sm">
          <Field label="Responsible supervisor">
            <select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)}>
              {supervisors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Escalation reason" required>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
          <ErrorNote error={error} />
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!supervisorId || reason.trim().length < 5}
              onClick={async () => {
                try {
                  await api.escalate(caseRow.id, caseRow.version, reason, supervisorId);
                  setReason('');
                  onSaved();
                } catch (err) {
                  setError(err as ApiError);
                }
              }}
            >
              Open escalation
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ReopenCard({ caseRow, onSaved }: { caseRow: CaseRow; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Card title="Reopen case" subtitle="Previous outcomes and the original receipt time are preserved.">
      <Field label="Reopen reason" required error={error?.fields?.reason}>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button
          type="button"
          className="btn"
          disabled={reason.trim().length < 5}
          onClick={async () => {
            setError(null);
            try {
              await api.reopen(caseRow.id, caseRow.version, reason);
              setReason('');
              onSaved();
            } catch (err) {
              setError(err as ApiError);
            }
          }}
        >
          Reopen for review
        </button>
      </div>
    </Card>
  );
}

function DeadlineCard({ caseRow, onSaved }: { caseRow: CaseRow; onSaved: () => void }) {
  const [date, setDate] = useState(dateInput(caseRow.expectedDisposalAt));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Card
      title="Deadline policy"
      subtitle="No deadline is invented. Clearing the date switches the case to age-only tracking."
      actions={<DeadlineChip state={caseRow.deadlineState} />}
    >
      <Field label="Expected disposal date">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Reason for change" required error={error?.fields?.reason}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Deadline changes need a separate authorised action" />
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={reason.trim().length < 5}
          onClick={async () => {
            setError(null);
            try {
              await api.changeDeadline(caseRow.id, caseRow.version, date ? toIsoFromInput(date, true) : null, reason);
              setReason('');
              onSaved();
            } catch (err) {
              setError(err as ApiError);
            }
          }}
        >
          Save deadline change
        </button>
      </div>
    </Card>
  );
}

function EvidenceCard({ detail, caseRow, onSaved }: { detail: CaseDetail; caseRow: CaseRow; onSaved: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const { push } = useToast();
  return (
    <Card title="Evidence" subtitle="PDF, PNG or JPEG · up to 5 files · 10 MB each · private storage, authorised downloads.">
      {detail.attachments.length === 0 ? (
        <p className="small muted">No evidence files yet.</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {detail.attachments.map((a) => (
            <li key={a.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
              <span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={downloading !== null}
                  aria-busy={downloading === a.id}
                  style={{ padding: 0 }}
                  onClick={async () => {
                    setDownloading(a.id);
                    setError(null);
                    try {
                      await downloadFile(api.attachmentUrl(caseRow.id, a.id), a.originalName);
                      push({ tone: 'success', title: 'Download prepared', body: a.originalName });
                    } catch (err) {
                      setError(err as ApiError);
                    } finally { setDownloading(null); }
                  }}
                >
                  {downloading === a.id ? 'Preparing download…' : a.originalName}
                </button>
                <span className="cell-sub">
                  {a.mime} · {bytes(a.size)} · sha256 {a.sha256.slice(0, 12)}… · {a.uploadedBy} {fmtDate(a.uploadedAt)}
                </span>
                <CopyButton value={a.sha256} label="Copy SHA-256" />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Field label="Add evidence file" hint="Type is validated from the file content on the server, not the extension.">
        <input
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!file || busy}
          onClick={async () => {
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              await api.upload(caseRow.id, caseRow.version, file);
              setFile(null);
              onSaved();
            } catch (err) {
              setError(err as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </Card>
  );
}

function RelatedCard({ detail }: { detail: CaseDetail }) {
  const { go } = useApp();
  const { push } = useToast();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  return (
    <Card
      title="Related cases"
      subtitle="Linking never changes ownership, deadlines or outcomes. Only a reviewer-confirmed relationship is displayed here."
    >
      {detail.relationships.length === 0 ? (
        <p className="small muted">No confirmed relationships.</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {detail.relationships.map((r) => (
            <li key={r.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <div className="row-between">
                <span className="row" style={{ gap: 6 }}>
                  <Pill tone={r.type === 'Duplicate report' ? 'violet' : 'indigo'}>{r.type}</Pill>
                  <Pill tone={r.state === 'active' ? 'green' : 'slate'}>{r.state}</Pill>
                </span>
                <span className="small muted">{fmtDate(r.decidedAt)}</span>
              </div>
              <div className="small">
                {r.case?.caseNumber ? (
                  <a href={`#/cases/${r.case.id}`}>{r.case.caseNumber}</a>
                ) : (
                  <span className="muted">Linked case outside your view</span>
                )}
              </div>
              <div className="small muted">{r.reason}</div>
              <div className="small muted">
                Reviewer: {r.reviewerName}
                {r.revokedReason ? ` · revoked: ${r.revokedReason}` : ''}
              </div>
              {r.state === 'active' && !r.canRevoke && (
                <p className="small muted" style={{ marginTop: 4 }}>
                  Revoking needs a lead or supervisor with current content access to both cases.
                </p>
              )}
              {r.state === 'active' && r.canRevoke && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: 4 }}
                  onClick={async () => {
                    const reason = window.prompt('Reason for revoking this link (recorded in history):');
                    if (!reason || reason.trim().length < 5) return;
                    try {
                      await api.revokeRelationship(r.id, reason, detail.case.version, r.case?.version);
                      push({ tone: 'success', title: 'Link revoked', body: 'Both cases remain intact with their own owners and outcomes.' });
                      go(`/cases/${detail.case.id}`);
                    } catch (err) {
                      push({ tone: 'error', title: 'Could not revoke', body: (err as Error).message });
                    }
                  }}
                >
                  Revoke link
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="divider" />
      <div className="section-title">Open suggestions</div>
      {detail.suggestions.length === 0 ? (
        <p className="small muted">No open suggestion for this case.</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {detail.suggestions.map((s) => (
            <li key={s.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
              <span>
                <Pill tone={s.kind === 'Duplicate report' ? 'violet' : 'indigo'}>{s.kind}</Pill>
                <div className="small muted">
                  with {s.caseA.id === detail.case.id ? s.caseB.caseNumber : s.caseA.caseNumber} · {s.reasons.length} evidence signal(s)
                </div>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setSuggestion(s)}>
                Review
              </button>
            </li>
          ))}
        </ul>
      )}

      {suggestion && (
        <SuggestionModal
          suggestion={suggestion}
          onClose={() => setSuggestion(null)}
          onSaved={async () => {
            setSuggestion(null);
            push({ tone: 'success', title: 'Relationship decision recorded', body: 'Reviewer, reason, evidence snapshot and rule version are stored.' });
            go(`/cases/${detail.case.id}`);
          }}
        />
      )}
    </Card>
  );
}

export function SuggestionModal({
  suggestion,
  onClose,
  onSaved,
}: {
  suggestion: Suggestion;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [decision, setDecision] = useState<'Related issue' | 'Duplicate report' | 'Separate issues'>(
    suggestion.kind === 'Duplicate report' ? 'Duplicate report' : 'Related issue'
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const col = (
    c: { bureau: string; caseNumber: string | null; category: string; status: string; access: string },
    summary?: string | null
  ) => (
    <div className="compare-col">
      <h4>{c.bureau} · {c.caseNumber ?? 'restricted reference'}</h4>
      <div className="small">
        {c.category} · <StatusPill status={c.status} />
      </div>
      {summary ? (
        <p className="small" style={{ marginTop: 6 }}>{summary}</p>
      ) : (
        <p className="small muted" style={{ marginTop: 6 }}>Summary restricted for your account.</p>
      )}
    </div>
  );

  return (
    <Modal
      title={`Review ${suggestion.kind.toLowerCase()} candidate`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || reason.trim().length < 5 || !suggestion.canDecide}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.decideSuggestion(suggestion.id, decision, reason, suggestion.caseA?.version, suggestion.caseB?.version);
                await onSaved();
              } catch (err) {
                setError(err as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save decision'}
          </button>
        </>
      }
    >
      <div className="side-by-side">{col(suggestion.caseA, suggestion.caseA.summary)}{col(suggestion.caseB, suggestion.caseB.summary)}</div>

      <div>
        <div className="section-title">Match evidence (P0 rules, version {suggestion.ruleVersion})</div>
        <ul className="reason-list">
          {suggestion.reasons.map((r, i) => (
            <li key={i}>
              <span className="rule-tag">{r.rule}</span>
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {!suggestion.canDecide && (
        <Notice tone="warn">
          <strong>Decision not available for your account</strong>
          {suggestion.requiresContentAccess
            ? ' You need current content access to both cases in this pair. A read-only grant does not confer decision authority; request coordination access from the owning bureau lead or a supervisor.'
            : ' Relationship decisions are recorded by a bureau lead for their own bureau pair, or by a supervisor with regional oversight of both cases.'}
        </Notice>
      )}

      <Field label="Decision" required hint="Duplicate report is a reviewer classification — it never merges or disposes either case.">
        <select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
          <option value="Related issue">Related issue</option>
          <option value="Duplicate report">Duplicate report</option>
          <option value="Separate issues">Separate issues</option>
        </select>
      </Field>
      <Field label="Reason (required)" error={error?.fields?.reason}>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="What evidence decided this?" />
      </Field>
      <p className="small muted">
        Saving stores the reviewer, reason, evidence snapshot and rule version with the decision time. Dismissed suggestions stay suppressed
        until the underlying evidence changes.
      </p>
      <ErrorNote error={error} />
    </Modal>
  );
}

function GrantsCard({ detail, onSaved }: { detail: CaseDetail; onSaved: () => void }) {
  const [users, setUsers] = useState<any[]>([]);
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api
      .users()
      .then((res) => setUsers(res.users.filter((u: any) => ['supervisor', 'reviewer', 'bureau_lead', 'bureau_officer'].includes(u.role))))
      .catch(() => setUsers([]));
  }, []);

  return (
    <Card title="Case access grants" subtitle="A role alone never grants national access. Grants are explicit, reviewed and revocable.">
      {detail.grants.length === 0 ? (
        <p className="small muted">No explicit grants on this case.</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {detail.grants.map((g) => (
            <li key={g.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
              <span>
                <strong>{g.userName}</strong>
                <span className="cell-sub">
                  {roleLabel(g.role)} · granted by {g.grantedByName} {fmtDate(g.grantedAt)} · {g.revokedAt ? 'revoked' : 'active'}
                </span>
              </span>
              {!g.revokedAt && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    try {
                      await api.grants(detail.case.id, detail.case.version, g.userId, 'Revoked by reviewer', true);
                      onSaved();
                    } catch (err) {
                      setError(err as ApiError);
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
      <Field label="Grant read access to">
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Select a colleague…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} — {roleLabel(u.role)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Grant note" required>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is this grant needed?" />
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!userId || note.trim().length < 3}
          onClick={async () => {
            setError(null);
            try {
              await api.grants(detail.case.id, detail.case.version, userId, note);
              setNote('');
              setUserId('');
              onSaved();
            } catch (err) {
              setError(err as ApiError);
            }
          }}
        >
          Grant access
        </button>
      </div>
    </Card>
  );
}

function TriageCard({ caseRow, onSaved }: { caseRow: CaseRow; onSaved: () => void }) {
  const [query, setQuery] = useState(caseRow.intakeInstitutionText ?? '');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (query.trim().length < 3) return;
    const timer = setTimeout(async () => {
      try {
        const res = await api.resolveInstitution(query);
        setSuggestions(res.suggestions);
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <Card
      title="Institution identity unresolved"
      subtitle="This case is excluded from automatic institution overlap checks until the identity is confirmed."
    >
      <Field label="Search the confirmed directory">
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </Field>
      <div className="stack-sm">
        {suggestions.map((s) => (
          <button
            key={s.id}
            type="button"
            className="demo-account"
            onClick={async () => {
              setError(null);
              try {
                await api.resolveTriage(caseRow.id, caseRow.version, s.id, reason || `Confirmed by ${s.permanentId}`);
                onSaved();
              } catch (err) {
                setError(err as ApiError);
              }
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
      </div>
      <Field label="Resolution reason" hint="Recorded with the identity decision.">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
    </Card>
  );
}
