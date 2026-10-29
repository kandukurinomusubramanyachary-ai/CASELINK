/**
 * M4 — durable, human-owned relationship decisions.
 * A completed M3 review is mandatory. No automatic merges, case ownership changes,
 * private data expansion, or assignment (M5) occur here.
 */
import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { db, nowIso, uid, tx, audit } from './db.js';
import { requireAuth, recordSecurityDenial, type SessionUser } from './auth.js';
import { canDecideRelationship, getCase, type CaseRecord } from './domain.js';
import { appendEvent, decideRelationship, revokeRelationship, guardWrite } from './service.js';
import { AppError } from './errors.js';

type RelationshipChoice = 'Same' | 'Related' | 'Separate';
type DecisionRow = {
  id: string; handoff_id: string; suggestion_id: string; pair_key: string;
  decision: RelationshipChoice; reason_category: string; reason: string;
  relationship_id: string | null; reviewer_id: string; state: 'confirmed'|'reversed';
  version: number; decided_at: string; reversed_by: string|null;
  reversed_at: string|null; reversed_reason: string|null;
};
type DraftRow = {
  decision: RelationshipChoice; reason_category: string; reason: string;
  version: number; updated_at: string;
};
type Context = {
  handoffId: string; suggestionId: string; suggestionState: string;
  a: CaseRecord; b: CaseRecord; pairKey: string;
  review: { state: string; version: number }|null;
};
type Handler = (req: Request, res: Response) => void;
const handle = (fn: Handler) => (req: Request, res: Response, next: NextFunction): void => {
  try { fn(req,res); } catch(error) { next(error); }
};
const choiceSchema = z.enum(['Same','Related','Separate']);
const reasonSchema = z.string().trim().min(10).max(1000);
const categorySchema = z.string().trim().min(3).max(100);
const versionSchema = z.number().int().nonnegative();
const keySchema = z.string().min(8).max(120).regex(/^[a-zA-Z0-9_.:-]+$/);
const pairKey = (a: string,b: string) => [a,b].sort().join('::');

