import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApplication } from '../../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../../apps/api/server.ts';
import { demoUser } from '../../packages/market/src/fixtures.ts';
import type { PlaidTransport } from '../../packages/market/src/plaid-link.ts';

const instant='2026-09-09T16:00:00.000Z';
const accessToken='access-sandbox-11111111-2222-3333-4444-555555555555';

// This transport is a deterministic Plaid Sandbox-shaped test double. It performs
// no network requests and proves only the app's simulated brokerage workflow.
function syntheticPlaid() {
  const calls:Array<{path:string;body:Record<string,unknown>}>=[];
  const transport:PlaidTransport=async(path,body)=>{
    calls.push({path,body});
    assert.equal(body.client_id,'synthetic-client');
    assert.equal(body.secret,'synthetic-secret');
    if(path==='/link/token/create')return {link_token:'link-sandbox-browser',expiration:'2026-09-09T20:00:00.000Z',request_id:'request-link'};
    if(path==='/item/public_token/exchange'){
      assert.equal(body.public_token,'public-sandbox-browser');
      return {access_token:accessToken,item_id:'synthetic-item',request_id:'request-exchange'};
    }
    assert.equal(body.access_token,accessToken);
    if(path==='/accounts/get')return {accounts:[
      {account_id:'brokerage-account',type:'investment',subtype:'brokerage',balances:{current:1005}},
      {account_id:'checking-account',type:'depository',subtype:'checking'},
    ],item:{institution_id:'synthetic-institution'},request_id:'request-accounts'};
    if(path==='/investments/holdings/get')return {
      holdings:[
        {account_id:'brokerage-account',security_id:'security-one',quantity:10,institution_value:900},
        {account_id:'brokerage-account',security_id:'security-two',quantity:1,institution_value:100},
        {account_id:'brokerage-account',security_id:'cash',quantity:5,institution_value:5},
      ],
      securities:[
        {security_id:'security-one',ticker_symbol:'SBSI',type:'equity'},
        {security_id:'security-two',ticker_symbol:'EWZ',type:'etf'},
        {security_id:'cash',ticker_symbol:null,type:'cash'},
      ],request_id:'request-holdings'};
    if(path==='/investments/transactions/get'){
      assert.equal(body.start_date,'2026-06-11');assert.equal(body.end_date,'2026-09-09');
      const rows=[
        {account_id:'brokerage-account',security_id:'security-one',type:'buy',amount:500},
        {account_id:'brokerage-account',security_id:'security-two',type:'sell',amount:-200},
        {account_id:'brokerage-account',security_id:'security-one',type:'cash',amount:-3},
        {account_id:'checking-account',security_id:'security-one',type:'buy',amount:999},
      ];
      const offset=Number((body.options as {offset:number}).offset);
      return {investment_transactions:rows.slice(offset,offset+2),total_investment_transactions:rows.length,securities:[],request_id:'request-transactions'};
    }
    if(path==='/item/remove')return {removed:true,request_id:'request-remove'};
    throw new Error(`Unexpected synthetic Plaid path: ${path}`);
  };
  return {calls,transport};
}

