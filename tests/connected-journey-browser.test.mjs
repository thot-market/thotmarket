import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {request as httpRequest} from 'node:http';
import {getBytes} from 'ethers';
import {chromium} from 'playwright-core';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {WalletAuth} from '../packages/auth/src/index.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {createHistoryState,runHistorySync} from '../packages/capture/src/history-sync.ts';
import {connectHistory} from '../packages/capture/src/history-connect.ts';
import {loadPrivate} from '../packages/capture/src/local-state.ts';

// Real browser, HTTP/session verification, private uploader, vault and listing
// construction. The only wallet is the isolated Anvil fixture: it signs login
// and one sale authorization, and refuses every transaction-send request.
test('connected contributor journey: private upload, exact release edits, signed listing and isolated buyer metadata',{timeout:360000},async t=>{
  assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must select local Chromium');
  const evidence=resolve(process.env.THOT_JOURNEY_ARTIFACTS??'work/connected-journey');await mkdir(evidence,{recursive:true});
  const dir=await mkdtemp(join(tmpdir(),'thot-connected-journey-')),errors=[],requests=[],walletCalls=[];
  let fixture,app,server,browser;const contexts=[];
  t.after(async()=>{
    await writeFile(join(evidence,'browser-errors.json'),JSON.stringify(errors,null,2)+'\n');
    for(let index=0;index<contexts.length;index++){
      const current=contexts[index].pages()[0];if(current)await current.screenshot({path:join(evidence,'final-account-'+index+'.png'),fullPage:true}).catch(()=>{});
    }
    for(const context of contexts)await context.close().catch(()=>{});
    await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
    await app?.close();await fixture?.close();await rm(dir,{recursive:true,force:true});
  });
  fixture=await deployThotFixture();
  app=await createApplication({dataDir:join(dir,'app'),memory:true,thot:{...fixture.config,confirmations:1,
    codeHashes:fixture.manifest.codeHashes,localDeliverySigner:fixture.config.operator}});
  const origin='https://journey.example.test',host=new URL(origin).host;
  const auth=await WalletAuth.create(app.db,{schema_version:'thot.wallet-auth/1',origin,chain_id:31337,
    rpc_url:origin+'/rpc/'+('a'.repeat(32)),allow_public_signup:true,session_ttl_seconds:300});
  server=createHttpServer(app,{externalAuth:auth,publicOrigin:origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local='http://127.0.0.1:'+server.address().port;
  const transport=(url,init={})=>{
    assert.equal(new URL(url).origin,origin,'uploader sends only to selected THOT origin');
    // Node fetch replaces Host with the transport URL. Keep the real server's
    // exact origin checks by explicitly preserving the logical application Host.
    return new Promise((resolve,reject)=>{
      const request=httpRequest(local+new URL(url).pathname,{method:init.method??'GET',headers:{...init.headers,Host:host,Origin:origin},signal:init.signal},response=>{
        const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>2_000_000)request.destroy(Error('Fixture response limit'));else chunks.push(chunk);});
        response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);
      });request.on('error',reject);request.end(init.body);
    });
  };
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  async function browserFor(signer){
    const address=await signer.getAddress(),context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
    // Model the user's explicit browser permission for this loopback pairing.
    await context.grantPermissions(['local-network-access'],{origin});
    await context.exposeBinding('journeyWalletRequest',async(_source,request)=>{
      walletCalls.push(request.method);
      if(['eth_accounts','eth_requestAccounts'].includes(request.method))return[address];
      if(request.method==='eth_chainId')return'0x7a69';
      if(request.method==='personal_sign')return signer.signMessage(getBytes(request.params[0]));
      if(request.method==='eth_signTypedData_v4'){
        assert.equal(request.params[0].toLowerCase(),address.toLowerCase());
        const typed=JSON.parse(request.params[1]),{EIP712Domain:_,...types}=typed.types;
        return signer.signTypedData(typed.domain,types,typed.message);
      }
      if(['eth_blockNumber','eth_call','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt'].includes(request.method))return fixture.provider.send(request.method,request.params??[]);
      throw Error('No transaction or provider call is authorized by this fixture: '+request.method);
    });
    await context.addInitScript(()=>{
      const events=new Map();window.ethereum={isMetaMask:true,request:value=>window.journeyWalletRequest(value),on:(event,listener)=>events.set(event,listener),removeListener:event=>events.delete(event)};
    });
    // HTTPS logical origin keeps production cookie/SIWE rules intact; every
    // application request reaches the real isolated loopback HTTP server.
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin===origin){
        requests.push({path:url.pathname,method:request.method()});
        const response=await route.fetch({url:local+url.pathname+url.search,headers:{...request.headers(),host},maxRedirects:0});
        return route.fulfill({response});
      }
      if(url.hostname==='127.0.0.1'&&/^\/pair\/[a-f0-9]{48}$/.test(url.pathname))return route.continue();
      return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
    return {page,context,address};
  }
  const owner=await browserFor(fixture.seller),page=owner.page;
  const call=(page,path,body)=>page.evaluate(async({path,body})=>{
    const response=await fetch(path,{credentials:'same-origin',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  },{path,body});
  const shot=async(name,target=page)=>{await target.evaluate(()=>document.fonts.ready);await target.screenshot({path:join(evidence,name+'.png'),fullPage:true});};
  const closeDialog=()=>page.getByRole('button',{name:'Close dialog',exact:true}).first().click();
  await page.goto(origin+'/app');await page.locator('[data-wallet-login="metamask"]').click();
  await page.locator('#conversation-library').waitFor();
  const session=await call(page,'/v1/auth/session');assert.equal(session.status,200);const actor=session.body.actor;
  assert.equal(session.body.wallet_address.toLowerCase(),owner.address.toLowerCase());await shot('01-my-work-empty');

  const source=join(dir,'synthetic-history');await mkdir(source);
  const marker='SYNTHETIC-PRIVATE-QUEUE-CONTEXT',retained='SYNTHETIC-REUSABLE-QUEUE-LESSON';
  const history=[
    {type:'user',sessionId:'synthetic-connected',message:{role:'user',content:'Explain queue cancellation in this synthetic fixture.'}},
    {type:'assistant',sessionId:'synthetic-connected',message:{role:'assistant',content:'Bound pending work and cancel only the selected job.'}},
    {type:'user',sessionId:'synthetic-connected',message:{role:'user',content:marker+' should stay out of the licensed release.'}},
    {type:'assistant',sessionId:'synthetic-connected',message:{role:'assistant',content:retained+' Retry with the same idempotency key.'}},
  ].map(row=>JSON.stringify(row)).join('\n');
  const file=join(source,'synthetic.jsonl');await writeFile(file,history,{mode:0o600});const old=new Date(Date.now()-180000);await utimes(file,old,old);
  const historyState=await createHistoryState({origin,client:'claude',paths:[source],backfill:true,time:'02:00'}),connectionDir=join(dir,'history-state',historyState.id);
  const paired=connectHistory(historyState,connectionDir,{transport,timeoutMs:60000,log:()=>{},open:async url=>{await page.goto(url);return true;}});
  paired.catch(()=>{}); // A UI assertion may fail before the helper's timeout.
  await page.locator('#history-private-consent').waitFor();await page.locator('#history-private-consent').check();
  await page.locator('[data-action="history-sync-confirm"]').click();await paired;
  await page.getByText('History uploader connected',{exact:true}).waitFor();await shot('02-private-upload-consent');
  assert.equal((await app.service.traces(actor)).length,0,'browser approval does not collect history');
  const synced=await runHistorySync(connectionDir,{transport});assert.equal(synced.saved,1);
  const replay=await runHistorySync(connectionDir,{transport});assert.equal(replay.unchanged,1);assert.equal(replay.saved,0);
  const saved=(await app.service.traces(actor))[0];assert.equal(saved.status,'PRIVATE');assert.equal(saved.provenance_status,'IMPORTED_UNVERIFIED');
  const grant=(await loadPrivate(connectionDir)).grant;
  const scopeDenied=await transport(origin+'/v1/thot/listings/preview',{method:'POST',headers:{Authorization:'Bearer '+grant.device_token,'Content-Type':'application/json'},body:JSON.stringify({trace_id:saved.trace_id})});
  assert.equal(scopeDenied.status,401,'upload-only grant cannot preview content');
  await closeDialog();await page.reload();const row=page.locator('[data-testid="conversation-row"][data-trace-id="'+saved.trace_id+'"]');await row.waitFor();
  await row.locator('[data-action="library-open"]').first().click();await page.locator('#library-prepare-sale').waitFor();
  assert.match(await page.locator('.library-conversation').innerText(),new RegExp(marker));await shot('03-private-import-reader');
  await page.locator('#library-prepare-sale [name="rights_confirmed"]').check();await page.locator('#library-prepare-sale [name="model_output_licensed"]').check();
  await page.locator('#library-prepare-sale button[type="submit"]').click();
  await page.locator('#detail-dialog [data-action="thot-list-configure"]').click();await page.locator('.journey-release-turns').waitFor();
  const before=(await call(page,'/v1/thot/listings/preview',{trace_id:saved.trace_id})).body;
  assert.match(await page.locator('.journey-release-turns').innerText(),new RegExp(marker));
  await page.locator('#thot-price').fill('123');await page.locator('#thot-list-consent').check();
  await page.locator('input[name="excluded_turn"][value="2"]').check();assert.equal(await page.locator('[data-action="thot-list-confirm"]').isDisabled(),true);
  await page.getByText('Apply privacy changes',{exact:true}).click();await page.locator('#release-exclusion-rights').check();await page.locator('#release-exclusion-outputs').check();
  await page.locator('[data-action="thot-release-exclude"]').click();
  await page.waitForFunction(marker=>!document.querySelector('.journey-release-turns')?.textContent.includes(marker),marker);
  const after=(await call(page,'/v1/thot/listings/preview',{trace_id:saved.trace_id})).body;
  assert.notEqual(after.content_hash,before.content_hash);assert.equal(after.content.turns.length,3);
  assert.equal(await page.locator('#thot-price').inputValue(),'');assert.equal(await page.locator('#thot-list-consent').isChecked(),false);
  assert.match(await page.locator('.journey-release-turns').innerText(),new RegExp(retained));await shot('04-reviewed-release-desktop');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('05-reviewed-release-mobile');
  await page.setViewportSize({width:1440,height:1000});await page.locator('#thot-title').fill('Synthetic queue cancellation lesson');await page.locator('#thot-price').fill('100');await page.locator('#thot-list-consent').check();
  assert.equal(await page.locator('#thot-treasury-consent').isChecked(),false);
  await page.locator('[data-action="thot-list-confirm"]').click();await page.locator('#detail-dialog').waitFor({state:'hidden'});
  const listing=await app.db.transaction(async tx=>(await tx.list('thot_records',actor.id)).find(item=>item.kind==='listing'));
  assert(listing?.active&&listing.signature);assert.equal(listing.release_content_hash,after.content_hash);assert.equal(listing.turn_count,3);
  const release=await app.privacy.open(actor.id,listing.release_ref);assert.deepEqual(release.content,after.content);assert.equal(listing.evidence_hash,'0x'+canonicalHash(release));
  assert.equal(JSON.stringify(release).includes(marker),false);assert.equal((await app.library.item(actor,saved.trace_id)).content.turns.length,4);
  await page.reload();await row.waitFor();assert.equal((await call(page,'/v1/auth/session')).body.actor.id,actor.id);await shot('06-listed-my-work');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('06b-listed-my-work-mobile');

  const buyer=await browserFor(fixture.other);await buyer.page.goto(origin+'/app#thot-available');await buyer.page.locator('[data-wallet-login="metamask"]').click();
  const publicCard=buyer.page.locator('[data-listing-id="'+listing.id+'"]');await publicCard.waitFor();
  assert.match(await publicCard.innerText(),/Synthetic queue cancellation lesson/);assert.doesNotMatch(await buyer.page.locator('main').innerText(),new RegExp(marker+'|'+retained));
  assert.equal((await call(buyer.page,'/v1/thot/listings/preview',{trace_id:saved.trace_id})).status,404);
  assert.equal((await call(buyer.page,'/v1/contributor/library')).body.items.length,0);
  assert.equal((await call(buyer.page,'/v1/contributor/history-devices')).body.devices.length,0);
  await buyer.page.reload();await publicCard.waitFor();assert.match(await buyer.page.locator('nav [data-view="market"]').getAttribute('class'),/active/);
  await buyer.page.setViewportSize({width:390,height:844});assert(await buyer.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('07-buyer-metadata-mobile',buyer.page);
  await buyer.page.locator('[data-action="thot-buy"][data-id="'+listing.id+'"]').click();await buyer.page.locator('#detail-dialog[open]').waitFor();
  assert.doesNotMatch(await buyer.page.locator('#detail-dialog').innerText(),new RegExp(marker+'|'+retained));await shot('08-buyer-purchase-review',buyer.page);
  assert.equal(walletCalls.filter(method=>method==='eth_sendTransaction'||method==='eth_sendRawTransaction').length,0);
  assert.equal(walletCalls.filter(method=>method==='eth_signTypedData_v4').length,1);
  assert.deepEqual(errors,[]);
  await writeFile(join(evidence,'result.json'),JSON.stringify({status:'PASS',scope:'Real backend and browser with synthetic histories, loopback-only application transport, local Anvil configuration and real synthetic wallet signatures. No token payment, paid model call, production activity, OTP or external wallet service.',
    checks:['Signed wallet sessions','Browser grant approval reads no history','Stable selected history upload and duplicate-free retry','Upload token cannot preview','Private import readback','Explicit rights preparation','Exact scrubbed release preview','Server exclusion updates commitment and resets consent','Actual signed listing preserves exact encrypted release','Private original preserved','Reload restores account','Other account cannot read private release/library/grant','Direct catalogue persists on reload','Desktop/mobile no horizontal overflow','Buyer review remains metadata-only before payment'],
    screenshots:['01-my-work-empty.png','02-private-upload-consent.png','03-private-import-reader.png','04-reviewed-release-desktop.png','05-reviewed-release-mobile.png','06-listed-my-work.png','06b-listed-my-work-mobile.png','07-buyer-metadata-mobile.png','08-buyer-purchase-review.png'],
    wallet_transaction_requests:0,listing_authorizations:1,errors},null,2)+'\n');
});
