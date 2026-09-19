import test from 'node:test';
import assert from 'node:assert/strict';
import { appraisePortfolio, buildPortfolioCard, type PortfolioAppraisalInput, type VerifiedCredentialReference } from '../packages/market/src/portfolio.ts';
import { canonicalJson } from '../packages/protocol/src/index.ts';

const now='2026-09-07T12:00:00.000Z';
const base=():PortfolioAppraisalInput=>({trace_id:'trace-1',content_commitment:'a'.repeat(64),features:{counts:{turns:20,tool_calls:4},workflow_type:'research',topic_labels:['finance']},rights_status:'eligible',provenance_status:'USER_SUPPLIED',appraised_at:now});
const brokerage:VerifiedCredentialReference={receipt_id:'credential-1',predicate_type:'brokerage_control',evidence_commitment:'b'.repeat(64),verification_status:'ORIGINAL_EVIDENCE_VERIFIED',observed_at:now,valid_until:'2026-10-07T12:00:00.000Z'};

test('demo appraisal is bounded, explained and separate from brokerage eligibility',()=>{
  const without=appraisePortfolio(base()), withCredential=appraisePortfolio({...base(),credentials:[brokerage]},[without]);
  assert.equal(without.label,'DEMO_ESTIMATE');assert.equal(without.estimated_value_minor,'740');assert.equal(without.eligible_for_brokerage_research,false);
  assert.equal(withCredential.version,2);assert.equal(withCredential.eligible_for_brokerage_research,true);
  assert.equal(withCredential.estimated_value_minor,without.estimated_value_minor);
  assert.match(withCredential.limitations.join(' '),/not an offer/);
});

test('same estimator inputs deduplicate while changed evidence creates an immutable next version',()=>{
  const first=appraisePortfolio(base());
  assert.strictEqual(appraisePortfolio(base(),[first]),first);
  const second=appraisePortfolio({...base(),credentials:[brokerage]},[first]);
  assert.equal(first.version,1);assert.equal(second.version,2);assert.notEqual(first.input_commitment,second.input_commitment);
});

test('returning to an older input after credential disconnect creates a new historical version',()=>{
  const first=appraisePortfolio(base()), linked=appraisePortfolio({...base(),credentials:[brokerage]},[first]);
  const disconnected=appraisePortfolio({...base(),appraised_at:'2026-09-08T12:00:00Z'},[first,linked]);
  assert.equal(disconnected.version,3);assert.equal(disconnected.input_commitment,first.input_commitment);
});

test('rights denial produces zero estimate and cannot be hidden by a credential',()=>{
  const result=appraisePortfolio({...base(),rights_status:'rejected',credentials:[brokerage]});
  assert.equal(result.estimated_value_minor,'0');assert.equal(result.eligible_for_brokerage_research,false);assert.match(result.contributions[0]!.explanation,/No estimate/);
});

test('unverified, expired and duplicate credential references do not forge eligibility',()=>{
  assert.throws(()=>appraisePortfolio({...base(),credentials:[{...brokerage,verification_status:'UNVERIFIED' as any}]}),/INVALID_VERIFIED_CREDENTIAL_REFERENCE/);
  assert.equal(appraisePortfolio({...base(),credentials:[{...brokerage,valid_until:'2026-09-01T00:00:00Z'}]}).eligible_for_brokerage_research,false);
  assert.throws(()=>appraisePortfolio({...base(),credentials:[brokerage,brokerage]}),/DUPLICATE_CREDENTIAL_REFERENCE/);
});

test('portfolio card keeps evidence, estimate and rights distinct',()=>{
  const appraisal=appraisePortfolio({...base(),credentials:[brokerage]});
  const card=buildPortfolioCard({trace:{trace_id:'trace-1',created_at:now,display_status:'AVAILABLE',provenance_status:'USER_SUPPLIED'},features:base().features,provenance:{confidence_tier:'P0_OPERATOR'},rights:{status:'eligible'},import_preview:{title:'Claude Code: demo',source_date:now,size_bytes:123,turn_count:20,content_commitment:'a'.repeat(64),privacy_flags:[]},appraisals:[appraisal],credentials:[brokerage]});
  assert.equal(card.evidence.authenticated_provider_history,false);assert.equal(card.appraisal.label,'DEMO_ESTIMATE');assert.equal(card.credentials[0].predicate_type,'brokerage_control');
  assert.ok(!JSON.stringify(card).includes('evidence_commitment'));
  assert.doesNotThrow(()=>canonicalJson(card));
});
