import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Actual dashboard modules and DOM, synthetic API responses only. A controlled
// barrier proves catalogue visibility is independent of account/RPC completion.
const origin='https://market.example.test';
const wallet='0x0000000000000000000000000000000000000001';
const seller='0x0000000000000000000000000000000000000002';
const cap={mode:'thot-anvil',chain_id:31337,test_assets:true,production_enabled:false,automatic_sales:true,confirmations:1,dispute_seconds:43200};
const listing={id:'synthetic-listing',title:'Synthetic deployment comparison',seller,price_atoms:'1000000000000000000',license:'Synthetic evaluation licence, 30 days.',automatic_sales:true,workflow:'research',turn_count:2,provenance:'P0_OPERATOR',capture_model:null};
const catalogue={capabilities:cap,wallet,listings:[listing]};
const workspace={...catalogue,market_paused:false,reserve_buyer:false,account:{balance:'10000000000000000000',claimable:'0'},orders:[],own_listings:[],valuations:[],holder_rewards:null,staking:null};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
let browser;
before(async()=>{
 assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must name Chromium');
 browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});

async function fixture(t,{holdCatalog=false,failWorkspace=false,remembered='vault'}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const chain=deferred(),catalog=deferred(),requests=[],errors=[];
 let revoked=false,failed=failWorkspace;
 t.after(async()=>{chain.resolve();catalog.resolve();await context.close();});
 page.on('pageerror',e=>errors.push(e.message));
 t.after(()=>assert.deepEqual(errors,[]));
 await context.addInitScript(({wallet,remembered})=>{
   const listeners=new Map();
   window.ethereum={isMetaMask:true,request:async p=>{
     if(p.method==='eth_accounts')return[wallet];if(p.method==='eth_chainId')return'0x7a69';throw Error('No signing in catalogue fixture');
   },on(event,fn){listeners.set(event,fn);},removeListener(event){listeners.delete(event);}};
   window.fixtureAccountChange=()=>listeners.get('accountsChanged')?.(['0x0000000000000000000000000000000000000003']);
   if(!sessionStorage.getItem('fixture-initialized')){
     sessionStorage.setItem('thot.workspace-view.v1',JSON.stringify({actor:'synthetic-reader',role:'user',view:remembered}));
     sessionStorage.setItem('fixture-initialized','yes');
   }
 },{wallet,remembered});
 await context.route('**/*',async route=>{
   const u=new URL(route.request().url()),path=u.pathname;
   if(u.origin!==origin)return route.abort();
   const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(body)});
   if(path.startsWith('/v1/')){
     requests.push({path,method:route.request().method()});
     if(path==='/v1/auth/capabilities')return send({mode:'wallet_siwe',wallet:{chain_id:31337,rpc_url:origin+'/rpc'}});
     if(path==='/v1/auth/session')return send(revoked?{}:{actor:{id:'synthetic-reader',role:'user'},wallet_address:wallet,chain_id:31337},revoked?401:200);
     if(path==='/v1/auth/session/revoke'){revoked=true;return send({});}
     if(path==='/v1/thot/catalog'){if(holdCatalog)await catalog.promise;return send(catalogue);}
     if(path==='/v1/thot/workspace'){await chain.promise;return send(failed?{error:'THOT_UNAVAILABLE'}:workspace,failed?400:200);}
     if(path==='/v1/money/capabilities')return send({mode:'mock'});
     if(path==='/v1/earnings')return send({entitlements:[],settlements:[],burn_allocations:[]});
     if(path==='/v1/contributor/portfolio')return send({items:[],robinhood:{status:'not_linked'}});
     if(path==='/v1/contributor/library')return send({items:[],total:0});
     if(path==='/v1/inference/capabilities')return send({enabled:false});
     if(['/v1/traces','/v1/candidates','/v1/inference/requests'].includes(path))return send([]);
     return send({enabled:false,items:[]});
   }
   const relative=path==='/app'?'index.html':path.slice(1);
   if(!/^(?:[a-z0-9-]+\.(?:js|css)|index\.html|assets\/[a-z0-9-]+\.png|assets\/fonts\/[a-z0-9-]+\.woff2)$/.test(relative))return route.abort();
   try{
     const body=await readFile(new URL('../apps/'+(relative.startsWith('assets/')?'site/':'dashboard/')+relative,import.meta.url));
     return route.fulfill({status:200,contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.png')?'image/png':relative.endsWith('.woff2')?'font/woff2':'text/html',body});
   }catch{return route.fulfill({status:404,body:''});}
 });
 return {page,requests,release:()=>chain.resolve(),releaseCatalog:()=>catalog.resolve(),recover:()=>{failed=false;},
   async open(hash='#thot-available'){await page.goto(origin+'/app'+hash,{waitUntil:'domcontentloaded'});},
   async snapshot(name){if(process.env.THOT_MARKET_SCREENSHOTS){await mkdir(process.env.THOT_MARKET_SCREENSHOTS,{recursive:true});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:process.env.THOT_MARKET_SCREENSHOTS+'/'+name+'.png'});}},
 };
}
const card=page=>page.locator('.thot-listing').filter({hasText:listing.title});
const ready=page=>page.locator('[data-action="thot-buy"][data-id="synthetic-listing"]');

