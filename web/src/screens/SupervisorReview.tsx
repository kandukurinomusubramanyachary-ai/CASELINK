import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, m3EvidenceBlob } from '../api';
import { useApp } from '../App';
import './SupervisorReview.css';

type ReviewState = 'pending' | 'needs_review' | 'awaiting_evidence' | 'accepted';
type ReviewAction = 'accept' | 'needs_review' | 'request_evidence' | 'resume';
type CaseSummary = {
  id: string; caseNumber: string; institutionName: string | null;
  region: string | null; bureau: string; category: string; status: string;
  version: number; receivedAt: string; summary: string;
  attachments: Array<{ id: string; originalName: string; mime: string; size: number; uploadedAt: string }>;
  history: Array<{ id: string; at: string; actionType: string; remarks: string | null; actorName: string }>;
};
type ReviewDetail = {
  id: string; sentAt: string; ruleVersion: string; handoffReason: string;
  suggestionState: string;
  review: { state: ReviewState; version: number; note: string | null };
  comparison: { method: string; reasons: Array<{ rule: string; detail: string; sourceField: string }> };
  caseA: CaseSummary; caseB: CaseSummary;
  auditEvents: Array<{ id: string; action: string; at: string; actorName: string; reason: string }>;
};
type QueueItem = { id: string; sentAt: string; state: ReviewState;
  caseA: { caseNumber: string; category: string };
  caseB: { caseNumber: string; category: string } };
