import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../App';
import { Card, ErrorNote, Loading, Notice, Pill, useToast } from '../ui';
import { fmtDateTime, roleLabel } from '../util';
import { ThemeControl } from '../theme';
import { HelpDialog } from '../components/HelpDialog';

export default function SettingsScreen() {
  const { meta, session, refreshSession } = useApp();
  const { push } = useToast();
  const [status, setStatus] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([api.systemStatus(), api.users()]);
      setStatus(s);
      setUsers(u.users);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = session.user!.role === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings and system status</h1>
          <p className="page-sub">
            Environment, scheduler and policy state. Settings appear for permitted users; content access still requires a case role or grant.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      <ErrorNote error={error} onRetry={() => void load()} />
      <Card title="Appearance and privacy" className="settings-appearance" subtitle="Choose a theme without reloading. System follows your device; explicit choices stay in this browser.">
        <ThemeControl />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPrivacyOpen(true)}>Cookies, storage and privacy</button>
      </Card>
      {privacyOpen && <HelpDialog initialTopic="privacy" onClose={() => setPrivacyOpen(false)} />}

      {!status ? (
        <Card title="System status">
          <Loading label="Loading configuration…" />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <Notice tone="warn">
            <strong>{status.environment}</strong>
            No government integration, official SLA or real personal data is used. Deployment gates (hosting, residency, retention, backup,
            evidence scanning, incident ownership) must be approved before any live pilot.
          </Notice>

          <div className="split-wide">
            <Card title="Runtime">
              <dl className="kv">
                <dt>Signed in as</dt>
                <dd>
                  {status.signedInAs?.displayName} · {roleLabel(status.signedInAs?.role)} · {status.signedInAs?.bureau ?? 'cross-bureau'}
                </dd>
                <dt>Matching mode</dt>
                <dd>
                  <Pill tone={status.matchingMode === 'rule-based' ? 'green' : 'amber'}>{status.matchingMode}</Pill>
                </dd>
                <dt>Rule version</dt>
                <dd className="mono">{status.ruleVersion}</dd>
                <dt>Scheduler</dt>
                <dd>
                  every {status.worker.intervalSeconds}s · last run{' '}
                  {status.worker.lastRunAt ? fmtDateTime(status.worker.lastRunAt) : 'not yet'} · {status.worker.pendingJobs} pending job(s)
                </dd>
                <dt>Database</dt>
                <dd className="mono">{status.database}</dd>
                <dt>Seeded</dt>
                <dd>{status.seededAt ? fmtDateTime(status.seededAt) : 'not seeded'}</dd>
                <dt>Server time (UTC)</dt>
                <dd className="mono">{status.serverTime}</dd>
                <dt>Display timezone</dt>
                <dd>{status.timezone}</dd>
              </dl>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await api.workerTick();
                      await load();
                      push({ tone: 'info', title: 'Scheduled check ran', body: `${res.processed} job(s), ${res.notifications} notification(s).` });
                    } catch (err) {
                      setError(err as ApiError);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Run scheduled check
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const next = status.matchingMode === 'rule-based' ? 'unavailable' : 'rule-based';
                      const res = await api.matchingMode(next);
                      await load();
                      push({ tone: 'info', title: 'Matching mode changed', body: res.note });
                    } catch (err) {
                      setError(err as ApiError);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {status.matchingMode === 'rule-based' ? 'Simulate matching outage' : 'Restore matching'}
                </button>
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                Simulating an outage demonstrates the failure path: institution overlap alerts keep running on the rule baseline, cases and
                actions still save, and the interface shows the available matching mode.
              </p>
            </Card>

            <Card title="Deadline policies" subtitle="No official SLA is invented. The demo policy is labelled and versioned.">
              <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {status.deadlinePolicy.map((p: any) => (
                  <li key={p.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                    <div className="row-between">
                      <strong>{p.name}</strong>
                      <Pill tone="amber">{p.version}</Pill>
                    </div>
                    <p className="small muted">
                      {p.calendar_days} {p.basis === 'calendar_days' ? 'calendar' : 'business'} days · policy source {p.id}
                    </p>
                    <p className="small muted">{p.note}</p>
                  </li>
                ))}
              </ul>
              <Notice tone="info">
                <strong>Awaiting response never pauses a deadline.</strong>
                Approved business-day calendars, pause rules and retrospective policy changes remain sponsor decisions.
              </Notice>
            </Card>
          </div>

          <Card title="Accounts and scope" subtitle="Role, bureau and region decide access. Content still requires bureau membership or an explicit grant.">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Bureau</th>
                    <th>Region</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.displayName}</td>
                      <td className="mono small">{u.username}</td>
                      <td>
                        <Pill tone={u.role === 'supervisor' ? 'violet' : u.role === 'admin' ? 'slate' : 'indigo'}>{roleLabel(u.role)}</Pill>
                      </td>
                      <td>{u.bureau ?? '—'}</td>
                      <td>{u.region ?? 'national'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">
              {isAdmin
                ? 'Identity management is available to administrators, but content access still requires a case role or grant.'
                : 'Account management is restricted to system administrators. Membership changes are audited.'}
            </p>
          </Card>

          <Card title="Scope and regions" subtitle="Bureaus configured for this prototype.">
            <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {(meta?.bureaus ?? []).map((b: any) => (
                <li key={b.code} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                  <strong>{b.code}</strong> — {b.name}
                  <div className="small muted">{b.description}</div>
                </li>
              ))}
            </ul>
            <p className="small muted" style={{ marginTop: 8 }}>
              Regions in the directory: {(meta?.regions ?? []).join(', ')}. Your scope:{' '}
              {session.user!.region ?? 'national'}.
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await refreshSession();
                  push({ tone: 'info', title: 'Session refreshed', body: 'Grants and memberships are re-read on every request.' });
                }}
              >
                Refresh session
              </button>
            </p>
          </Card>
        </div>
      )}
    </>
  );
}
