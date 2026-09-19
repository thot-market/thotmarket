import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoBuyer, demoUser, mandateInput, policyInput } from '../packages/market/src/fixtures.ts';
import type { Document } from '../packages/storage/src/index.ts';
import {canonicalJson,canonicalHash} from '../packages/protocol/src/index.ts';

const now='2026-09-07T12:00:00.000Z',clock=()=>new Date(now);
async function setup(t:TestContext,options:Document={}){const dataDir=await mkdtemp(join(tmpdir(),'thot-contributor-test-'));const app=await createApplication({dataDir,config:{clock},...options});t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});return app;}
const history=(user='Study public AAPL filings',assistant='Compare reported revenue and stated risks.')=>[
  JSON.stringify({type:'user',sessionId:'session-1',timestamp:'2026-09-07T10:00:00Z',cwd:'/projects/research',message:{role:'user',content:user}}),
  JSON.stringify({type:'assistant',sessionId:'session-1',timestamp:'2026-09-07T10:01:00Z',message:{role:'assistant',content:[{type:'text',text:assistant}]}}),
].join('\n');
const codexHistory=()=>[
  JSON.stringify({timestamp:'2026-09-07T10:00:00Z',type:'session_meta',payload:{id:'codex-session-1',timestamp:'2026-09-07T10:00:00Z',cwd:'/projects/research-router',originator:'codex_cli_rs'}}),
  JSON.stringify({timestamp:'2026-09-07T10:01:00Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Review the public protocol implementation'}]}}),
  JSON.stringify({timestamp:'2026-09-07T10:02:00Z',type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'The implementation uses bounded inputs.'}]}}),
].join('\n');
const input=(text:string,content_commitment:string):Document=>({filename:'session.jsonl',text,content_commitment,category:'research_flow',rights_confirmed:true,model_output_licensed:true});
const verifier=async(_evidence:Document,ticket:string)=>{
  const [encoded]=ticket.split('.');const payload=JSON.parse(Buffer.from(encoded!,'base64url').toString('utf8'));
  return {verified:true,owner_user_id:payload.owner_user_id,job_id:payload.job_id,link_ticket_hash:createHash('sha256').update(ticket).digest('hex'),subject:'c'.repeat(64),observed_at:now};
};

test('contributor preview and confirmation persist an honest appraised portfolio card',async t=>{
  const app=await setup(t);const text=history();
  const preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  assert.equal(preview.title,'Claude Code: research');assert.equal(preview.turn_count,2);assert.equal(preview.privacy_flags.length,0);
  await assert.rejects(app.portfolio.import(demoUser,'import-mismatch',input(text,'0'.repeat(64))),/IMPORT_PREVIEW_CHANGED/);
  await assert.rejects(app.portfolio.import(demoUser,'import-no-rights',{...input(text,preview.content_commitment),rights_confirmed:false}),/IMPORT_RIGHTS_CONFIRMATION_REQUIRED/);
  const imported=await app.portfolio.import(demoUser,'import-confirmed',input(text,preview.content_commitment));
  assert.ok(imported.item);assert.equal(imported.status,'AVAILABLE');assert.equal(imported.item.appraisal.version,1);assert.equal(imported.item.appraisal.label,'DEMO_ESTIMATE');
  assert.equal(imported.item.evidence.authenticated_provider_history,false);assert.equal(imported.item.evidence.confidence_tier,'P0_OPERATOR');assert.equal(imported.item.evidence.status,'IMPORTED_UNVERIFIED');
});

test('Codex coding-session import persists truthful source metadata and deduplicates inventory',async t=>{
  const app=await setup(t),text=codexHistory();
  const preview=app.portfolio.preview(demoUser,{filename:'rollout.jsonl',text});
  assert.equal(preview.format,'Codex coding-session JSONL');assert.equal(preview.source_label,'Codex (user supplied)');
  const first=await app.portfolio.import(demoUser,'codex-import',input(text,preview.content_commitment));
  assert.ok(first.item);
  assert.equal(first.item.source,'Codex (user supplied)');assert.equal(first.item.title,'Codex: research-router');
  assert.equal(first.item.evidence.status,'IMPORTED_UNVERIFIED');
  const duplicate=await app.portfolio.import(demoUser,'codex-import-again',input(text+'\n',preview.content_commitment));
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.trace_id,first.trace_id);
  assert.equal((await app.portfolio.list(demoUser)).items.length,1);
});

