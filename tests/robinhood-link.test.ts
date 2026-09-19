import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoUser, demoBuyer, importDemo } from '../packages/market/src/fixtures.ts';
import type { EvidenceVerifier } from '../packages/market/src/robinhood-link.ts';

const start=Date.parse('2026-09-07T16:00:00Z');
const proof={credential:{fixture:'TEST ONLY'},witness_receipts:[]};
function fixtureVerifier():EvidenceVerifier {return async(_evidence,ticket)=>{
  const payload=JSON.parse(Buffer.from(ticket.split('.')[0]!,'base64url').toString());
  return {verified:true,owner_user_id:payload.owner_user_id,job_id:payload.job_id,link_ticket_hash:createHash('sha256').update(ticket).digest('hex'),subject:'a'.repeat(64),observed_at:payload.issued_at};
};}
async function setup(t:any,verifier?:EvidenceVerifier){
  const dir=await mkdtemp(join(tmpdir(),'thot-robinhood-test-'));let time=start;
  const app=await createApplication({dataDir:dir,memory:true,config:{clock:()=>new Date(time)},brokerageVerifier:verifier});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,advance:(ms:number)=>{time+=ms;}};
}

test('Robinhood linking is unavailable without an operator-configured verifier; buyers cannot start jobs',async t=>{
  const {app}=await setup(t);
  assert.equal(app.robinhood.capabilities().robinhood_linking,false);
  await assert.rejects(app.robinhood.begin(demoUser,'unconfigured-job'),/ROBINHOOD_LINKING_UNAVAILABLE/);
  await assert.rejects(app.robinhood.begin(demoBuyer,'buyer-start-job'),/FORBIDDEN/);
});

test('link tickets verify with public issuer key and bind unique owner, challenge and expiry',async t=>{
  const {app,advance}=await setup(t,fixtureVerifier());advance(123);
  const job=await app.robinhood.begin(demoUser,'signed-ticket-test');
  const [payload,sig]=job.link_ticket.split('.');
  assert.equal(verify(null,Buffer.from(payload!),createPublicKey(app.robinhood.publicKey),Buffer.from(sig!,'base64url')),true);
  const decoded=JSON.parse(Buffer.from(payload!,'base64url').toString());
  assert.equal(decoded.owner_user_id,demoUser.id);assert.equal(decoded.job_id,job.job_id);
  assert.equal(Date.parse(decoded.expires_at)-Date.parse(decoded.issued_at),600_000);
  assert.equal(Date.parse(decoded.issued_at)%1000,0);
  assert.match(decoded.nonce,/^[0-9a-f]{64}$/);
  assert.deepEqual(await app.robinhood.begin(demoUser,'signed-ticket-test'),job);
  await assert.rejects(app.robinhood.begin(demoUser,'second-pending-job'),/LINK_ALREADY_PENDING/);
});

test('completion links verified original evidence once; disconnect revokes eligibility without deleting history',async t=>{
  const {app}=await setup(t,fixtureVerifier());
  const imported=await importDemo(app.service,demoUser,'coding','link-fixture-import');
  const job=await app.robinhood.begin(demoUser,'link-fixture-start');
  const done=await app.robinhood.complete(demoUser,'link-fixture-complete',job.job_id,proof);
  assert.equal(done.status,'linked');
  assert.equal((await app.robinhood.status(demoUser)).status,'linked');
  assert.deepEqual(await app.robinhood.proof(demoUser,done.credential_id),{evidence:proof,link_ticket:job.link_ticket,thot_public_key_pem:app.robinhood.publicKey});
  await assert.rejects(app.robinhood.proof(demoBuyer,done.credential_id),/FORBIDDEN/);
  await assert.rejects(app.robinhood.proof({id:'other-user',role:'user'},done.credential_id),/NOT_FOUND|FORBIDDEN/);
  const receipts=await app.service.receipts(demoUser,imported.trace_id);
  assert.equal(receipts.credentials.length,1);assert.equal(receipts.credentials[0].predicate_type,'brokerage_control');
  const retry=await app.robinhood.complete(demoUser,'link-fixture-complete',job.job_id,proof);
  assert.equal(retry.credential_id,done.credential_id);
  await assert.rejects(app.robinhood.complete(demoUser,'link-fixture-change',job.job_id,{...proof,credential:{tampered:true}}),/LINK_ALREADY_COMPLETED/);
  await app.robinhood.disconnect(demoUser,'link-fixture-disconnect');
  assert.equal((await app.robinhood.status(demoUser)).status,'disconnected');
  const owner=await app.db.transaction(tx=>tx.get('users',demoUser.id));
  assert.ok(owner.revoked_receipts.includes(done.credential_id));
  assert.equal((await app.service.receipts(demoUser,imported.trace_id)).credentials.length,1);
});

test('cross-contributor response, expired jobs, cancelled jobs and secret capture envelopes are rejected',async t=>{
  const malicious:EvidenceVerifier=async(e,ticket)=>({...await fixtureVerifier()(e,ticket),owner_user_id:'other-user'});
  const {app,advance}=await setup(t,malicious);
  const job=await app.robinhood.begin(demoUser,'attack-start-job');
  await assert.rejects(app.robinhood.complete(demoUser,'attack-owner-job',job.job_id,proof),/CREDENTIAL_SUBJECT_MISMATCH/);
  await assert.rejects(app.robinhood.complete(demoUser,'attack-secret-job',job.job_id,{...proof,secrets:{token:'not-a-real-token'}}),/INVALID_CREDENTIAL_ENVELOPE/);
  await assert.rejects(app.robinhood.get({id:'other-user',role:'user'},job.job_id),/NOT_FOUND/);
  await app.robinhood.cancel(demoUser,'attack-cancel-job',job.job_id);
  await assert.rejects(app.robinhood.complete(demoUser,'attack-cancel-complete',job.job_id,proof),/LINK_NOT_PENDING/);
  const next=await app.robinhood.begin(demoUser,'attack-expiry-job');advance(600_001);
  assert.equal((await app.robinhood.get(demoUser,next.job_id)).status,'expired');
  await assert.rejects(app.robinhood.complete(demoUser,'attack-expiry-complete',next.job_id,proof),/LINK_NOT_PENDING/);
});

test('rejected verifier never creates a receipt or a linked state',async t=>{
  const {app}=await setup(t,async()=>{throw new Error('bad original quote');});
  const job=await app.robinhood.begin(demoUser,'reject-start-job');
  await assert.rejects(app.robinhood.complete(demoUser,'reject-complete-job',job.job_id,proof),/ROBINHOOD_EVIDENCE_REJECTED/);
  assert.equal((await app.robinhood.status(demoUser)).status,'pending');
  assert.equal((await app.db.transaction(tx=>tx.list('credential_receipts',demoUser.id))).length,0);
});
