import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApplication } from '../../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../../apps/api/server.ts';
import { validateRateCard, type InferenceProvider, type InferenceRateCard } from '../../packages/inference/src/index.ts';
import { demoUser,policyInput,importDemo,createDemoMandate } from '../../packages/market/src/fixtures.ts';

const instant='2026-09-06T00:00:00.000Z';
// Fictional prices/model and an in-process provider. This fixture has no network transport.
const card:InferenceRateCard={version:'synthetic-browser-fixture/1',model:'synthetic-browser-model',service_tier:'default',currency:'USD',
  input_micro_usd_per_million:'4000000',cached_micro_usd_per_million:'2000000',cache_write_micro_usd_per_million:null,
  output_micro_usd_per_million:'20000000',max_input_tokens:1000,max_output_tokens:250,verified_at:instant,
  expires_at:'2026-09-07T00:00:00.000Z',verified:true,example_only:false};

class SyntheticBrowserProvider implements InferenceProvider {
  readonly provider='synthetic-browser-fixture';
  readonly billingEnvironment='synthetic' as const;
  readonly rateCard=card;
  calls:Array<{operation:'count'|'generate';requestId:string;prompt:string}>=[];
  validate(){validateRateCard(this.rateCard,new Date(instant));}
  async count(prompt:string,requestId:string){this.calls.push({operation:'count',requestId,prompt});return 100;}
  async generate(prompt:string,requestId:string){
    this.calls.push({operation:'generate',requestId,prompt});
    return {provider_response_id:'resp_synthetic_browser_fixture',status:'COMPLETED' as const,text:'Synthetic browser response; no external model was called.',actual_minor:'1',
      usage:{input_tokens:100,cached_tokens:0,cache_write_tokens:0,output_tokens:100,total_tokens:200}};
  }
}

test('browser: explicitly execute synthetic inference, capture it, and inspect P0 portfolio evidence',{timeout:90_000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-inference-browser-')),provider=new SyntheticBrowserProvider();
  const cleanup:Array<()=>Promise<unknown>>=[];
  t.after(async()=>{try{for(const close of cleanup.reverse())await close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const app=await createApplication({dataDir,config:{clock:()=>new Date(instant)},inference:{provider,dailyBudgetMinor:'100'}});
  cleanup.push(()=>app.close());
  // Earn the synthetic credit through the actual authorization/settlement path.
  // An orphan entitlement is deliberately not displayed as a settled earning.
  await app.service.createPolicy(demoUser,'browser-inference-policy',policyInput(app.service));
  await importDemo(app.service,demoUser,'coding','browser-inference-import');
  await createDemoMandate(app.service,'general','browser-inference-mandate');
  await app.service.runWorker();
  const candidate=(await app.service.candidates(demoUser))[0]!;
  const {release,...authorization}=await app.service.preview(demoUser,candidate.candidate_id);
  await app.service.authorize(demoUser,'browser-inference-authorization',{...authorization,payout_preference:'inference_credit'});
  await app.service.runWorker();
  const earnings=await app.service.earnings(demoUser);
  assert.equal(earnings.settlements.length,1);
  assert.ok(BigInt(earnings.entitlements[0]!.available_minor)>=100n);

  const server=createHttpServer(app);cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const browser=await chromium.launch({headless:true,executablePath:process.env.THOT_E2E_BROWSER??'/usr/bin/chromium'});cleanup.push(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(15_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));

  await page.goto(`http://127.0.0.1:${address.port}/app`);
  await page.locator('[data-view="earnings"]').click();
  await page.locator('[data-action="external-inference"]').click();
  await page.getByText('synthetic-browser-fixture / synthetic-browser-model').waitFor();
  await page.locator('#inference-prompt').fill('Synthetic browser prompt; do not send to a network.');
  await page.locator('#external-inference-consent').check();
  const execution=page.waitForResponse(response=>response.url().endsWith('/execute')&&response.request().method()==='POST');
  await page.locator('[data-action="submit-external-inference"]').click();
  assert.equal((await execution).status(),200);
  await page.getByText('Synthetic browser response; no external model was called.').waitFor();
  assert.deepEqual(provider.calls.map(call=>call.operation),['count','generate']);

  await page.locator('[data-action="capture-inference"]').click();
  await page.getByText(/not a provider-signed or TEE-verified conversation/i).waitFor();
  await page.locator('#capture-rights').check();
  await page.locator('#capture-output-license').check();
  const capture=page.waitForResponse(response=>response.url().endsWith('/capture')&&response.request().method()==='POST');
  await page.locator('[data-action="confirm-capture-inference"]').click();
  const captured=await capture;assert.equal(captured.status(),200);
  const saved=await captured.json() as {trace_id:string};assert.match(saved.trace_id,/^[A-Za-z0-9-]{16,80}$/);
  assert.deepEqual(provider.calls.map(call=>call.operation),['count','generate'],'capture must not invoke the provider');

  // Saving moves to the current private-library result without another navigation step.
  const cardView=page.locator('[data-testid="conversation-row"]').filter({hasText:'THOT inference conversation'});await cardView.waitFor();
  assert.match(await cardView.innerText(),/THOT inference/i);assert.match(await cardView.innerText(),/Saved/i);
  await cardView.locator('[data-action="library-open"]').click();
  assert.match(await page.locator('#detail-dialog').innerText(),/Synthetic browser response; no external model was called\./);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByText('Developer demo tools',{exact:true}).click();
  await page.locator(`[data-action="trace"][data-id="${saved.trace_id}"]`).click();
  await page.getByRole('heading',{name:'Provenance claims & limitations',exact:true}).waitFor();
  assert.match(await page.locator('#detail-dialog').innerText(),/P0_OPERATOR/);
  const portfolio=await app.portfolio.list(demoUser),item=portfolio.items.find(row=>row.title==='THOT inference conversation');
  assert.ok(item);assert.equal(item.evidence.confidence_tier,'P0_OPERATOR');assert.equal(item.evidence.authenticated_provider_history,false);
  assert.deepEqual(errors,[]);
});