test('reimport deduplicates inventory and restart retains the same appraisal history',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-contributor-'));const text=history();let app=await createApplication({dataDir,config:{clock}});
  try {
    const preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
    const first=await app.portfolio.import(demoUser,'dedup-first',input(text,preview.content_commitment));
    const second=await app.portfolio.import(demoUser,'dedup-second',input(text,preview.content_commitment));
    assert.equal(second.duplicate,true);assert.equal(second.trace_id,first.trace_id);assert.equal((await app.portfolio.list(demoUser)).items.length,1);
    assert.ok(second.item);const appraisalId=second.item.appraisal.appraisal_id;await app.close();app=await createApplication({dataDir,config:{clock}});
    const restored=await app.portfolio.list(demoUser);assert.equal(restored.items.length,1);assert.equal(restored.items[0]!.appraisal.appraisal_id,appraisalId);assert.equal(restored.items[0]!.appraisal_history.length,1);
  } finally {await app.close();await rm(dataDir,{recursive:true,force:true});}
});

test('normalized history commitment deduplicates newline and skipped metadata variants',async t=>{
  const app=await setup(t);const text=history();const firstPreview=app.portfolio.preview(demoUser,{filename:'first.jsonl',text});
  const first=await app.portfolio.import(demoUser,'normalized-first',input(text,firstPreview.content_commitment));
  const variant=JSON.stringify({type:'summary',summary:'changed UI metadata',sessionId:'session-1'})+'\n'+text+'\n';
  const variantPreview=app.portfolio.preview(demoUser,{filename:'variant.jsonl',text:variant});
  assert.equal(variantPreview.content_commitment,firstPreview.content_commitment);
  const repeated=await app.portfolio.import(demoUser,'normalized-variant',input(variant,variantPreview.content_commitment));
  assert.equal(repeated.duplicate,true);assert.equal(repeated.trace_id,first.trace_id);assert.equal((await app.portfolio.list(demoUser)).items.length,1);
});

test('same normalized history with different release rights is a consent conflict',async t=>{
  const app=await setup(t);const text=history(),preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  await app.portfolio.import(demoUser,'consent-first',input(text,preview.content_commitment));
  await assert.rejects(app.portfolio.import(demoUser,'consent-narrower',{...input(text,preview.content_commitment),model_output_licensed:false}),/IMPORT_CONSENT_CONFLICT/);
  assert.equal((await app.portfolio.list(demoUser)).items.length,1);
});

test('generic trace import cannot bypass the preview content commitment',async t=>{
  const app=await setup(t);const text=history();
  await assert.rejects(app.service.importTrace(demoUser,'generic-no-preview',{bundle:{format:'thot.claude-code-jsonl/1',text},category:'research_flow',rights_confirmed:true,model_output_licensed:true}),/IMPORT_PREVIEW_CHANGED/);
  assert.equal((await app.service.traces(demoUser)).length,0);
  const preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  const imported=await app.service.importTrace(demoUser,'generic-with-preview',{bundle:{format:'thot.claude-code-jsonl/1',text},content_commitment:preview.content_commitment,category:'research_flow',rights_confirmed:true,model_output_licensed:true});
  assert.equal((await app.service.trace(demoUser,imported.trace_id)).provenance_status,'IMPORTED_UNVERIFIED');
});

test('verified Robinhood linkage changes eligibility without upgrading history provenance or estimate',async t=>{
  const app=await setup(t,{brokerageVerifier:verifier});const text=history();
  const preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});await app.portfolio.import(demoUser,'link-import',input(text,preview.content_commitment));
  const before=(await app.portfolio.list(demoUser)).items[0]!;const job=await app.robinhood.begin(demoUser,'begin-link');
  const evidence={credential:{schema_version:'fixture-public-evidence/1'},witness_receipts:[]};await app.robinhood.complete(demoUser,'complete-link',job.job_id,evidence);
  const after=(await app.portfolio.list(demoUser)).items[0]!;
  assert.equal(after.appraisal.eligible_for_brokerage_research,true);assert.equal(after.appraisal.version,2);assert.equal(after.appraisal.estimated_value_minor,before.appraisal.estimated_value_minor);
  assert.equal(after.evidence.authenticated_provider_history,false);assert.equal(after.evidence.status,'IMPORTED_UNVERIFIED');assert.equal(after.evidence.confidence_tier,'P0_OPERATOR');
});

