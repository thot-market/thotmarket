import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {importDemo,demoUser,demoBuyer} from '../packages/market/src/fixtures.ts';
import type {EvidenceVerifier} from '../packages/market/src/robinhood-link.ts';
import type {Document} from '../packages/storage/src/index.ts';
const start=Date.parse('2026-09-15T17:00:00.000Z');
const proof={credential:{synthetic:'TEST ONLY'},witness_receipts:[]};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixtureResult(ticket:string,request:Document){
 const p=JSON.parse(Buffer.from(ticket.split('.')[0]!,'base64url').toString());
 return {verified:true,purpose:'trace-vault.credential.robinhood-traded-outcome.v1',owner_user_id:p.owner_user_id,job_id:p.job_id,link_ticket_hash:hash(ticket),observed_at:p.issued_at,symbol:request.symbol,window_days:request.window_days,value:true,trace_ts:request.trace_ts,scope:'observed_records',valid_until:new Date(Date.parse(p.issued_at)+86400000).toISOString()};
}
async function setup(t:any,enabled=true){
 const dir=await mkdtemp(join(tmpdir(),'trade-evidence-test-'));let time=start,request:Document={},transform=(r:Document)=>r;
 let hold:Promise<void>|undefined;
 const verifier:EvidenceVerifier=async(_e,ticket)=>{if(hold)await hold;return transform(fixtureResult(ticket,request));};
 const app=await createApplication({dataDir:dir,memory:true,config:{clock:()=>new Date(time)},...(enabled?{tradeEvidenceVerifier:verifier}:{})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const trace=await importDemo(app.service,demoUser,'coding','trade-test-import');
 const begin=async(key='trade-test-begin')=>{const j=await app.tradeEvidence.begin(demoUser,key,{trace_id:trace.trace_id,symbol:'AAPL',window_days:7});request=j.request;return j;};
 return {app,trace,begin,advance:(ms:number)=>{time+=ms;},modify:(f:(r:Document)=>Document)=>{transform=f;},pause:(p:Promise<void>)=>{hold=p;}};
}

test('trade evidence requires explicit verifier capability and owned trace; tickets use the pinned issuer',async t=>{
 const off=await setup(t,false);assert.equal(off.app.tradeEvidence.enabled(),false);
 await assert.rejects(off.begin(),/UNAVAILABLE/);
 const {app,trace,begin}=await setup(t);const j=await begin();
 const [payload,sig]=j.link_ticket.split('.');
 assert(verify(null,Buffer.from(payload),createPublicKey(app.robinhood.publicKey),Buffer.from(sig,'base64url')));
 const decoded=JSON.parse(Buffer.from(payload,'base64url').toString());
 assert.equal(decoded.job_id,j.job_id);assert.equal(decoded.owner_user_id,demoUser.id);
 await assert.rejects(app.tradeEvidence.begin(demoBuyer,'trade-test-buyer',{trace_id:trace.trace_id,symbol:'AAPL',window_days:7}),/FORBIDDEN/);
 await assert.rejects(app.tradeEvidence.begin({id:'trade-test-other',role:'user'},'trade-test-other',{trace_id:trace.trace_id,symbol:'AAPL',window_days:7}),/NOT_FOUND/);
 await assert.rejects(app.tradeEvidence.begin(demoUser,'trade-test-extra',{trace_id:trace.trace_id,symbol:'AAPL',window_days:7,cookies:'not-secret-fixture'}),/INVALID/);
});

test('verifier results cannot change the owner, request, scope, positive value or freshness',async t=>{
 const {app,begin,modify}=await setup(t);const j=await begin();
 for(const bad of [{owner_user_id:'trade-test-other'},{job_id:'trade-test-other'},{link_ticket_hash:'0'.repeat(64)},{symbol:'MSFT'},{window_days:8},{value:false},{scope:'portfolio'},{trace_ts:new Date(start-1000).toISOString()},{observed_at:new Date(start+1000).toISOString()},{valid_until:new Date(start+2*86400000).toISOString()}]){
  modify(r=>({...r,...bad}));await assert.rejects(app.tradeEvidence.complete(demoUser,'bad:'+JSON.stringify(bad),{job_id:j.job_id,evidence:proof}));
 }
 modify(r=>r);
 const completed=await app.tradeEvidence.complete(demoUser,'trade-test-good',{job_id:j.job_id,evidence:proof});
 assert(completed.id);assert(completed.evidence_hash);
 assert.deepEqual(await app.tradeEvidence.complete(demoUser,'good-retry',{job_id:j.job_id,evidence:proof}),completed);
 await assert.rejects(app.tradeEvidence.complete(demoUser,'trade-test-changed',{job_id:j.job_id,evidence:{...proof,credential:{changed:true}}}),/COMPLETED/);
 const rows=await app.db.transaction(tx=>tx.list('thot_records',demoUser.id));
 const stored=rows.find(r=>r.kind==='trade_evidence')!;
 assert(stored.object_ref);assert(!JSON.stringify(rows).includes('TEST ONLY'),'proof body must be encrypted');
});

test('verification rechecks source changes, expiry and per-owner concurrency after async execution',async t=>{
 const s=await setup(t);const j=await s.begin();let release!:()=>void;
 s.pause(new Promise<void>(r=>{release=r;}));
 const pending=s.app.tradeEvidence.complete(demoUser,'trade-test-pending',{job_id:j.job_id,evidence:proof});
 await new Promise(r=>setTimeout(r,15));
 await assert.rejects(s.app.tradeEvidence.complete(demoUser,'concurrent',{job_id:j.job_id,evidence:proof}),/BUSY/);
 s.advance(601000);release();await assert.rejects(pending,/EXPIRED|CHANGED|TIME_INVALID/);
 assert.equal((await s.app.db.transaction(tx=>tx.list('thot_records'))).filter(r=>r.kind==='trade_evidence').length,0);
 const other=await setup(t);const job=await other.begin();let go!:()=>void;
 other.pause(new Promise<void>(r=>{go=r;}));const changed=other.app.tradeEvidence.complete(demoUser,'trade-test-source',{job_id:job.job_id,evidence:proof});
 await new Promise(r=>setTimeout(r,15));
 await other.app.db.transaction(async tx=>{const row=await tx.get('traces',other.trace.trace_id);row.scrub_ref=await other.app.privacy.seal(demoUser.id,{turns:[{role:'user',content:'changed research'}]});await tx.update('traces',row.id,row);});
 go();await assert.rejects(changed,/TRACE_CHANGED/);
});

test('capture-job quota survives expired jobs, and attachment rejects stale content and undisclosed proof',async t=>{
 const {app,trace,begin,advance}=await setup(t);
 for(let n=0;n<3;n++){await begin('trade-test-job'+n);advance(601000);}
 await assert.rejects(begin('trade-test-job4'),/LIMIT/);
 const other=await setup(t);const j=await other.begin();const done=await other.app.tradeEvidence.complete(demoUser,'trade-test-complete',{job_id:j.job_id,evidence:proof});
 const row=await other.app.db.transaction(tx=>tx.get('traces',other.trace.trace_id));
 await assert.rejects(other.app.db.transaction(tx=>other.app.tradeEvidence.attachment(tx,demoUser,{trade_evidence_id:done.id,trade_evidence_hash:done.evidence_hash},row,done.content_hash)),/CONSENT/);
 await assert.rejects(other.app.db.transaction(tx=>other.app.tradeEvidence.attachment(tx,demoUser,{trade_evidence_id:done.id,trade_evidence_hash:done.evidence_hash,trade_evidence_disclosure:true},row,done.content_hash)),/UNAVAILABLE|TICKET/);
 other.advance(601000);
 const attachment=await other.app.db.transaction(tx=>other.app.tradeEvidence.attachment(tx,demoUser,{trade_evidence_id:done.id,trade_evidence_hash:done.evidence_hash,trade_evidence_disclosure:true},row,done.content_hash));
 assert.equal(attachment?.summary.value,true);assert.equal((attachment?.summary as Document)?.trace_id,undefined);
 assert.equal(attachment?.proof.link_ticket,j.link_ticket);
 await other.app.db.transaction(tx=>other.app.tradeEvidence.cleanup(tx,other.trace.trace_id));
 await assert.rejects(other.app.db.transaction(tx=>other.app.tradeEvidence.attachment(tx,demoUser,{trade_evidence_id:done.id,trade_evidence_hash:done.evidence_hash,trade_evidence_disclosure:true},row,done.content_hash)),/UNAVAILABLE/);
});
