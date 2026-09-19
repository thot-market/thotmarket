import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoUser, demoBuyer, demoSettlement, demoOperator, importDemo, createDemoMandate, policyInput, mandateInput } from '../packages/market/src/fixtures.ts';
import { canonicalHash } from '../packages/protocol/src/index.ts';
import { splitSale, postJournal, accountBalance } from '../packages/ledger/src/index.ts';
import { completeDevelopmentAllocations } from '../packages/market/src/chain-worker.ts';
import type { Document } from '../packages/storage/src/index.ts';

const fixed='2026-09-05T12:00:00.000Z';const clock=()=>new Date(fixed);
async function app(options:Document={}) {return createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-market-')),config:{clock,...options}});}
async function ready(scenario='coding',options:Document={}) {
  const a=await app(options);await a.service.createPolicy(demoUser,'setup-policy',policyInput(a.service));
  const imported=await importDemo(a.service,demoUser,scenario,'setup-import-'+scenario);
  const mandate=await createDemoMandate(a.service,scenario==='research'?'research_flow':['professional','privileged'].includes(scenario)?'professional_flow':'general','setup-mandate');
  assert.equal((await a.service.runWorker()).failed,0);
  return {...a,imported,mandate};
}
const auth=(preview:Document,payout='inference_credit')=>{const{release,...fields}=preview;return {...fields,payout_preference:payout};};
async function sell(a:Awaited<ReturnType<typeof ready>>,payout='inference_credit') {
  const candidates=await a.service.candidates(demoUser);assert.equal(candidates.length,1);
  const preview=await a.service.preview(demoUser,candidates[0]!.candidate_id);
  const sale=await a.service.authorize(demoUser,'sale-authorization',auth(preview,payout));
  return {sale,preview};
}

test('E2E-1 local north-star: P0 fixture to exact delivery, 65/20/15, inference spend and separate mock burn',async t=>{
  const a=await ready();t.after(a.close);const{sale,preview}=await sell(a);
  const delivery=await a.service.delivery(demoBuyer,sale.license_id);
  assert.equal(delivery.delivery.bundle_hash,preview.release_artifact_hash);
  assert.equal(delivery.provenance.confidence_tier,'P0_OPERATOR');assert.match(delivery.provenance.limitations.join(' '),/PUBLIC DEVELOPMENT/);
  assert.ok(!JSON.stringify(delivery).includes('alex@example.test'));
  await a.service.runWorker();
  const earnings=await a.service.earnings(demoUser),s=earnings.settlements[0]!,e=earnings.entitlements[0]!;
  assert.deepEqual([s.gross_minor,s.direct_costs_minor,s.eligible_net_minor,s.contributor_minor,s.burn_minor,s.operator_minor],['10000','0','10000','6500','2000','1500']);
  assert.equal(e.disposition,'inference_credit');
  const reserved=await a.service.reserveInference(demoUser,'reserve-inference',e.entitlement_id,{amount_minor:'500'});
  await a.service.settleInference(demoSettlement,'settle-inference',reserved.reservation_id,{actual_minor:'400'});
  assert.equal((await a.service.earnings(demoUser)).entitlements[0]!.available_minor,'6100');
  const burned=await a.db.transaction(tx=>completeDevelopmentAllocations(tx,demoOperator.id));
  assert.equal(burned.burns_completed,1);assert.equal(burned.token_payouts_completed,0);
  const reconciliation=await a.service.reconciliation(demoOperator);assert.equal(reconciliation.balanced,true);
  assert.equal(reconciliation.burn_allocations[0]!.status,'BURN_FINAL');
  const exported=await a.service.auditExport(demoUser);assert.equal(exported.commitment,canonicalHash(exported.records));
});
test('E2E-2 local Research Flow: only the authorized security predicate enters delivery',async t=>{
  const a=await ready('research');t.after(a.close);const{sale,preview}=await sell(a);
  const delivery=await a.service.delivery(demoBuyer,sale.license_id);
  assert.equal(delivery.outcomes.length,1);assert.deepEqual(delivery.outcomes[0].predicate,{type:'security_traded',security_id:'broker:AAPL@mapping-v1'});
  for(const field of ['MSFT','NEVER-DISCLOSE-DEMO-ACCOUNT','positionSize','accountId','pseudonymous_subject_id','owner_user_id'])assert.ok(!JSON.stringify(delivery).includes(field));
  assert.deepEqual(preview.outcome_receipt_ids.length,1);await a.service.runWorker();assert.equal((await a.service.earnings(demoUser)).entitlements.length,1);
});
test('E2E-3 local Professional Flow: public exercise sells; same valid credential cannot rescue privileged text',async t=>{
  const a=await ready('professional');t.after(a.close);await sell(a);
  const rejected=await importDemo(a.service,demoUser,'privileged','privileged-import');
  const before=(await a.db.query('SELECT count(*)::text AS n FROM assay_receipts')).rows[0].n;
  await a.service.runWorker();assert.equal(rejected.status,'REJECTED');
  assert.equal((await a.service.receipts(demoUser,rejected.trace_id)).credentials.length,1);
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM assay_receipts')).rows[0].n,before);
  assert.equal((await a.service.candidates(demoUser)).filter(c=>c.trace_id===rejected.trace_id).length,0);
});
test('E2E-4 local THOT token payout and burn are separate final orders and cannot also spend inference',async t=>{
  const a=await ready('coding',{tokenEnabled:true});t.after(a.close);await sell(a,'token');await a.service.runWorker();
  const e=(await a.service.earnings(demoUser)).entitlements[0]!;
  await assert.rejects(a.service.choose(demoUser,'missing-wallet',e.entitlement_id,{disposition:'token'}),/INVALID_WALLET/);
  await a.service.choose(demoUser,'choose-token-wallet',e.entitlement_id,{disposition:'token',wallet_address:'0x'+'1'.repeat(40)});
  await assert.rejects(a.service.reserveInference(demoUser,'cannot-both-pay',e.entitlement_id,{amount_minor:'1'}),/NOT_INFERENCE/);
  const result=await a.db.transaction(tx=>completeDevelopmentAllocations(tx,demoOperator.id));
  assert.equal(result.burns_completed,1);assert.equal(result.token_payouts_completed,1);
  assert.equal((await a.service.earnings(demoUser)).entitlements[0]!.status,'TOKEN_WITHDRAWN');
  assert.equal((await a.service.reconciliation(demoOperator)).balanced,true);
});
test('E2E-5 local crash recovery: committed license survives restart; failed worker rolls back then settles once',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-recovery-'));
  let a=await createApplication({dataDir,config:{clock}});
  try {
    await a.service.createPolicy(demoUser,'recovery-policy',policyInput(a.service));await importDemo(a.service,demoUser,'coding','recovery-import');await createDemoMandate(a.service,'general','recovery-mandate');await a.service.runWorker();
    const preview=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0]!.candidate_id);
    const sale=await a.service.authorize(demoUser,'recovery-authorize',auth(preview));
    await a.close();a=await createApplication({dataDir,config:{clock}});
    const original=a.service.settleLicense.bind(a.service);
    a.service.settleLicense=async(tx,id)=>{await original(tx,id);throw new Error('SIMULATED_CRASH_BEFORE_ACK');};
    assert.equal((await a.service.runWorker()).failed,1);
    assert.equal((await a.service.earnings(demoUser)).entitlements.length,0);
    assert.equal((await a.db.query('SELECT count(*)::text AS n FROM licenses')).rows[0].n,'1');
    a.service.settleLicense=original;
    await a.db.transaction(tx=>tx.sql.query("UPDATE outbox_events SET available_at=now() WHERE status='pending'"));
    await a.service.runWorker();await a.service.runWorker();
    assert.equal((await a.service.earnings(demoUser)).entitlements.length,1);
    assert.equal((await a.service.authorize(demoUser,'recovery-authorize',auth(preview))).license_id,sale.license_id);
    assert.equal((await a.service.reconciliation(demoOperator)).balanced,true);
  }finally{await a.close();}
});
test('E2E-6 local chain replay: persisted orders, transfers and journal commitment are unchanged by repeat execution',async t=>{
  const a=await ready('coding',{tokenEnabled:true});t.after(a.close);await sell(a,'token');await a.service.runWorker();
  const e=(await a.service.earnings(demoUser)).entitlements[0]!;await a.service.choose(demoUser,'replay-token-choice',e.entitlement_id,{disposition:'token',wallet_address:'0x'+'2'.repeat(40)});
  await a.db.transaction(tx=>completeDevelopmentAllocations(tx,demoOperator.id));
  const before=await a.service.reconciliation(demoOperator);
  const repeated=await a.db.transaction(tx=>completeDevelopmentAllocations(tx,demoOperator.id));
  assert.equal(repeated.token_payouts_completed,0);assert.equal(repeated.burns_completed,0);
  assert.equal((await a.service.reconciliation(demoOperator)).commitment,before.commitment);
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM market_purchase_orders')).rows[0].n,'2');
});
test('spec 16/89/113: import, authorization, worker and delivery retries never duplicate sale or entitlement',async t=>{
  const a=await ready();t.after(a.close);
  const repeated=await importDemo(a.service,demoUser,'coding','setup-import-coding');assert.equal(repeated.trace_id,a.imported.trace_id);
  const{sale,preview}=await sell(a);await a.service.authorize(demoUser,'sale-authorization',auth(preview));
  await assert.rejects(a.service.authorize(demoUser,'sale-authorization',auth(preview,'token')),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(a.service.authorize(demoUser,'second-authorization',auth(preview)),/ALREADY_AUTHORIZED/);
  await Promise.all([a.service.runWorker(),a.service.runWorker()]);
  await a.service.delivery(demoBuyer,sale.license_id);await a.service.delivery(demoBuyer,sale.license_id);
  assert.equal((await a.service.earnings(demoUser)).entitlements.length,1);assert.equal((await a.service.stats(demoBuyer,a.mandate.mandate_id)).delivered,1);
});
test('spec 48–51/57: draft metadata edits, funding, expiry, pause and semantic immutability',async t=>{
  const a=await app();t.after(a.close);const body=mandateInput(a.service);
  await assert.rejects(a.service.createMandate(demoBuyer,'expired-mandate',{...body,expires_at:'2026-09-04T00:00:00.000Z'}),/MANDATE_EXPIRED/);
  const m=await a.service.createMandate(demoBuyer,'draft-mandate',body);
  await assert.rejects(a.service.activateMandate(demoBuyer,'unfunded-activate',m.mandate_id),/MANDATE_UNFUNDED/);
  await a.service.editMandate(demoBuyer,'draft-expiry',m.mandate_id,{expires_at:a.service.future(86400)});
  await assert.rejects(a.service.editMandate(demoBuyer,'draft-price-change',m.mandate_id,{economics:{unit_price_minor:'1'}}),/INVALID_MANDATE_ECONOMICS/);
  await a.service.fundMandate(demoBuyer,'funded-mandate',m.mandate_id,{});await a.service.activateMandate(demoBuyer,'active-mandate',m.mandate_id);
  await assert.rejects(a.service.editMandate(demoBuyer,'active-edit',m.mandate_id,{expires_at:a.service.future(86400)}),/MANDATE_IMMUTABLE/);
  await a.service.pauseMandate(demoBuyer,'paused-mandate',m.mandate_id);assert.equal((await a.service.stats(demoBuyer,m.mandate_id)).status,'paused');
});
test('spec 52/56: concurrent exact approvals cannot spend more than a funded one-unit mandate',async t=>{
  const a=await app();t.after(a.close);await a.service.createPolicy(demoUser,'race-policy',policyInput(a.service));
  await importDemo(a.service,demoUser,'coding','race-trace-one');
  const distinctBundle=a.service.privacy.createDemoBundle({turns:[{role:'user',content:'Debug a second TypeScript cache: expired entries survive the eviction pass.'},{role:'assistant',content:'Check the eviction deadline and add a failing expiry test.'}]},demoUser.id);
  await a.service.importTrace(demoUser,'race-trace-two',{bundle:distinctBundle,category:'general',rights_confirmed:true,model_output_licensed:true});
  const body=mandateInput(a.service);body.economics.total_budget_minor='10000';body.economics.max_units=1;
  const m=await a.service.createMandate(demoBuyer,'race-mandate',body);await a.service.fundMandate(demoBuyer,'race-fund',m.mandate_id,{});await a.service.activateMandate(demoBuyer,'race-activate',m.mandate_id);await a.service.runWorker();
  const candidates=await a.service.candidates(demoUser);assert.equal(candidates.length,2);
  const previews=await Promise.all(candidates.map(c=>a.service.preview(demoUser,c.candidate_id)));
  const results=await Promise.allSettled(previews.map((p,i)=>a.service.authorize(demoUser,'concurrent-auth-'+i,auth(p))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await a.service.runWorker();
  assert.equal((await a.service.stats(demoBuyer,m.mandate_id)).remaining_budget_minor,'0');assert.equal((await a.service.earnings(demoUser)).entitlements.length,1);
});
test('spec 53/54/55/66: provenance, credentials, rights and missing policy hard filters run before assays',async t=>{
  const a=await app();t.after(a.close);await importDemo(a.service,demoUser,'coding','gate-no-policy');await createDemoMandate(a.service,'general','gate-mandate');await a.service.runWorker();
  assert.equal((await a.service.candidates(demoUser)).length,0);
  await a.service.createPolicy(demoUser,'gate-policy',policyInput(a.service));
  const body=mandateInput(a.service);body.criteria.provenance_tiers=['P2_TEE'];
  const m=await a.service.createMandate(demoBuyer,'gate-p2-mandate',body);await a.service.fundMandate(demoBuyer,'gate-p2-fund',m.mandate_id,{});await a.service.activateMandate(demoBuyer,'gate-p2-activate',m.mandate_id);await a.service.runWorker();
  assert.equal((await a.db.query("SELECT count(*)::text AS n FROM assay_receipts WHERE document->'receipt'->>'mandate_id'=$1",[m.mandate_id])).rows[0].n,'0');
});
test('spec 67–73: exact price, evidence IDs and separate disclosure policy bind approval',async t=>{
  const a=await ready('research');t.after(a.close);const p=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0]!.candidate_id);
  await assert.rejects(a.service.authorize(demoUser,'bad-approval-price',{...auth(p),expected_gross_minor:'9999'}),/PRICE_MISMATCH/);
  await assert.rejects(a.service.authorize(demoUser,'bad-approval-scope',{...auth(p),outcome_receipt_ids:[]}),/SCOPE_MISMATCH/);
  const policy=policyInput(a.service);policy.evidence_disclosure.outcome_predicate_types=[];
  await a.service.createPolicy(demoUser,'deny-outcome-policy',policy);
  await assert.rejects(a.service.authorize(demoUser,'stale-approval-policy',auth(p)),/POLICY_CHANGED/);
  await assert.rejects(a.service.createPolicy(demoUser,'identity-flag-policy',{...policy,evidence_disclosure:{...policy.evidence_disclosure,identity_disclosure:true}}),/IDENTITY_DISCLOSURE_DISABLED/);
});
test('spec 74/80: standing authorization and exclusivity are fail-closed flags by default',async t=>{
  const a=await app();t.after(a.close);
  await assert.rejects(a.service.createPolicy(demoUser,'standing-disabled',{...policyInput(a.service),mode:'standing_authorization'}),/STANDING_AUTHORIZATION_DISABLED/);
  const m=mandateInput(a.service);m.license.exclusive=true;await assert.rejects(a.service.createMandate(demoBuyer,'exclusive-disabled',m),/EXCLUSIVITY_DISABLED/);
});
test('spec 70/75/76/110: no delivery before authorization, wrong buyer denied, expiry denies retrieval',async t=>{
  let time=fixed;const a=await ready('coding',{clock:()=>new Date(time)});t.after(a.close);
  const p=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0]!.candidate_id);
  await assert.rejects(a.service.delivery(demoBuyer,p.release.license_id));const {sale}=await sell(a);
  time='2026-11-05T12:00:00.000Z';await assert.rejects(a.service.delivery(demoBuyer,sale.license_id),/DELIVERY_EXPIRED/);
});
test('spec 82–88: exact bigint split properties hold over boundaries and 10,000 deterministic amounts',()=>{
  for(const gross of [0n,1n,2n,3n,99n,100n,101n,10n**50n,...Array.from({length:10000},(_,i)=>BigInt(i)*7919n)]) {
    const s=splitSale(gross);assert.equal(s.gross_minor-s.direct_costs_minor,s.eligible_net_minor);
    assert.equal(s.contributor_minor+s.burn_minor+s.operator_minor,s.eligible_net_minor);
    assert.equal(s.contributor_minor,gross*65n/100n);assert.equal(s.burn_minor,gross*20n/100n);assert.equal(s.operator_minor,gross-s.contributor_minor-s.burn_minor);
  }
  assert.throws(()=>splitSale(-1n));assert.throws(()=>splitSale(10n,[{code:'overhead',amount_minor:'1'}],[],10n));
  assert.throws(()=>splitSale(10n,[{code:'approved',amount_minor:'-1'}],['approved'],10n));
  assert.throws(()=>splitSale(10n,[{code:'approved',amount_minor:'11'}],['approved'],11n));
});
test('spec 82: database defers balance validation to commit and rejects currency mismatches and mutable journals',async t=>{
  const a=await app();t.after(a.close);
  await assert.rejects(a.db.transaction(tx=>postJournal(tx,'unbalanced-journal','USD',[{account:'ASSET:cash',owner:'network',amount:2n},{account:'LIABILITY:buyer_escrow',owner:'x',amount:-1n}])));
  await a.db.transaction(tx=>postJournal(tx,'balanced-journal','USD',[{account:'ASSET:cash',owner:'network',amount:2n},{account:'LIABILITY:buyer_escrow',owner:'x',amount:-2n}]));
  await assert.rejects(a.db.transaction(tx=>tx.sql.query('UPDATE ledger_entries SET amount=0')));
  await assert.rejects(a.db.transaction(tx=>tx.sql.query('DELETE FROM ledger_transactions')));
  assert.equal(await a.db.transaction(tx=>accountBalance(tx,'USD','network','ASSET:cash')),2n);
});
test('spec 90–93: failed inference releases exact reservation and spent credit cannot become token',async t=>{
  const a=await ready('coding',{tokenEnabled:true});t.after(a.close);await sell(a);await a.service.runWorker();const e=(await a.service.earnings(demoUser)).entitlements[0]!;
  await assert.rejects(a.service.reserveInference(demoUser,'oversized-reserve',e.entitlement_id,{amount_minor:'6501'}),/INSUFFICIENT_CREDIT/);
  const r=await a.service.reserveInference(demoUser,'all-credit-reserve',e.entitlement_id,{amount_minor:'6500'});
  await a.service.settleInference(demoSettlement,'failed-inference-release',r.reservation_id,{actual_minor:'0'});
  assert.equal((await a.service.earnings(demoUser)).entitlements[0]!.available_minor,'6500');
  await assert.rejects(a.service.choose(demoUser,'cannot-switch-credit',e.entitlement_id,{disposition:'token',wallet_address:'0x'+'1'.repeat(40)}),/ALREADY_DISPOSED/);
});
test('private deletion is owner-scoped, blocks new sale immediately and deletes only unlicensed private objects',async t=>{
  const a=await ready();t.after(a.close);const p=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0]!.candidate_id);
  const ref=await a.db.transaction(tx=>tx.get('traces',a.imported.trace_id,demoUser.id));
  await assert.rejects(a.service.deleteTrace({id:'other-user',role:'user'},'wrong-owner-delete',a.imported.trace_id),/NOT_FOUND/);
  await a.service.deleteTrace(demoUser,'delete-own-trace',a.imported.trace_id);
  await assert.rejects(a.service.authorize(demoUser,'deleted-trace-sale',auth(p)),/TRACE_INELIGIBLE/);
  await a.service.runWorker();await assert.rejects(a.privacy.open(demoUser.id,ref.raw_ref),/ENOENT/);
  assert.ok((await a.service.receipts(demoUser,a.imported.trace_id)).provenance);
});
test('worker exceptions cannot commit a sale and retry exhaustion becomes explicit failed work',async t=>{
  const a=await app();t.after(a.close);await a.db.transaction(tx=>tx.enqueue('network','UnknownSyntheticJob',{test_id:'fixture'}));
  for(let i=0;i<5;i++){const result=await a.service.runWorker();assert.equal(result.failed,1);await a.db.transaction(tx=>tx.sql.query("UPDATE outbox_events SET available_at=now() WHERE status='pending'"));}
  const job=(await a.db.query('SELECT status,attempts,last_error_code FROM outbox_events')).rows[0];
  assert.equal(job.status,'failed');assert.equal(job.attempts,5);assert.equal(job.last_error_code,'UNKNOWN_JOB');
});
test('retention sweep deletes private and expired release objects while preserving immutable accounting',async t=>{
  let time=fixed;const a=await ready('coding',{clock:()=>new Date(time),privateRetentionDays:1});t.after(a.close);
  const{sale}=await sell(a);await a.service.runWorker();
  const record=await a.db.transaction(tx=>tx.get('traces',a.imported.trace_id,demoUser.id));
  time='2026-09-07T12:00:00.000Z';await a.service.sweepRetention();assert.equal((await a.service.runWorker()).failed,0);
  await assert.rejects(a.privacy.open(demoUser.id,record.raw_ref),/ENOENT/);
  assert.ok(await a.service.delivery(demoBuyer,sale.license_id),'licensed release has its own longer retention period');
  const artifact=await a.db.transaction(tx=>tx.get('release_artifacts',sale.license_id,demoUser.id));
  time='2026-11-05T12:00:00.000Z';await a.service.sweepRetention();assert.equal((await a.service.runWorker()).failed,0);
  await assert.rejects(a.privacy.open(demoUser.id,artifact.object_ref),/ENOENT/);
  assert.equal((await a.service.earnings(demoUser)).settlements.length,1);
  assert.equal((await a.service.reconciliation(demoOperator)).balanced,true);
  assert.equal((await a.service.sweepRetention()).queued,0);
});
test('spec 51/70: advancing past a pending mandate deadline prevents authorization with no persisted sale',async t=>{
  let time=fixed;const a=await ready('coding',{clock:()=>new Date(time)});t.after(a.close);
  const preview=await a.service.preview(demoUser,(await a.service.candidates(demoUser))[0]!.candidate_id);
  time='2026-09-20T12:00:00.000Z';
  await assert.rejects(a.service.authorize(demoUser,'expired-pending-authorization',auth(preview)),/AUTHORIZATION_EXPIRED/);
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM licenses')).rows[0].n,'0');
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM sale_authorizations')).rows[0].n,'0');
});
test('spec 74: explicitly enabled standing policy records its exact version and concrete release authorization',async t=>{
  const a=await app({standingAuthorization:true});t.after(a.close);
  const p=await a.service.createPolicy(demoUser,'standing-policy-enabled',{...policyInput(a.service),mode:'standing_authorization',payout_preference:'inference_credit'});
  await importDemo(a.service,demoUser,'coding','standing-import');await createDemoMandate(a.service,'general','standing-mandate');assert.equal((await a.service.runWorker()).failed,0);
  const authorizations=await a.db.transaction(tx=>tx.list('sale_authorizations',demoUser.id));
  assert.equal(authorizations.length,1);assert.equal(authorizations[0]!.policy_id,p.policy_id);assert.equal(authorizations[0]!.policy_version,p.version);
  assert.equal((await a.service.earnings(demoUser)).entitlements.length,1);
});
test('spec 80: controlled exclusive license blocks a second funded buyer mandate from licensing the same trace',async t=>{
  const a=await app({exclusivity:true});t.after(a.close);
  a.service.config.approvedLicenseTemplates['synthetic-exclusive-v1']='SYNTHETIC DEVELOPMENT DATA ONLY. Exclusive research evaluation for 30 days. No model training, onward transfer or re-identification.';
  const p=policyInput(a.service);p.license_defaults.exclusive=true;await a.service.createPolicy(demoUser,'exclusive-policy-enabled',p);
  await importDemo(a.service,demoUser,'coding','exclusive-import');const input=mandateInput(a.service);input.license.exclusive=true;input.license_template_id='synthetic-exclusive-v1';
  const exclusive=await a.service.createMandate(demoBuyer,'exclusive-mandate-enabled',input);await a.service.fundMandate(demoBuyer,'exclusive-funding',exclusive.mandate_id,{});await a.service.activateMandate(demoBuyer,'exclusive-activate',exclusive.mandate_id);
  await createDemoMandate(a.service,'general','nonexclusive-mandate');await a.service.runWorker();
  const c=await a.service.candidates(demoUser);assert.equal(c.length,2);
  const first=await a.service.preview(demoUser,c.find(item=>item.mandate_id===exclusive.mandate_id)!.candidate_id);
  await a.service.authorize(demoUser,'exclusive-first-sale',auth(first));
  const second=await a.service.preview(demoUser,c.find(item=>item.mandate_id!==exclusive.mandate_id)!.candidate_id);
  await assert.rejects(a.service.authorize(demoUser,'exclusive-conflicting-sale',auth(second)),/EXCLUSIVE_LOCK/);
  assert.equal((await a.db.query('SELECT count(*)::text AS n FROM licenses')).rows[0].n,'1');
});
test('contributor burn receipts are visible for their own sales but never expose another contributor allocation',async t=>{
  const a=await ready();t.after(a.close);await sell(a);await a.service.runWorker();
  await a.db.transaction(tx=>tx.insert('burn_allocations','another-sale-burn','network',{settlement_id:'another-private-sale',amount_minor:'999',currency:'USD',status:'CREATED',simulated:true}));
  const earnings=await a.service.earnings(demoUser);assert.equal(earnings.burn_allocations.length,1);assert.equal(earnings.burn_allocations[0]!.amount_minor,'2000');
  const exported=await a.service.auditExport(demoUser);assert.equal(exported.records.burn_allocations.length,1);assert.ok(!JSON.stringify(exported).includes('another-private-sale'));
});
