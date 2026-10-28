import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CaseRow } from '../api';
import { useApp } from '../App';
import { CaseTable } from '../components/CaseTable';
import { Card, EmptyState, ErrorNote, Loading, Modal, Field, Notice, Stat, StatusPill, useToast } from '../ui';
import { fmtDateTime, relativeDays } from '../util';
import { useSharedRefresh } from '../refresh';
import { Icon } from '../components/Icon';

export default function MyWorkScreen() {
  const { session, go, refreshSession } = useApp();
  const { push } = useToast();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [assignTarget, setAssignTarget] = useState<CaseRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.myWork();
      setData(res);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Shared 10-second cycle (M6): replaced the per-screen 15-second poll so My work, case detail,
  // institutions, coordination and reports all pick up the same update on the same tick.
  useSharedRefresh(load);

  const user = session.user!;
  const canCreate = ['bureau_officer', 'bureau_lead'].includes(user.role);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My work</h1>
          <p className="page-sub">
            Assigned and unassigned work in your scope.
          </p>
          <details className="priority-help"><summary>How priority works <Icon name="chevron" size={14} /></summary><p>Work is ordered by open escalation, breached configured deadline, approaching deadline and case age.</p></details>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={loading} aria-busy={loading} onClick={() => void load()}>
            <Icon name="refresh" size={18} />{loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => go('/cases?new=1')}>
              <Icon name="plus" size={18} />Register a case
            </button>
          )}
        </div>
      </div>

      <ErrorNote error={error} onRetry={() => void load()} />

      {loading && !data ? (
        <Card title="Loading your work">
          <Loading label="Fetching assigned, unassigned and overdue work…" rows={5} />
        </Card>
      ) : !data ? null : (
        <div className="stack work-stack">
          <div className="grid grid-6 queue-grid" aria-label="Work queues">
            <Stat
              label="Assigned to me"
              value={data.counts.assigned}
              hint={user.role === 'bureau_lead' ? 'Lead-owned work' : 'Active cases you own'}
              tone="blue"
              onClick={() => go('/cases?mine=1')}
            />
            <Stat
              label="Unassigned queue"
              value={data.counts.unassigned}
              hint={user.role === 'bureau_lead' ? 'Assign an owner' : 'Awaiting a bureau lead'}
              tone="violet"
              onClick={() => go('/cases?unassigned=1')}
            />
            <Stat label="Overdue" value={data.counts.overdue} hint="Configured deadline breached" tone="red" onClick={() => go('/cases?overdue=1')} />
            <Stat label="Approaching" value={data.counts.approaching} hint="Due within 7 days" tone="amber" onClick={() => go('/cases?pending=1')} />
            <Stat label="Escalated" value={data.counts.escalated} hint="Open escalation flag" tone="red" onClick={() => go('/cases?escalated=1')} />
            <Stat label="Triage" value={data.counts.triage} hint="Institution unresolved" tone="slate" onClick={() => go('/cases?triage=1')} />
          </div>

          {data.counts.assigned === 0 && data.counts.unassigned === 0 && data.counts.overdue === 0 && (
            <EmptyState
              title="Nothing is assigned to you yet"
              body="Register a case, or import an existing register with the CSV template. A bureau lead can also assign work from the unassigned queue."
              action={
                <>
                  {canCreate && (
                    <button type="button" className="btn btn-primary" onClick={() => go('/cases?new=1')}>
                      Register a case
                    </button>
                  )}
                  {user.role === 'bureau_lead' && (
                    <button type="button" className="btn" onClick={() => go('/import')}>
                      Import a CSV batch
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => go('/institutions')}>
                    Browse institutions
                  </button>
                </>
              }
            />
          )}

          {data.overdue.length > 0 && (
            <Card
              title={`Overdue work (${data.overdue.length})`}
              subtitle="Configured disposal deadline has passed. Overdue is computed only where a policy is configured — no invented SLA."
            >
              <CaseTable cases={data.overdue} />
            </Card>
          )}

          <Card
            title={`Your assigned cases (${data.assigned.length})`}
            subtitle="Open a case to record the next action, transfer, escalate or dispose."
          >
            <CaseTable cases={data.assigned} emptyMessage="No active cases are assigned to you." />
          </Card>

          <Card
            title={`Unassigned in your scope (${data.unassigned.length})`}
            subtitle={
              user.role === 'bureau_lead'
                ? 'Assign an owner so the case is never left unowned.'
                : 'A bureau lead assigns these; you can still read cases that belong to your bureau.'
            }
          >
            <CaseTable
              cases={data.unassigned}
              emptyMessage="Every active case in your scope has an owner."
              actions={
                user.role === 'bureau_lead'
                  ? (c) => (
                      <button type="button" className="btn btn-sm" onClick={() => setAssignTarget(c)}>
                        Assign
                      </button>
                    )
                  : undefined
              }
            />
          </Card>

          {data.approaching.length > 0 && (
            <Card title={`Deadline approaching (${data.approaching.length})`} subtitle="Due within 7 days under the configured DEMO policy.">
              <CaseTable cases={data.approaching} />
            </Card>
          )}

          {data.triage.length > 0 && (
            <Card
              title={`Institution identity unresolved (${data.triage.length})`}
              subtitle="Held in triage: excluded from automatic institution overlap checks until an officer confirms the identity."
            >
              <CaseTable cases={data.triage} />
            </Card>
          )}

          {data.pendingTransfers.length > 0 && (
            <Card title={`Transfer requests involving your bureau (${data.pendingTransfers.length})`}>
              <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.pendingTransfers.map((t: any) => (
                  <li key={t.id} className="row-between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                    <span>
                      <strong>
                        {t.fromBureau} → {t.toBureau}
                      </strong>
                      <span className="cell-sub">{t.reason}</span>
                    </span>
                    <span className="row">
                      <span className="small muted">requested {fmtDateTime(t.requestedAt)}</span>
                      <a className="btn btn-sm" href={`#/cases/${t.caseId}`}>
                        Review
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Notice tone="info">
            <strong>Scheduled checks</strong>
            In-app notifications are persisted for new institution overlaps, approaching deadlines, overdue work, transfer requests and
            escalations. Acknowledgement records awareness, not resolution. A failed notification never removes a saved case action.
          </Notice>
        </div>
      )}

      {assignTarget && (
        <AssignModal
          caseRow={assignTarget}
          onClose={() => setAssignTarget(null)}
          onSaved={async (name) => {
            setAssignTarget(null);
            push({ tone: 'success', title: 'Owner assigned', body: `${assignTarget.caseNumber} is now owned by ${name}.` });
            await load();
            await refreshSession();
          }}
        />
      )}
    </>
  );
}

function AssignModal({
  caseRow,
  onClose,
  onSaved,
}: {
  caseRow: CaseRow;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [officers, setOfficers] = useState<{ id: string; displayName: string }[]>([]);
  const [officerId, setOfficerId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .users(caseRow.bureau)
      .then((res) => setOfficers(res.users.filter((u: any) => ['bureau_officer', 'bureau_lead'].includes(u.role))))
      .catch(() => setOfficers([]));
  }, [caseRow.bureau]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.assign(caseRow.id, caseRow.version, officerId || null, reason || 'Owner assigned by bureau lead');
      const name = officers.find((o) => o.id === officerId)?.displayName ?? 'the assignment queue';
      await onSaved(name);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Assign ${caseRow.caseNumber}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !officerId}>
            {busy ? 'Saving…' : 'Assign owner'}
          </button>
        </>
      }
    >
      <p className="small muted">
        Current state: <StatusPill status={caseRow.status} /> · version {caseRow.version}. Assignment is an auditable action; the case is
        never silently reassigned by editing a label.
      </p>
      <Field label="Owning officer" required hint="Only officers in the case's owning bureau can be selected.">
        <select value={officerId} onChange={(e) => setOfficerId(e.target.value)}>
          <option value="">Select an officer…</option>
          {officers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason (recorded in history)" error={error?.fields?.reason}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. workload balancing after leave" />
      </Field>
      <ErrorNote error={error} />
      {caseRow.pendingTransfer && (
        <Notice tone="warn">
          A transfer to {caseRow.pendingTransfer.toBureau} is pending. The case keeps its current bureau until the target lead decides.
        </Notice>
      )}
    </Modal>
  );
}
