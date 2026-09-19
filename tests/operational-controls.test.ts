import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { OperationalControls } from '../packages/market/src/operational-controls.ts';
import { DeliveryLinks } from '../packages/market/src/delivery-links.ts';
import { demoUser, demoBuyer, demoOperator, importDemo, createDemoMandate, policyInput } from '../packages/market/src/fixtures.ts';
const clock=()=>new Date('2026-09-06T00:00:00.000Z');
async function setup(t:any){
  const path=await mkdtemp(join(tmpdir(),'thot-operations-test-'));
  const app=await createApplication({dataDir:path,config:{clock}});
  t.after(async()=>{await app.close();await rm(path,{recursive:true,force:true});});
  const controls=new OperationalControls(app.service);return {...app,controls};
}
function update(revision:number,sales=false,deliveries=false,inference=false){return {expected_revision:revision,paused:{sales,deliveries,inference},reason_code:'MAINTENANCE',acknowledge_resume:true};}
async function candidate(a:any){
  await a.service.createPolicy(demoUser,'ops-policy',policyInput(a.service));
  await importDemo(a.service,demoUser,'coding','ops-import');
  await createDemoMandate(a.service,'general','ops-mandate');await a.service.runWorker();
  const preview=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0].candidate_id);
  const {release,...fields}=preview;return {...fields,payout_preference:'inference_credit'};
}
test('incident controls require security role, exact revision, bounded reason and explicit resume review',async t=>{
  const a=await setup(t);
  await assert.rejects(a.controls.update(demoUser,'ops-forbidden',update(0,true)),/FORBIDDEN/);
  await assert.rejects(a.controls.update(demoOperator,'ops-raw-reason',{...update(0,true),reason_code:'PRIVATE SECRET'}),/INVALID_OPERATIONAL_REASON/);
  const input=update(0,true);const paused=await a.controls.update(demoOperator,'ops-paused',input);
  assert.equal(paused.revision,1);assert.deepEqual(await a.controls.update(demoOperator,'ops-paused',input),paused);
  await assert.rejects(a.controls.update(demoOperator,'ops-stale',update(0)),/REVISION_CONFLICT/);
  await assert.rejects(a.controls.update(demoOperator,'ops-resume-without-review',{...update(1),acknowledge_resume:false}),/RESUME_REVIEW_REQUIRED/);
  assert.equal((await a.controls.status(demoOperator)).control.sales,true);
  assert.equal((await a.controls.update(demoOperator,'ops-resume',update(1))).sales,false);
});
test('sales pause blocks new authorizations without destroying existing candidates; resume works once',async t=>{
  const a=await setup(t),input=await candidate(a);
  await a.controls.update(demoOperator,'ops-stop-sales',update(0,true));
  await assert.rejects(a.service.authorize(demoUser,'ops-paused-authorization',input),/OPERATION_PAUSED/);
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM licenses')).rows[0].n,'0');
  await a.controls.update(demoOperator,'ops-start-sales',update(1));
  const sale=await a.service.authorize(demoUser,'ops-paused-authorization',input);
  assert.equal((await a.service.authorize(demoUser,'ops-paused-authorization',input)).license_id,sale.license_id);
});
test('delivery pause blocks ordinary and previously signed access while committed settlement still completes',async t=>{
  const a=await setup(t),input=await candidate(a),sale=await a.service.authorize(demoUser,'ops-committed-sale',input);
  const links=new DeliveryLinks(a.service),issued=await links.issue(demoBuyer,'ops-link-before-pause',sale.license_id);
  const capability=new URL(issued.download_url,'http://127.0.0.1').searchParams.get('capability');
  await a.controls.update(demoOperator,'ops-stop-all',update(0,true,true,true));
  await assert.rejects(a.service.delivery(demoBuyer,sale.license_id),/OPERATION_PAUSED/);
  await assert.rejects(links.redeem(demoBuyer,sale.license_id,capability),/OPERATION_PAUSED/);
  await assert.rejects(links.issue(demoBuyer,'ops-new-link-paused',sale.license_id),/OPERATION_PAUSED/);
  assert.equal((await a.service.runWorker()).failed,0);
  assert.equal((await a.service.earnings(demoUser)).entitlements.length,1);
  assert.equal((await a.service.reconciliation(demoOperator)).balanced,true);
  await a.controls.update(demoOperator,'ops-resume-all',update(1));
  assert.equal((await links.redeem(demoBuyer,sale.license_id,capability)).license_id,sale.license_id);
});
test('paused matching creates no assays and resume re-enqueues active mandates',async t=>{
  const a=await setup(t);
  await a.service.createPolicy(demoUser,'ops-match-policy',policyInput(a.service));
  await createDemoMandate(a.service,'general','ops-match-mandate');await a.service.runWorker();
  await a.controls.update(demoOperator,'ops-stop-matching',update(0,true));
  await importDemo(a.service,demoUser,'coding','ops-match-import');await a.service.runWorker();
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM assay_receipts')).rows[0].n,'0');
  await a.controls.update(demoOperator,'ops-resume-matching',update(1));await a.service.runWorker();
  assert.equal((await a.service.candidates(demoUser)).length,1);
});
test('operational reports use bounded aggregate metrics and preserve controls across restart',async t=>{
  const a=await setup(t);await candidate(a);await a.controls.update(demoOperator,'ops-durable-pause',update(0,true));
  const status=await a.controls.status(demoOperator);
  assert.equal(status.metrics.trace_count,1);assert.equal(status.metrics.ledger_balanced,true);
  assert.deepEqual(status.alerts,[]);
  for(const secret of ['alex@example.test','demo-user','demo-buyer','scrubbed_content','object_ref','prompt_ref'])assert.ok(!JSON.stringify(status).includes(secret));
  await assert.rejects(a.controls.status(demoBuyer),/FORBIDDEN/);
  await a.close();const restored=await createApplication({dataDir:a.dataDir,config:{clock}});
  try{assert.equal((await new OperationalControls(restored.service).status(demoOperator)).control.sales,true);}finally{await restored.close();}
});