function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function enforceSupervisor(req: Request): SessionUser {
  const user=req.user as SessionUser;
  if(user.role!=='supervisor'){
    recordSecurityDenial(user.id,'m4_supervisor_role_denied');
    throw new AppError(403,'access_denied','A supervisor account is required.');
  }
  return user;
}
function invisible(user: SessionUser): never {
  recordSecurityDenial(user.id,'m4_pair_access_denied');
  throw new AppError(404,'not_found','Decision record not found.');
}
function context(user: SessionUser, handoffId: string): Context {
  const row=db.prepare(
    'SELECT h.id AS handoffId, s.id AS suggestionId, s.state AS suggestionState, '+
    's.case_a_id AS caseAId, s.case_b_id AS caseBId '+
    'FROM m2_review_handoffs h JOIN suggestions s ON s.id = h.suggestion_id '+
    'WHERE h.id = ? AND h.supervisor_id = ?'
  ).get(handoffId,user.id) as {
    handoffId:string;suggestionId:string;suggestionState:string;caseAId:string;caseBId:string;
  }|undefined;
  if(!row)invisible(user);
  const a=getCase(row.caseAId),b=getCase(row.caseBId);
  // Re-use the hardened domain decision policy: explicit content access to both,
  // valid region and supervisor role. No client-supplied claims are accepted.
  if(!a || !b || !canDecideRelationship(user,a,b))invisible(user);
  const review=db.prepare(
    'SELECT state,version FROM m3_reviews WHERE handoff_id=?'
  ).get(handoffId) as {state:string;version:number}|undefined;
  return {handoffId,suggestionId:row.suggestionId,suggestionState:row.suggestionState,
    a,b,pairKey:pairKey(a.id,b.id),review:review??null};
}
function requireAccepted(c:Context): void {
  if(c.review?.state!=='accepted')
    throw new AppError(409,'m3_not_accepted','Supervisor review must be accepted before confirming a relationship.');
}
function activeDecision(pair:string):DecisionRow|null {
  return (db.prepare("SELECT * FROM m4_decisions WHERE pair_key=? AND state='confirmed'").get(pair) as DecisionRow|undefined)??null;
}
function allDecisions(c:Context): DecisionRow[] {
  return db.prepare('SELECT * FROM m4_decisions WHERE pair_key=? ORDER BY decided_at DESC,rowid DESC').all(c.pairKey) as DecisionRow[];
}
function auditEvents(c:Context){
  return db.prepare(
    'SELECT e.id,e.action,e.reason,e.at,e.from_state AS fromState,'+
    'e.to_state AS toState,e.version_after AS versionAfter,e.decision_id AS decisionId,'+
    'u.display_name AS actorName '+
    'FROM m4_decision_events e JOIN users u ON e.actor_id=u.id '+
    'WHERE e.handoff_id=? ORDER BY e.at ASC,e.rowid ASC'
  ).all(c.handoffId);
}
function appendAudit(handoffId:string, decisionId:string|null, actor:SessionUser,
  action:string, reason:string, fromState:string, toState:string, version:number): void {
  db.prepare(
    'INSERT INTO m4_decision_events '+
    '(id,handoff_id,decision_id,actor_id,action,reason,from_state,to_state,at,version_after) '+
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(uid(),handoffId,decisionId,actor.id,action,reason,fromState,toState,nowIso(),version);
}
function caseView(c:CaseRecord) {
  const history=db.prepare(
    'SELECT e.id,e.at,e.action_type AS actionType,e.remarks,e.paired_case_id AS pairedCaseId,'+
    'e.version_after AS versionAfter, u.display_name AS actorName '+
    'FROM action_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=? '+
    'ORDER BY e.at,e.rowid'
  ).all(c.id) as Array<{id:string;at:string;actionType:string;remarks:string|null;
    pairedCaseId:string|null;versionAfter:number;actorName:string}>;
  const attachments=db.prepare(
    "SELECT id,original_name AS originalName,mime,size FROM attachments WHERE case_id=? AND state='ready' ORDER BY uploaded_at"
  ).all(c.id);
  return {
    id:c.id,caseNumber:c.case_number,institutionName:c.institution_name,
    region:c.institution_region,category:c.category,bureau:c.bureau,status:c.status,
    version:c.version,summary:c.complaint_summary,receivedAt:c.received_at,
    attachments,
    history:history.map(e=>({...e,
      // A relationship remark must not become visible without access to the third case.
      remarks:e.pairedCaseId ? null : e.remarks,
    })),
  };
}
function projectDecision(row:DecisionRow){
  return { id:row.id,decision:row.decision,reason:row.reason,reasonCategory:row.reason_category,
    state:row.state,version:row.version,relationshipId:row.relationship_id,
    decidedAt:row.decided_at,reversedAt:row.reversed_at,reversalReason:row.reversed_reason };
}
function details(c:Context) {
  const draft=db.prepare(
    'SELECT decision,reason_category,reason,version,updated_at FROM m4_drafts WHERE handoff_id=?'
  ).get(c.handoffId) as DraftRow|undefined;
  return {
    handoffId:c.handoffId,suggestionId:c.suggestionId,
    suggestionState:c.suggestionState,
    eligible:c.review?.state==='accepted',review:c.review,
    pairKey:c.pairKey,caseA:caseView(c.a),caseB:caseView(c.b),
    draft:draft ? {decision:draft.decision,reason:draft.reason,
      reasonCategory:draft.reason_category,version:draft.version,updatedAt:draft.updated_at} : null,
    activeDecision:activeDecision(c.pairKey) ? projectDecision(activeDecision(c.pairKey)!) : null,
    decisions:allDecisions(c).map(projectDecision),
    auditEvents:auditEvents(c),
    // M5 consumes a constrained summary after approval; M5 is NOT implemented here.
    assignmentBoundary: activeDecision(c.pairKey)?.state==='confirmed' ? {
      status:'available_for_future_m5',pairKey:c.pairKey,caseIds:[c.a.id,c.b.id],
      relationshipDecisionId:activeDecision(c.pairKey)!.id,
    } : null,
  };
}
function requireKey(req: Request): string {
  const parsed=keySchema.safeParse(req.get('Idempotency-Key'));
  if(!parsed.success)throw new AppError(422,'idempotency_required','Supply a valid Idempotency-Key header.');
  return parsed.data;
}
function replay(user:SessionUser,scope:string,key:string,hash:string): Record<string,unknown>|null {
  const row=db.prepare(
    'SELECT request_hash,response_json FROM m4_idempotency WHERE actor_id=? AND scope=? AND key=?'
  ).get(user.id,scope,key) as {request_hash:string;response_json:string}|undefined;
  if(!row)return null;
  if(row.request_hash!==hash)throw new AppError(409,'idempotency_conflict','A different request already uses that idempotency key.');
  return JSON.parse(row.response_json) as Record<string,unknown>;
}
function saveReplay(user:SessionUser,scope:string,key:string,hash:string,result:unknown):void {
  db.prepare(
    'INSERT INTO m4_idempotency(id,actor_id,scope,key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(uid(),user.id,scope,key,hash,JSON.stringify(result),nowIso());
}
function assertVersions(c:Context,a:number,b:number):void {
  if(c.a.version!==a||c.b.version!==b)
    throw new AppError(409,'stale_case_version','Either complaint changed. Reload before proceeding.');
}

export function registerM4Routes(app:Express):void {
  app.get('/api/m4/decisions/:handoffId',requireAuth,handle((req,res)=>{
    const user=enforceSupervisor(req);
    const c=context(user,req.params.handoffId);
    res.json(details(c));
  }));

  app.post('/api/m4/decisions/:handoffId/draft',requireAuth,handle((req,res)=>{
    const user=enforceSupervisor(req);
    const c=context(user,req.params.handoffId);
    requireAccepted(c);
    const parsed=z.object({
      decision:choiceSchema,reasonCategory:categorySchema,reason:reasonSchema,
      expectedDraftVersion:versionSchema,
    }).safeParse(req.body);
    if(!parsed.success)throw new AppError(422,'validation_error','Select a decision, category, reason and current draft version.');
    if(activeDecision(c.pairKey))throw new AppError(409,'decision_exists','A confirmed decision already exists for this case pair.');
    const body=parsed.data;
    const result=tx(()=>{
      const latest=context(user,c.handoffId);
      requireAccepted(latest);
      if(activeDecision(latest.pairKey))throw new AppError(409,'decision_exists','A confirmed decision already exists.');
      const existing=db.prepare('SELECT version FROM m4_drafts WHERE handoff_id=?')
        .get(latest.handoffId) as {version:number}|undefined;
      if((existing?.version??0)!==body.expectedDraftVersion)
        throw new AppError(409,'stale_draft','A newer draft exists. Reload before saving.');
      const version=(existing?.version??0)+1,at=nowIso();
      if(existing){
        const changed=db.prepare(
          'UPDATE m4_drafts SET decision=?,reason_category=?,reason=?,version=?,updated_at=?,actor_id=? '+
          'WHERE handoff_id=? AND version=?'
        ).run(body.decision,body.reasonCategory,body.reason,version,at,user.id,latest.handoffId,body.expectedDraftVersion).changes;
        if(changed!==1)throw new AppError(409,'stale_draft','Concurrent draft update refused.');
      }else{
        db.prepare(
          'INSERT INTO m4_drafts(handoff_id,actor_id,decision,reason_category,reason,version,updated_at) '+
          'VALUES (?,?,?,?,?,?,?)'
        ).run(latest.handoffId,user.id,body.decision,body.reasonCategory,body.reason,version,at);
      }
      appendAudit(latest.handoffId,null,user,'draft_saved','Draft saved without an approved relationship.',
        existing?'draft':'none','draft',version);
      audit(user.id,'m4_draft_saved','handoff='+latest.handoffId);
      return {state:'draft',version,updatedAt:at};
    });
    res.json(result);
  }));

  app.post('/api/m4/decisions/:handoffId/confirm',requireAuth,handle((req,res)=>{
    const user=enforceSupervisor(req);
    const c=context(user,req.params.handoffId);
    requireAccepted(c);
    const key=requireKey(req);
    const parsed=z.object({
      decision:choiceSchema,reasonCategory:categorySchema,reason:reasonSchema,
      caseAVersion:versionSchema,caseBVersion:versionSchema,
      reviewVersion:versionSchema,
    }).safeParse(req.body);
    if(!parsed.success)throw new AppError(422,'validation_error',
      'Provide the relationship classification, detailed reason, and current review and case versions.');
    const body=parsed.data,scope='confirm:'+c.handoffId,hash=fingerprint(body);
    // Permission is rechecked before any replay; a revoked grant cannot replay private content.
    const previous=replay(user,scope,key,hash);
    if(previous){res.setHeader('Idempotent-Replay','true');res.json(previous);return;}
    const outcome=tx(()=>{
      const latest=context(user,c.handoffId);
      requireAccepted(latest);
      const already=replay(user,scope,key,hash);
      if(already)return already;
      if(latest.review?.version!==body.reviewVersion)
        throw new AppError(409,'stale_review','Supervisor review changed. Reload.');
      if(!['open','outdated'].includes(latest.suggestionState))
        throw new AppError(409,'suggestion_decided','The candidate is no longer pending.');
      if(activeDecision(latest.pairKey))
        throw new AppError(409,'decision_exists','An approved decision exists for this canonical case pair.');
      assertVersions(latest,body.caseAVersion,body.caseBVersion);
      const mapped=body.decision==='Same'?'Duplicate report':
        body.decision==='Related'?'Related issue':'Separate issues';
      // The existing hardened decision service handles both case-version updates,
      // independent case history events, and suggestion/relationship persistence.
      const existing=decideRelationship(user,latest.suggestionId,mapped,body.reason,{
        caseA:body.caseAVersion,caseB:body.caseBVersion,
      },true);
      const id=uid(),at=nowIso();
      db.prepare(
        'INSERT INTO m4_decisions(id,handoff_id,suggestion_id,pair_key,decision,reason_category,reason,'+
        'relationship_id,reviewer_id,state,version,decided_at) '+
        "VALUES (?,?,?,?,?,?,?,?,?,'confirmed',1,?)"
      ).run(id,latest.handoffId,latest.suggestionId,latest.pairKey,body.decision,
        body.reasonCategory,body.reason,existing.relationshipId,user.id,at);
      appendAudit(latest.handoffId,id,user,'decision_confirmed',body.reason,'none','confirmed',1);
      audit(user.id,'m4_decision_confirmed','decision='+id+' pair='+latest.pairKey);
      const result={decisionId:id,state:'confirmed',type:body.decision,
        relationshipId:existing.relationshipId,version:1,decidedAt:at};
      saveReplay(user,scope,key,hash,result);
      return result;
    });
    res.json(outcome);
  }));

  app.post('/api/m4/decisions/:handoffId/reverse',requireAuth,handle((req,res)=>{
    const user=enforceSupervisor(req);
    const c=context(user,req.params.handoffId);
    const key=requireKey(req);
    const parsed=z.object({
      decisionId:z.string().min(1).max(120),reason:reasonSchema,
      decisionVersion:versionSchema,caseAVersion:versionSchema,caseBVersion:versionSchema,
    }).safeParse(req.body);
    if(!parsed.success)throw new AppError(422,'validation_error',
      'Provide the existing decision, reversal reason and current versions of both complaints.');
    const body=parsed.data,scope='reverse:'+c.handoffId,hash=fingerprint(body);
    const previous=replay(user,scope,key,hash);
    if(previous){res.setHeader('Idempotent-Replay','true');res.json(previous);return;}
    const outcome=tx(()=>{
      const latest=context(user,c.handoffId);
      const repeated=replay(user,scope,key,hash);
      if(repeated)return repeated;
      const row=db.prepare('SELECT * FROM m4_decisions WHERE id=? AND handoff_id=?')
        .get(body.decisionId,latest.handoffId) as DecisionRow|undefined;
      if(!row)throw new AppError(404,'not_found','Decision not found.');
      if(row.state!=='confirmed')throw new AppError(409,'already_reversed','Decision already reversed.');
      if(row.version!==body.decisionVersion)
        throw new AppError(409,'stale_decision','Decision was changed by another supervisor.');
      assertVersions(latest,body.caseAVersion,body.caseBVersion);
      if(row.relationship_id){
        revokeRelationship(user,row.relationship_id,body.reason,{
          caseA:body.caseAVersion,caseB:body.caseBVersion,
        },true);
      }else{
        for(const [a,b] of [[latest.a,latest.b],[latest.b,latest.a]]){
          const changed=db.prepare(
            'UPDATE cases SET version=version+1,updated_at=? WHERE id=? AND version=?'
          ).run(nowIso(),a.id,a.version).changes;
          guardWrite(changed);
          appendEvent({actor:user,caseId:a.id,actionType:'relationship_revoked',
            remarks:body.reason,
            after:{previousDecisionId:row.id,previousType:'Separate issues',casesIntact:true},
            versionAfter:a.version+1,pairedCaseId:b.id});
        }
      }
      // The M4 audit remains immutable while the candidate may be reconsidered.
      // Avoid resurrecting the earlier decision or overwriting its preserved events.
      const reopened=db.prepare(
        "UPDATE suggestions SET state='open',decided_by=NULL,decided_at=NULL,decision_reason=NULL "+
        "WHERE id=? AND state='dismissed'"
      ).run(latest.suggestionId).changes;
      if(reopened!==1)throw new AppError(409,'suggestion_changed','Suggestion state changed; reversal aborted.');
      const at=nowIso();
      const changed=db.prepare(
        "UPDATE m4_decisions SET state='reversed',version=version+1,reversed_by=?,reversed_at=?,reversed_reason=? "+
        "WHERE id=? AND state='confirmed' AND version=?"
      ).run(user.id,at,body.reason,row.id,body.decisionVersion).changes;
      if(changed!==1)throw new AppError(409,'stale_decision','Decision concurrently revised.');
      appendAudit(latest.handoffId,row.id,user,'decision_reversed',body.reason,'confirmed','reversed',row.version+1);
      audit(user.id,'m4_decision_reversed','decision='+row.id+' pair='+latest.pairKey);
      const result={decisionId:row.id,state:'reversed',version:row.version+1,reversedAt:at};
      saveReplay(user,scope,key,hash,result);
      return result;
    });
    res.json(outcome);
  }));
}
