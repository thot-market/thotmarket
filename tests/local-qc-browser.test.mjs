import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';

test('contributor grants and revokes a local review through the real browser',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'local-qc-browser-')),app=await createApplication({memory:true,dataDir:dir});
 const owner={id:'demo-user',role:'user'},operator={id:'reviewer',role:'operator_security'};
 const input={filename:'synthetic.jsonl',text:[{type:'user',message:{role:'user',content:'Compare synthetic queue designs.'}},{type:'assistant',message:{role:'assistant',content:'Bound the queue and test recovery before choosing.'}}].map(v=>JSON.stringify(v)).join('\n')};
 const preview=app.portfolio.preview(owner,input),saved=await app.portfolio.import(owner,randomUUID(),{...input,content_commitment:preview.content_commitment,rights_confirmed:true,model_output_licensed:true});
 const server=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.close();await rm(dir,{recursive:true,force:true});});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/app');
 await page.locator('[data-action="library-open"]').first().click();
 await page.getByRole('button',{name:'Allow review of this version',exact:true}).click();
 await page.getByRole('button',{name:'Stop future review downloads',exact:true}).waitFor();
 const exported=await app.qc.exportForReview(operator,saved.trace_id);assert.equal(exported.selected_source.scope,'release');
 const output=resolve('work/local-qc-browser');await mkdir(output,{recursive:true});
 await page.screenshot({path:join(output,'review-consent.png'),fullPage:true});
 await page.getByRole('button',{name:'Stop future review downloads',exact:true}).click();
 await page.getByRole('button',{name:'Allow review of this version',exact:true}).waitFor();
 await assert.rejects(app.qc.exportForReview(operator,saved.trace_id),/QC_REVIEW_CONSENT_REQUIRED/);
 assert.deepEqual(errors,[]);
});

test('operator downloads a usable QC-only connection through the browser',async t=>{
 const {Wallet}=await import('ethers'),{WalletAuth}=await import('../packages/auth/src/wallet.ts'),{request}=await import('node:http'),{readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'qc-connection-browser-')),app=await createApplication({memory:true,dataDir:dir});
 const wallet=Wallet.createRandom(),origin='https://qc.example.test',auth=await WalletAuth.create(app.db,{schema_version:'thot.wallet-auth/1',origin,chain_id:46630,allow_public_signup:true,operator_addresses:[wallet.address]});
 const challenge=await auth.challenge({address:wallet.address,chain_id:46630},origin);
 const login=await auth.verify({id:challenge.body.id,message:challenge.body.message,signature:await wallet.signMessage(challenge.body.message)},origin,challenge.set_cookie.split(';')[0]);
 const cookie=login.set_cookies[0].split(';')[0],server=createHttpServer(app,{externalAuth:auth,publicOrigin:origin});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.close();await rm(dir,{recursive:true,force:true});});
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.addCookies([{name:cookie.split('=')[0],value:cookie.split('=')[1],url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
 await context.addInitScript(address=>{window.ethereum={isMetaMask:true,request:async({method})=>{if(method==='eth_accounts')return[address];if(method==='eth_chainId')return'0xb626';throw Error('No signing in connection test');},on(){},removeListener(){}};},wallet.address);
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
  const response=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:url.pathname+url.search,method:route.request().method(),headers:{...route.request().headers(),host:url.host,origin}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([k])=>!['transfer-encoding','connection','set-cookie'].includes(k))),body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(route.request().postDataBuffer());});
  await route.fulfill(response);
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/ops');await page.getByRole('button',{name:'Connect local QC',exact:true}).waitFor();
 const out=resolve('work/local-qc-browser');await mkdir(out,{recursive:true});await page.screenshot({path:join(out,'operator-qc.png'),fullPage:true});
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Connect local QC',exact:true}).click();
 const download=await downloading,config=JSON.parse(await readFile(await download.path(),'utf8'));
 assert.equal(config.origin,origin);assert.equal(config.scope,'local_qc');assert.equal((await auth.authenticate(config.token)).scope,'local_qc');
 const session=await auth.authenticate(config.token);await auth.revoke(session.identity,session.actor,'synthetic-browser-revoke');
 await assert.rejects(auth.authenticate(config.token));assert.deepEqual(errors,[]);
});
