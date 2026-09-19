import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {demoUser,demoBuyer,importDemo} from '../packages/market/src/fixtures.ts';

const digest=value=>'0x'+canonicalHash(value).replace(/^sha256:/,'').replace(/^0x/,'');
const harness=fileURLToPath(new URL('../trace-vault/tests/traded_verifier_fixture.py',import.meta.url));
const python=process.env.THOT_TRADE_TEST_PYTHON??'/usr/bin/python3';

test('synthetic signed trade evidence crosses the Python verifier and exact THOT purchase boundary',async t=>{
 const f=await deployThotFixture({activate:false}),dir=await mkdtemp(join(tmpdir(),'thot-trade-proof-'));
 let app,server,time=(await f.now())*1000;
 try{
  app=await createApplication({dataDir:dir,memory:true,config:{clock:()=>new Date(time)},
   robinhood:{verifierExecutable:python,verifierArgs:[harness],tradeVerifierArgs:[harness],witnessUrl:'https://witness.example.test',appraiserUrl:'https://appraiser.example.test'},
   thot:{...f.config,confirmations:1,codeHashes:f.manifest.codeHashes,localDeliverySigner:f.config.operator}});
  server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const call=async(path,body,token)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const su=(await call('/v1/dev/session',{role:'user'})).body.token,bu=(await call('/v1/dev/session',{role:'buyer_admin'})).body.token;
  for(const [token,signer] of [[su,f.seller],[bu,f.buyer]]){
   const challenge=await call('/v1/thot/wallet/challenge',{address:await signer.getAddress()},token);
   assert.equal((await call('/v1/thot/wallet/link',{id:challenge.body.id,signature:await signer.signMessage(challenge.body.message)},token)).status,200);
  }
  assert.equal(app.thot.capabilities().trade_evidence,true);
  assert.equal(app.tradeEvidence.publicKey,app.robinhood.publicKey,'same pinned capture-ticket issuer');
  const trace=await importDemo(app.service,demoUser,'research',randomUUID());
  const request={trace_id:trace.trace_id,symbol:'AAPL',window_days:7};
  assert.equal((await call('/v1/thot/trade-evidence/begin',request)).status,401);
  assert.equal((await call('/v1/thot/trade-evidence/begin',request,bu)).status,403);
  const job=(await call('/v1/thot/trade-evidence/begin',request,su)).body;
  assert.ok(job.link_ticket,JSON.stringify(job));
  const generated=spawnSync(python,[harness,'--make'],{input:JSON.stringify({link_ticket:job.link_ticket,thot_public_key_pem:app.tradeEvidence.publicKey,...job.request}),encoding:'utf8',env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(generated.status,0,generated.stderr+generated.stdout);
  const evidence=JSON.parse(generated.stdout).evidence;
  const bad=structuredClone(evidence);bad.credential.value=false;
  assert.notEqual((await call('/v1/thot/trade-evidence/complete',{job_id:job.job_id,evidence:bad},su)).status,200);
  const done=await call('/v1/thot/trade-evidence/complete',{job_id:job.job_id,evidence},su);
  assert.equal(done.status,200,JSON.stringify(done.body));
  const metadata=(await call('/v1/thot/listings/metadata',{trace_id:trace.trace_id},su)).body;
  assert.equal(metadata.content,undefined);assert.equal(metadata.trade_evidence.length,1);const proof=metadata.trade_evidence[0];
  assert.equal(proof.value,true);assert.equal(proof.scope,'observed_records');
  assert(!JSON.stringify(metadata.trade_evidence).includes('witness_receipts'));
  const base={trace_id:trace.trace_id,content_hash:metadata.content_hash,title:'Synthetic research with observed trade evidence',price_thot:'100000',license:'Synthetic research only; nonexclusive evaluation for 30 days. No onward transfer.',rights_confirmed:true,metadata_public:true,automatic_sales:true};
  const selection={trade_evidence_id:proof.id,trade_evidence_hash:proof.evidence_hash,trade_evidence_disclosure:true};
  await t.test('a still-live capture ticket cannot be disclosed to a buyer',async()=>{
   const early=await call('/v1/thot/listings',{...base,...selection},su);
   assert.notEqual(early.status,200,'disclosure must wait for capture authorization to expire');
  });
  time+=601000;await f.advance(601);
  await t.test('attachment requires exact separate consent and immutable proof/content selection',async()=>{
   for(const extra of [{...selection,trade_evidence_disclosure:false},{...selection,trade_evidence_hash:'0x'+'0'.repeat(64)},{...selection,content_hash:'0x'+'0'.repeat(64)}]){
    assert.notEqual((await call('/v1/thot/listings',{...base,...extra},su)).status,200);
   }
   const clean=await app.thot.listTrace(demoUser,randomUUID(),base);
   assert.equal(clean.brokerage_claim,undefined);
   const row=await app.db.transaction(tx=>tx.get('thot_records',clean.id));
   assert.equal((await app.privacy.open(demoUser.id,row.release_ref)).brokerage_evidence,undefined);
  });
  const listing=await call('/v1/thot/listings',{...base,...selection},su);
  assert.equal(listing.status,200,JSON.stringify(listing.body));
  const typed=listing.body.typed_data,{EIP712Domain:_,...types}=typed.types;
  assert.equal(listing.body.brokerage_claim.value,true);
  assert(typed.message.validUntil<=Date.parse(proof.expires_at)/1000,'sale cannot outlive evidence freshness');
  const signature=await f.seller.signTypedData(typed.domain,types,typed.message);
  assert.equal((await call('/v1/thot/listings/activate',{id:listing.body.id,signature},su)).status,200);
  const zeroBalanceBuyer={id:'zero-balance-proof-inspector',role:'buyer_member'},zeroSigner=f.signers[7];
  const zeroAddress=await zeroSigner.getAddress(),zeroChallenge=await app.thot.challenge(zeroBalanceBuyer,randomUUID(),{address:zeroAddress},url);
  await app.thot.link(zeroBalanceBuyer,randomUUID(),{id:zeroChallenge.id,signature:await zeroSigner.signMessage(zeroChallenge.message)});
  const zeroAccount=await app.thot.chain.account(zeroAddress);assert(BigInt(zeroAccount.balance)+BigInt(zeroAccount.qualified)<100000n*10n**18n);
  const zeroInspection=await app.thot.buyerEvidence(zeroBalanceBuyer,{listing_id:listing.body.id,evaluation_only:true});
  assert.equal(zeroInspection.release_hash,listing.body.evidence_hash);assert.equal(zeroInspection.content,undefined);assert.equal(zeroInspection.brokerage_evidence,undefined);
  await t.test('ordinary buyer inspection discloses the public claim without the raw proof',async()=>{
   const inspected=await call('/v1/thot/listings/evidence',{listing_id:listing.body.id,evaluation_only:true},bu);
   assert.equal(inspected.status,200,JSON.stringify(inspected.body));
   assert.equal(inspected.body.release_hash,listing.body.evidence_hash);
   assert.equal(inspected.body.brokerage_claim.scope,'observed_records');
   assert.equal(inspected.body.brokerage_evidence,undefined);
   assert(!JSON.stringify(inspected.body).includes(evidence.credential.signature));
   assert.equal(inspected.body.content,undefined);
   assert.equal((await call('/v1/thot/listings/evidence',{listing_id:listing.body.id,evaluation_only:true},su)).status,403);
   assert.equal((await call('/v1/thot/listings/evidence',{listing_id:listing.body.id,evaluation_only:true})).status,401);
  });
  const offer=await call('/v1/thot/offers/prepare',{listing_id:listing.body.id},bu);
  assert.equal(offer.status,200,JSON.stringify(offer.body));
  assert.notEqual((await call('/v1/thot/offers/delivery',{id:offer.body.id},bu)).status,200);
  for(const tx of offer.body.transactions)await(await f.buyer.sendTransaction(tx)).wait();
  const delivered=await call('/v1/thot/offers/delivery',{id:offer.body.id},bu);
  assert.equal(delivered.status,200,JSON.stringify(delivered.body));
  assert.equal(delivered.body.delivery_hash,listing.body.evidence_hash);
  assert(delivered.body.release.content.turns.length>0);
  assert.equal(delivered.body.release.brokerage_evidence,undefined);
  assert(!JSON.stringify(delivered.body).includes(evidence.credential.signature));
  await t.test('expiry blocks new inspection/purchases but preserves the historical paid evidence',async()=>{
   time+=86400000;await f.advance(86400);
   assert.notEqual((await call('/v1/thot/listings/evidence',{listing_id:listing.body.id,evaluation_only:true},bu)).status,200);
   const historical=await call('/v1/thot/offers/delivery',{id:offer.body.id},bu);
   assert.equal(historical.status,200);assert.equal(historical.body.delivery_hash,listing.body.evidence_hash);
  });
 }finally{if(server)await new Promise(r=>server.close(r));if(app)await app.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
