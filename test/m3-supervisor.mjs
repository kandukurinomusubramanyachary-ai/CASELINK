/**
 * M3 regression gate. All records are synthetic and generated in the isolated verify database.
 * Tests M2 handoff -> supervisor-only M3 review -> persisted, non-mutating audit log.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const DB = process.env.CASELINK_DB ?? 'data/caselink.db';
let failed = 0;
const tests = [];
const check = async (name, work) => {
  try { await work(); tests.push([name,'PASS']); console.log('PASS',name); }
  catch(error){failed++;tests.push([name,'FAIL']);console.error('FAIL',name,error);}
};
async function request(method, endpoint, token, body) {
  const headers={};
  if(token)headers.authorization='Bearer '+token;
  if(body && !(body instanceof FormData))headers['content-type']='application/json';
  const response=await fetch(BASE+'/api'+endpoint,{
    method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,
  });
  const type=response.headers.get('content-type')??'';
  const data=type.includes('application/json')?await response.json():null;
  return {status:response.status,data,response};
}
async function login(username) {
  const r=await request('POST','/auth/login',null,{username,password:'caselink-demo'});
  assert.equal(r.status,200,'login '+username);
  return r.data.token;
}
const [lead,supervisor,officer,reviewer,westSupervisor]=await Promise.all([
  login('m.nair'),login('a.desai'),login('p.rao'),login('r.khan'),login('v.kumar')
]);
const stamp=Date.now().toString(36);
const inst=await request('GET','/institutions?q=vaigai',lead);
assert.equal(inst.status,200);
const instId=inst.data.institutions[0].id;
const cases=[];
for (const [i,summary] of [
 'Hostel roof has a large leak affecting several student rooms after the latest rain; repairs remain pending.',
 'Hostel roof leak damages student rooms after the latest rain; the promised repair is still pending.',
].entries()) {
  const r=await request('POST','/cases',lead,{
    institutionId:instId, receivedAt:new Date(Date.now()-86400000).toISOString(),
    sourceChannel:'Email',sourceReference:'M3-'+stamp+'-'+i,
    category:'Infrastructure', complaintSummary:summary+' '+stamp,
    deadlinePolicyId:'DEMO-POL-30',
  });
  assert.equal(r.status,201,JSON.stringify(r.data));
  cases.push(r.data);
}
// A handoff is not a content grant: the owning lead must authorize the
// recipient to inspect BOTH complaint records before supervisor review.
for (const c of cases) {
  const grant=await request('POST','/cases/'+c.id+'/grants',lead,{
    version:c.version,userId:'u-supervisor',note:'Authorize synthetic M3 supervisor review.',
    revoke:false,
  });
  assert.equal(grant.status,200,JSON.stringify(grant.data));
}
let pair=null;
for(let attempt=0;attempt<90;attempt++){
  const r=await request('GET','/m2/suggestions?state=all&caseId='+cases[0].id+'&pageSize=50',lead);
  if(r.status===200)pair=r.data.rows.find(p=>
    [p.caseA.id,p.caseB.id].includes(cases[0].id)&&[p.caseA.id,p.caseB.id].includes(cases[1].id));
  if(pair)break;
  await new Promise(ok=>setTimeout(ok,250));
}
assert.ok(pair,'Expected M2 pair did not appear');
const sender=await request('GET','/m2/suggestions/'+pair.id,lead);
assert.equal(sender.status,200);
const recipient=sender.data.supervisors.find(s=>s.id==='u-supervisor');
assert.ok(recipient,'South supervisor must be eligible for handoff');
const beforeDb=new Database(DB,{readonly:true});
const beforeRelationships=beforeDb.prepare('SELECT COUNT(*) AS n FROM relationships').get().n;
beforeDb.close();
const handoff=await request('POST','/m2/suggestions/'+pair.id+'/handoff',lead,{
  supervisorId:recipient.id,reason:'Please inspect both complaints to determine the nature of their overlap.',
  caseAVersion:pair.caseA.version,caseBVersion:pair.caseB.version,
});
assert.equal(handoff.status,201,JSON.stringify(handoff.data));
const id=handoff.data.handoffId;
await check('M3 only permits an authenticated supervisor',async()=>{
  assert.equal((await request('GET','/m3/reviews',null)).status,401);
  assert.equal((await request('GET','/m3/reviews',officer)).status,403);
  assert.equal((await request('GET','/m3/reviews/'+id,reviewer)).status,403);
  assert.equal((await request('POST','/m3/reviews/'+id+'/actions',officer,{action:'accept',reason:'Unauthorized attempt',expectedVersion:0})).status,403);
});
await check('M3 enforces assigned supervisor and region',async()=>{
  assert.equal((await request('GET','/m3/reviews/'+id,westSupervisor)).status,404);
  const westList=await request('GET','/m3/reviews',westSupervisor);
  assert.equal(westList.status,200);
  assert.ok(!JSON.stringify(westList.data).includes(stamp));
});
await check('supervisor queue only includes actual handoffs',async()=>{
  const q=await request('GET','/m3/reviews',supervisor);
  assert.equal(q.status,200);
  assert.ok(q.data.reviews.some(r=>r.id===id));
  assert.ok(q.data.reviews.every(r=>r.state!==undefined));
});
let details;
await check('pair details, preserved independent histories and real factors',async()=>{
  const r=await request('GET','/m3/reviews/'+id,supervisor);
  assert.equal(r.status,200);
  details=r.data;
  assert.ok(details.caseA.summary.includes(stamp));
  assert.ok(details.caseB.summary.includes(stamp));
  const comparisonDb=new Database(DB,{readonly:true});
  try { assert.equal(details.comparison.reasons.length,
    JSON.parse(comparisonDb.prepare('SELECT reasons_json FROM suggestions WHERE id=?').get(pair.id).reasons_json).length);
  } finally { comparisonDb.close(); }
  assert.equal(details.comparison.method.includes('not AI confidence'),true);
  assert.ok(Array.isArray(details.caseA.history)&&Array.isArray(details.caseB.history));
  assert.equal(details.review.state,'pending');
});
await check('contradictory matching factors are preserved, not converted to confidence',async()=>{
  const database=new Database(DB);
  try {
    const source=database.prepare('SELECT reasons_json FROM suggestions WHERE id=?').get(pair.id);
    const reasons=JSON.parse(source.reasons_json);
    reasons.push({rule:'different_category',detail:'Conflicting classifications require manual inspection.',sourceField:'category'});
    database.prepare('UPDATE suggestions SET reasons_json=? WHERE id=?').run(JSON.stringify(reasons),pair.id);
  }finally{database.close();}
  const r=await request('GET','/m3/reviews/'+id,supervisor);
  assert.equal(r.status,200);
  assert.ok(r.data.comparison.reasons.some(x=>x.rule==='different_category'));
  assert.ok(!JSON.stringify(r.data.comparison).includes('87%'));
});
await check('empty evidence is represented explicitly without invented previews',async()=>{
  assert.ok(Array.isArray(details.caseA.attachments));
  const missing=await request('GET','/m3/reviews/'+id+'/evidence/00000000-0000-0000-0000-000000000000',supervisor);
  assert.equal(missing.status,404);
});
await check('evidence bytes stay protected after upload',async()=>{
  const c=await request('GET','/cases/'+cases[0].id,lead);
  assert.equal(c.status,200);
  const form=new FormData();
  form.append('version',String(c.data.case.version));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Ya8VV4AAAAASUVORK5CYII=', 'base64');
  form.append('file',new Blob([png],{type:'image/png'}),'m3-proof.png');
  const uploaded=await request('POST','/cases/'+cases[0].id+'/attachments',lead,form);
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));
  const after=await request('GET','/m3/reviews/'+id,supervisor);
  const file=after.data.caseA.attachments.find(x=>x.originalName==='m3-proof.png') ??
    after.data.caseB.attachments.find(x=>x.originalName==='m3-proof.png');
  assert.ok(file);
  const url='/m3/reviews/'+id+'/evidence/'+file.id;
  assert.equal((await request('GET',url,null)).status,401);
  assert.equal((await request('GET',url,officer)).status,403);
  assert.equal((await request('GET',url,westSupervisor)).status,404);
  const authorized=await request('GET',url,supervisor);
  assert.equal(authorized.status,200);
  assert.deepEqual(Buffer.from(await authorized.response.arrayBuffer()),png);
});
let version=0;
async function action(kind,reason,expectedVersion=version) {
  return request('POST','/m3/reviews/'+id+'/actions',supervisor,{action:kind,reason,expectedVersion});
}
await check('reason and version are mandatory',async()=>{
  assert.equal((await request('POST','/m3/reviews/'+id+'/actions',supervisor,{action:'accept',reason:'',expectedVersion:0})).status,422);
  assert.equal((await request('POST','/m3/reviews/'+id+'/actions',supervisor,{action:'accept',reason:'Valid detailed reason'})).status,422);
});
await check('needs review and resumption are persisted',async()=>{
  const a=await action('needs_review','Manual inspection of contradictory institution details is necessary.');
  assert.equal(a.status,200,JSON.stringify(a.data));
  version=a.data.version;
  assert.equal(a.data.state,'needs_review');
  const b=await action('resume','Contradictory points have now been inspected.');
  assert.equal(b.status,200);
  version=b.data.version;
  assert.equal(b.data.state,'pending');
});
await check('request for evidence and resume are persisted',async()=>{
  const a=await action('request_evidence','Need original signed notice before approval.');
  assert.equal(a.status,200);
  version=a.data.version;
  assert.equal(a.data.state,'awaiting_evidence');
  assert.ok(a.data.notificationsSent>=1,'At least one owning lead must be notified');
  const inbox=await request('GET','/notifications',lead);
  assert.equal(inbox.status,200);
  const alerts=inbox.data.notifications.filter(x=>x.kind==='Supervisor evidence request' &&
    [cases[0].id,cases[1].id].includes(x.entityId));
  assert.ok(alerts.length>=1,'Owning leads must receive actionable case notifications');
  for(const alert of alerts){
    assert.ok(!alert.body.includes('m3-evidence:'),'Notification body must not reveal pair keys');
    assert.ok(!alert.body.includes(pair.id),'Notification must not reveal M2 pair information');
  }
  const b=await action('resume','Requested notice received in the independent case evidence section.');
  assert.equal(b.status,200);
  version=b.data.version;
});
await check('optimistic concurrency prevents stale review writes',async()=>{
  const stale=await action('accept','An outdated review version should fail.',0);
  assert.equal(stale.status,409);
});
await check('acceptance remains distinct from a relationship decision',async()=>{
  const before=new Database(DB,{readonly:true});
  const baseline=cases.map(c=>({
    id:c.id,
    row:before.prepare('SELECT version,status FROM cases WHERE id=?').get(c.id),
    events:before.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id=?').get(c.id).n,
  }));
  before.close();
  const accepted=await action('accept','Two separate grievances are ready for a human relationship decision.');
  assert.equal(accepted.status,200,JSON.stringify(accepted.data));
  version=accepted.data.version;
  assert.equal(accepted.data.state,'accepted');
  assert.equal((await action('needs_review','Must not undo accepted review')).status,409);
  const verify=new Database(DB,{readonly:true});
  try{
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM relationships').get().n,beforeRelationships);
    for(const c of baseline){
      assert.deepEqual(verify.prepare('SELECT version,status FROM cases WHERE id=?').get(c.id),c.row);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM action_events WHERE case_id=?').get(c.id).n,c.events);
    }
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM m3_review_events WHERE handoff_id=?').get(id).n,5);
    assert.equal(verify.prepare('SELECT state FROM m3_reviews WHERE handoff_id=?').get(id).state,'accepted');
  }finally{verify.close();}
});
await check('access revocation prevents new reads, writes, and evidence retrieval',async()=>{
  const db=new Database(DB);
  try{db.prepare("UPDATE users SET region='West' WHERE id='u-supervisor'").run();}
  finally{db.close();}
  try{
    assert.equal((await request('GET','/m3/reviews/'+id,supervisor)).status,404);
    assert.equal((await action('needs_review','Attempt with rescinded regional authority')).status,404);
    const latest=await request('GET','/m3/reviews/'+id+'/evidence/'+
      (await request('GET','/cases/'+cases[0].id,lead)).data.attachments[0].id,supervisor);
    assert.equal(latest.status,404);
    const queue=await request('GET','/m3/reviews',supervisor);
    assert.equal(queue.status,200);
    assert.ok(!queue.data.reviews.some(r=>r.id===id));
  }finally{
    const restore=new Database(DB);
    restore.prepare("UPDATE users SET region='South' WHERE id='u-supervisor'").run();
    restore.close();
  }
});
console.log('M3 supervisor API:',tests.filter(x=>x[1]==='PASS').length+'/'+tests.length);
if(failed)process.exitCode=1;