test('direct catalogue overrides remembered vault, renders before chain readiness, then restores after reload',async t=>{
 const f=await fixture(t);await f.open();await card(f.page).waitFor();
 assert.equal(await f.page.locator('nav [data-view="market"]').getAttribute('class').then(v=>v.includes('active')),true);
 assert.match(await f.page.locator('#wallet-summary').innerText(),/Loading balance/i);
 assert.match(await card(f.page).innerText(),new RegExp(seller));
 assert.equal(await ready(f.page).count(),0);
 assert.equal(await f.page.locator('[data-action="thot-send"],[data-action="thot-unlist"]').count(),0);
 assert.doesNotMatch(await f.page.locator('main').innerText(),/No purchases|Save a trace in your private library first/);
 await card(f.page).locator('summary').filter({hasText:'License'}).click();
 await f.snapshot('catalogue-before-account');
 const beforeTop=await card(f.page).evaluate(e=>e.getBoundingClientRect().top);
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/catalog').length,1);
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/workspace').length,1);
 f.release();await ready(f.page).waitFor();assert.equal(await ready(f.page).isEnabled(),true);
 assert.equal(await card(f.page).locator('details').getAttribute('open'),'');
 assert.equal(await card(f.page).locator('summary').evaluate(e=>e===document.activeElement),true);
 assert(Math.abs(await card(f.page).evaluate(e=>e.getBoundingClientRect().top)-beforeTop)<=2,'listing remains at the same viewport position');
 await f.snapshot('catalogue-ready');
 await f.page.reload({waitUntil:'domcontentloaded'});await ready(f.page).waitFor();
 assert.match(await f.page.locator('nav [data-view="market"]').getAttribute('class'),/active/);
 assert.equal(f.requests.filter(r=>r.method!=='GET').length,0);
});

test('partial marketplace fits a narrow viewport while chain data is pending',async t=>{
 const f=await fixture(t);await f.page.setViewportSize({width:390,height:844});await f.open();await card(f.page).waitFor();
 assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert(await card(f.page).locator('.thot-seller-address').evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
 await f.snapshot('catalogue-mobile');
});

test('workspace failure keeps listings visible and retry recovers without signing in again',async t=>{
 const f=await fixture(t,{failWorkspace:true});await f.open();await card(f.page).waitFor();f.release();
 await f.page.getByText('Balance unavailable',{exact:true}).waitFor();
 assert.equal(await card(f.page).isVisible(),true);assert.equal(await ready(f.page).count(),0);
 assert.equal(f.requests.filter(r=>r.path==='/v1/auth/session/revoke').length,0);
 await f.snapshot('catalogue-account-unavailable');
 f.recover();await f.page.locator('.journey-menu>summary').click();await f.page.getByRole('button',{name:'Refresh current view'}).click();await ready(f.page).waitFor();
 assert.equal(await ready(f.page).isEnabled(),true);
});

test('same-page fragment selects marketplace and late account response cannot restore signed-out content',async t=>{
 const f=await fixture(t);await f.open('');
 await f.page.locator('[data-action="identity-sign-out"]').waitFor({state:'attached'});
 await f.page.evaluate(()=>{location.hash='thot-available';});await card(f.page).waitFor();
 await f.page.locator('.journey-menu>summary').click();await f.page.locator('[data-action="identity-sign-out"]').click();
 await f.page.getByRole('heading',{name:'Sign in with your wallet.'}).waitFor();
 f.release();await f.page.waitForTimeout(100);
 assert.equal(await card(f.page).count(),0);assert.equal(await ready(f.page).count(),0);
});

test('wallet change discards late catalogue and account responses',async t=>{
 const f=await fixture(t,{holdCatalog:true});await f.open();
 await f.page.locator('[data-action="identity-sign-out"]').waitFor({state:'attached'});
 await f.page.evaluate(()=>window.fixtureAccountChange());
 await f.page.getByRole('heading',{name:'Sign in with your wallet.'}).waitFor();
 f.releaseCatalog();f.release();await f.page.waitForTimeout(100);
 assert.equal(await card(f.page).count(),0);
 assert.equal(await f.page.locator('#wallet-summary').isVisible(),false);
});
