import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';

const output=resolve(process.argv[2]??'work/openrouter-usage');
await mkdir(output,{recursive:true});
const dataDir=await mkdtemp(join(tmpdir(),'thot-usage-browser-'));
let app,server,browser,providerCalls=0;
try {
  app=await createApplication({dataDir,memory:true,openrouter:{enabled:true,transport:async()=>{providerCalls++;throw Error('Provider calls forbidden in usage acceptance');}}});
  const examples=[
    {model:'synthetic/code-model',status:'COMPLETED',usage:{prompt_tokens:12000,completion_tokens:2400,total_tokens:14400,cost:0.0184}},
    {model:'synthetic/free-model',status:'COMPLETED',usage:{prompt_tokens:800,completion_tokens:150,total_tokens:950,cost:0}},
    {model:'synthetic/interrupted',status:'INTERRUPTED'},
    {model:'synthetic/small-call',status:'COMPLETED',usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25,cost:0.00000004}},
  ];
  await app.db.transaction(async tx=>{for(const [i,row] of examples.entries())await tx.insert('thot_records','openrouter-request:usage-fixture-'+i,'demo-user',{kind:'openrouter-request',request_id:'openrouter-request:usage-fixture-'+i,trace_id:'usage-fixture-'+i,created_at:'2026-10-07T01:0'+i+':00.000Z',...row});});
  server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER??'/usr/bin/chromium',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Singapore'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/app');
  await page.locator('[data-action="openrouter-usage"]').first().click();
  await page.getByRole('heading',{name:'Model usage & cost'}).waitFor();
  assert.equal(await page.locator('.usage-request').count(),4);
  assert.match(await page.locator('.openrouter-usage').innerText(),/0\.0184/);
  assert.equal((await page.request.get(origin+'/openrouter-usage.js')).status(),200);
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
    await page.setViewportSize({width,height});await page.locator('.dialog-body').evaluate(e=>e.scrollTop=0);
    assert.equal(await page.locator('.dialog-body').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
    const bounds=await page.locator('.dialog-footer [data-action="openrouter-usage"]').boundingBox();assert(bounds&&bounds.y+bounds.height<=height);
    await page.screenshot({path:join(output,'usage-'+name+'.png')});
    await page.locator('.usage-request').last().scrollIntoViewIfNeeded();
    await page.screenshot({path:join(output,'requests-'+name+'.png')});
  }
  const refresh=page.waitForResponse(r=>r.url().endsWith('/v1/contributor/openrouter'));
  await page.locator('.dialog-footer [data-action="openrouter-usage"]').click();assert.equal((await refresh).status(),200);
  assert.equal(providerCalls,0);assert.deepEqual(errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({status:'PASS',scope:'Synthetic local records and actual application, API and browser modules. No provider call or wallet action.',checks:['Authenticated recent usage rendered','New module served over application HTTP','Desktop and mobile: no horizontal overflow; refresh visible','Read-only refresh','No provider calls','No page errors']},null,2));
  console.log('PASS: local usage browser acceptance');
} finally {
  await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await app?.close();await rm(dataDir,{recursive:true,force:true});
}
