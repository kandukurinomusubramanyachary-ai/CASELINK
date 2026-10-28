import React from 'react';
import type { CaseDetail } from '../api';
import { actionLabel, fmtDateTime } from '../util';

export function CasePrintView({ detail }: { detail: CaseDetail }) {
  const record = detail.case;
  return <section className="print-evidence" aria-hidden="true">
    <h1>CaseLink · {record.caseNumber}</h1>
    <p>Authorized case evidence view. Fictional prototype records. Action timestamps are shown in IST.</p>
    <dl className="kv"><dt>Institution</dt><dd>{record.institutionName ?? record.intakeInstitutionText ?? 'Unresolved'}</dd><dt>Institution ID</dt><dd>{record.institutionPermanentId ?? 'Not confirmed'}</dd><dt>Case UUID</dt><dd>{record.id}</dd><dt>Status / version</dt><dd>{record.status} · v{record.version}</dd><dt>Owning bureau</dt><dd>{record.bureau}</dd><dt>Received</dt><dd>{fmtDateTime(record.receivedAt)}</dd><dt>Last record update</dt><dd>{fmtDateTime(record.updatedAt)}</dd></dl>
    <h2>Complaint record</h2><p>{detail.canViewContent ? record.complaintSummary : 'Restricted. Complaint text is not available to this account.'}</p>
    {detail.dispositions.length > 0 && <><h2>Disposition records</h2><ol>{detail.dispositions.map(item => <li key={item.id}><strong>{item.outcome}</strong> · {fmtDateTime(item.at)}<p>{item.decisionReference}</p><p>{item.note}</p></li>)}</ol></>}
    <h2>Action history</h2><ol>{detail.history.map(item => <li key={item.id}><strong>{actionLabel(item.actionType)}</strong> · {item.actorName} · {fmtDateTime(item.at)}<p>Event ID: {item.id}</p><p>{item.remarks}</p>{item.nextStep && <p>Next step: {item.nextStep}</p>}{(item.before || item.after) && <pre>{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre>}</li>)}</ol>
    {detail.attachments.length > 0 && <><h2>Evidence files</h2><ul>{detail.attachments.map(file => <li key={file.id}>{file.originalName}<pre>SHA-256: {file.sha256}</pre><p>Uploaded {fmtDateTime(file.uploadedAt)} by {file.uploadedBy}</p></li>)}</ul></>}
    <p>This view contains only data authorized for the signed-in account. A local action history is not an independently tamper-proof infrastructure guarantee.</p>
  </section>;
}
