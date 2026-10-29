/** M4 Playwright: M3 acceptance -> draft -> confirm -> reverse -> mobile. Synthetic data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const BASE=process.env.BASE??'http://127.0.0.1:8080';
const OUT=process.env.CASELINK_SCREENSHOT_DIR??'.runtime/screenshots';
fs.mkdirSync(OUT,{recursive:true});
async function api(method,path,token,body){
  const response=await fetch(BASE+'/api'+path,{
    method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});
  return{status:response.status,data:await response.json().catch(()=>null)};
}
const login=async username=>{
  const r=await api('POST','/auth/login',null,{username,password:'caselink-demo'});
  assert.equal(r.status,200);
  return r.data.token;
};
const lead=await login('m.nair');
const inst=await api('GET','/institutions?q=vaigai',lead);
const stamp=Date.now().toString(36),cases=[];
for(const [i,summary] of [
  'Workshop block electricity panel remains broken and emits sparks during practical sessions after rain.',
  'Electricity panel at workshop block emits dangerous sparks during practical labs, repair is still pending.',
].entries()){
  const r=await api('POST','/cases',lead,{
    institutionId:inst.data.institutions[0].id,
    category:'Infrastructure',sourceChannel:'Email',
    sourceReference:'M4-UI-'+stamp+'-'+i,
    receivedAt:new Date(Date.now()-86400000).toISOString(),
    complaintSummary:summary+' '+stamp,
    deadlinePolicyId:'DEMO-POL-30',
  });
  assert.equal(r.status,201,JSON.stringify(r.data));cases.push(r.data);
}
for(const c of cases){
  const r=await api('POST','/cases/'+c.id+'/grants',lead,{
    userId:'u-supervisor',version:c.version,note:'Synthetic M4 UI review read authorization',
  });
  assert.equal(r.status,200,JSON.stringify(r.data));
}
let pair;
for(let i=0;i<90;i++){
  const r=await api('GET','/m2/suggestions?state=open&caseId='+cases[0].id+'&pageSize=50',lead);
  pair=r.data?.rows?.find(p=>[p.caseA.id,p.caseB.id].includes(cases[0].id)&&
    [p.caseA.id,p.caseB.id].includes(cases[1].id));
  if(pair)break;
  await new Promise(done=>setTimeout(done,250));
}
assert.ok(pair);
const handoff=await api('POST','/m2/suggestions/'+pair.id+'/handoff',lead,{
  supervisorId:'u-supervisor',caseAVersion:pair.caseA.version,caseBVersion:pair.caseB.version,
  reason:'Supervisor must examine both engineering workshop electrical safety reports.',
});
assert.equal(handoff.status,201,JSON.stringify(handoff.data));
const supervisor=await login('a.desai');
const accepted=await api('POST','/m3/reviews/'+handoff.data.handoffId+'/actions',supervisor,{
  action:'accept',reason:'Both independent complaints have been examined and are ready for classification.',
  expectedVersion:0,
});
assert.equal(accepted.status,200,JSON.stringify(accepted.data));
const browser=await chromium.launch({args:['--no-sandbox']});
const errors=[];
async function browserLogin(page){
  await page.goto(BASE+'/#/login');
  await page.locator('#username').fill('a.desai');
  await page.locator('#password').fill('caselink-demo');
  await page.click('button[type=submit]');
  await page.locator('#username').waitFor({state:'detached',timeout:15000});
}
try{
  const desktop=await browser.newContext({viewport:{width:1440,height:960}});
  const page=await desktop.newPage();
  page.on('pageerror',e=>errors.push(String(e)));
  await browserLogin(page);
  await page.goto(BASE+'/#/relationship-decision/'+handoff.data.handoffId);
  await page.getByRole('heading',{name:'M4 — Relationship Decision'}).waitFor();
  await page.getByRole('heading',{name:'Complaint A'}).waitFor();
  await page.getByText('No active confirmed relationship for this pair.').waitFor();
  await page.screenshot({path:OUT+'/m4-01-decision.png',fullPage:true});
  await page.getByRole('radio',{name:/Related/}).check();
  await page.locator('#m4-reason').fill('Both reports describe connected workshop electrical safety failures but involve distinct evidence and complainants.');
  await page.getByRole('button',{name:'Save Draft'}).click();
  await page.getByText('Draft saved; no relationship has been confirmed.').waitFor();
  await page.screenshot({path:OUT+'/m4-02-draft.png',fullPage:true});
  await page.getByRole('button',{name:'Confirm Decision'}).click();
  await page.getByText('Confirmed: Related').waitFor();
  await page.getByText('decision confirmed',{exact:false}).first().waitFor();
  await page.screenshot({path:OUT+'/m4-03-confirmed.png',fullPage:true});
  await page.locator('#m4-reversal-reason').fill('Further supervisor inspection shows the relationship needs reconsideration after new evidence.');
  await page.getByRole('button',{name:'Undo / Reverse Decision'}).click();
  await page.getByText('Decision reversed. Both complaint histories remain preserved.').waitFor();
  await page.getByText('No active confirmed relationship for this pair.').waitFor();
  await page.screenshot({path:OUT+'/m4-04-reversed.png',fullPage:true});
  assert.equal(errors.length,0,'M4 desktop runtime errors: '+errors.join('; '));
  await desktop.close();
  const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const m=await mobile.newPage();
  m.on('pageerror',e=>errors.push(String(e)));
  await browserLogin(m);
  await m.goto(BASE+'/#/relationship-decision/'+handoff.data.handoffId);
  await m.getByRole('heading',{name:'M4 — Relationship Decision'}).waitFor();
  await m.getByRole('heading',{name:'Relationship classification'}).waitFor();
  await m.screenshot({path:OUT+'/m4-05-mobile.png',fullPage:true});
  const overflow=await m.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+3);
  assert.equal(overflow,false,'Mobile horizontal overflow');
  assert.equal(errors.length,0,'M4 mobile JS errors: '+errors.join('; '));
  await mobile.close();
  console.log('PASS M4 Playwright desktop: draft, confirm, reversed and persisted audits');
  console.log('PASS M4 Playwright mobile: relationship screen renders without overflow');
}finally{await browser.close();}
