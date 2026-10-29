/** M4 isolated API/security/database assertions — all complaints and users are synthetic. */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const BASE=process.env.BASE??'http://127.0.0.1:8080';
const DB=process.env.CASELINK_DB??'data/caselink.db';
const tests=[];let failures=0;
async function check(name,fn){
  try{await fn();tests.push([name,true]);console.log('PASS',name);}
  catch(error){failures++;tests.push([name,false]);console.error('FAIL',name,error);}
}
async function call(method,path,token,body,key){
  const res=await fetch(BASE+'/api'+path,{method,headers:{
    ...(token?{Authorization:'Bearer '+token}:{}),
    ...(body?{'Content-Type':'application/json'}:{}),
    ...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>null);
  return{status:res.status,data,replayed:res.headers.get('Idempotent-Replay')==='true'};
}
async function login(username){const r=await call('POST','/auth/login',null,{username,password:'caselink-demo'});assert.equal(r.status,200);return r.data.token;}
const [lead,supervisor,officer,reviewer,west]=await Promise.all([
  login('m.nair'),login('a.desai'),login('p.rao'),login('r.khan'),login('v.kumar')
]);
const stamp=Date.now().toString(36),inst=await call('GET','/institutions?q=vaigai',lead);
assert.equal(inst.status,200);
const institutionId=inst.data.institutions[0].id;
function openDb(readonly=true){return new Database(DB,{readonly});}
async function makeFixture(prefix,summaryA,summaryB){
  const cases=[];
  for(const [i,summary] of [summaryA,summaryB].entries()){
    const r=await call('POST','/cases',lead,{
      institutionId,category:'Infrastructure',receivedAt:new Date(Date.now()-86400000).toISOString(),
      sourceChannel:'Email',sourceReference:prefix+'-'+stamp+'-'+i,
      complaintSummary:summary+' '+prefix+' '+stamp,deadlinePolicyId:'DEMO-POL-30',
    });
    assert.equal(r.status,201,JSON.stringify(r.data));
    cases.push(r.data);
  }
  for(const c of cases){
    const g=await call('POST','/cases/'+c.id+'/grants',lead,{
      version:c.version,userId:'u-supervisor',note:'Synthetic M4 supervisor content grant',
    });
    assert.equal(g.status,200,JSON.stringify(g.data));
  }
  let pair;
  for(let retry=0;retry<90;retry++){
    const r=await call('GET','/m2/suggestions?state=open&caseId='+cases[0].id+'&pageSize=50',lead);
    assert.equal(r.status,200);
    pair=r.data.rows.find(p=>[p.caseA.id,p.caseB.id].includes(cases[0].id)&&
      [p.caseA.id,p.caseB.id].includes(cases[1].id));
    if(pair)break;
    await new Promise(done=>setTimeout(done,250));
  }
  assert.ok(pair,'Expected distinct overlap pair for '+prefix);
  const handoff=await call('POST','/m2/suggestions/'+pair.id+'/handoff',lead,{
    supervisorId:'u-supervisor',reason:'Please independently review the supporting evidence for '+prefix+' reports.',
    caseAVersion:pair.caseA.version,caseBVersion:pair.caseB.version,
  });
  assert.equal(handoff.status,201,JSON.stringify(handoff.data));
  return{cases,pair,id:handoff.data.handoffId};
}
async function get(f){return call('GET','/m4/decisions/'+f.id,supervisor);}
async function accept(f){
  const r=await call('POST','/m3/reviews/'+f.id+'/actions',supervisor,{
    action:'accept',reason:'Both complaints reviewed and ready for a human classification.',expectedVersion:0,
  });
  assert.equal(r.status,200,JSON.stringify(r.data));
}
function body(d,decision,reason='Two reports share the same documented context requiring a supervisor decision.'){
  return {decision,reasonCategory:'Same incident',reason,caseAVersion:d.caseA.version,
    caseBVersion:d.caseB.version,reviewVersion:d.review?.version??0};
}
const same=await makeFixture('M4-SAME',
 'North hostel water pipeline ruptured near block B and left rooms without drinking water for two days.',
 'Broken drinking water pipeline near hostel block B disrupted resident supply for two days.');
await check('M4 requires authentication and supervisor role for every route',async()=>{
  assert.equal((await call('GET','/m4/decisions/'+same.id,null)).status,401);
  assert.equal((await call('GET','/m4/decisions/'+same.id,officer)).status,403);
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/confirm',officer,{},'unauthorized01')).status,403);
  assert.equal((await call('GET','/m4/decisions/'+same.id,reviewer)).status,403);
  assert.equal((await call('GET','/m4/decisions/'+same.id,west)).status,404);
});
await check('M3 acceptance is mandatory before draft or confirmation',async()=>{
  const d=(await get(same)).data;
  assert.equal(d.eligible,false);
  const p=await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,body(d,'Same'),'m4-gate-'+stamp);
  assert.equal(p.status,409);
  const draft=await call('POST','/m4/decisions/'+same.id+'/draft',supervisor,{
    decision:'Same',reasonCategory:'Same incident',reason:'This should be blocked before review.',expectedDraftVersion:0,
  });
  assert.equal(draft.status,409);
});
await accept(same);
await check('Save Draft is versioned but never creates a relationship',async()=>{
  const db=openDb(),before=db.prepare('SELECT COUNT(*) AS n FROM relationships').get().n;db.close();
  const saved=await call('POST','/m4/decisions/'+same.id+'/draft',supervisor,{
    decision:'Same',reasonCategory:'Same incident',
    reason:'These reports describe a common hostel water disruption.',expectedDraftVersion:0,
  });
  assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.version,1);
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/draft',supervisor,{
    decision:'Same',reasonCategory:'Same incident',
    reason:'A stale concurrent draft must fail.',expectedDraftVersion:0,
  })).status,409);
  const d=(await get(same)).data;
  assert.equal(d.draft.decision,'Same');assert.equal(d.activeDecision,null);
  const verify=openDb();assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM relationships').get().n,before);verify.close();
});
await check('M4 rejects missing reason, missing versions and missing idempotency',async()=>{
  const d=(await get(same)).data;
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,
    {...body(d,'Same'),reason:'short'},'m4-badreason')).status,422);
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,
    {...body(d,'Same'),caseAVersion:undefined},'m4-badversion')).status,422);
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,body(d,'Same'))).status,422);
});
let sameDecision;
await check('SAME confirms canonical pair while preserving both complaint originals',async()=>{
  const d=(await get(same)).data;
  const original=openDb();
  const history=same.cases.map(c=>original.prepare('SELECT id FROM action_events WHERE case_id=?').all(c.id).map(x=>x.id));
  const owners=same.cases.map(c=>original.prepare('SELECT bureau,status,assigned_officer_id FROM cases WHERE id=?').get(c.id));
  original.close();
  const result=await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,body(d,'Same'),'m4-same-'+stamp);
  assert.equal(result.status,200,JSON.stringify(result.data));
  sameDecision=result.data;
  assert.equal(result.data.type,'Same');
  assert.ok(result.data.relationshipId);
  const verify=openDb();
  try{
    const dbRelation=verify.prepare('SELECT * FROM relationships WHERE id=?').get(result.data.relationshipId);
    assert.equal(dbRelation.type,'Duplicate report');
    assert.equal(dbRelation.state,'active');
    const ledger=verify.prepare('SELECT * FROM m4_decisions WHERE id=?').get(result.data.decisionId);
    assert.equal(ledger.state,'confirmed');assert.equal(ledger.decision,'Same');
    assert.equal(ledger.pair_key,[same.cases[0].id,same.cases[1].id].sort().join('::'));
    for(let i=0;i<2;i++){
      const row=verify.prepare('SELECT bureau,status,assigned_officer_id FROM cases WHERE id=?').get(same.cases[i].id);
      assert.deepEqual(row,owners[i]);
      const after=new Set(verify.prepare('SELECT id FROM action_events WHERE case_id=?').all(same.cases[i].id).map(x=>x.id));
      for(const oldId of history[i])assert.ok(after.has(oldId),'Existing history was deleted');
    }
  }finally{verify.close();}
});
await check('identical confirm requests replay without a second relationship',async()=>{
  // A replay is matched to the original request versions, not the new case versions.
  const d=await call('GET','/m3/reviews/'+same.id,supervisor);
  const confirmedDb=openDb();
  const record=confirmedDb.prepare('SELECT * FROM m4_decisions WHERE id=?').get(sameDecision.decisionId);
  const priorA=confirmedDb.prepare('SELECT version FROM cases WHERE id=?').get(same.cases[0].id).version-1;
  const priorB=confirmedDb.prepare('SELECT version FROM cases WHERE id=?').get(same.cases[1].id).version-1;
  const count=confirmedDb.prepare('SELECT COUNT(*) AS n FROM relationships').get().n;
  confirmedDb.close();
  const initial=body({caseA:{version:priorA},caseB:{version:priorB},review:{version:d.data.review.version}},'Same');
  const retry=await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,initial,'m4-same-'+stamp);
  assert.equal(retry.status,200,JSON.stringify(retry.data));assert.equal(retry.replayed,true);
  assert.equal(retry.data.decisionId,sameDecision.decisionId);
  const db2=openDb();assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM relationships').get().n,count);db2.close();
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,
    {...initial,reason:'Different reason with same idempotency key.'},'m4-same-'+stamp)).status,409);
});
await check('unique active pair prevents a second confirmed decision',async()=>{
  const d=(await get(same)).data;
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,body(d,'Related'),
    'm4-second-'+stamp)).status,409);
});
await check('M4 rejects stale versions and cross-region reversals',async()=>{
  const d=(await get(same)).data;
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/reverse',west,{
    decisionId:d.activeDecision.id,decisionVersion:d.activeDecision.version,
    reason:'Cross region must not reverse relationships.',
    caseAVersion:d.caseA.version,caseBVersion:d.caseB.version,
  },'m4-west-'+stamp)).status,404);
  assert.equal((await call('POST','/m4/decisions/'+same.id+'/reverse',supervisor,{
    decisionId:d.activeDecision.id,decisionVersion:0,
    reason:'Stale state must not overwrite a confirmed decision.',
    caseAVersion:d.caseA.version,caseBVersion:d.caseB.version,
  },'m4-stale-'+stamp)).status,409);
});
await check('reversal is durable and non-destructive; revision to Related is allowed',async()=>{
  const d=(await get(same)).data;
  const oldRelationship=d.activeDecision.relationshipId;
  const res=await call('POST','/m4/decisions/'+same.id+'/reverse',supervisor,{
    decisionId:d.activeDecision.id,decisionVersion:d.activeDecision.version,
    reason:'Evidence review found two different complainants with connected but distinct grievances.',
    caseAVersion:d.caseA.version,caseBVersion:d.caseB.version,
  },'m4-reverse-'+stamp);
  assert.equal(res.status,200,JSON.stringify(res.data));
  const checkDb=openDb();
  assert.equal(checkDb.prepare('SELECT state FROM relationships WHERE id=?').get(oldRelationship).state,'revoked');
  assert.equal(checkDb.prepare('SELECT state FROM suggestions WHERE id=?').get(same.pair.id).state,'open');
  assert.equal(checkDb.prepare('SELECT state FROM m4_decisions WHERE id=?').get(sameDecision.decisionId).state,'reversed');
  checkDb.close();
  const next=(await get(same)).data;
  assert.equal(next.activeDecision,null);
  const revised=await call('POST','/m4/decisions/'+same.id+'/confirm',supervisor,
    body(next,'Related','Further evidence shows connected grievances but separate incidents and independent case ownership.'),
    'm4-revised-'+stamp);
  assert.equal(revised.status,200,JSON.stringify(revised.data));
  assert.equal(revised.data.type,'Related');
  assert.notEqual(revised.data.relationshipId,oldRelationship);
});
const separate=await makeFixture('M4-SEPARATE',
 'Fire exit stairs in the main block are unsafe due to a broken handrail after maintenance.',
 'Broken fire exit handrail at main block stairs creates safety concerns that need inspection.');