test('credential-gated demo offer previews the narrow license and disconnect blocks new authorization',async t=>{
  const app=await setup(t,{brokerageVerifier:verifier});const text=history();
  const importPreview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  const imported=await app.portfolio.import(demoUser,'offer-import',input(text,importPreview.content_commitment));
  await assert.rejects(app.portfolio.demoOffer(demoUser,'offer-without-link',imported.trace_id),/VERIFIED_BROKERAGE_REQUIRED/);
  const job=await app.robinhood.begin(demoUser,'offer-begin-link');
  const linked=await app.robinhood.complete(demoUser,'offer-complete-link',job.job_id,{credential:{schema_version:'fixture-public-evidence/1'},witness_receipts:[]});
  const offer=await app.portfolio.demoOffer(demoUser,'credential-offer',imported.trace_id);assert.equal(offer.simulated,true);assert.equal(offer.candidates.length,1);
  const preview=await app.service.preview(demoUser,offer.candidates[0]!.candidate_id);
  assert.equal(preview.release.license.terms.template_id,'local-portfolio-demo-v1');assert.deepEqual(preview.credential_receipt_ids,[linked.credential_id]);
  await app.robinhood.disconnect(demoUser,'offer-disconnect');
  await assert.rejects(app.service.authorize(demoUser,'offer-after-disconnect',{candidate_id:preview.candidate_id,release_artifact_hash:preview.release_artifact_hash,license_hash:preview.license_hash,expected_gross_minor:preview.expected_gross_minor,expected_direct_costs_max_minor:preview.expected_direct_costs_max_minor,credential_receipt_ids:preview.credential_receipt_ids,outcome_receipt_ids:preview.outcome_receipt_ids,payout_preference:'inference_credit'}),/CREDENTIAL_FILTER/);
  await assert.rejects(app.portfolio.demoOffer(demoUser,'offer-after-revoke',imported.trace_id),/VERIFIED_BROKERAGE_REQUIRED/);
});

test('demo offer retry remains idempotent after the service clock advances',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-contributor-retry-'));let instant=now;const movingClock=()=>new Date(instant);
  const app=await createApplication({dataDir,config:{clock:movingClock},brokerageVerifier:verifier});
  try{
    const text=history(),preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
    const imported=await app.portfolio.import(demoUser,'retry-import',input(text,preview.content_commitment));
    const job=await app.robinhood.begin(demoUser,'retry-begin-link');
    await app.robinhood.complete(demoUser,'retry-complete-link',job.job_id,{credential:{schema_version:'fixture-public-evidence/1'},witness_receipts:[]});
    const first=await app.portfolio.demoOffer(demoUser,'stable-demo-offer',imported.trace_id);
    instant='2026-09-07T12:00:01.000Z';
    const repeated=await app.portfolio.demoOffer(demoUser,'stable-demo-offer',imported.trace_id);
    assert.equal(repeated.mandate_id,first.mandate_id);assert.deepEqual(repeated.candidates,first.candidates);
  }finally{await app.close();await rm(dataDir,{recursive:true,force:true});}
});

test('role checks and explicit privileged-content rejection survive credential filtering',async t=>{
  const app=await setup(t);const text=history('Attorney-client privileged. password=super-secret-value');
  assert.throws(()=>app.portfolio.preview(demoBuyer,{filename:'session.jsonl',text}),/FORBIDDEN/);
  await assert.rejects(app.portfolio.list(demoBuyer),/FORBIDDEN/);
  const preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});assert.ok(preview.privacy_flags.includes('secret'));
  const result=await app.portfolio.import(demoUser,'blocked-import',input(text,preview.content_commitment));
  assert.ok(result.item);assert.equal(result.status,'REJECTED');assert.equal(result.item.rights_status,'rejected');assert.equal(result.item.appraisal.estimated_value_minor,'0');
});

