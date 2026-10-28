import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { useApp } from '../App';
import { Card, ErrorNote, Field, Notice, Pill, useToast } from '../ui';

const SAMPLE = `institution_permanent_id,institution_name_if_unconfirmed,received_date,source_system,source_reference,category,complaint_summary,assigned_officer_username,policy_id,complainant_contact
AICTE-DEMO-1001,,2026-09-12,Legacy grievance register,DEMO-LGR-9001,Certificate / documentation,Duplicate retention certificate not issued after six reminders.,p.rao,DEMO-POL-30,
,,2026-09-14,Legacy grievance register,DEMO-LGR-9002,Other,Sri Ranga College scholarship form rejected without a stated reason.,,DEMO-POL-30,
AICTE-DEMO-1001,,2026-09-15,Legacy grievance register,DEMO-LGR-9001,Certificate / documentation,Duplicate retention certificate not issued after six reminders.,p.rao,DEMO-POL-30,
AICTE-DEMO-9999,,2026-09-16,Legacy grievance register,DEMO-LGR-9003,Infrastructure,Bench repair request.,p.rao,DEMO-POL-30,`;

export default function ImportScreen() {
  const { session } = useApp();
  const { push } = useToast();
  const [sourceSystem, setSourceSystem] = useState('Legacy grievance register');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [committed, setCommitted] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const canImport = ['bureau_lead'].includes(session.user!.role);

  if (!canImport) {
    return (
      <Card title="CSV import">
        <div className="denied" style={{ padding: '20px 0' }}>
          <h2>Import is a bureau lead action</h2>
          <p>
            Ask a lead in {session.user!.bureau ?? 'your bureau'} to import the register, or register individual cases from the Cases screen.
            Permission checks apply equally to preview, commit and download requests.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>CSV import</h1>
          <p className="page-sub">
            Preview, per-row validation and a separate commit. Only valid, confirmed rows are imported; a repeated source system, bureau and
            reference never creates another case. Limit 500 rows per batch.
          </p>
        </div>
        <div className="page-actions">
          <a className="btn" href={api.templateUrl()}>
            Download template
          </a>
          <button type="button" className="btn" onClick={() => setCsvText(SAMPLE)}>
            Load sample rows
          </button>
        </div>
      </div>

      <Card title="1 · Source and file" subtitle="Every imported row must carry a stable external reference for duplicate protection.">
        <Field label="Source system" required hint="Recorded on each imported case for provenance.">
          <input value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)} />
        </Field>
        <Field label="Upload a CSV file" hint="Or paste the rows below. The server re-validates everything it receives.">
          <input
            type="file"
            accept="text/csv,.csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setCsvText(await file.text());
            }}
          />
        </Field>
        <Field label="CSV content" required>
          <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={8} spellCheck={false} className="mono" />
        </Field>
        <ErrorNote error={error} />
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || csvText.trim().length < 10}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setCommitted(null);
              try {
                const res = await api.importPreview(sourceSystem, csvText);
                setPreview(res);
                push({ tone: 'info', title: 'Preview ready', body: 'Nothing is saved yet. Review the rows, then commit.' });
              } catch (err) {
                setError(err as ApiError);
                setPreview(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Validating…' : 'Validate and preview'}
          </button>
        </div>
      </Card>

      {preview && (
        <Card
          title="2 · Preview"
          subtitle={`${preview.rows.length} row(s) checked against ${preview.sourceSystem} · accepted ${preview.counts.accepted} · rejected ${preview.counts.rejected} · skipped ${preview.counts.skipped}`}
          actions={
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || preview.counts.accepted === 0}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await api.importCommit(preview.batchId);
                  setCommitted(res);
                  push({
                    tone: 'success',
                    title: 'Batch committed',
                    body: `${res.accepted} case(s) created, ${res.rejected} rejected, ${res.skipped} skipped.`,
                  });
                } catch (err) {
                  setError(err as ApiError);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Commit {preview.counts.accepted} valid row(s)
            </button>
          }
        >
          <Notice tone="warn">
            <strong>Preview only</strong>
            Nothing is saved until commit. A row's identity is the source system, the owning bureau and the external reference; a repeated
            identity is skipped as an unchanged duplicate (identical content) or held for review (different content) — never overwritten.
            A blank policy means <strong>No deadline configured</strong>: the importer never invents a deadline.
          </Notice>
          <div className="table-wrap">
            <table className="data import-rows">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Status</th>
                  <th>Institution</th>
                  <th>Reference</th>
                  <th>Category</th>
                  <th>Deadline</th>
                  <th>Summary</th>
                  <th>Notes / errors</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r: any) => (
                  <tr key={r.lineNumber} className={`row-${r.status}`}>
                    <td className="num">{r.lineNumber}</td>
                    <td>
                      <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                    </td>
                    <td className="mono small">{r.values.institution_permanent_id || r.values.institution_name_if_unconfirmed || '—'}</td>
                    <td className="mono small">{r.values.source_reference || '—'}</td>
                    <td className="small">{r.values.category}</td>
                    <td className="small">
                      {r.deadlineLabel ?? (r.values.policy_id ? r.values.policy_id : 'No deadline configured')}
                      {!r.values.policy_id && <span className="muted"> (no policy in file)</span>}
                    </td>
                    <td className="small" style={{ maxWidth: 320 }}>
                      {r.values.complaint_summary}
                    </td>
                    <td className="small">
                      {r.errors.length > 0 ? <span style={{ color: 'var(--red)' }}>{r.errors.join(' ')}</span> : r.note ?? 'Ready to import'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {committed && (
        <Card title="3 · Commit result">
          <div className="grid grid-3">
            <div className="stat stat-green">
              <span className="stat-label">Accepted</span>
              <span className="stat-value">{committed.accepted}</span>
              <span className="stat-hint">{committed.createdCaseNumbers.join(', ')}</span>
            </div>
            <div className="stat stat-red">
              <span className="stat-label">Rejected</span>
              <span className="stat-value">{committed.rejected}</span>
              <span className="stat-hint">{committed.failures.map((f: any) => `line ${f.lineNumber}`).join(', ') || 'none'}</span>
            </div>
            <div className="stat stat-amber">
              <span className="stat-label">Skipped</span>
              <span className="stat-value">{committed.skipped}</span>
              <span className="stat-hint">{committed.skips.map((s: any) => `line ${s.lineNumber}`).join(', ') || 'none'}</span>
            </div>
          </div>
          {(committed.newConflicts ?? []).length > 0 && (
            <Notice tone="warn">
              <strong>New conflicts found at commit</strong>
              {(committed.newConflicts as any[]).map((c) => (
                <div key={`nc-${c.lineNumber}`} className="small">
                  Line {c.lineNumber}: {c.reason}
                </div>
              ))}
            </Notice>
          )}
          <p className="small muted">
            Batch {committed.batchId.slice(0, 8)} committed. Imported cases record the batch, the source system and both received and import
            times. Triage rows stay out of automatic overlap checks until identity is resolved.
          </p>
        </Card>
      )}
    </>
  );
}

function statusTone(status: string): string {
  return status === 'valid' ? 'green' : status === 'triage' ? 'amber' : status === 'rejected' ? 'red' : 'violet';
}
