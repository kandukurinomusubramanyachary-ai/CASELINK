import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, m3EvidenceBlob } from '../api';
import { useApp } from '../App';
import './RelationshipDecision.css';
type Choice = 'Same'|'Related'|'Separate';
type RecordCase={
  id:string;caseNumber:string;institutionName:string|null;category:string;
  bureau:string;region:string|null;status:string;version:number;summary:string;receivedAt:string;
  attachments:Array<{id:string;originalName:string;mime:string;size:number}>;
  history:Array<{id:string;at:string;actionType:string;remarks:string|null;actorName:string}>;
};
type Decision={
  id:string;decision:Choice;reason:string;reasonCategory:string;state:string;version:number;
  relationshipId:string|null;decidedAt:string;reversedAt:string|null;reversalReason:string|null;
};
type Detail={
  handoffId:string;eligible:boolean;review:{state:string;version:number}|null;
  caseA:RecordCase;caseB:RecordCase;
  draft:{decision:Choice;reason:string;reasonCategory:string;version:number}|null;
  activeDecision:Decision|null;decisions:Decision[];
  auditEvents:Array<{id:string;action:string;reason:string;at:string;actorName:string;fromState:string;toState:string}>;
  assignmentBoundary:unknown;
};
const choices:Array<{id:Choice;title:string;description:string;icon:string}>=[
  {id:'Same',title:'Same',description:'Two reports of the same underlying grievance. Both originals remain intact.',icon:'◎'},
  {id:'Related',title:'Related',description:'Connected concerns or incidents, but separate complaints and case owners.',icon:'◇'},
  {id:'Separate',title:'Separate',description:'No justified active relationship. Both cases continue independently.',icon:'▤'},
];
const date=(s:string)=>new Date(s).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'});
const reasonCategories=['Same incident','Shared institution','Same time period','Similar allegations','Distinct complainants','Conflicting evidence','Independent issue'];
function CasePanel({c,label,onEvidence}:{c:RecordCase;label:'A'|'B';onEvidence:(c:RecordCase,attachment:RecordCase['attachments'][number])=>void}) {
  const [show,setShow]=useState(true);
  return <article className="m4-card m4-case">
    <div className="m4-case-heading"><span className={`m4-marker m4-marker-${label.toLowerCase()}`}>{label}</span>
      <h3>Complaint {label}</h3><span className="m4-state">{c.status}</span></div>
    <dl className="m4-fields">
      <dt>Case ID</dt><dd>{c.caseNumber}</dd>
      <dt>Institution</dt><dd>{c.institutionName??'Unresolved'}</dd>
      <dt>Category</dt><dd>{c.category}</dd>
      <dt>Bureau</dt><dd>{c.bureau}</dd>
      <dt>Region</dt><dd>{c.region??'Unresolved'}</dd>
      <dt>Filed</dt><dd>{date(c.receivedAt)}</dd>
    </dl>
    <h4>Summary</h4><p className="m4-subtext">{c.summary}</p>
    <h4>Protected evidence ({c.attachments.length})</h4>
    <div className="m4-evidence">{c.attachments.length?c.attachments.map(a=><button type="button" key={a.id}
      title={a.originalName} onClick={()=>onEvidence(c,a)}>
      <span>{a.mime==='application/pdf'?'▤':'▧'}</span><strong>{a.originalName}</strong></button>):
      <p>No published attachments.</p>}</div>
    <button type="button" className="m4-light m4-wide" aria-expanded={show} onClick={()=>setShow(!show)}>
      {show?'Hide':'Show'} preserved case timeline ({c.history.length})
    </button>
    {show&&<ol className="m4-events">{c.history.map(e=><li key={e.id}>
      <time>{date(e.at)}</time><strong>{e.actionType.replaceAll('_',' ')}</strong>
      <span>{e.actorName}</span>{e.remarks&&<p>{e.remarks}</p>}
    </li>)}</ol>}
  </article>;
}
export default function RelationshipDecisionScreen({id}:{id:string}){
  const {go,session}=useApp();
  const [detail,setDetail]=useState<Detail|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [choice,setChoice]=useState<Choice>('Related');
  const [category,setCategory]=useState('Same incident');
  const [reason,setReason]=useState('');
  const [reversalReason,setReversalReason]=useState('');
  const [preview,setPreview]=useState<{url:string;name:string;mime:string}|null>(null);
  const closePreview=useCallback(()=>setPreview(p=>{if(p)URL.revokeObjectURL(p.url);return null;}),[]);
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url);},[preview]);
  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const next=await api.m4Decision(id) as Detail;
      setDetail(next);
      if(next.draft){setChoice(next.draft.decision);setCategory(next.draft.reasonCategory);setReason(next.draft.reason);}
    }catch(e){setError(e instanceof Error?e.message:'Decision could not be loaded.');setDetail(null);}
    finally{setLoading(false);}
  },[id]);
  useEffect(()=>{void load();},[load]);
  const showEvidence=async(_c:RecordCase,attachment:RecordCase['attachments'][number])=>{
    closePreview();setError('');
    try{const blob=await m3EvidenceBlob(id,attachment.id);
      setPreview({url:URL.createObjectURL(blob),name:attachment.originalName,mime:attachment.mime});
    }catch(e){setError(e instanceof Error?e.message:'Unauthorized evidence.');}
  };
  const submit=async(kind:'draft'|'confirm'|'reverse')=>{
    if(!detail||busy)return;
    setBusy(true);setNotice('');setError('');
    try{
      if(kind==='draft'){
        await api.m4SaveDraft(id,{decision:choice,reasonCategory:category,reason,
          expectedDraftVersion:detail.draft?.version??0});
        setNotice('Draft saved; no relationship has been confirmed.');
      }else if(kind==='confirm'){
        const key='m4-'+crypto.randomUUID();
        await api.m4Confirm(id,{decision:choice,reasonCategory:category,reason,
          caseAVersion:detail.caseA.version,caseBVersion:detail.caseB.version,
          reviewVersion:detail.review!.version},key);
        setNotice('Relationship decision confirmed and recorded in the immutable audit ledger.');
      }else{
        if(!detail.activeDecision)throw Error('No confirmed decision to reverse.');
        await api.m4Reverse(id,{decisionId:detail.activeDecision.id,reason:reversalReason,
          decisionVersion:detail.activeDecision.version,
          caseAVersion:detail.caseA.version,caseBVersion:detail.caseB.version},
          'm4-'+crypto.randomUUID());
        setNotice('Decision reversed. Both complaint histories remain preserved.');
        setReversalReason('');
      }
      await load();
    }catch(e){const err=e as ApiError;setError(err.status===409?'The decision or complaint versions changed. Reload and review current values.':err.message);}
    finally{setBusy(false);}
  };
  if(session.user?.role!=='supervisor')return <div className="m4-page"><h1>Relationship Decision</h1>
    <p>This workspace requires a supervisor account with access to both complaints.</p></div>;
  return <main className="m4-page">
    <header className="m4-header"><div><p className="m4-kicker">CASELINK / Overlap Detection</p>
      <h1>M4 — Relationship Decision</h1>
      <p>Human classification with reversible links and permanent independent case histories.</p></div>
      <span className="m4-authorized">◈ Authorized supervisors only — server-side checks</span></header>
    <nav className="m4-top-actions"><button type="button" className="m4-light" onClick={()=>go('#/supervisor-review/'+id)}>← Back to Supervisor Review</button>
      <button type="button" className="m4-light" onClick={()=>void load()} disabled={loading}>Refresh versions</button></nav>
    {error&&<div className="m4-alert" role="alert">{error}</div>}
    {notice&&<div className="m4-success" role="status">{notice}</div>}
    {loading?<p role="status">Loading current authorized decision record…</p>:detail&&<>
      {!detail.eligible&&<p className="m4-alert">M3 review is not accepted. A relationship decision cannot be confirmed.</p>}
      <div className="m4-layout">
        <CasePanel key={detail.caseA.id} c={detail.caseA} label="A" onEvidence={showEvidence}/>
        <CasePanel key={detail.caseB.id} c={detail.caseB} label="B" onEvidence={showEvidence}/>
        <div className="m4-controls">
          <section className="m4-card m4-choice-panel"><h2>Relationship classification</h2>
            <p className="m4-subtext">Choose one classification based on the evidence; no AI score is an automatic decision.</p>
            <div className="m4-choices">{choices.map(option=><label className={`m4-choice ${choice===option.id?'m4-selected':''}`} key={option.id}>
              <input type="radio" name="relationship-type" value={option.id} checked={choice===option.id}
                disabled={!!detail.activeDecision||!detail.eligible} onChange={()=>setChoice(option.id)}/>
              <span className="m4-choice-icon">{option.icon}</span><strong>{option.title}</strong><small>{option.description}</small>
            </label>)}</div>
            <h4>Reason category</h4><div className="m4-chips">{reasonCategories.map(c=><button key={c} type="button"
              disabled={!!detail.activeDecision||!detail.eligible} onClick={()=>setCategory(c)}
              className={`m4-chip ${c===category?'m4-chip-selected':''}`}>{c}</button>)}</div>
            <label htmlFor="m4-reason" className="m4-form-label">Detailed explanation (required)</label>
            <textarea id="m4-reason" value={reason} onChange={e=>setReason(e.target.value)}
              disabled={!!detail.activeDecision||!detail.eligible} placeholder="Explain supporting and conflicting evidence…" maxLength={1000} rows={4}/>
            <div className="m4-form-actions">
              <button className="m4-primary" type="button" disabled={!detail.eligible||!!detail.activeDecision||reason.trim().length<10||busy}
                onClick={()=>void submit('confirm')}>{busy?'Recording…':'Confirm Decision'}</button>
              <button className="m4-light" type="button" disabled={!detail.eligible||!!detail.activeDecision||reason.trim().length<10||busy}
                onClick={()=>void submit('draft')}>Save Draft</button></div>
            <p className="m4-fine">Drafts do not count as approved relationships. Confirmation preserves both original cases.</p>
          </section>
          <section className="m4-card m4-decision-history">
            <h2>Decision and reversal</h2>
            {detail.activeDecision?<div className="m4-confirmed">
              <strong>Confirmed: {detail.activeDecision.decision}</strong>
              <p>{detail.activeDecision.reason}</p><small>Approved {date(detail.activeDecision.decidedAt)}</small>
            </div>:<p className="m4-subtext">No active confirmed relationship for this pair.</p>}
            {detail.activeDecision&&<div className="m4-reverse">
              <label htmlFor="m4-reversal-reason" className="m4-form-label">Reversal reason (required)</label>
              <textarea id="m4-reversal-reason" value={reversalReason} rows={3} maxLength={1000}
                onChange={e=>setReversalReason(e.target.value)}
                placeholder="Document why the previous decision must be reversed…"/>
              <button type="button" className="m4-light" disabled={busy||reversalReason.trim().length<10}
                onClick={()=>void submit('reverse')}>Undo / Reverse Decision</button>
            </div>}
            <h4>Decision history ({detail.decisions.length})</h4>
            {detail.decisions.map(d=><div className="m4-history-row" key={d.id}>
              <strong>{d.decision}</strong><span className="m4-state">{d.state}</span>
              <small>{date(d.decidedAt)}</small><p>{d.reason}</p>
              {d.reversalReason&&<p><strong>Reversal:</strong> {d.reversalReason}</p>}
            </div>)}
          </section>
        </div>
      </div>
      <section className="m4-card m4-audit">
        <div className="m4-audit-header"><h2>Persisted audit history</h2><span className="m4-state">Append-only events</span></div>
        {detail.auditEvents.length===0?<p>No decision actions recorded yet.</p>:
          <ol className="m4-events">{detail.auditEvents.map(e=><li key={e.id}>
            <time>{date(e.at)}</time><strong>{e.action.replaceAll('_',' ')}</strong>
            <span>{e.actorName} · {e.fromState} → {e.toState}</span><p>{e.reason}</p>
          </li>)}</ol>}
      </section>
      <section className="m4-preserve">✓ Both case histories, original evidence, statuses and ownership remain independent. No destructive merge is performed.</section>
    </>}
    {preview&&<div className="m4-preview-layer" role="presentation" onClick={closePreview}>
      <div className="m4-preview" role="dialog" aria-modal="true" aria-label={preview.name} onClick={e=>e.stopPropagation()}>
        <div><strong>{preview.name}</strong><button type="button" className="m4-light" onClick={closePreview}>Close</button></div>
        {['application/pdf','image/png','image/jpeg'].includes(preview.mime)?
          <iframe title={preview.name} src={preview.url} className="m4-preview-frame"/>:
          <p>Secure preview unavailable for this file format.</p>}
        <a href={preview.url} download={preview.name} className="m4-light">Download authorized copy</a>
      </div></div>}
  </main>;
}