test('browser: simulated research market loop from upload through exact consent and settlement',{timeout:90_000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thot-market-browser-'));
  const plaid=syntheticPlaid();
  const cleanup:Array<()=>Promise<unknown>>=[];
  t.after(async()=>{try{for(const close of cleanup.reverse())await close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const app=await createApplication({dataDir,config:{clock:()=>new Date(instant)},plaid:{clientId:'synthetic-client',secret:'synthetic-secret',environment:'sandbox',transport:plaid.transport}});
  cleanup.push(()=>app.close());
  const server=createHttpServer(app);
  cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const browser=await chromium.launch({headless:true,executablePath:process.env.THOT_E2E_BROWSER??'/usr/bin/chromium'});
  cleanup.push(()=>browser.close());
  const context=await browser.newContext();
  await context.route('https://cdn.plaid.com/link/v2/stable/link-initialize.js',route=>route.fulfill({
    contentType:'application/javascript',
    body:`window.Plaid={create(options){return {open(){setTimeout(()=>options.onSuccess('public-sandbox-browser',{institution:{name:'Synthetic Test Institution'}}),0)}}}};`,
  }));
  const page=await context.newPage();page.setDefaultTimeout(15_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const history=Buffer.from([
    {type:'user',sessionId:'synthetic-market-e2e',cwd:'/synthetic/research',message:{role:'user',content:'Compare public filings and explain valuation assumptions for a fictional exercise.'}},
    {type:'assistant',sessionId:'synthetic-market-e2e',message:{role:'assistant',content:[{type:'text',text:'Separate reported results from hypothetical assumptions; this is synthetic research.'}]}},
  ].map(value=>JSON.stringify(value)).join('\n'));

  await page.goto(`http://127.0.0.1:${address.port}/app`);
  await page.locator('[data-action="import-research"]').waitFor();
  await page.locator('[data-action="import-research"]').click();
  await page.locator('#research-file').setInputFiles({name:'synthetic-research.jsonl',mimeType:'application/x-ndjson',buffer:history});
  const importPreview=page.waitForResponse(response=>response.url().endsWith('/v1/contributor/import/preview')&&response.request().method()==='POST');
  await page.locator('#research-preview-form button[type="submit"]').click();
  assert.equal((await importPreview).status(),200);
  assert.equal(await page.locator('#detail-dialog').getAttribute('open'),'');
  await page.getByRole('heading',{name:'Review conversation'}).waitFor();
  await page.getByText('Prepare for a sale later (optional)',{exact:true}).click();
  await page.locator('#research-rights').check();
  await page.locator('#research-license').check();
  await page.locator('#confirm-research').click();
  await page.locator('#confirm-research').waitFor({state:'hidden'});
  await page.locator('nav [data-view="market"]').click();
  await page.locator('.portfolio-card').waitFor();

  const plaidComplete=page.waitForResponse(response=>response.url().includes('/v1/contributor/plaid/link-jobs/')&&response.url().endsWith('/complete'));
  await page.getByRole('button',{name:/Try Plaid sandbox/}).click();
  assert.equal((await plaidComplete).status(),200);
  await page.getByText('Plaid Sandbox: a test institution, not a real account.').waitFor();
  await page.getByText('Connected',{exact:true}).waitFor();
  assert.deepEqual(plaid.calls.map(call=>call.path),['/link/token/create','/item/public_token/exchange','/accounts/get','/investments/holdings/get','/investments/transactions/get','/investments/transactions/get']);
  const owner=await app.db.transaction(tx=>tx.get('users',demoUser.id,demoUser.id));
  assert.ok(owner.plaid_item?.ref,'The linked Item remains encrypted for credential refresh.');

  await page.getByRole('button',{name:/See research offer/}).click();
  await page.locator('#detail-dialog').getByText(/simulated research offer/i).waitFor();
  await page.getByRole('button',{name:/Create simulated offer/}).click();
  const offer=page.locator('.candidate-card');await offer.waitFor();
  assert.match(await offer.innerText(),/Research Flow/i);assert.match(await offer.innerText(),/\$100\.00/);
  await offer.getByRole('button',{name:/Review release & license/}).click();
  const release=page.getByLabel('Exact authorized release JSON');await release.waitFor();
  assert.match(await release.innerText(),/controls_brokerage/);
  assert.doesNotMatch(await release.innerText(),/SBSI|EWZ|brokerage-account|1005/);
  assert.equal(await page.locator('#approve-sale').isDisabled(),true);
  await page.locator('#sale-consent').check();
  const authorization=page.waitForResponse(response=>response.url().endsWith('/v1/sale-authorizations')&&response.request().method()==='POST');
  await page.locator('#approve-sale').click();assert.equal((await authorization).status(),200);

  const worker=page.waitForResponse(response=>response.url().endsWith('/v1/dev/run-worker')&&response.request().method()==='POST');
  await page.locator('.section-head [data-action="worker"]').click();assert.equal((await worker).status(),200);
  await page.locator('[data-view="earnings"]').click();
  await page.getByText('$65.00 demo allocation',{exact:true}).waitFor();
  await page.getByRole('button',{name:/Inspect allocation record/}).click();
  const receipt=page.locator('#detail-dialog');
  assert.match(await receipt.innerText(),/6500/);assert.match(await receipt.innerText(),/2000/);assert.match(await receipt.innerText(),/1500/);

  const earnings=await app.service.earnings(demoUser);
  assert.equal(earnings.settlements.length,1);assert.equal(earnings.entitlements.length,1);
  assert.deepEqual([earnings.settlements[0]!.contributor_minor,earnings.settlements[0]!.burn_minor,earnings.settlements[0]!.operator_minor],['6500','2000','1500']);
  assert.deepEqual(errors,[]);
});
