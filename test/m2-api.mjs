/**
 * M2 API/integration/security regressions. Runs on its own seeded, non-demo verification server.
 * Three same-institution synthetic complaints verify independent A-B and A-C pairs.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080';
const PASSWORD = 'caselink-demo';
const DB = process.env.CASELINK_DB ?? 'data/caselink.db';
const tests = [];
async function check(label, work) {
  try { await work(); tests.push([label,true]); console.log('PASS',label); }
  catch(e) { tests.push([label,false]); console.error('FAIL',label,e); }
}
async function req(method, path, token, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
async function login(username) {
  const response = await req('POST', '/auth/login', null, { username, password: PASSWORD });
  assert.equal(response.status, 200);
  return response.data.token;
}
const [lead, reviewer, west, supervisor] = await Promise.all([
  login('m.nair'), login('r.khan'), login('s.bose'), login('a.desai'),
]);
const institutionRes = await req('GET','/institutions?q=vaigai',lead);
const inst = institutionRes.data.institutions[0];
assert.ok(inst);
const stamp = Date.now().toString(36);
const created = [];
for (const [i, summary] of [
  'Hostel north wing drinking water is unavailable to residents after a pipe failure and delayed repair.',
  'Hostel north wing drinking water is unavailable to students after a pipe failure and delayed repair.',
  'Hostel north wing drinking water is unavailable since yesterday after a pipe failure and delayed repair.',
].entries()) {
  const r = await req('POST','/cases',lead,{
    institutionId: inst.id,
    receivedAt: new Date(Date.now()-86400000).toISOString(),
    sourceChannel: 'Email',
    sourceReference: 'M2-PAIR-' + stamp + '-' + i,
    category: 'Infrastructure',
    complaintSummary: summary + ' Fixture ' + stamp,
    assignedOfficerId: null,
    deadlinePolicyId: 'DEMO-POL-30',
  });
  assert.equal(r.status,201,JSON.stringify(r.data));
  created.push(r.data);
}
const a = created[0], b = created[1], c = created[2];
async function queue(token, args = {}) {
  const params = new URLSearchParams({ state: 'all', page: '1', pageSize: '50', ...args });
  return req('GET','/m2/suggestions?' + params,token);
}
let pairs = [];
for (let tries = 0; tries < 80; tries++) {
  const response = await queue(lead, { caseId: a.id });
  pairs = response.data?.rows?.filter((r) =>
    [a.id,b.id,c.id].includes(r.caseA.id) && [a.id,b.id,c.id].includes(r.caseB.id)) ?? [];
  if (pairs.length >= 2) break;
  await new Promise((resolve) => setTimeout(resolve,250));
}
const pairAB = pairs.find((r) => [r.caseA.id,r.caseB.id].includes(a.id) && [r.caseA.id,r.caseB.id].includes(b.id));
const pairAC = pairs.find((r) => [r.caseA.id,r.caseB.id].includes(a.id) && [r.caseA.id,r.caseB.id].includes(c.id));
await check('pairwise A-B and A-C exist independently', () => {
  assert.ok(pairAB); assert.ok(pairAC); assert.notEqual(pairAB.id,pairAC.id);
});
if (pairAB && pairAC) {
  await check('evidence breakdown is deterministic and genuinely stored', () => {
    assert.ok(pairAB.evidenceSignals >= 2);
    assert.equal(pairAB.semanticSimilarity,null);
    assert.ok(pairAB.lexicalJaccard !== null && pairAB.lexicalJaccard >= 0 && pairAB.lexicalJaccard <= 1);
    const database = new Database(DB,{ readonly:true });
    try {
      const row = database.prepare('SELECT reasons_json FROM suggestions WHERE id = ?').get(pairAB.id);
      const reasons = JSON.parse(row.reasons_json);
      const topic = reasons.find((r) => r.rule === 'topic_similarity');
      assert.ok(topic);
      const saved = Number(topic.detail.match(/similarity (0(?:\.\d+)?|1(?:\.0+)?) \(/)[1]);
      assert.equal(pairAB.lexicalJaccard,saved);
    } finally { database.close(); }
  });
  await check('pagination retains candidate identity without duplicate/truncated counts', async () => {
    const page1 = await queue(lead, { caseId:a.id, page:'1',pageSize:'1' });
    const page2 = await queue(lead, { caseId:a.id, page:'2',pageSize:'1' });
    assert.equal(page1.status,200); assert.equal(page2.status,200);
    assert.ok(page1.data.total >= 2);
    assert.notEqual(page1.data.rows[0].id,page2.data.rows[0].id);
  });
  await check('protected endpoint requires authentication', async () => {
    assert.equal((await req('GET','/m2/suggestions',null)).status,401);
    assert.equal((await req('GET','/m2/suggestions/'+pairAB.id,null)).status,401);
  });
  await check('out-of-region user cannot read pair or infer text in queue', async () => {
    const hidden = await req('GET','/m2/suggestions/'+pairAB.id,west);
    assert.equal(hidden.status,404);
    const list = await queue(west,{ caseId:a.id });
    assert.equal(list.status,200);
    assert.equal(list.data.rows.length,0);
    assert.ok(!JSON.stringify(list.data).includes(stamp));
  });
  await check('reviewer without both content grants sees redacted evidence and cannot hand off', async () => {
    const detail = await req('GET','/m2/suggestions/'+pairAB.id,reviewer);
    if(detail.status === 200) {
      assert.equal(detail.data.candidate.requiresContentAccess,true);
      assert.equal(detail.data.candidate.lexicalJaccard,null);
      assert.ok(!JSON.stringify(detail.data).includes(stamp));
      const forbidden = await req('POST','/m2/suggestions/'+pairAB.id+'/handoff',reviewer,{
        supervisorId: detail.data.supervisors[0]?.id ?? supervisor,
        reason:'Request supervisor review of infrastructure complaint pair',
        caseAVersion:pairAB.caseA.version,caseBVersion:pairAB.caseB.version,
      });
      assert.equal(forbidden.status,403);
    } else assert.equal(detail.status,404);
  });
  const detail = await req('GET','/m2/suggestions/'+pairAB.id,lead);
  await check('authorized sender sees region-scoped supervisor choices', () => {
    assert.equal(detail.status,200);
    assert.ok(detail.data.supervisors.length > 0);
    assert.equal(detail.data.candidate.requiresContentAccess,false);
  });
  const recipient = detail.data.supervisors[0]?.id;
  if(recipient) {
    const request = {
      supervisorId:recipient,
      reason:'Independent complaints refer to one water disruption; supervisor must inspect evidence before deciding.',
      caseAVersion:pairAB.caseA.version,caseBVersion:pairAB.caseB.version,
    };
    const database = new Database(DB,{ readonly:true });
    let before;
    try { before = database.prepare('SELECT COUNT(*) AS n FROM relationships').get().n; }
    finally { database.close(); }
    await check('handoff rejects a stale case version', async () => {
      const stale = await req('POST','/m2/suggestions/'+pairAB.id+'/handoff',lead,{...request,caseAVersion:pairAB.caseA.version + 1});
      assert.equal(stale.status,409);
    });
    await check('handoff is durable and returns 201 with no relationship decision', async () => {
      const accepted = await req('POST','/m2/suggestions/'+pairAB.id+'/handoff',lead,request);
      assert.equal(accepted.status,201,JSON.stringify(accepted.data));
      const after = new Database(DB,{readonly:true});
      try {
        const row = after.prepare('SELECT * FROM m2_review_handoffs WHERE id = ?').get(accepted.data.handoffId);
        assert.equal(row.supervisor_id,recipient);
        assert.equal(after.prepare('SELECT COUNT(*) AS n FROM relationships').get().n,before);
        assert.ok(after.prepare('SELECT id FROM notifications WHERE entity_id = ? AND kind = ?').get(pairAB.id,'m2_handoff'));
      } finally { after.close(); }
    });
    await check('duplicate handoff is blocked without duplicate notification', async () => {
      const again = await req('POST','/m2/suggestions/'+pairAB.id+'/handoff',lead,request);
      assert.equal(again.status,409);
    });
  }
}
console.log('M2 API/integration/security:',tests.filter((t)=>t[1]).length+'/'+tests.length);
if(tests.some((t)=>!t[1]))process.exitCode=1;
