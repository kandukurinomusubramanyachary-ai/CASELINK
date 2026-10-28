import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, downloadCsv } from '../api';
import { useApp } from '../App';
import { useSharedRefresh } from '../refresh';
import { Bar, Card, EmptyState, ErrorNote, Field, Loading, Notice, Pill, Stat, useToast } from '../ui';
import { fmtDateTime, queryFrom } from '../util';
import { Icon } from '../components/Icon';

export default function ReportsScreen() {
  const { meta, go } = useApp();
  const { push } = useToast();
  const [filters, setFilters] = useState({
    bureau: [] as string[],
    status: [] as string[],
    category: [] as string[],
    region: '',
    receivedFrom: '',
    receivedTo: '',
  });
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => queryFrom(filters as unknown as Record<string, unknown>), [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.reportSummary(query));
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);
  // M6: join the shared 10-second refresh cycle, so another officer's change appears without a reload.
  useSharedRefresh(load);

  const drill = (extra: Record<string, string>) => {
    const next = queryFrom({ ...filters, ...extra } as unknown as Record<string, unknown>);
    go(`/cases${next ? `?${next}` : ''}`);
  };

  const totals = data?.totals;
  const maxAgeing = data ? Math.max(...Object.values(data.ageing as Record<string, number>), 1) : 1;
  const maxBureau = data ? Math.max(...Object.values(data.byBureau as Record<string, { total: number }>).map((b) => b.total), 1) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="page-sub">
            Every total uses one definition and reconciles with its drill-down case list. Exports contain only permitted rows and fields with
            the snapshot time and filters, and spreadsheet formula-like values are escaped.
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
                await downloadCsv(api.exportUrl(query), `caselink-report-${Date.now()}.csv`);
                push({ tone: 'success', title: 'Export prepared', body: 'Permitted rows only, with snapshot time and filters.' });
              } catch (err) {
                setError(err as ApiError);
              } finally { setExporting(false); }
            }}
          >
            {exporting ? 'Preparing export…' : 'Export permitted rows (CSV)'}
          </button>
          <button type="button" className="btn" disabled={loading} aria-busy={loading} onClick={() => void load()}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn" onClick={() => window.print()}><Icon name="print" size={18} />Print report</button>
        </div>
      </div>

      <p className="print-only">Active report filters: {Object.entries(filters).filter(([, value]) => Array.isArray(value) ? value.length > 0 : Boolean(value)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('; ') || 'All records in the signed-in account’s scope'}</p>
      <Card title="Filters" className="print-hide">
        <div className="toolbar">
          <Field label="Region">
            <select value={filters.region} onChange={(e) => setFilters({ ...filters, region: e.target.value })}>
              <option value="">All regions</option>
              {(meta?.regions ?? []).map((r: string) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Received from">
            <input type="date" value={filters.receivedFrom} onChange={(e) => setFilters({ ...filters, receivedFrom: e.target.value })} />
          </Field>
          <Field label="Received to">
            <input type="date" value={filters.receivedTo} onChange={(e) => setFilters({ ...filters, receivedTo: e.target.value })} />
          </Field>
        </div>
        <fieldset>
          <legend>Bureau</legend>
          <div className="row">
            {(meta?.bureaus ?? []).map((b: any) => (
              <label key={b.code} className="check">
                <input
                  type="checkbox"
                  checked={filters.bureau.includes(b.code)}
                  onChange={() =>
                    setFilters({
                      ...filters,
                      bureau: filters.bureau.includes(b.code) ? filters.bureau.filter((x) => x !== b.code) : [...filters.bureau, b.code],
                    })
                  }
                />
                {b.code}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Status</legend>
          <div className="row">
            {(meta?.statuses ?? []).map((s: string) => (
              <label key={s} className="check">
                <input
                  type="checkbox"
                  checked={filters.status.includes(s)}
                  onChange={() =>
                    setFilters({
                      ...filters,
                      status: filters.status.includes(s) ? filters.status.filter((x) => x !== s) : [...filters.status, s],
                    })
                  }
                />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        {data && (
          <div className="filter-summary">
            <strong>Snapshot:</strong> {fmtDateTime(data.snapshotAt)} · timezone {data.timezone} · {JSON.stringify(data.filters)}
          </div>
        )}
      </Card>

      <ErrorNote error={error} onRetry={() => void load()} />

      {loading && !data ? (
        <Card title="Loading report">
          <Loading label="Aggregating permitted cases…" rows={5} />
        </Card>
      ) : !data ? null : data.totals.current === 0 ? (
        <EmptyState
          title="No cases match these filters"
          body="Widen the filters, or check that cases exist in your bureau, region and grants."
          action={
            <button
              type="button"
              className="btn"
              onClick={() => setFilters({ bureau: [], status: [], category: [], region: '', receivedFrom: '', receivedTo: '' })}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="grid grid-6">
            <Stat label="Current total" value={totals.current} hint="All visible cases in the snapshot" tone="blue" onClick={() => drill({})} />
            <Stat label="Pending" value={totals.pending} hint="Received → Awaiting response" tone="indigo" onClick={() => drill({ pending: '1' })} />
            <Stat label="Overdue" value={totals.overdue} hint="Configured deadline breached" tone="red" onClick={() => drill({ overdue: '1' })} />
            <Stat label="Transferred" value={totals.transferred} hint="Accepted events in period" tone="violet" onClick={() => drill({})} />
            <Stat label="Escalated" value={totals.escalated} hint="Open escalation flag" tone="amber" onClick={() => drill({ escalated: '1' })} />
            <Stat
              label="Disposals in period"
              value={totals.disposalsInPeriod}
              hint={`${totals.currentlyDisposed} currently disposed`}
              tone="green"
              onClick={() => drill({ status: 'Disposed' })}
            />
          </div>

          <Notice tone="info">
            <strong>Definitions in use</strong>
            Pending: Received, Assigned, Under review and Awaiting response. Overdue: pending cases with a configured disposal due time earlier
            than the snapshot. Transferred: accepted transfer events in the period — not an extra lifecycle state. Escalated: cases with an open
            escalation flag shown alongside their lifecycle state. Disposal throughput is labelled separately from current disposed cases.
            {totals.noDeadlineConfigured > 0 &&
              ` ${totals.noDeadlineConfigured} pending case(s) have no policy configured and are never marked overdue.`}
          </Notice>

          <div className="split-wide">
            <Card title="By lifecycle state" subtitle={`${totals.current} current total — each case has exactly one state`}>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>State</th>
                      <th>Cases</th>
                      <th>Drill down</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.byStatus as Record<string, number>).map(([state, n]) => (
                      <tr key={state}>
                        <td>{state}</td>
                        <td className="num">{n}</td>
                        <td>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => drill({ status: state })}>
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Active-case ageing" subtitle="Measured from receipt; completed processing duration is reported separately">
              {Object.entries(data.ageing as Record<string, number>).map(([bucket, n]) => (
                <Bar key={bucket} label={`${bucket} days`} value={n} max={maxAgeing} tone={bucket === '90+' ? 'red' : bucket === '61-90' ? 'amber' : 'indigo'} />
              ))}
              <p className="small muted" style={{ marginTop: 10 }}>
                Average completed processing duration: {totals.avgProcessingDays === null ? 'no disposed cases yet' : `${totals.avgProcessingDays} days`}.
              </p>
            </Card>
          </div>

          <div className="split-wide">
            <Card title="By bureau" subtitle="Totals reconcile with the drill-down lists">
              {Object.entries(data.byBureau as Record<string, { total: number; pending: number; overdue: number }>).map(([bureau, v]) => (
                <div key={bureau} style={{ marginBottom: 10 }}>
                  <Bar label={`${bureau}`} value={v.total} max={maxBureau} tone="blue" />
                  <p className="small muted" style={{ marginLeft: 160 }}>
                    {v.pending} pending · {v.overdue} overdue
                  </p>
                </div>
              ))}
            </Card>

            <Card title="Workload by owner" subtitle="Active cases only">
              <div className="table-wrap scroll-y">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>Bureau</th>
                      <th>Pending</th>
                      <th>Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.workload as any[]).map((w) => (
                      <tr key={`${w.officer}-${w.bureau}`}>
                        <td>{w.officer}</td>
                        <td>{w.bureau}</td>
                        <td className="num">{w.pending}</td>
                        <td className="num">{w.overdue > 0 ? <Pill tone="red">{w.overdue}</Pill> : 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card title="By category">
            {Object.entries(data.byCategory as Record<string, number>)
              .sort((a, b) => b[1] - a[1])
              .map(([category, n]) => (
                <Bar key={category} label={category} value={n} max={Math.max(...Object.values(data.byCategory as Record<string, number>))} tone="indigo" />
              ))}
          </Card>

          <p className="small muted">
            Report rule version {data.ruleVersion} · exported files carry the snapshot time and filters in their header line.
          </p>
        </div>
      )}
    </>
  );
}
