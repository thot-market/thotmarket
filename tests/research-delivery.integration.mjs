import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';

test('research HTTP import → signed immutable licence → local-chain payment → exact entitled package',async()=>{
 const f=await deployThotFixture(),dir=await mkdtemp(join(tmpdir(),'research-delivery-'));let app,server;
 try{
  app=await createApplication({dataDir:dir,memory:true,thot:{...f.config,confirmations:1,codeHashes:f.manifest.codeHashes,localDeliverySigner:f.config.operator}});
  server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const request=async(path,body,token)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const call=async(path,body,token)=>{const result=await request(path,body,token);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
  const su=(await call('/v1/dev/session',{role:'user'})).token,bu=(await call('/v1/dev/session',{role:'buyer_admin'})).token;
  for(const [token,signer] of [[su,f.seller],[bu,f.buyer]]){const challenge=await call('/v1/thot/wallet/challenge',{address:await signer.getAddress()},token);await call('/v1/thot/wallet/link',{id:challenge.id,signature:await signer.signMessage(challenge.message)},token);}
  const content=JSON.parse(await readFile(new URL('./fixtures/research-package.json',import.meta.url),'utf8')),input={kind:'research',filename:'package.json',text:JSON.stringify(content)};
  const preview=await call('/v1/contributor/import/preview',input,su),saved=await call('/v1/contributor/import/confirm',{...input,content_commitment:preview.content_commitment,save_privately:true},su);
  assert.deepEqual((await call('/v1/contributor/library/'+saved.trace_id,undefined,su)).content,content);
  assert.equal((await request('/v1/contributor/library/'+saved.trace_id,undefined,bu)).status,403);
  await call('/v1/contributor/library/'+saved.trace_id+'/prepare-sale',{content_commitment:preview.content_commitment,rights_confirmed:true,model_output_licensed:false},su);
  const review=await call('/v1/thot/listings/preview',{trace_id:saved.trace_id},su);assert.equal(review.content_kind,'research');
  const listing=await call('/v1/thot/listings',{trace_id:saved.trace_id,content_hash:review.content_hash,title:'Synthetic research package',price_thot:'100000',license:'Synthetic authored report, code and data: nonexclusive research evaluation for thirty days, no onward transfer.',rights_confirmed:true,metadata_public:true,automatic_sales:true,treasury_opt_in:false},su);
  assert.equal(listing.content_kind,'research');assert.equal(listing.file_count,3);assert.equal(listing.turn_count,0);assert.equal(JSON.stringify(listing).includes('calculate.py'),false);
  const typed=listing.typed_data,{EIP712Domain:_,...types}=typed.types;
  await call('/v1/thot/listings/activate',{id:listing.id,signature:await f.seller.signTypedData(typed.domain,types,typed.message)},su);
  const prepared=await call('/v1/thot/offers/prepare',{listing_id:listing.id},bu),id=prepared.id;
  assert.notEqual((await request('/v1/thot/offers/delivery',{id},bu)).status,200);
  for(const tx of prepared.transactions)await(await f.buyer.sendTransaction(tx)).wait();
  await call('/v1/thot/offers/review',{id},su);
  const delivered=await call('/v1/thot/offers/delivery',{id},bu);assert.deepEqual(delivered.release.content,content);assert.equal('turns' in delivered.release.content,false);
  for(const file of delivered.release.content.files){assert.equal(Buffer.byteLength(file.text),file.bytes);assert.equal(createHash('sha256').update(file.text).digest('hex'),file.sha256);}
  assert.equal((await request('/v1/thot/offers/delivery',{id},su)).status,403);
  const op=(await call('/v1/dev/session',{role:'operator_security'})).token;assert.equal((await request('/v1/thot/offers/delivery',{id},op)).status,404);
  if(process.env.THOT_RESEARCH_BROWSER){
   const {chromium}=await import('playwright-core'),{mkdir}=await import('node:fs/promises');
   const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
   try{
    const context=await browser.newContext({viewport:{width:1365,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.goto(origin+'/app');await page.locator('#conversation-library').waitFor();
    await page.locator('#conversation-library .section-head [data-action="journey-add"]').click();await page.locator('[data-action="import-research-package"]').click();
    assert.equal(await page.locator('#research-kind').inputValue(),'research');await page.locator('#package-title').fill('Browser synthetic research');await page.locator('#package-entrypoint').fill('report.md');
    await page.locator('#research-file').setInputFiles(content.files.map(file=>({name:file.path,mimeType:file.media_type,buffer:Buffer.from(file.text)})));
    await page.locator('#research-preview-form button[type="submit"]').click();await page.getByRole('heading',{name:'Review research package',exact:true}).waitFor();assert.equal(await page.locator('[data-research-file]').count(),3);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/v1/contributor/import/confirm'&&r.request().method()==='POST');await page.locator('[data-action="confirm-research"]').click();const result=await response;assert.equal(result.status(),200);const uiSaved=await result.json();
    const row=page.locator('[data-testid="conversation-row"][data-trace-id="'+uiSaved.trace_id+'"]');await row.waitFor();await row.locator('[data-action="library-open"]').first().click();await page.locator('#library-reader [data-research-file]').first().waitFor();assert.equal(await page.locator('#library-reader [data-research-file]').count(),3);
    await page.locator('#library-prepare-sale input[name="rights_confirmed"]').check();await page.locator('#library-prepare-sale button[type="submit"]').click();await page.locator('#detail-dialog [data-action="close-dialog"]').first().click();
    await row.locator('[data-action="thot-list-configure"]').click();await page.locator('.journey-release [data-research-file]').first().waitFor();assert.equal(await page.locator('.journey-release [data-research-file]').count(),3);
    await mkdir('work/task0040-browser',{recursive:true});await page.screenshot({path:'work/task0040-browser/research-release-desktop.png'});
    await page.locator('input[name="excluded_file"][value="calculate.py"]').check();assert.equal(await page.locator('[data-action="thot-list-confirm"]').isDisabled(),true);await page.locator('#release-exclusion-rights').check();await page.locator('[data-action="thot-release-exclude"]').click();await page.waitForFunction(()=>document.querySelectorAll('.journey-release [data-research-file]').length===2);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'work/task0040-browser/research-release-mobile.png'});assert.deepEqual(errors,[]);
   }finally{await browser.close();}
  }
  const newer=structuredClone(content);newer.title='A separately imported revision';const nextInput={...input,text:JSON.stringify(newer)},nextPreview=await call('/v1/contributor/import/preview',nextInput,su),next=await call('/v1/contributor/import/confirm',{...nextInput,content_commitment:nextPreview.content_commitment,save_privately:true},su);assert.notEqual(next.trace_id,saved.trace_id);
  await call('/v1/thot/listings/unlist',{id:listing.id},su);
  assert.deepEqual((await call('/v1/thot/offers/delivery',{id},bu)).release.content,content);
  const denied=await request('/v1/thot/listings/exclude',{trace_id:saved.trace_id,content_hash:review.content_hash,excluded_files:['calculate.py'],rights_confirmed:true,model_output_licensed:false},su);assert.equal(denied.status,409);assert.equal(denied.body.error,'RELEASE_ALREADY_COMMITTED');
 }finally{if(server)await new Promise(r=>server.close(r));if(app)await app.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