await accept(separate);
await check('SEPARATE decision persists a negative relationship without a link',async()=>{
  const d=(await get(separate)).data;
  const res=await call('POST','/m4/decisions/'+separate.id+'/confirm',supervisor,
    body(d,'Separate','The two reports must be treated separately after reviewing conflicting evidence.'),
    'm4-separate-'+stamp);
  assert.equal(res.status,200,JSON.stringify(res.data));
  assert.equal(res.data.relationshipId,null);
  const db=openDb();
  try{
    assert.equal(db.prepare('SELECT decision FROM m4_decisions WHERE id=?').get(res.data.decisionId).decision,'Separate');
    assert.equal(db.prepare('SELECT state FROM suggestions WHERE id=?').get(separate.pair.id).state,'dismissed');
  }finally{db.close();}
  const decision=(await get(separate)).data;
  const reversed=await call('POST','/m4/decisions/'+separate.id+'/reverse',supervisor,{
    decisionId:res.data.decisionId,decisionVersion:decision.activeDecision.version,
    reason:'Original separation requires revision after additional site evidence.',
    caseAVersion:decision.caseA.version,caseBVersion:decision.caseB.version,
  },'m4-separate-reverse-'+stamp);
  assert.equal(reversed.status,200,JSON.stringify(reversed.data));
  const reopen=openDb();
  assert.equal(reopen.prepare('SELECT state FROM suggestions WHERE id=?').get(separate.pair.id).state,'open');
  reopen.close();
});
await check('M4 audit entries cannot be rewritten or deleted at database level',async()=>{
  const db=openDb(false);
  try{
    const e=db.prepare("SELECT id FROM m4_decision_events WHERE action='decision_confirmed' LIMIT 1").get();
    assert.ok(e);
    assert.throws(()=>db.prepare('UPDATE m4_decision_events SET reason=? WHERE id=?').run('tampered',e.id));
    assert.throws(()=>db.prepare('DELETE FROM m4_decision_events WHERE id=?').run(e.id));
  }finally{db.close();}
});
const related=await makeFixture('M4-RELATED',
 'Unrepaired laboratory electrical panel exposes student users to hazards and sparks.',
 'Electrical panel at the laboratory has sparks and dangerous exposed wiring requiring urgent repair.');
