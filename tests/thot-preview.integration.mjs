import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {demoUser,demoBuyer} from '../packages/market/src/fixtures.ts';

test('ordinary buyers receive metadata and allowlisted predicates but no trace text before purchase',async()=>{
 const f=await deployThotFixture(),dir=await mkdtemp(join(tmpdir(),'thot-buyer-privacy-'));
 let app,server;
 try{
  app=await createApplication({dataDir:dir,memory:true,thot:{...f.config,confirmations:1,codeHashes:f.manifest.codeHashes,localDeliverySigner:f.config.operator}});
  server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const call=async(path,body,token)=>{const res=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const sellerToken=(await call('/v1/dev/session',{role:'user'})).body.token,buyerToken=(await call('/v1/dev/session',{role:'buyer_admin'})).body.token;
  for(const [actor,signer] of [[demoUser,f.seller],[demoBuyer,f.buyer]]){
   const challenge=await app.thot.challenge(actor,randomUUID(),{address:await signer.getAddress()},url);
   await app.thot.link(actor,randomUUID(),{id:challenge.id,signature:await signer.signMessage(challenge.message)});
  }
  const secret='SYNTHETIC_PRIVATE_TRACE_TEXT_MUST_NOT_LEAK';
  const bundle=await app.privacy.createDemoBundle({turns:[{role:'user',content:secret+' debug a tenant cache'},{role:'assistant',content:'Use a tenant-scoped key and verify isolation.'}]},demoUser.id);
  const trace=await app.service.importTrace(demoUser,randomUUID(),{bundle,category:'general',rights_confirmed:true,model_output_licensed:true});

  const removed=await call('/v1/thot/listings/preview',{trace_id:trace.trace_id},sellerToken);
  assert.equal(removed.status,404);assert(!JSON.stringify(removed.body).includes(secret));
  const metadata=await call('/v1/thot/listings/metadata',{trace_id:trace.trace_id},sellerToken);
  assert.equal(metadata.status,200);assert.equal(metadata.body.content,undefined);assert(!JSON.stringify(metadata.body).includes(secret));
  assert.equal((await call('/v1/thot/listings/metadata',{trace_id:trace.trace_id},buyerToken)).status,403);

  const stalePreview=await call('/v1/thot/listings',{trace_id:trace.trace_id,content_hash:metadata.body.content_hash,title:'Private cache research',price_thot:'100',license:'Non-exclusive evaluation license for thirty days. No onward transfer.',rights_confirmed:true,metadata_public:true,automatic_sales:true,free_preview:true},sellerToken);
  assert.equal(stalePreview.body.error,'ORDINARY_PREVIEWS_DISABLED');
  const listed=await call('/v1/thot/listings',{trace_id:trace.trace_id,content_hash:metadata.body.content_hash,title:'Private cache research',price_thot:'100',license:'Non-exclusive evaluation license for thirty days. No onward transfer.',rights_confirmed:true,metadata_public:true,automatic_sales:true,treasury_opt_in:false},sellerToken);
  assert.equal(listed.status,200,JSON.stringify(listed.body));
  const {EIP712Domain:_,...types}=listed.body.typed_data.types;
  const signature=await f.seller.signTypedData(listed.body.typed_data.domain,types,listed.body.typed_data.message);
  assert.equal((await call('/v1/thot/listings/activate',{id:listed.body.id,signature},sellerToken)).status,200);

  const workspace=await fetch(url+'/v1/thot/workspace',{headers:{Authorization:'Bearer '+buyerToken}}).then(r=>r.json());
  assert(!JSON.stringify(workspace).includes(secret));assert.equal(workspace.listings[0].free_preview,undefined);
  const withoutReserve=await call('/v1/thot/listings/sample',{listing_id:listed.body.id,evaluation_only:true},buyerToken);
  assert.equal(withoutReserve.status,403);assert.equal(withoutReserve.body.error,'RESERVE_BUYER_REQUIRED');assert(!JSON.stringify(withoutReserve.body).includes(secret));
  const pretendingReserve=await call('/v1/thot/listings/sample',{listing_id:listed.body.id,evaluation_only:true,funding_source:'reserve'},buyerToken);
  assert.equal(pretendingReserve.status,403);assert.equal(pretendingReserve.body.error,'RESERVE_BUYER_REQUIRED');assert(!JSON.stringify(pretendingReserve.body).includes(secret));
  const assay=await call('/v1/thot/assay',{listing_id:listed.body.id,workflow:'coding',min_turns:1},buyerToken);
  assert.equal(assay.status,200);assert.equal(assay.body.private_content_disclosed,false);assert(!JSON.stringify(assay.body).includes(secret));
  const zeroBalanceInspector={id:'zero-balance-assay-inspector',role:'buyer_member'};
  const zeroAssay=await app.thot.assay(zeroBalanceInspector,randomUUID(),{listing_id:listed.body.id,workflow:'coding',min_turns:1});
  assert.equal(zeroAssay.private_content_disclosed,false);assert(!JSON.stringify(zeroAssay).includes(secret),'safe-feature inspection neither needs a wallet balance nor discloses trace text');
 }finally{if(server)await new Promise(r=>server.close(r));if(app)await app.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
