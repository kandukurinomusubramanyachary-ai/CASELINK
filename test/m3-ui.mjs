/** M3 desktop/mobile Playwright acceptance and screenshot capture. Synthetic database only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const BASE=process.env.BASE??'http://127.0.0.1:8080';
const OUT=process.env.CASELINK_SCREENSHOT_DIR??'.runtime/screenshots';
fs.mkdirSync(OUT,{recursive:true});
async function request(method,endpoint,token,body){
  const res=await fetch(BASE+'/api'+endpoint,{method,
    headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data};
}
async function token(username){
  const r=await request('POST','/auth/login',null,{username,password:'caselink-demo'});
  assert.equal(r.status,200);
  return r.data.token;
}
const lead=await token('m.nair');
const institution=await request('GET','/institutions?q=vaigai',lead);
const institutionId=institution.data.institutions[0].id;
const stamp='M3-VISUAL-'+Date.now().toString(36);
const cases=[];
for(const [i,summary] of [
  'Exam hall accessibility obstruction blocks wheelchair access at the south gate and requires remediation.',
  'Wheelchair users cannot access the examination hall south gate because of an obstruction; please repair access.',
].entries()){
  const res=await request('POST','/cases',lead,{
    institutionId,receivedAt:new Date(Date.now()-86400000).toISOString(),
    sourceChannel:'Email',sourceReference:stamp+'-'+i,category:'Infrastructure',
    complaintSummary:summary+' '+stamp,deadlinePolicyId:'DEMO-POL-30',
  });
  assert.equal(res.status,201,JSON.stringify(res.data));
  cases.push(res.data);
}
let pair;
for(let i=0;i<90;i++){
  const r=await request('GET','/m2/suggestions?state=open&caseId='+cases[0].id+'&pageSize=50',lead);
  pair=r.data?.rows?.find(x=>[x.caseA.id,x.caseB.id].includes(cases[0].id)&&[x.caseA.id,x.caseB.id].includes(cases[1].id));
  if(pair)break;
  await new Promise(resolve=>setTimeout(resolve,250));
}
assert.ok(pair,'M2 fixture pair not generated');
const handoff=await request('POST','/m2/suggestions/'+pair.id+'/handoff',lead,{
  supervisorId:'u-supervisor',reason:'Supervisor must compare independent exam hall accessibility reports before any relationship decision.',
  caseAVersion:pair.caseA.version,caseBVersion:pair.caseB.version,
});
assert.equal(handoff.status,201,JSON.stringify(handoff.data));
const browser=await chromium.launch({args:['--no-sandbox']});
const errors=[];
async function login(page){
  await page.goto(BASE+'/#/login');
  await page.locator('#username').fill('a.desai');
  await page.locator('#password').fill('caselink-demo');
  await page.click('button[type=submit]');
  await page.locator('#username').waitFor({state:'detached',timeout:15000});
}
try{
  const desktop=await browser.newContext({viewport:{width:1440,height:950}});
  const page=await desktop.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  await login(page);
  await page.goto(BASE+'/#/supervisor-review');
  await page.getByRole('heading',{name:'M3 — Supervisor Review'}).waitFor();
  await page.getByRole('heading',{name:'Assigned supervisor reviews'}).waitFor();
  await page.screenshot({path:OUT+'/m3-01-queue.png',fullPage:true});
  await page.getByRole('button',{name:new RegExp(pair.caseA.caseNumber+'|'+pair.caseB.caseNumber)}).first().click();
  await page.getByRole('heading',{name:'Complaint A'}).waitFor();
  await page.getByRole('heading',{name:'AI-assisted comparison'}).waitFor();
  await page.screenshot({path:OUT+'/m3-02-side-by-side.png',fullPage:true});
  await page.getByRole('button',{name:/Inspect independent timeline/}).first().click();
  await page.locator('.m3-timeline').first().waitFor();
  await page.screenshot({path:OUT+'/m3-03-timeline.png',fullPage:true});
  const select=page.locator('#m3-action');
  await select.selectOption('request_evidence');
  await page.locator('#m3-reason').fill('Please provide the original site inspection report for this incident.');
  await page.getByRole('button',{name:'Record Supervisor Action'}).click();
  await page.getByText('Awaiting Evidence').first().waitFor();
  await page.screenshot({path:OUT+'/m3-04-audit.png',fullPage:true});
  assert.equal(errors.length,0,'Desktop browser runtime errors: '+errors.join('; '));
  await desktop.close();

  const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const mobilePage=await mobile.newPage();
  mobilePage.on('pageerror',error=>errors.push(String(error)));
  await login(mobilePage);
  await mobilePage.goto(BASE+'/#/supervisor-review/'+handoff.data.handoffId);
  await mobilePage.getByRole('heading',{name:'Complaint A'}).waitFor();
  await mobilePage.screenshot({path:OUT+'/m3-05-mobile.png',fullPage:true});
  const overflow=await mobilePage.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+3);
  assert.equal(overflow,false,'M3 mobile horizontal overflow');
  assert.equal(errors.length,0,'Mobile browser runtime errors: '+errors.join('; '));
  await mobile.close();
  console.log('PASS M3 Playwright desktop: queue, comparison, independent timeline and review action');
  console.log('PASS M3 Playwright mobile: detail responsive, no viewport overflow');
}finally{await browser.close();}
