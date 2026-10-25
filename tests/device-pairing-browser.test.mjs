import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {request as httpRequest} from 'node:http';
import {Wallet} from 'ethers';
import {chromium} from 'playwright-core';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {WalletAuth} from '../packages/auth/src/index.ts';
import {connectCapture} from '../packages/capture/src/connect.ts';

// A helper whose loopback callback the browser cannot reach pairs by short
// device code instead: the real dashboard approves it from a signed-in
// browser, first from the helper's forced code mode, then from loopback
// falling back to a code typed into the verification page by hand.
test('device-code pairing reaches the helper when loopback pairing cannot',{timeout:300000},async t=>{
  assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must select local Chromium');
  const evidence=resolve(process.env.THOT_PAIRING_ARTIFACTS??'work/device-pairing-browser');await mkdir(evidence,{recursive:true});
  const dir=await mkdtemp(join(tmpdir(),'thot-pairing-browser-')),errors=[];
  let app,server,browser;
  t.after(async()=>{
    await writeFile(join(evidence,'browser-errors.json'),JSON.stringify(errors,null,2)+'\n').catch(()=>{});
    await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
    await app?.close();await rm(dir,{recursive:true,force:true});
  });
  app=await createApplication({dataDir:join(dir,'app'),memory:true});
  const origin='https://pairing.example.test',host=new URL(origin).host;
  const auth=await WalletAuth.create(app.db,{schema_version:'thot.wallet-auth/1',origin,chain_id:31337,
    rpc_url:origin+'/rpc/'+('b'.repeat(32)),allow_public_signup:true,session_ttl_seconds:300});
  server=createHttpServer(app,{externalAuth:auth,publicOrigin:origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local='http://127.0.0.1:'+server.address().port;
  // The helper machine and the browser machine do not share loopback: the
  // helper reaches the application only through its public origin.
  const transport=(url,init={})=>new Promise((resolve,reject)=>{
    const request=httpRequest(local+new URL(url).pathname,{method:init.method??'GET',headers:{...init.headers,Host:host},signal:init.signal},response=>{
      const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>2_000_000)request.destroy(Error('Fixture response limit'));else chunks.push(chunk);});
      response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);
    });request.on('error',reject);request.end(init.body);
  });
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const signer=Wallet.createRandom(),address=await signer.getAddress();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  t.after(async()=>{for(const page of context.pages())await page.screenshot({path:join(evidence,'final-state.png'),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});});
  await context.exposeBinding('pairingWalletRequest',async(_source,request)=>{
    if(['eth_accounts','eth_requestAccounts'].includes(request.method))return[address];
    if(request.method==='eth_chainId')return'0x7a69';
    if(request.method==='personal_sign')return signer.signMessage((await import('ethers')).getBytes(request.params[0]));
    throw Error('No provider call is authorized by this fixture: '+request.method);
  });
  await context.addInitScript(()=>{
    const events=new Map();window.ethereum={isMetaMask:true,request:value=>window.pairingWalletRequest(value),on:(event,listener)=>events.set(event,listener),removeListener:event=>events.delete(event)};
  });
  const requests=[];await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===origin){
      requests.push({path:url.pathname,method:request.method()});
      const response=await route.fetch({url:local+url.pathname+url.search,headers:{...request.headers(),host},maxRedirects:0});
      return route.fulfill({response});
    }
    // Nothing may fall back to a loopback helper: this journey pairs by code.
    return route.abort();
  });
  const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  const shot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(evidence,name+'.png'),fullPage:true});};
  await page.goto(origin+'/app');await page.locator('[data-wallet-login="metamask"]').click();
  await page.locator('#conversation-library').waitFor();
  const actor=(await page.evaluate(async()=>await (await fetch('/v1/auth/session',{credentials:'same-origin'})).json())).actor;
  assert.equal(actor.role,'user');

  // 1. The helper is started with --pairing code: no loopback server at all.
  const waitFor=(predicate,limit=15000)=>new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve();}else if(limit<=0){clearInterval(timer);reject(Error('Timed out waiting for the helper to reach the pairing step'));}else limit-=50;},50);});
  let approvalUrl;
  const coded=connectCapture({origin,client:'claude',project:'browser-code-pairing',root:join(dir,'connections'),pairing:'code',transport,log:()=>{},open:async url=>{approvalUrl=url;return true;}});
  coded.catch(()=>{}); // A UI assertion may fail before the helper gives up.
  await waitFor(()=>approvalUrl!==undefined);
  await page.goto(approvalUrl);
  await page.getByRole('heading',{name:'Connect Claude Code',exact:true}).waitFor();
  const review=await page.locator('.dialog-body').innerText();
  assert.match(review,/Requesting device:/,'the approval screen names the requesting device');
  assert.match(review,/IP /,'the approval screen shows the requesting address');
  assert.match(review,/Connect Claude Code on .+ once/);
  await shot('01-code-approval-screen');
  await page.locator('[data-action="confirm-agent-capture"]').click();
  const forced=await coded;
  assert.equal(forced.account_id,actor.id);assert.ok(forced.capture_id);assert.equal(forced.automatic_sales,false);
  await page.getByRole('heading',{name:'Browser approval complete',exact:true}).waitFor();
  await shot('02-browser-approval-complete');
  const devices=await app.captureDevices.list({id:actor.id,role:'user'});
  assert.equal(devices.devices.length,1);assert.equal(devices.devices[0].client,'claude');
  assert.equal((await app.agentCapture.authenticate(forced.capture_id,forced.upload_token)).owner_id,actor.id);

  // 2. Loopback pairing starts, nothing reaches it, and the helper falls back
  // to a code the person types into the verification page by hand.
  const logs=[];let fallbackCode='';
  const fallen=connectCapture({origin,client:'codex',project:'browser-fallback-pairing',root:join(dir,'connections'),fallbackMs:250,transport,open:async()=>false,log:message=>{logs.push(message);const code=/^  Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})$/.exec(message)?.[1];if(code)fallbackCode=code;}});
  fallen.catch(()=>{});
  await page.getByRole('button',{name:'Close dialog',exact:true}).first().click();
  await waitFor(()=>fallbackCode!=='');
  assert.match(logs.join('\n'),/Pair with a code instead/);
  assert.match(logs.join('\n'),/or visit .*#thot-pair= and enter the code there/);
  await page.goto(origin+'/app#thot-pair=');
  await page.getByRole('heading',{name:'Connect a device',exact:true}).waitFor();
  await shot('03-manual-code-entry');
  await page.locator('#device-pairing-code').fill(fallbackCode.toLowerCase()+' ');
  await page.locator('[data-action="device-pairing-submit"]').click();
  await page.getByRole('heading',{name:'Connect Codex',exact:true}).waitFor();
  const fallbackReview=await page.locator('.dialog-body').innerText();
  assert.match(fallbackReview,/Requesting device:/);
  await shot('04-fallback-approval-screen');
  await page.locator('[data-action="confirm-agent-capture"]').click();
  const fallback=await fallen;
  assert.equal(fallback.account_id,actor.id);assert.ok(fallback.capture_id);
  const finalDevices=await app.captureDevices.list({id:actor.id,role:'user'});
  assert.equal(finalDevices.devices.length,2,'both pairings produced one device each');
  assert.ok(!requests.some(r=>r.path.startsWith('/v1/device-pairing/sessions/events')),'no loopback-style relay is used by capture pairing');
});
