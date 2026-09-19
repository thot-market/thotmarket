import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {deployMoneyFixture} from '../../scripts/anvil-money-fixture.mjs';
import {createApplication} from '../../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../../apps/api/server.ts';
import {demoUser,demoBuyer,demoSettlement,policyInput} from '../../packages/market/src/fixtures.ts';

function observeRecorder(child) {
  let spawnError;
  const done=new Promise(resolve=>{
    child.once('error',error=>{spawnError=error;resolve({error});});
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  // A recorder that exits early may close stdin before the final q is written.
  child.stdin.on('error',()=>{});
  const within=async ms=>{let timer;try{return await Promise.race([done,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}finally{clearTimeout(timer);}};
  return async()=>{
    if(!spawnError&&child.exitCode===null&&child.signalCode===null&&!child.stdin.destroyed)child.stdin.write('q',()=>{});
    let result=await within(5000);
    if(!result){child.kill('SIGTERM');result=await within(1000);}
    if(!result){child.kill('SIGKILL');result=await within(1000);}
    if(!result)throw Error('Recording process did not close after SIGKILL');
    if(result.error)throw result.error;
    if(result.code!==0)throw Error(`Recording process exited with ${result.signal??result.code}`);
  };
}

test('recorded browser journey: create and fund a buy order, approve uploaded history, pay and download',{timeout:420000},async t=>{
  const output=resolve(process.env.THOT_MONEY_REPORT_DIR??'work/anvil-money/browser');await mkdir(output,{recursive:true});
  const fixture=await deployMoneyFixture({outputDir:output});
  const dataDir=await mkdtemp(join(tmpdir(),'thot-money-browser-'));
  let app,server,browser,displayProcess,recorderStop;const contexts=[];
  async function stopRecording(){if(!recorderStop)return;const stop=recorderStop;recorderStop=null;await stop();}

  t.after(async()=>{
    const failures=[];
    for(const close of [stopRecording,...contexts.map(c=>()=>c.close()),()=>browser?.close(),()=>displayProcess?.kill('SIGTERM'),()=>server&&new Promise(r=>{server.closeAllConnections();server.close(r);}),()=>app?.close(),()=>fixture.close(),()=>rm(dataDir,{recursive:true,force:true})]){
      try{await close();}catch(error){failures.push(error);}
    }
    if(failures.length)throw new AggregateError(failures,'Browser journey cleanup failed');
  });
  app=await createApplication({dataDir,config:{anvil:fixture.config,tokenEnabled:true}});
  await app.service.createPolicy(demoUser,'browser-policy',policyInput(app.service));
  server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const useX11=process.platform==='linux';let display;
  if(useX11){
    displayProcess=spawn('Xvfb',['-displayfd','3','-screen','0','1360x1024x24','-nolisten','tcp'],{stdio:['ignore','ignore','pipe','pipe']});
    display=':'+await new Promise((resolve,reject)=>{displayProcess.stdio[3].once('data',b=>resolve(b.toString().trim()));displayProcess.once('error',reject);});
  }
  browser=await chromium.launch({headless:!useX11,executablePath:process.env.THOT_E2E_BROWSER??(useX11?'/usr/bin/chromium':undefined),env:{...process.env,...(display?{DISPLAY:display}:{})},args:['--window-size=1360,1024','--window-position=0,0']});
  const errors=[],walletCalls=[];
  const dwell=ms=>new Promise(r=>setTimeout(r,ms));
  async function chapter(name,role,account) {
    const context=await browser.newContext({viewport:{width:1280,height:880},acceptDownloads:true,...(!useX11?{recordVideo:{dir:output,size:{width:1280,height:880}}}:{})});contexts.push(context);
    // Only the wallet transport and development identities are preconfigured.
    // Every transaction is estimated, signed and executed by the isolated Anvil
    // node. No API response, matching outcome or contract result is stubbed.
    await context.exposeBinding('anvilWalletRequest',async(_source,{method,params=[]})=>{
      walletCalls.push({chapter:name,method});
      if(['eth_requestAccounts','eth_accounts'].includes(method))return [account];
      if(method==='eth_chainId')return '0x7a69';
      if(method==='eth_getTransactionReceipt')return fixture.provider.send(method,params);
      const signer=await fixture.provider.getSigner(account);
      if(method==='eth_sendTransaction'){
        assert.equal(params[0].from.toLowerCase(),account.toLowerCase());
        const transaction=await signer.sendTransaction(params[0]);return transaction.hash;
      }
      if(method==='eth_signTypedData_v4'){
        assert.equal(params[0].toLowerCase(),account.toLowerCase());const typed=JSON.parse(params[1]);delete typed.types.EIP712Domain;
        return signer.signTypedData(typed.domain,typed.types,typed.message);
      }
      throw new Error('Unexpected test-wallet method: '+method);
    });
    await context.addInitScript(()=>{window.ethereum={request:args=>window.anvilWalletRequest(args)};});
    const page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/app');await page.locator('[data-testid="anvil-mode"]').waitFor();
    if(role!=='user'){await page.locator('#role').selectOption(role);await page.getByRole('heading',{name:'Ask for the work you need.'}).waitFor();}
    if(useX11){
      const recorder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-f','x11grab','-framerate','12','-video_size','1360x1024','-i',display,'-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart','-y',join(output,name+'.mp4')],{stdio:['pipe','ignore','pipe']});
      recorderStop=observeRecorder(recorder);
      recorder.stderr.on('data',b=>console.log('recording:',b.toString()));
    }
    return {page,context,name,finish:async()=>{await page.screenshot({path:join(output,name+'-final.png')});await stopRecording();await context.close();if(!useX11){await page.video().saveAs(join(output,name+'.webm'));await page.video().delete();}}};
  }
  const order=await chapter('01-fund-order','buyer_admin',fixture.accounts.buyer),p=order.page;
  await dwell(2500);
  await p.getByRole('button',{name:'Draft custom mandate +'}).click();
  await p.locator('#draft-currency').selectOption('USDC');
  await p.locator('#draft-unit_price').fill('100');await p.locator('#draft-total_budget').fill('100');await p.locator('#draft-max_units').fill('1');
  await p.locator('[name="workflow_types"][value="coding"]').uncheck();
  await p.locator('[name="workflow_types"][value="investment_research"]').check();
  await p.locator('[name="funding_mode"]').selectOption('onchain_escrow');
  await p.locator('#draft-unit_price').scrollIntoViewIfNeeded();await dwell(4000);
  await p.locator('#draft-save').click();await p.locator('#draft-save').waitFor({state:'hidden'});
  const mandates=await app.service.mandates(demoBuyer);assert.equal(mandates.length,1);const mandate=mandates[0];
  await p.getByRole('button',{name:'Fund with your wallet ↗'}).click();await dwell(4000);
  const funding=p.waitForResponse(r=>r.url().endsWith('/fund')&&r.request().postDataJSON()?.transaction_hash);
  await p.getByRole('button',{name:'Approve & deposit test dollars'}).click();assert.equal((await funding).status(),200);
  await p.getByRole('button',{name:'Activate matching ↗'}).waitFor();await dwell(3000);
  await p.getByRole('button',{name:'Activate matching ↗'}).click();await p.getByRole('button',{name:'Pause matching'}).waitFor();await dwell(3000);await order.finish();
  const upload=await chapter('02-upload-approve-paid','user',fixture.accounts.contributor),u=upload.page;
  const history=Buffer.from([
    {type:'user',sessionId:'anvil-browser-demo',cwd:'/synthetic/demo',message:{role:'user',content:'Compare public filings and explain valuation assumptions for a fictional company. This is synthetic example data.'}},
    {type:'assistant',sessionId:'anvil-browser-demo',message:{role:'assistant',content:[{type:'text',text:'Separate reported revenue from assumptions. Compare base, low-growth and high-growth cases; these examples are not forecasts.'}]}},
  ].map(v=>JSON.stringify(v)).join('\n'));
  await dwell(2500);await u.locator('[data-action="import-research"]').click();
  await u.locator('#research-file').setInputFiles({name:'claude-code-synthetic-example.jsonl',mimeType:'application/x-ndjson',buffer:history});await dwell(2000);
  await u.locator('#research-preview-form button[type="submit"]').click();await u.getByRole('heading',{name:'Review conversation'}).waitFor();
  await u.locator('details:has(#research-rights) > summary').click();
  assert.equal(await u.locator('#research-license').isDisabled(),true);
  await u.locator('#research-rights').check();await u.locator('#research-license').check();await dwell(4500);
  const saved=u.waitForResponse(r=>r.url().endsWith('/v1/contributor/import/confirm')&&r.request().method()==='POST');
  await u.locator('#confirm-research').click();assert.equal((await saved).status(),200);await u.locator('#confirm-research').waitFor({state:'hidden'});
  const imported=await app.service.traces(demoUser);assert.equal(imported.length,1);
  await u.locator('nav [data-view="market"]').click();
  await u.getByRole('button',{name:'Refresh matching ↻'}).click();await u.locator('.candidate-card').waitFor();await dwell(3500);
  const candidates=await app.service.candidates(demoUser);assert.equal(candidates.length,1);const candidate=candidates[0];
  await u.getByRole('button',{name:'Review release & license ↗'}).click();
  await u.getByLabel('Exact authorized release JSON').waitFor();await dwell(4000);
  await u.locator('#sale-consent').scrollIntoViewIfNeeded();await dwell(2500);await u.locator('#sale-consent').check();
  await u.locator('#approve-sale').click();await u.getByRole('heading',{name:'Receive THOT for this release'}).waitFor();await dwell(6000);
  const authorization=u.waitForResponse(r=>r.url().endsWith('/v1/sale-authorizations')&&r.request().method()==='POST');
  await u.getByRole('button',{name:'Sign & authorize release'}).click();const authResponse=await authorization;assert.equal(authResponse.status(),200);const authorized=await authResponse.json();
  await u.getByRole('heading',{name:'Payment is still pending'}).waitFor();
  await assert.rejects(()=>app.service.delivery(demoBuyer,authorized.license_id),/PAYMENT_PENDING/);
  await dwell(4500);
  const before={supply:await fixture.thot.totalSupply(),contributor:await fixture.thot.balanceOf(fixture.accounts.contributor),operator:await fixture.payment.balanceOf(fixture.accounts.treasury)};
  const run=await app.service.runWorker();assert.equal(run.failed,0);
  await u.getByRole('button',{name:'Refresh payment status'}).click();await u.getByRole('heading',{name:'Payment complete'}).waitFor();await dwell(6500);
  await u.getByText('Verify transaction and commitments',{exact:true}).click();await u.getByLabel('Onchain settlement receipt').scrollIntoViewIfNeeded();await dwell(4000);await upload.finish();
  const delivery=await chapter('03-buyer-download','buyer_admin',fixture.accounts.buyer),b=delivery.page;
  await dwell(2500);await b.getByRole('button',{name:'View deliveries & budget ↗'}).click();await b.getByText('Paid · ready to download',{exact:true}).waitFor();await dwell(4500);
  await b.getByRole('button',{name:'Inspect release ↗'}).click();await b.getByRole('heading',{name:'Your licensed delivery'}).waitFor();await dwell(5000);
  const downloadPromise=b.waitForEvent('download');await b.getByRole('button',{name:'Download licensed bundle ↓'}).click();const download=await downloadPromise;await download.saveAs(join(output,'licensed-release.json'));
  const bytes=JSON.parse(await readFile(join(output,'licensed-release.json'),'utf8'));assert.equal(bytes.delivery.bundle_hash,candidate.release_hash);
  const receipt=await app.service.moneyPath.status(demoUser,authorized.license_id);assert.equal(receipt.status,'FINALIZED');
  assert.equal(before.supply-await fixture.thot.totalSupply(),BigInt(receipt.receipt.burned_thot_atoms));
  assert.equal(await fixture.thot.balanceOf(fixture.accounts.contributor)-before.contributor,BigInt(receipt.receipt.paid_thot_atoms));
  assert.equal(await fixture.payment.balanceOf(fixture.accounts.treasury)-before.operator,15000000n);
  await dwell(3500);await delivery.finish();
  assert.deepEqual(errors,[]);
  const evidence={passed:true,deployment:fixture.manifest,scope:fixture.manifest.scope+' Real browser and app. Synthetic Claude Code JSONL; preconfigured development accounts, manual policy and injected Anvil wallets. No Clerk signup, real Robinhood, live model call, public-chain deployment or MetaMask setup was tested in this run.',chapters:['01-fund-order','02-upload-approve-paid','03-buyer-download'],wallet_calls:walletCalls,mandate_id:mandate.mandate_id,license_id:authorized.license_id,release_hash:bytes.delivery.bundle_hash,receipt:receipt.receipt,console_errors:errors,reconciliation:await app.service.reconciliation(demoSettlement)};
  await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
});
