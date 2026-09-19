import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createApplication} from '../../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../../apps/api/server.ts';
import {startRobinhoodPairing} from '../../packages/capture/src/robinhood-pairing.ts';

// Fresh browser profile, real local helper HTTP boundary, real API and database.
// Brokerage verification alone is a named fixture; this is not live Robinhood evidence.
test('guided first-time setup: missing helper, extension readiness, account check, consent and renewal',{timeout:90_000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-guided-e2e-'));
  const app=await createApplication({dataDir,memory:true,robinhood:{verifierExecutable:'/usr/bin/python3',verifierArgs:[],witnessUrl:'https://witness.example',appraiserUrl:'https://appraiser.example'},brokerageVerifier:async(_evidence,ticket)=>{
    const payload=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url').toString());
    return {verified:true,owner_user_id:payload.owner_user_id,job_id:payload.job_id,link_ticket_hash:createHash('sha256').update(ticket).digest('hex'),subject:'f'.repeat(64),observed_at:payload.issued_at};
  }});t.after(()=>app.close());
  const server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});t.after(()=>browser.close());
  const record=process.env.THOT_RECORD_SETUP==='1';const out=resolve('work/guided-setup-e2e');await mkdir(out,{recursive:true});
  const context=await browser.newContext({bypassCSP:record,viewport:{width:1280,height:900},...(record?{recordVideo:{dir:out,size:{width:1280,height:900}}}:{})});
  if(record)await context.addInitScript(()=>{new MutationObserver(()=>{if(!document.body||document.getElementById('setup-test-label'))return;const e=document.createElement('div');e.id='setup-test-label';e.textContent='Setup rehearsal · fresh browser · synthetic brokerage proof';e.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#112f29;color:white;padding:16px 24px;font:18px system-ui';document.body.append(e);}).observe(document,{childList:true,subtree:true});});
  const page=await context.newPage();page.setDefaultTimeout(12_000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const pause=async()=>{if(record)await page.waitForTimeout(4500);};
  await page.goto(origin+'/app');await page.getByRole('heading',{name:'Your traces'}).waitFor();
  await page.getByRole('button',{name:'Capture a conversation'}).click();await page.getByRole('button',{name:'Set up Claude Code'}).click();
  assert.match(await page.locator('#detail-dialog').innerText(),/thot-setup claude/);await page.getByText('First time on this computer?',{exact:true}).click();
  const guideOpening=context.waitForEvent('page');await page.getByRole('link',{name:'First-time setup guide'}).click();const guide=await guideOpening;guide.on('pageerror',e=>errors.push(e.message));
  await guide.getByRole('heading',{name:'Save your AI work privately.'}).waitFor();await pause();
  assert.match(await guide.locator('#install-command').innerText(),new RegExp(origin.replaceAll('.','\\.')));
  await guide.getByRole('link',{name:'← Back to your vault'}).click();await guide.getByRole('heading',{name:'Your traces'}).waitFor();await guide.close();
  await pause();await page.getByRole('button',{name:'Next: start capture'}).click();assert.match(await page.locator('#detail-dialog').innerText(),/thot claude/);await pause();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByText('Brokerage connection',{exact:true}).click();
  await page.getByRole('button',{name:'Connect Robinhood',exact:false}).click();await pause();
  assert.doesNotMatch(await page.locator('#detail-dialog').innerText(),/THOT_GATE_COOKIE|CONFIG_FILE|link ticket|upload.*proof/i);
  // Paste a dead helper link into the existing tab; hash navigation must work.
  const dead={callback:'http://127.0.0.1:1/pair/'+'A'.repeat(48)};
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.evaluate(hash=>{location.hash=hash;},'#thot-robinhood='+Buffer.from(JSON.stringify(dead)).toString('base64url'));
  await page.getByRole('button',{name:'Check connection',exact:true}).click();
  await page.getByRole('heading',{name:'Connection needs attention'}).waitFor();await pause();
  await page.getByRole('button',{name:'Cancel connection',exact:true}).click();
  let update!:(record:unknown)=>void;
  const bridge=await startRobinhoodPairing({origin,extensionDir:'/example/thot/robinhood/extension',launch(_input,emit){update=emit;emit({stage:'awaiting_browser_login'});return ()=>{};}});t.after(()=>bridge.close());
  await page.goto(bridge.url);await page.getByRole('button',{name:'Check connection',exact:true}).click();
  await page.getByRole('heading',{name:'Open Robinhood in Chrome'}).waitFor();await pause();
  await page.getByText('First time, or still waiting?',{exact:true}).click();assert.match(await page.locator('#detail-dialog').innerText(),/Load unpacked/);await pause();
  update({stage:'awaiting_account_request'});
  await page.getByRole('heading',{name:'Open your Robinhood account'}).waitFor();await pause();
  assert.equal(await page.getByRole('link',{name:'Open Robinhood'}).getAttribute('href'),'https://robinhood.com/');
  update({stage:'capturing'});await page.getByRole('heading',{name:'Checking your account'}).waitFor();await pause();
  assert.equal(await page.getByRole('heading',{name:'Robinhood connected',exact:true}).count(),0);
  update({evidence:{credential:{fixture:'TEST ONLY — no live brokerage'},witness_receipts:[]}});
  await page.getByRole('heading',{name:'Robinhood connected',exact:true}).waitFor();await pause();
  await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByText('Brokerage connection',{exact:true}).click();await page.getByRole('button',{name:'Renew Robinhood connection',exact:true}).waitFor();
  // Same-tab capture pairing regression: no new browser/page needed.
  await page.evaluate(hash=>{location.hash=hash;},'#thot='+Buffer.from(JSON.stringify({...dead,client:'codex'})).toString('base64url'));
  await page.getByRole('heading',{name:'Connect Codex',exact:true}).waitFor();
  assert.match(await page.locator('#detail-dialog').innerText(),/Save this Codex session privately as you work/);
  assert.match(await page.locator('#detail-dialog').innerText(),/review and approve content separately before any release/i);
  assert.equal(await page.locator('#confirm-agent-capture').isEnabled(),true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/getting-started');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await pause();
  assert.deepEqual(errors,[]);
  const video=page.video();await context.close();if(record&&video){await video.saveAs(join(out,'journey.webm'));await writeFile(join(out,'results.json'),JSON.stringify({status:'PASS',recorded_at:new Date().toISOString(),evidence:'Fresh browser + real helper HTTP/API/database; synthetic brokerage verifier, no live account or clean OS installation',assertions:['missing helper blocks before job creation','extension readiness has explicit next step','account request differs from verified proof','server accepts fixture proof before Connected','renewal control visible','existing-tab capture link works','mobile guide has no horizontal overflow'],errors},null,2));}
});