for(const client of ['claude','codex'])test(client+': private history import is readable without claiming release rights',async t=>{
  const app=await setup(t),text=client==='claude'?history():codexHistory(),preview=app.portfolio.preview(demoUser,{filename:client+'.jsonl',text});
  const privateInput={filename:client+'.jsonl',text,content_commitment:preview.content_commitment,save_privately:true};
  const saved=await app.portfolio.import(demoUser,'private-first-'+client,privateInput);
  assert.ok(saved.item);
  assert.equal(saved.status,'PRIVATE');assert.equal(saved.item.evidence.status,'IMPORTED_UNVERIFIED');assert.ok(!['eligible','eligible_with_restrictions'].includes(saved.item.rights_status));
  const item=await app.library.item(demoUser,saved.trace_id);assert.equal(item.content.turns.length,2);assert.equal(item.origin,'upload');assert.equal(item.private,true);assert.deepEqual(item.release_preparation,[]);assert.doesNotThrow(()=>canonicalJson(item),'The owner reader must serialize through the actual API JSON contract');
  const again=await app.portfolio.import(demoUser,'private-repeat-'+client,privateInput);assert.equal(again.duplicate,true);assert.equal(again.trace_id,saved.trace_id);
  await assert.rejects(app.portfolio.import(demoUser,'mixed-private-rights-'+client,{...privateInput,rights_confirmed:true}),/PRIVATE_IMPORT_RELEASE_CONFLICT/);
  await assert.rejects(app.service.importTrace(demoUser,'generic-mixed-private-'+client,{bundle:{format:'thot.coding-session-jsonl/1',text},content_commitment:preview.content_commitment,save_privately:true,model_output_licensed:true}),/PRIVATE_IMPORT_RELEASE_CONFLICT/);
  await assert.rejects(app.portfolio.import(demoUser,'no-silent-rights-upgrade-'+client,{...input(text,preview.content_commitment),category:'general'}),/IMPORT_CONSENT_CONFLICT/);
  await assert.rejects(app.library.item({id:'other-user',role:'user'},saved.trace_id),/NOT_FOUND/);
});

test('a private JSONL deposit cannot enter an otherwise matching licensed-release workflow',async t=>{
  const app=await setup(t),text=codexHistory().replace('public protocol implementation','public TypeScript implementation'),preview=app.portfolio.preview(demoUser,{filename:'coding.jsonl',text});
  await app.service.createPolicy(demoUser,'private-matching-policy',policyInput(app.service));
  const mandate=await app.service.createMandate(demoBuyer,'private-matching-mandate',mandateInput(app.service));
  await app.service.fundMandate(demoBuyer,'private-matching-fund',mandate.mandate_id,{});await app.service.activateMandate(demoBuyer,'private-matching-active',mandate.mandate_id);
  const saved=await app.portfolio.import(demoUser,'private-no-offer',{filename:'coding.jsonl',text,content_commitment:preview.content_commitment,save_privately:true});
  await app.service.runWorker(20);assert.equal((await app.service.candidates(demoUser)).length,0);
  const eligibleText=text.replace('bounded inputs','strict checks'),eligiblePreview=app.portfolio.preview(demoUser,{filename:'eligible.jsonl',text:eligibleText});
  const eligible=await app.portfolio.import(demoUser,'explicit-release-rights',{...input(eligibleText,eligiblePreview.content_commitment),category:'general'});
  assert.ok(eligible.item);assert.equal(eligible.status,'AVAILABLE');assert.equal(eligible.item.rights_status,'eligible');
  await app.service.runWorker(20);const candidates=await app.service.candidates(demoUser);assert.equal(candidates.length,1);assert.equal(candidates[0].trace_id,eligible.trace_id);assert.notEqual(candidates[0].trace_id,saved.trace_id);
});

