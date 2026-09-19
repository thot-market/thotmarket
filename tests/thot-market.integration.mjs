import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseEther} from 'ethers';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {demoUser,demoBuyer,importDemo} from '../packages/market/src/fixtures.ts';

test('v0.9 authenticated app: private trace → signed enrollment → automatic sale → delivery → configured-window claim',async t=>{
 const f=await deployThotFixture(),dir=await mkdtemp(join(tmpdir(),'thot-app-'));
 let app,server;
 try {
  app=await createApplication({dataDir:dir,memory:true,thot:{...f.config,confirmations:1,codeHashes:f.manifest.codeHashes,localDeliverySigner:f.config.operator}});
  server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const call=async(path,body,token)=>{const res=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const su=(await call('/v1/dev/session',{role:'user'})).body.token,bu=(await call('/v1/dev/session',{role:'buyer_admin'})).body.token;
  const link=async(token,signer)=>{const c=await call('/v1/thot/wallet/challenge',{address:await signer.getAddress()},token);assert.equal(c.status,200);return call('/v1/thot/wallet/link',{id:c.body.id,signature:await signer.signMessage(c.body.message)},token);};
  await t.test('wallet proof is required, actor-bound and immutable',async()=>{
   assert.equal((await call('/v1/thot/workspace')).status,401);
   assert.equal((await link(su,f.seller)).status,200);assert.equal((await link(bu,f.buyer)).status,200);
   const challenge=await call('/v1/thot/wallet/challenge',{address:await f.seller.getAddress()},bu);
   assert.equal((await call('/v1/thot/wallet/link',{id:challenge.body.id,signature:await f.seller.signMessage(challenge.body.message)},bu)).status,409);
   const mismatch=await call('/v1/thot/wallet/challenge',{address:await f.buyer.getAddress()},bu);
   assert.equal((await call('/v1/thot/wallet/link',{id:mismatch.body.id,signature:await f.seller.signMessage(mismatch.body.message)},bu)).body.error,'WALLET_SIGNATURE_MISMATCH');
  });
  const trace=await importDemo(app.service,demoUser,'coding',randomUUID());
  const metadata=await call('/v1/thot/listings/metadata',{trace_id:trace.trace_id},su);assert.equal(metadata.status,200);assert.equal(metadata.body.content,undefined);
  assert.equal((await call('/v1/thot/listings/metadata',{trace_id:trace.trace_id},bu)).status,403);
  assert.equal((await call('/v1/thot/listings/preview',{trace_id:trace.trace_id},su)).status,404);
  const listing=await call('/v1/thot/listings',{trace_id:trace.trace_id,content_hash:metadata.body.content_hash,title:'Synthetic cache debugging trace',price_thot:'100000',license:'Synthetic content only; non-exclusive evaluation for 30 days, no onward transfer.',rights_confirmed:true,metadata_public:true,automatic_sales:true,treasury_opt_in:false},su);
  assert.equal(listing.status,200,JSON.stringify(listing.body));
  await t.test('enrollment binds exact automatic-sale terms to the contributor signature before activation',async()=>{
   assert.equal((await call('/v1/thot/offers/prepare',{listing_id:listing.body.id},bu)).body.error,'LISTING_UNAVAILABLE');
   const typed=listing.body.typed_data;assert.ok(typed);assert.equal(typed.primaryType,'SaleAuthorization');
   const {EIP712Domain:_domainType,...types}=typed.types;
   const forged=await f.buyer.signTypedData(typed.domain,types,typed.message);
   assert.equal((await call('/v1/thot/listings/activate',{id:listing.body.id,signature:forged},su)).body.error,'WALLET_SIGNATURE_MISMATCH');
   const signature=await f.seller.signTypedData(typed.domain,types,typed.message);
   assert.equal((await call('/v1/thot/listings/activate',{id:listing.body.id,signature},bu)).status,403);
   const activated=await call('/v1/thot/listings/activate',{id:listing.body.id,signature},su);
   assert.equal(activated.status,200,JSON.stringify(activated.body));assert.equal(activated.body.id,listing.body.id);
  });
  await t.test('fixed property assay is bounded and cannot execute buyer code',async()=>{
   const a=await call('/v1/thot/assay',{listing_id:listing.body.id,workflow:'coding',min_turns:2},bu);assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(a.body.receipt.result,'accepted');assert.equal(a.body.private_content_disclosed,false);
   const r=await call('/v1/thot/assay',{listing_id:listing.body.id,workflow:'research',min_turns:100},bu);assert.equal(r.body.receipt.result,'rejected');
   const evil=await call('/v1/thot/assay',{listing_id:listing.body.id,workflow:'coding',min_turns:1,source:'fetch(secret)'},bu);assert.equal(evil.body.error,'UNSUPPORTED_ASSAY_INPUT');
  });
  const prepared=await call('/v1/thot/offers/prepare',{listing_id:listing.body.id},bu);assert.equal(prepared.status,200,JSON.stringify(prepared.body));
  const id=prepared.body.id;
  await t.test('unfunded orders never disclose the release',async()=>{
   assert.equal((await call('/v1/thot/offers/delivery',{id},bu)).body.error,'OFFER_NOT_CONFIRMED');
   const ws=await call('/v1/thot/workspace',undefined,bu);assert.equal(ws.status,200);assert.ok(!JSON.stringify(ws.body).includes('tenant-scoped'));
  });
  const sellerNonceBefore=await f.provider.getTransactionCount(await f.seller.getAddress());
  assert.equal(f.market.interface.parseTransaction({data:prepared.body.transactions.at(-1).data}).name,'createReviewedAuthorizedOffer');
  for(const tx of prepared.body.transactions)await (await f.buyer.sendTransaction(tx)).wait();
  const review=await call('/v1/thot/offers/review',{id},su);assert.equal(review.status,200,JSON.stringify(review.body));
  assert.equal(review.body.receipt.seller_amount,parseEther('99999.96').toString());
  assert.equal(review.body.receipt.status,2);
  assert.equal(await f.provider.getTransactionCount(await f.seller.getAddress()),sellerNonceBefore);
  const delivery=await call('/v1/thot/offers/delivery',{id},bu);assert.equal(delivery.status,200,JSON.stringify(delivery.body));
  assert.ok(delivery.body.release.content.turns.length);assert.equal((await call('/v1/thot/offers/delivery',{id},su)).status,403);
  assert.equal(delivery.body.acknowledgment,null);
  assert.equal(Number((await f.market.offers(id)).status),3);
  assert.equal((await app.thot.workspace(demoUser)).account.claimable,'0');
  await assert.rejects(f.market.finalize(id));
  await f.advance(Number(await f.market.DISPUTE_WINDOW())+1);await (await f.market.finalize(id,{gasLimit:1000000})).wait();
  const before=await f.token.balanceOf(await f.seller.getAddress());
  const ws=await app.thot.workspace(demoUser);assert.equal(ws.account.claimable,parseEther('99999.96').toString());
  const claim=await call('/v1/thot/transaction',{action:'claim'},su);await (await f.seller.sendTransaction(claim.body.transactions[0])).wait();
  assert.equal(await f.token.balanceOf(await f.seller.getAddress())-before,parseEther('99999.96'));
  assert.equal((await app.thot.workspace(demoUser)).account.claimable,'0');
  await t.test('operator role cannot impersonate a contributor or read another account’s active paid release',async()=>{
   const session=await call('/v1/dev/session',{role:'operator_security'});assert.equal(session.status,200);
   const op=session.body.token;assert.equal(typeof op,'string');
   const denied=async(path)=>{
    const response=await call(path,{id},op);
    assert.equal(response.status,404);assert.equal(response.body.error,'NOT_FOUND');
    assert.equal(response.body.release,undefined);assert.ok(!JSON.stringify(response.body).includes('tenant-scoped'));
   };
   await denied('/v1/thot/offers/delivery');
   const challenge=await call('/v1/thot/wallet/challenge',{address:await f.seller.getAddress()},op);assert.equal(challenge.status,200);
   const forged=await call('/v1/thot/wallet/link',{id:challenge.body.id,signature:await f.admin.signMessage(challenge.body.message)},op);
   assert.equal(forged.status,400);assert.equal(forged.body.error,'WALLET_SIGNATURE_MISMATCH');
   const alreadyBound=await call('/v1/thot/wallet/link',{id:challenge.body.id,signature:await f.seller.signMessage(challenge.body.message)},op);
   assert.equal(alreadyBound.status,409);assert.equal(alreadyBound.body.error,'WALLET_ALREADY_BOUND');
   assert.equal((await link(op,f.admin)).status,200);
   await denied('/v1/thot/offers/delivery');await denied('/v1/thot/offers/review');
   const privateMetadata=await call('/v1/thot/listings/metadata',{trace_id:trace.trace_id},op);
   assert.equal(privateMetadata.status,403);assert.equal(privateMetadata.body.release,undefined);
   // Confirm denial is actor ownership, not a missing, deleted or expired release.
   const stillAvailable=await call('/v1/thot/offers/delivery',{id},bu);
   assert.equal(stillAvailable.status,200);assert.ok(stillAvailable.body.release.content.turns.length);
  });
  await t.test('unlisted source cannot create another funded offer; automatically sold license survives unlisting',async()=>{
   await app.thot.unlist(demoUser,randomUUID(),listing.body.id);
   assert.equal((await call('/v1/thot/offers/prepare',{listing_id:listing.body.id},bu)).body.error,'LISTING_UNAVAILABLE');
   assert.equal((await call('/v1/thot/offers/delivery',{id},bu)).status,200);
  });
  await t.test('deleting an unfunded signed listing removes its encrypted release',async()=>{
   const unsold=await importDemo(app.service,demoUser,'research',randomUUID());
   const meta=await call('/v1/thot/listings/metadata',{trace_id:unsold.trace_id},su);
   const listed=await call('/v1/thot/listings',{trace_id:unsold.trace_id,content_hash:meta.body.content_hash,title:'Unfunded research release',price_thot:'100',license:'Synthetic research only; nonexclusive evaluation for thirty days.',rights_confirmed:true,metadata_public:true,automatic_sales:true,treasury_opt_in:false},su);
   assert.equal(listed.status,200,JSON.stringify(listed.body));
   const typed=listed.body.typed_data,{EIP712Domain:_,...types}=typed.types;
   assert.equal((await call('/v1/thot/listings/activate',{id:listed.body.id,signature:await f.seller.signTypedData(typed.domain,types,typed.message)},su)).status,200);
   await app.service.deleteTrace(demoUser,randomUUID(),unsold.trace_id);await app.service.runWorker();
   const source=await app.db.transaction(tx=>tx.get('traces',unsold.trace_id));
   const release=await app.db.transaction(tx=>tx.get('thot_records',listed.body.id));
   assert.equal(source.thot_release_copies_retained,0);
   assert.ok(release.release_deleted_at);assert.equal(release.release_ref,undefined);
  });
  await t.test('trace deletion accounts for paid copies and license expiry removes access',async()=>{
   await app.service.deleteTrace(demoUser,randomUUID(),trace.trace_id);await app.service.runWorker();
   let row=await app.db.transaction(tx=>tx.get('traces',trace.trace_id));
   assert.equal(row.source_private_objects_deleted,true);assert.equal(row.private_objects_deleted,false);assert.equal(row.thot_release_copies_retained,1);
   await f.advance(31*86400);assert.equal((await call('/v1/thot/offers/delivery',{id},bu)).body.error,'LICENSE_RETENTION_EXPIRED');
   await app.thot.sweepRetention();row=await app.db.transaction(tx=>tx.get('traces',trace.trace_id));
   assert.equal(row.private_objects_deleted,true);assert.equal(row.thot_release_copies_retained,0);
   const l=await app.db.transaction(tx=>tx.get('thot_records',listing.body.id));assert.ok(l.release_deleted_at);assert.equal(l.release_ref,undefined);
  });
 } finally {if(server)await new Promise(r=>server.close(r));if(app)await app.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
