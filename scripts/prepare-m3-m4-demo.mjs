/**
 * CASELINK synthetic M3/M4 manual-test fixture.
 * Run only on a locally seeded, isolated database with the server already listening.
 * Creates an M2 pair, grants supervisor access to both cases, and handoffs to M3.
 * Does NOT auto-accept review or auto-confirm any relationship.
 */
import assert from 'node:assert/strict';
const BASE=process.env.BASE??'http://127.0.0.1:8080';
async function api(method,route,token,body){
  const res=await fetch(BASE+'/api'+route,{method,headers:{
    ...(token?{Authorization:'Bearer '+token}:{}),
    ...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{}),
  },body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>null);
  if(res.status>=400)throw new Error(method+' '+route+' -> '+res.status+' '+JSON.stringify(data));
  return data;
}
const lead=await api('POST','/auth/login',null,{username:'m.nair',password:'caselink-demo'});
const institution=await api('GET','/institutions?q=vaigai',lead.token);
const id=institution.institutions?.[0]?.id;
assert.ok(id,'Seeded South-region institution not found. Run npm run seed on an isolated DB.');
const stamp='MANUAL-'+Date.now().toString(36);
const summaries=[
  'University hostel drinking water pipes have leaked for several days, leaving student rooms without safe supply.',
  'Drinking water pipes are leaking in the university hostel and students cannot access a reliable safe water supply.',
];
const cases=[];
for(const [i,summary] of summaries.entries()){
  const c=await api('POST','/cases',lead.token,{
    institutionId:id,category:'Infrastructure',
    complaintSummary:summary+' '+stamp,
    sourceChannel:'Email',sourceReference:stamp+'-'+i,
    receivedAt:new Date(Date.now()-86400000).toISOString(),
    deadlinePolicyId:'DEMO-POL-30',
  });
  cases.push(c);
  await api('POST','/cases/'+c.id+'/grants',lead.token,{
    version:c.version,userId:'u-supervisor',
    note:'Synthetic M3/M4 manual preview: explicit content-read authorization.',
  });
  const current=await api('GET','/cases/'+c.id,lead.token);
  const proof=new FormData();
  proof.append('version',String(current.case.version));
  proof.append('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Ya8VV4AAAAASUVORK5CYII=','base64')],{type:'image/png'}),'synthetic-inspection-'+i+'.png');
  await api('POST','/cases/'+c.id+'/attachments',lead.token,proof);
}
let pair=null;
for(let attempt=0;attempt<100;attempt++){
  const q=await api('GET','/m2/suggestions?state=open&caseId='+cases[0].id+'&pageSize=50',lead.token);
  pair=q.rows.find(x=>[x.caseA.id,x.caseB.id].includes(cases[0].id)&&
    [x.caseA.id,x.caseB.id].includes(cases[1].id))??null;
  if(pair)break;
  await new Promise(resolve=>setTimeout(resolve,300));
}
assert.ok(pair,'M2 did not generate a matching pair. Review the M2 worker and server logs.');
if(process.argv.includes('--prepare-only')){
  console.log('Synthetic M2 fixture ready. No handoff, review or relationship decision has been made.');
  console.log('Bureau lead: m.nair / caselink-demo; supervisor: a.desai / caselink-demo');
  console.log('Case A:',pair.caseA.caseNumber,'Case B:',pair.caseB.caseNumber);
  console.log('M2:',new URL(BASE).origin+'/#/overlaps/'+pair.id);
  console.log('Both complaints have private synthetic PNG evidence and explicit supervisor content grants.');
  process.exit(0);
}
const handoff=await api('POST','/m2/suggestions/'+pair.id+'/handoff',lead.token,{
  supervisorId:'u-supervisor',
  reason:'Inspect both synthetic hostel water-supply grievances and determine their relationship.',
  caseAVersion:pair.caseA.version,caseBVersion:pair.caseB.version,
});
const local=new URL(BASE);
const root=local.origin;
console.log('\nSynthetic CASELINK M3/M4 fixture created. No decisions were made.');
console.log('Case A:',pair.caseA.caseNumber,'Case B:',pair.caseB.caseNumber);
console.log('Supervisor login: a.desai / caselink-demo');
console.log('Bureau lead login: m.nair / caselink-demo');
console.log('M3 review:',root+'/#/supervisor-review/'+handoff.handoffId);
console.log('M4 decision (after M3 acceptance):',root+'/#/relationship-decision/'+handoff.handoffId);
console.log('Try Request More Evidence in M3, then view the bureau lead\'s Notifications inbox.');
console.log('Never run this fixture against production or real complaint data.\n');
