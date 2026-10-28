import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../App';
import { useSharedRefresh } from '../refresh';
import { Card, EmptyState, ErrorNote, Loading, Notice, Pill, Stat, Tabs, useToast } from '../ui';
import { fmtDateTime, relativeDays } from '../util';

export default function AlertsScreen() {
  const { notifications, refreshNotifications, refreshSession } = useApp();
  const { push } = useToast();
  const [tab, setTab] = useState<'all' | 'overlap' | 'deadline' | 'overdue' | 'transfer' | 'escalation'>('all');
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
    } catch (err) {
      setError(err as ApiError);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void refreshNotifications();
  }, [loadStatus, refreshNotifications]);
  // M6: alerts are shared, so refresh them on the same cycle. The per-notification acknowledgement a
  // user records stays personal and is re-read from the server with the same request.
  useSharedRefresh(refreshNotifications);

  const filtered = notifications.filter((n) => (tab === 'all' ? true : n.kind === tab));
  const byKind = (kind: string) => notifications.filter((n) => n.kind === kind).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts and notifications</h1>
          <p className="page-sub">
            Persisted in-app notifications for new institution overlap, approaching deadline, overdue case, transfer request and escalation.
            The scheduled check runs every minute and deduplicates by rule, entity, due date and threshold.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await api.workerTick();
                await refreshNotifications();
                await loadStatus();
                push({
                  tone: 'info',
                  title: 'Scheduled check completed',
                  body: `${res.processed} background job(s) processed, ${res.notifications} new notification(s).`,
                });
              } catch (err) {
                setError(err as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Running…' : 'Run scheduled check now'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await refreshNotifications();
              await loadStatus();
              await refreshSession();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Unread" value={notifications.filter((n) => !n.readAt).length} tone="blue" hint="Click to open the record" />
        <Stat label="Overdue reminders" value={byKind('overdue')} tone="red" hint="Disposed cases stop receiving these" />
        <Stat label="Deadline approaching" value={byKind('deadline')} tone="amber" hint="Within 7 days of the configured due time" />
        <Stat label="Overlap / escalation" value={byKind('overlap') + byKind('escalation')} tone="violet" hint="Coordination and supervisor signal" />
      </div>

      {status && (
        <Notice tone={status.worker.lastError ? 'warn' : 'info'}>
          <strong>Scheduler status</strong>
          Runs every {status.worker.intervalSeconds}s · last run {status.worker.lastRunAt ? fmtDateTime(status.worker.lastRunAt) : 'not yet'} ·
          pending background jobs {status.worker.pendingJobs} · matching mode {status.matchingMode}.
          {status.worker.lastError ? ` Last error: ${status.worker.lastError}` : ' Background work is committed with its business mutation and retried idempotently.'}
        </Notice>
      )}

      <Card>
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'all', label: 'All', count: notifications.length },
            { id: 'overlap', label: 'Overlap', count: byKind('overlap') },
            { id: 'deadline', label: 'Deadline', count: byKind('deadline') },
            { id: 'overdue', label: 'Overdue', count: byKind('overdue') },
            { id: 'transfer', label: 'Transfer', count: byKind('transfer') },
            { id: 'escalation', label: 'Escalation', count: byKind('escalation') },
          ]}
        />

        {filtered.length === 0 ? (
          <EmptyState
            title="No notifications in this view"
            body="Notifications appear after a scheduled check finds an overlap, an approaching or breached configured deadline, a transfer request or an escalation. A failed notification never removes a saved case action."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await api.workerTick();
                  await refreshNotifications();
                  await loadStatus();
                }}
              >
                Run scheduled check now
              </button>
            }
          />
        ) : (
          <ul className="notif-list">
            {filtered.map((n) => (
              <li key={n.id}>
                <div className="notif-body">
                  <div className="row-between">
                    <span className="notif-title">{n.title}</span>
                    <span className="row" style={{ gap: 6 }}>
                      <Pill tone={kindTone(n.kind)}>{n.kind}</Pill>
                      {!n.readAt && <Pill tone="blue">unread</Pill>}
                      {n.acknowledgedAt && <Pill tone="green">acknowledged</Pill>}
                    </span>
                  </div>
                  <div className="notif-text">{n.body}</div>
                  <div className="notif-meta">
                    <span>{fmtDateTime(n.createdAt)}</span>
                    <span className="mono small">{n.entityType}:{String(n.entityId).slice(0, 8)}…</span>
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await api.markRead(n.id);
                        await refreshNotifications();
                      }}
                    >
                      Mark read
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await api.acknowledge(n.id);
                        await refreshNotifications();
                        push({ tone: 'info', title: 'Acknowledged', body: 'Acknowledgement records awareness, not resolution.' });
                      }}
                    >
                      Acknowledge
                    </button>
                    {n.entityType === 'case' && (
                      <a className="btn btn-sm" href={`#/cases/${n.entityId}`}>
                        Open case
                      </a>
                    )}
                    {n.entityType === 'transfer' && (
                      <a className="btn btn-sm" href="#/my-work">
                        Open transfer queue
                      </a>
                    )}
                    {n.entityType === 'alert' && (
                      <a className="btn btn-sm" href={`#/coordination/${n.entityId}`}>
                        Open coordination review
                      </a>
                    )}
                    <span className="small muted">
                      {n.kind === 'overdue' || n.kind === 'deadline' ? `due ${relativeDays(n.createdAt)}` : ''}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function kindTone(kind: string): string {
  return { overlap: 'violet', deadline: 'amber', overdue: 'red', transfer: 'blue', escalation: 'red', assignment: 'indigo' }[kind] ?? 'slate';
}