await accept(related);
await check('transaction failure rolls back relationships, cases, suggestions and audit',async()=>{
  const d=(await get(related)).data;
  const db=openDb(false);
  const before={
    relationships:db.prepare('SELECT COUNT(*) AS n FROM relationships').get().n,
    versions:[d.caseA.version,d.caseB.version],
    histories:[db.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id=?').get(d.caseA.id).n,
      db.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id=?').get(d.caseB.id).n],
  };
  db.exec("CREATE TRIGGER m4_fail_before_audit BEFORE INSERT ON m4_decision_events "+
    "WHEN NEW.action='decision_confirmed' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  db.close();
  try{
    const result=await call('POST','/m4/decisions/'+related.id+'/confirm',supervisor,
      body(d,'Related'),'m4-injected-'+stamp);
    assert.ok(result.status>=400,'injected failure must reject');
  }finally{
    const remove=openDb(false);remove.exec('DROP TRIGGER IF EXISTS m4_fail_before_audit');remove.close();
  }
  const verify=openDb();
  try{
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM relationships').get().n,before.relationships);
    assert.equal(verify.prepare('SELECT state FROM suggestions WHERE id=?').get(related.pair.id).state,'open');
    for(const [i,id] of [d.caseA.id,d.caseB.id].entries()){
      assert.equal(verify.prepare('SELECT version FROM cases WHERE id=?').get(id).version,before.versions[i]);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id=?').get(id).n,before.histories[i]);
    }
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM m4_decisions WHERE handoff_id=?").get(related.id).n,0);
  }finally{verify.close();}
  const after=(await get(related)).data;
  const confirmed=await call('POST','/m4/decisions/'+related.id+'/confirm',supervisor,
    body(after,'Related'),'m4-related-'+stamp);
  assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
});
console.log('M4 relationship API:',tests.filter(x=>x[1]).length+'/'+tests.length);
if(failures)process.exitCode=1;