const date = (value: string) => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const pretty = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
function EvidenceList({ reviewId, c, onOpen }: { reviewId: string; c: CaseSummary; onOpen: (reviewId: string, a: CaseSummary['attachments'][number]) => void }) {
  return <section className="m3-evidence" aria-label={`Evidence for ${c.caseNumber}`}>
    <h4>Protected evidence <small>({c.attachments.length} files)</small></h4>
    {c.attachments.length === 0 ? <p className="m3-muted">No published evidence is currently available.</p> :
      <div className="m3-files">{c.attachments.map(file => <button key={file.id} type="button" className="m3-file" onClick={() => onOpen(reviewId,file)}>
        <span aria-hidden="true">{file.mime.startsWith('image/') ? '▧' : file.mime === 'application/pdf' ? '▤' : '▦'}</span>
        <strong title={file.originalName}>{file.originalName}</strong><small>{(file.size/1024).toFixed(0)} KB</small>
      </button>)}</div>}
  </section>;
}
function CaseCard({ label, reviewId, c, onOpen }: { label: 'A'|'B'; reviewId: string; c: CaseSummary; onOpen: (r: string, a: CaseSummary['attachments'][number]) => void }) {
  const [showHistory,setShowHistory]=useState(false);
  return <article className="m3-card m3-case">
    <header className={`m3-case-head m3-case-head-${label.toLowerCase()}`}>
      <span className="m3-letter">{label}</span><h3>Complaint {label}</h3><span className="m3-state">{c.status}</span>
    </header>
    <dl className="m3-fields">
      <dt>Case ID</dt><dd>{c.caseNumber}</dd>
      <dt>Institution</dt><dd>{c.institutionName ?? 'Unresolved institution'}</dd>
      <dt>Category</dt><dd>{c.category}</dd>
      <dt>Region</dt><dd>{c.region ?? 'Unresolved region'}</dd>
      <dt>Bureau</dt><dd>{c.bureau}</dd>
      <dt>Filed</dt><dd>{date(c.receivedAt)}</dd>
      <dt>Version</dt><dd>{c.version}</dd>
    </dl>
    <h4>Complaint summary</h4><p className="m3-summary">{c.summary}</p>
    <EvidenceList reviewId={reviewId} c={c} onOpen={onOpen} />
    <button className="m3-light-btn m3-full" type="button" aria-expanded={showHistory} onClick={()=>setShowHistory(v=>!v)}>
      {showHistory?'Hide':'Inspect'} independent timeline ({c.history.length})
    </button>
    {showHistory && <ol className="m3-timeline">{c.history.map(event=><li key={event.id}>
      <time>{date(event.at)}</time><strong>{pretty(event.actionType)}</strong>
      <span>{event.actorName}</span>{event.remarks && <p>{event.remarks}</p>}
    </li>)}</ol>}
  </article>;
}
export default function SupervisorReviewScreen({ focus }: { focus?: string }) {
  const { go, session } = useApp();
  const [queue,setQueue]=useState<QueueItem[]>([]);
  const [selected,setSelected]=useState<string | null>(focus??null);
  const [detail,setDetail]=useState<ReviewDetail|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [reason,setReason]=useState('');
  const [action,setAction]=useState<ReviewAction>('accept');
  const [saving,setSaving]=useState(false);
  const [preview,setPreview]=useState<{ url:string; fileName:string; mime:string } | null>(null);
  const [previewError,setPreviewError]=useState('');
  const closePreview = useCallback(() => {
    setPreview(p => { if(p) URL.revokeObjectURL(p.url); return null; });
    setPreviewError('');
  },[]);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url);},[preview]);
  const load = useCallback(async (id: string | null) => {
    setLoading(true);setError('');
    try{
      if(id) {const result=await api.m3Review(id) as ReviewDetail;setDetail(result);}
      else {const result=await api.m3Reviews() as {reviews:QueueItem[]};setQueue(result.reviews);setDetail(null);}
    }catch(e){setError(e instanceof Error ? e.message:'Review failed to load.');setDetail(null);}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load(selected);},[selected,load]);
  const openEvidence = async (reviewId:string, file:CaseSummary['attachments'][number]) => {
    closePreview();
    try{
      const blob=await m3EvidenceBlob(reviewId,file.id);
      setPreview({url:URL.createObjectURL(blob),fileName:file.originalName,mime:file.mime});
    }catch(e){setPreviewError(e instanceof Error ?e.message:'Unable to open protected evidence.');}
  };
  const submit = async () => {
    if(!detail || reason.trim().length < 10 || saving)return;
    setSaving(true);setError('');
    try{
      const result=await api.m3ReviewAction(detail.id,action,reason,detail.review.version) as { detail: ReviewDetail };
      setDetail(result.detail);setReason('');
    }catch(e){const err=e as ApiError;setError(err.status===409?'Another update occurred. Reload this review and try again.':err.message);}
    finally{setSaving(false);}
  };
  if(session.user?.role!=='supervisor') return <section className="m3-page"><h1>Supervisor Review</h1>
    <p>This workspace requires a supervisor account and permission to both complaints.</p></section>;
  return <div className="m3-page">
    <header className="m3-heading"><div><p className="m3-kicker">CASELINK / Overlap Detection</p>
      <h1>M3 — Supervisor Review</h1><p>Independent, evidence-first review of potentially overlapping institutional grievances.</p></div>
      <span className="m3-permission">◈ Current supervisor access is verified on every request</span></header>
    {error&&<div className="m3-error" role="alert">{error} <button type="button" onClick={()=>void load(selected)}>Reload</button></div>}
    {previewError&&<div className="m3-error" role="alert">{previewError}</div>}
    {loading?<p role="status">Loading authorized review records…</p>:!detail? <section className="m3-card m3-queue">
      <h2>Assigned supervisor reviews</h2><p className="m3-muted">Only M2 handoffs specifically sent to your account appear here.</p>
      {queue.length===0?<p className="m3-empty">No authorized review handoffs are currently available.</p>:
      <div className="m3-queue-rows">{queue.map(item=><button key={item.id} type="button" className="m3-queue-row"
        onClick={()=>{setSelected(item.id);go(`#/supervisor-review/${item.id}`);}}>
        <div><strong>{item.caseA.caseNumber}</strong><span>vs</span><strong>{item.caseB.caseNumber}</strong></div>
        <small>{item.caseA.category} · {item.caseB.category}</small>
        <span className="m3-state">{pretty(item.state)}</span><small>{date(item.sentAt)}</small>
      </button>)}</div>}
    </section>:<>
      <nav className="m3-actions-top"><button type="button" className="m3-light-btn" onClick={()=>{closePreview();setSelected(null);go('#/supervisor-review');}}>← Return to Review Queue</button>
        <span className="m3-state">{pretty(detail.review.state)}</span><span className="m3-muted">Review version {detail.review.version}</span></nav>
      <div className="m3-columns">
        <CaseCard key={detail.caseA.id} label="A" reviewId={detail.id} c={detail.caseA} onOpen={openEvidence}/>
        <section className="m3-card m3-comparison">
          <h3>AI-assisted comparison</h3><p className="m3-muted">Explainable, stored detection rules — no fabricated match percentage.</p>
          {detail.comparison.reasons.length===0?<p className="m3-empty">Matching factors are unavailable. Manual inspection required.</p>:
          <div className="m3-factors">{detail.comparison.reasons.map((r,i)=><div className="m3-factor" key={i}>
            <span className="m3-rule-icon">{r.rule.startsWith('different_')?'!':'✓'}</span>
            <div><strong>{pretty(r.rule)}</strong><p>{r.detail}</p><small>Source: {r.sourceField}</small></div>
          </div>)}</div>}
          <p className="m3-explain">{detail.comparison.method}</p>
          <h4>Reason for handoff</h4><p>{detail.handoffReason}</p>
          <h4>Review activity</h4>{detail.auditEvents.length===0?<p className="m3-muted">No review actions recorded yet.</p>:
          <ol className="m3-timeline">{detail.auditEvents.map(e=><li key={e.id}><time>{date(e.at)}</time>
            <strong>{pretty(e.action)}</strong><span>{e.actorName}</span><p>{e.reason}</p></li>)}</ol>}
        </section>
        <CaseCard key={detail.caseB.id} label="B" reviewId={detail.id} c={detail.caseB} onOpen={openEvidence}/>
      </div>
      <section className="m3-card m3-decision-panel">
        <div><h2>Supervisor action</h2><p className="m3-muted">Review actions do not decide whether complaints are Same, Related or Separate.</p></div>
        {detail.review.state==='accepted' ? <p className="m3-accepted">✓ Accepted for M4 relationship decision. Both original complaints remain unchanged.</p>:
        <div className="m3-review-form">
          <label htmlFor="m3-action">Review outcome</label>
          <select id="m3-action" value={action} onChange={e=>setAction(e.target.value as ReviewAction)}>
            <option value="accept">Accept for Decision</option><option value="request_evidence">Request More Evidence</option>
            <option value="needs_review">Needs Manual Inspection</option>
            {detail.review.state!=='pending'&&<option value="resume">Resume Review</option>}
          </select>
          <label htmlFor="m3-reason">Reason (required)</label>
          <textarea id="m3-reason" value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}
            placeholder="Record the evidence you examined and why this action is appropriate…" rows={3}/>
          <button type="button" className="m3-primary-btn" disabled={saving||reason.trim().length<10} onClick={()=>void submit()}>
            {saving?'Recording…':'Record Supervisor Action'}
          </button>
        </div>}
      </section>
    </>}
    {preview && <div className="m3-preview-layer" role="presentation" onClick={closePreview}><div role="dialog" aria-modal="true" aria-label={`Evidence preview: ${preview.fileName}`} className="m3-preview-dialog" onClick={e=>e.stopPropagation()}>
      <div><strong>{preview.fileName}</strong><button className="m3-light-btn" type="button" onClick={closePreview}>Close</button></div>
      {['application/pdf','image/png','image/jpeg','image/webp','text/plain'].includes(preview.mime) ?
        <iframe title={preview.fileName} src={preview.url} className="m3-preview-content"/>:
        <p>This file type cannot be previewed securely. Use the authorized download.</p>}
      <a href={preview.url} download={preview.fileName} className="m3-light-btn">Download authorized copy</a>
    </div></div>}
  </div>;
}