test('private import release preparation preserves provenance and needs a separate THOT listing',async t=>{
  const app=await setup(t),text=history('Review this TypeScript function','Use strict checks and write a regression test.');
  const preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  const saved=await app.portfolio.import(demoUser,'private-upgrade-import',{filename:'session.jsonl',text,content_commitment:preview.content_commitment,save_privately:true});
  const before=await app.service.db.transaction(tx=>tx.get('traces',saved.trace_id,demoUser.id));
  assert.equal((await app.library.item(demoUser,saved.trace_id)).private_import.content_commitment,preview.content_commitment);
  await app.service.createPolicy(demoUser,'private-upgrade-policy',policyInput(app.service));
  const mandate=await app.service.createMandate(demoBuyer,'private-upgrade-mandate',mandateInput(app.service));
  await app.service.fundMandate(demoBuyer,'private-upgrade-fund',mandate.mandate_id,{});await app.service.activateMandate(demoBuyer,'private-upgrade-active',mandate.mandate_id);
  const choice={content_commitment:preview.content_commitment,rights_confirmed:true,model_output_licensed:false};
  const result=await app.portfolio.prepareSale(demoUser,'private-upgrade-rights',saved.trace_id,choice);
  assert.equal(result.status,'AVAILABLE');assert.equal(result.listed,false);
  assert.deepEqual(await app.portfolio.prepareSale(demoUser,'private-upgrade-rights',saved.trace_id,choice),result);
  const after=await app.service.db.transaction(tx=>tx.get('traces',saved.trace_id,demoUser.id));
  assert.equal(after.import_consent_hash,before.import_consent_hash);assert.equal(after.provenance_id,before.provenance_id);assert.deepEqual(after.raw_ref,before.raw_ref);
  assert.equal(after.provenance_status,'IMPORTED_UNVERIFIED');assert.equal(after.thot_listing_only,true);
  const scrubbed=await app.service.privacy.open(demoUser.id,after.scrub_ref);
  assert.deepEqual(scrubbed.turns.map((turn:Document)=>turn.role),['user']);assert.equal(after.normalized_hash,canonicalHash(scrubbed));
  assert.equal((await app.library.item(demoUser,saved.trace_id)).private_import,null);
  await app.service.runWorker(20);assert.equal((await app.service.candidates(demoUser)).length,0);
  assert.equal((await app.service.db.transaction(tx=>tx.list('thot_records',demoUser.id))).filter(row=>row.kind==='listing').length,0);
  await assert.rejects(app.portfolio.prepareSale(demoUser,'private-upgrade-again',saved.trace_id,{...choice,model_output_licensed:true}),/PRIVATE_IMPORT_REQUIRED/);
});

test('private import release preparation enforces owner, exact content and explicit rights',async t=>{
  const app=await setup(t),text=history(),preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  const saved=await app.portfolio.import(demoUser,'private-guards-import',{filename:'session.jsonl',text,content_commitment:preview.content_commitment,save_privately:true});
  const choice={content_commitment:preview.content_commitment,rights_confirmed:true,model_output_licensed:true};
  await assert.rejects(app.portfolio.prepareSale(demoBuyer,'private-guards-role',saved.trace_id,choice),/FORBIDDEN/);
  await assert.rejects(app.portfolio.prepareSale({id:'other-user',role:'user'},'private-guards-owner',saved.trace_id,choice),/NOT_FOUND/);
  await assert.rejects(app.portfolio.prepareSale(demoUser,'private-guards-content',saved.trace_id,{...choice,content_commitment:'0'.repeat(64)}),/IMPORT_PREVIEW_CHANGED/);
  await assert.rejects(app.portfolio.prepareSale(demoUser,'private-guards-rights',saved.trace_id,{...choice,rights_confirmed:false}),/IMPORT_RIGHTS_CONFIRMATION_REQUIRED/);
  await assert.rejects(app.portfolio.prepareSale(demoUser,'private-guards-fields',saved.trace_id,{...choice,price:0}),/INVALID_RELEASE_PREPARATION/);
  await app.service.db.transaction(async tx=>{const trace=await tx.get('traces',saved.trace_id,demoUser.id);trace.retention_expires_at=now;await tx.update('traces',saved.trace_id,trace);});
  await assert.rejects(app.portfolio.prepareSale(demoUser,'private-guards-expired',saved.trace_id,choice),/TRACE_CONTENT_UNAVAILABLE/);
});

test('private import preparation masks known credentials while retaining useful licensed context',async t=>{
  const app=await setup(t),text=history('password=super-secret-value'),preview=app.portfolio.preview(demoUser,{filename:'session.jsonl',text});
  const saved=await app.portfolio.import(demoUser,'private-secret-import',{filename:'session.jsonl',text,content_commitment:preview.content_commitment,save_privately:true});
  const result=await app.portfolio.prepareSale(demoUser,'private-secret-rights',saved.trace_id,{content_commitment:preview.content_commitment,rights_confirmed:true,model_output_licensed:true});
  assert.equal(result.status,'AVAILABLE');assert.equal(result.listed,false);
  const trace=await app.service.db.transaction(tx=>tx.get('traces',saved.trace_id,demoUser.id));
  const scrubbed=await app.service.privacy.open(demoUser.id,trace.scrub_ref);assert.equal(scrubbed.turns[0].content,'[REDACTED]');assert.equal(scrubbed.turns[1].role,'assistant');assert.doesNotMatch(JSON.stringify(scrubbed),/super-secret-value/);
  assert.match(JSON.stringify(await app.service.privacy.open(demoUser.id,trace.raw_ref)),/super-secret-value/);
});
