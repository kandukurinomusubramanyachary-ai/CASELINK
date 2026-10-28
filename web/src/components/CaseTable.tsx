import React from 'react';
import type { CaseRow } from '../api';
import { DeadlineChip, MaskedBadge, PriorityChip, StatusPill } from '../ui';
import { fmtDate, fmtDateTime, relativeDays } from '../util';

export function CaseTable({
  cases,
  actions,
  showInstitution = true,
  showNextAction = true,
  emptyMessage = 'No cases in this view.',
}: {
  cases: CaseRow[];
  actions?: (c: CaseRow) => React.ReactNode;
  showInstitution?: boolean;
  showNextAction?: boolean;
  emptyMessage?: string;
}) {
  if (cases.length === 0) {
    return <p className="muted small" style={{ padding: '10px 0' }}>{emptyMessage}</p>;
  }
  return (
    <div className="table-wrap">
      <table className="data case-table" aria-label="Cases">
        <thead>
          <tr>
            <th scope="col">Case</th>
            {showInstitution && <th scope="col">Institution</th>}
            <th scope="col">Bureau</th>
            <th scope="col">Status</th>
            {showNextAction && <th scope="col">Next action</th>}
            <th scope="col">Owner</th>
            <th scope="col">Disposal deadline</th>
            {actions && <th scope="col" style={{ textAlign: 'right' }}>Action</th>}
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td data-label="Case" className="case-cell-reference">
                <a href={`#/cases/${c.id}`} className="case-number">
                  {c.caseNumber}
                </a>
                <span className="cell-sub">
                  {c.category} · received {fmtDate(c.receivedAt)}
                </span>
                <span className="row" style={{ marginTop: 4, gap: 4 }}>
                  <PriorityChip priority={c.priority} />
                  {c.access === 'restricted' && <MaskedBadge />}
                  {c.escalationOpen && <span className="pill pill-red">Escalation</span>}
                  {c.pendingTransfer && <span className="pill pill-violet">Transfer pending</span>}
                </span>
              </td>
              {showInstitution && (
                <td data-label="Institution" className="case-cell-institution">
                  <span className="cell-strong">{c.institutionName ?? c.intakeInstitutionText ?? 'Unresolved'}</span>
                  <span className="cell-sub">{c.institutionPermanentId ?? 'Triage — no permanent ID'}</span>
                </td>
              )}
              <td data-label="Bureau">{c.bureau}</td>
              <td data-label="Status">
                <StatusPill status={c.status} />
                <span className="cell-sub">{c.ageDays} days old</span>
              </td>
              {showNextAction && (
                <td data-label="Next action" className="case-cell-next">
                  <span>{c.nextAction ?? <span className="muted">Not recorded</span>}</span>
                  {c.nextActionDueAt && <span className="cell-sub">due {fmtDate(c.nextActionDueAt)} ({relativeDays(c.nextActionDueAt)})</span>}
                </td>
              )}
              <td data-label="Owner">
                <span>{c.access === 'restricted' ? c.ownerRole : c.assignedOfficerName ?? 'Unassigned queue'}</span>
                <span className="cell-sub">
                  {c.lastActionAt ? `last action ${fmtDateTime(c.lastActionAt)}` : 'no action recorded'}
                </span>
              </td>
              <td data-label="Disposal deadline">
                <DeadlineChip state={c.deadlineState} />
                <span className="cell-sub">{c.expectedDisposalAt ? fmtDate(c.expectedDisposalAt) : 'No deadline configured'}</span>
              </td>
              {actions && <td data-label="Action" className="case-cell-actions"><div className="cell-actions">{actions(c)}</div></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
