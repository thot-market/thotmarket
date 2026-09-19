import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApplication } from '../../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../../apps/api/server.ts';

// Real browser + HTTP + persistent database. Development identity, synthetic history;
// no Clerk, Plaid, live inference, or desktop/browser-profile interaction.
test('browser: preview cancellation, consent, persistence, deduplication and role isolation', {timeout:90_000}, async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'thot-browser-'));
  const cleanup:Array<()=>Promise<unknown>>=[];
  t.after(async()=>{try{for(const close of cleanup.reverse())await close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  let app=await createApplication({dataDir});
  cleanup.push(()=>app.close());
  let server=createHttpServer(app);
  cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const listen=async(port=0)=>{await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');return address.port;};
  const port=await listen();
  const browser=await chromium.launch({headless:true,executablePath:process.env.THOT_E2E_BROWSER??'/usr/bin/google-chrome',args:['--disable-gpu','--disable-dev-shm-usage']});
  cleanup.push(()=>browser.close());
  const context=await browser.newContext();
  const page=await context.newPage();page.setDefaultTimeout(12_000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const history=Buffer.from([
    {type:'user',sessionId:'synthetic-e2e',cwd:'/synthetic/browser-example',message:{role:'user',content:'Compare public filings and explain the assumptions.'}},
    {type:'assistant',sessionId:'synthetic-e2e',message:{role:'assistant',content:[{type:'text',text:'Separate reported revenue from estimates.'}]}},
  ].map(v=>JSON.stringify(v)).join('\n'));
  const cards=page.locator('[data-testid="conversation-row"]');
  const review=async(buffer=history)=>{
    await page.locator('#conversation-library [data-action="import-research"]').click();
    await page.locator('#research-file').setInputFiles({name:'synthetic.jsonl',mimeType:'application/x-ndjson',buffer});
    await page.locator('#research-preview-form button[type="submit"]').click();
    await page.locator('#confirm-research').waitFor();
    assert.equal(await page.locator('#confirm-research').isDisabled(),false);assert.equal(await page.locator('#detail-dialog input[type=checkbox]:visible').count(),0);
  };
  const save=async()=>{
    const response=page.waitForResponse(r=>r.url().endsWith('/v1/contributor/import/confirm')&&r.request().method()==='POST');
    await page.locator('#confirm-research').click();
    const r=await response;assert.equal(r.status(),200);const result=await r.json();
    await page.locator('#confirm-research').waitFor({state:'hidden'});
    await cards.first().waitFor();return result;
  };
  await page.goto(`http://127.0.0.1:${port}/app`);
  await review();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await cards.count(),0);
  await review();const first=await save();
  assert.equal(await cards.count(),1);
  assert.match(await cards.innerText(),/uploaded history/i);
  assert.doesNotMatch(await cards.innerText(),/demo estimate/i);
  await page.locator('nav [data-view="market"]').click();assert.equal(await page.locator('.offer-demo').count(),0);await page.locator('nav [data-view="vault"]').click();
  await page.reload();await cards.first().waitFor();
  await review();const duplicate=await save();
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.trace_id,first.trace_id);assert.equal(await cards.count(),1);
  await page.locator('#role').selectOption('buyer_admin');
  await cards.first().waitFor({state:'hidden'});
  assert.equal(await cards.count(),0);
  await page.locator('#role').selectOption('user');await cards.first().waitFor();
  // Restart the actual backend, retaining only this test's private directory.
  await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();
  app=await createApplication({dataDir});server=createHttpServer(app);await listen(port);
  await page.reload();await cards.first().waitFor();assert.equal(await cards.count(),1);
  const codex=Buffer.from([
    {type:'session_meta',payload:{id:'synthetic-codex',cwd:'/synthetic/codex-example'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Explain a sorting algorithm.'}]}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Compare adjacent entries.'}]}},
  ].map(v=>JSON.stringify(v)).join('\n'));
  await review(codex);await save();
  const codexCard=cards.filter({hasText:'Codex'});await codexCard.waitFor();
  assert.equal(await cards.count(),2);assert.match(await codexCard.innerText(),/uploaded history/i);
  await review(codex);const repeatedCodex=await save();assert.equal(repeatedCodex.duplicate,true);
  assert.equal(await cards.count(),2);
  assert.deepEqual(errors,[]);
});
