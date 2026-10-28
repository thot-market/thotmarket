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
const libraryItem={trace_id:'synthetic-trace-000001',title:'My private synthetic conversation',source:'Codex',state:'IMPORTED',origin:'upload',turn_count:2,created_at:'2026-01-01T00:00:00Z',sale_eligibility:{can_list:true,reason_code:'EXPLICIT_AUTOMATIC_SALE_CONSENT_REQUIRED'}};
const library={items:[libraryItem],summary:{saved:1,added_week:0,recording:0,bookmarked:0},total_matches:1,attempts:[],refreshed_at:'2026-01-01T00:00:00Z'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
let browser;
before(async()=>{
 assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must name Chromium');
 browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});

async function fixture(t,{holdCatalog=false,failWorkspace=false,remembered='vault',role='user',listingCount=1,checkout=false,failPrepareAt=0}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const listings=Array.from({length:listingCount},(_,i)=>({...listing,id:i?'synthetic-listing-'+i:listing.id,title:i?'Synthetic research comparison '+(i+1):listing.title}));
 page.setDefaultTimeout(15000);
 const chain=deferred(),catalog=deferred(),requests=[],errors=[];
 let revoked=false,failed=failWorkspace,prepareCalls=0;
 t.after(async()=>{chain.resolve();catalog.resolve();await context.close();});
 page.on('pageerror',e=>errors.push(e.message));
 t.after(()=>assert.deepEqual(errors,[]));
 await context.addInitScript(({wallet,remembered,checkout})=>{
   window.fixturePayments=[];
   const listeners=new Map();
   window.ethereum={isMetaMask:true,request:async p=>{
     if(p.method==='eth_accounts'||p.method==='eth_requestAccounts')return[wallet];if(p.method==='eth_chainId')return'0x7a69';
     if(checkout){if(p.method==='eth_call')return '0x';const h='0x'+'9'.repeat(64);if(p.method==='eth_sendTransaction'){window.fixturePayments.push(p.params[0]);return '0x'+String(window.fixturePayments.length).padStart(64,'0');}if(p.method==='eth_blockNumber')return '0x20';if(p.method==='eth_getBlockByNumber')return {hash:h};if(p.method==='eth_getTransactionReceipt')return {status:'0x1',transactionHash:p.params[0],blockNumber:'0x10',blockHash:h};if(p.method==='eth_getTransactionByHash')return null;}
     throw Error('Unexpected wallet request in catalogue fixture');
   },on(event,fn){listeners.set(event,fn);},removeListener(event){listeners.delete(event);}};
   window.fixtureAccountChange=()=>listeners.get('accountsChanged')?.(['0x0000000000000000000000000000000000000003']);
   if(!sessionStorage.getItem('fixture-initialized')){
     sessionStorage.setItem('thot.workspace-view.v1',JSON.stringify({actor:'synthetic-reader',role:'user',view:remembered}));
     sessionStorage.setItem('fixture-initialized','yes');
   }
 },{wallet,remembered,checkout});
 await context.route('**/*',async route=>{
   const u=new URL(route.request().url()),path=u.pathname;
   if(u.origin!==origin)return route.abort();
   const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(body)});
   if(path.startsWith('/v1/')){
     requests.push({path,search:u.search,method:route.request().method()});
     if(path==='/v1/auth/capabilities')return send({mode:'wallet_siwe',wallet:{chain_id:31337,rpc_url:origin+'/rpc'}});
     if(path==='/v1/auth/session')return send(revoked?{}:{actor:{id:'synthetic-reader',role},wallet_address:wallet,chain_id:31337},revoked?401:200);
     if(path==='/v1/auth/session/revoke'){revoked=true;return send({});}
     if(path==='/v1/thot/catalog'){if(holdCatalog)await catalog.promise;return send({...catalogue,listings});}
     if(path==='/v1/thot/workspace'){await chain.promise;return send(failed?{error:'THOT_UNAVAILABLE'}:{...workspace,account:{...workspace.account,balance:'100000000000000000000'},listings,workspace_scope:u.searchParams.get('scope')??'full'},failed?400:200);}
     if(path==='/v1/thot/offers/prepare'&&checkout){if(++prepareCalls===failPrepareAt)return send({error:'THOT_DAILY_PREPARATION_LIMIT'},429);const i=listings.findIndex(l=>l.id===route.request().postDataJSON().listing_id);assert(i>=0);return send({id:'0x'+String(i+10).padStart(64,'0'),wallet,seller,buyer_total:'1000000000000000000',transactions:[{to:seller,data:'0xaaaa',value:'0x0',chainId:'0x7a69'}]});}
     if(path==='/v1/money/capabilities')return send({mode:'mock'});
     if(path==='/v1/earnings')return send({entitlements:[],settlements:[],burn_allocations:[]});
     if(path==='/v1/contributor/portfolio')return send({items:[],robinhood:{status:'not_linked'}});
     if(path==='/v1/contributor/library')return send(library);
     if(path==='/v1/contributor/library/'+libraryItem.trace_id)return send({...libraryItem,note:'',events:[],model_history:[],capture_segments:[],content:{turns:[{role:'user',content:'Private synthetic question'},{role:'assistant',content:'Private synthetic response'}]}});
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
 assert.doesNotMatch(await f.page.locator('main').innerText(),/No purchases|Save an item in your private library first/);
 await card(f.page).locator('summary').filter({hasText:'License'}).click();
 await f.snapshot('catalogue-before-account');
 const beforeTop=await card(f.page).evaluate(e=>e.getBoundingClientRect().top);
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/catalog').length,1);
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/workspace').length,1);
 f.release();await ready(f.page).waitFor();assert.equal(await ready(f.page).isEnabled(),true);
 assert.equal(await card(f.page).locator('details').filter({has:f.page.locator('summary',{hasText:'License'})}).getAttribute('open'),'');
 assert.equal(await card(f.page).locator('summary').filter({hasText:'License'}).evaluate(e=>e===document.activeElement),true);
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
 // Signed out on the market route, the buyer sign-in state answers (#83).
 await f.page.getByRole('heading',{name:/Sign in with your wallet/}).waitFor();
 assert.equal(await f.page.title(),'Marketplace · thot market');
 f.release();await f.page.waitForTimeout(100);
 assert.equal(await card(f.page).count(),0);assert.equal(await ready(f.page).count(),0);
});

test('wallet change discards late catalogue and account responses',async t=>{
 const f=await fixture(t,{holdCatalog:true});await f.open();
 await f.page.locator('[data-action="identity-sign-out"]').waitFor({state:'attached'});
 await f.page.evaluate(()=>window.fixtureAccountChange());
 await f.page.getByRole('heading',{name:/Sign in with your wallet/}).waitFor();
 f.releaseCatalog();f.release();await f.page.waitForTimeout(100);
 assert.equal(await card(f.page).count(),0);
 assert.equal(await f.page.locator('#wallet-summary').isVisible(),false);
});

test('My data is readable while chain data waits and never presents pending sale state as private or zero',async t=>{
 const f=await fixture(t);await f.open('');
 await f.page.getByRole('button',{name:libraryItem.title,exact:true}).waitFor();
 assert.match(await f.page.locator('#wallet-summary').innerText(),/Loading balance/);
 assert.match(await f.page.locator('.library-row').innerText(),/Sale status loading/);
 assert.equal(await f.page.locator('[data-action="thot-list-configure"]').count(),0);
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/workspace'&&r.search==='?scope=buyer').length,1);
 await f.page.getByRole('button',{name:'Add work'}).click();
 await f.page.locator('#detail-dialog [data-action="journey-local"][data-client="codex"]').click();
 await f.page.getByRole('button',{name:/Daily history uploads/}).click();
 await f.page.getByRole('heading',{name:'Upload Codex history daily'}).waitFor();
 await f.page.locator('#detail-dialog [data-action="close-dialog"]').click();
 await f.page.getByRole('button',{name:'Add work'}).click();
 await f.page.locator('#detail-dialog [data-action="journey-local"][data-client="claude"]').click();
 await f.page.getByRole('button',{name:/Import a conversation/}).click();
 await f.page.locator('#research-file').waitFor();
 await f.page.locator('#detail-dialog [data-action="close-dialog"]').first().click();
 await f.page.getByRole('button',{name:libraryItem.title,exact:true}).click();
 await f.page.getByText('Private synthetic response',{exact:true}).waitFor();
 assert.equal(await f.page.locator('[data-action="thot-list-configure"]').count(),0);
 await f.snapshot('library-before-account');
 f.release();await f.page.locator('.library-row [data-action="thot-list-configure"]').waitFor();
 assert.equal(await f.page.getByText('Private synthetic response',{exact:true}).isVisible(),true,'account readiness must not close a private reader');
 assert.equal(f.requests.filter(r=>r.method!=='GET').length,0);
});

test('My data navigation loads contributor records without repeating the market wallet snapshot',async t=>{
 const f=await fixture(t);await f.open();f.release();await ready(f.page).waitFor();
 assert.equal(f.requests.some(r=>r.path.startsWith('/v1/contributor/')),false);
 await f.page.getByRole('button',{name:'My data',exact:true}).click();
 await f.page.getByRole('button',{name:libraryItem.title,exact:true}).waitFor();
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/workspace').length,1);
 assert.equal(f.requests.filter(r=>r.path==='/v1/contributor/library').length,1);
 assert.equal(f.requests.some(r=>r.path==='/v1/traces'||r.path==='/v1/contributor/portfolio'),false,'My data does not load the separate listing and legacy portfolio payloads');
 await f.page.locator('.journey-menu>summary').click();await f.page.getByRole('button',{name:'Manage THOT',exact:true}).click();
 await f.page.waitForFunction(()=>document.title==='THOT · thot market');
 assert.equal(f.requests.filter(r=>r.path==='/v1/thot/workspace'&&r.search==='').length,1,'full token view upgrades the reduced response');
});

test('chain failure leaves the private library usable and account changes clear it',async t=>{
 const f=await fixture(t,{failWorkspace:true});await f.open('');
 await f.page.getByRole('button',{name:libraryItem.title,exact:true}).waitFor();f.release();
 await f.page.getByText('Balance unavailable',{exact:true}).waitFor();
 assert.equal(await f.page.getByRole('button',{name:libraryItem.title,exact:true}).isVisible(),true);
 assert.equal(await f.page.locator('[data-action="thot-list-configure"]').count(),0);
 await f.page.evaluate(()=>window.fixtureAccountChange());
 await f.page.getByRole('heading',{name:'Sign in with your wallet.'}).waitFor();
 assert.equal(await f.page.getByRole('button',{name:libraryItem.title,exact:true}).count(),0);
});

test('primary navigation has one active destination and Purchases opens purchase history',async t=>{
 const f=await fixture(t);f.release();await f.page.goto(origin+'/app#thot-available');
 await f.page.locator('.thot-listing').first().waitFor();
 await f.page.locator('.journey-nav [data-view="receipts"]').click();
 await f.page.getByRole('heading',{name:'Purchases',exact:true}).waitFor();
 assert.equal(await f.page.locator('.journey-nav [aria-current="page"]').count(),1);
 assert.equal(await f.page.locator('.journey-nav [aria-current="page"]').getAttribute('data-view'),'receipts');
 assert.equal(await f.page.locator('#thot-buyer-purchases').isVisible(),true);
 await f.page.reload();await f.page.getByRole('heading',{name:'Purchases',exact:true}).waitFor();
 assert.equal(new URL(f.page.url()).hash,'#receipts');
 await f.page.setViewportSize({width:390,height:844});
 assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await f.page.locator('.journey-nav [data-view="market"]').click();
 await f.page.locator('.thot-listing').first().waitFor();
 assert.equal(await f.page.locator('.journey-nav .active').count(),1);
});

 test('buyer purchase route survives reload before workspace capabilities arrive',async t=>{
 const f=await fixture(t,{role:'buyer_admin'});f.release();await f.page.goto(origin+'/app#receipts');
 await f.page.getByRole('heading',{name:'Purchases',exact:true}).waitFor();
 await f.page.reload();await f.page.getByRole('heading',{name:'Purchases',exact:true}).waitFor();
 assert.equal(new URL(f.page.url()).hash,'#receipts');
 });


test('marketplace uses compact aligned rows with expandable terms on desktop and usable mobile actions',async t=>{
 const f=await fixture(t,{listingCount:10});await f.open();f.release();await ready(f.page).waitFor();
 const rows=f.page.locator('.thot-listing');assert.equal(await rows.count(),10);
 const first=await rows.nth(0).boundingBox(),second=await rows.nth(1).boundingBox();
 assert(first.height<110,'collapsed listing stays under 110px');assert.equal(first.x,second.x);
 assert(Math.abs(first.y+first.height-second.y)<2,'directory rows have no card gaps');
 assert.equal(await rows.nth(0).locator('details').getAttribute('open'),null);
 await f.snapshot('marketplace-directory-desktop');
 await rows.nth(0).locator('summary').click();assert(await rows.nth(0).getByText(listing.license,{exact:true}).isVisible());
 assert.equal(await rows.nth(1).locator('details').getAttribute('open'),null);
 await rows.nth(0).locator('summary').click();
 await f.page.setViewportSize({width:390,height:844});
 assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const action=await ready(f.page).boundingBox();assert(action.width>=44&&action.height>=44);
 await f.snapshot('marketplace-directory-mobile');
 assert.equal(f.requests.filter(r=>r.method!=='GET').length,0);
});


test('cart reviews two items once and drives sequential wallet payments without returning to the catalogue',async t=>{
 const f=await fixture(t,{listingCount:2,checkout:true});await f.open();f.release();await ready(f.page).waitFor();
 const add=f.page.locator('[data-action="thot-cart-toggle"]');await add.nth(0).click();await add.nth(1).click();
 await f.page.reload({waitUntil:'domcontentloaded'});await ready(f.page).waitFor();assert.equal(await add.nth(0).getAttribute('aria-pressed'),'true');
 await f.page.getByRole('button',{name:'Cart (2)',exact:true}).click();await f.page.getByRole('button',{name:'Review checkout',exact:true}).click();
 await f.page.getByRole('button',{name:'Pay 2 THOT',exact:true}).waitFor();assert.equal(await f.page.evaluate(()=>window.fixturePayments.length),0);await f.snapshot('cart-review');
 await f.page.getByRole('button',{name:'Pay 2 THOT',exact:true}).click();await f.page.getByRole('heading',{name:'Checkout complete',exact:true}).waitFor().catch(async e=>{await f.snapshot('cart-error');throw new Error(await f.page.locator('#detail-dialog').innerText(),{cause:e});});
 assert.equal(await f.page.evaluate(()=>window.fixturePayments.length),2);assert.equal(await add.nth(0).getAttribute('aria-pressed'),'false');
 await f.snapshot('cart-complete');await f.page.getByRole('button',{name:'View purchases',exact:true}).click();await f.page.getByRole('heading',{name:'Purchases',exact:true}).waitFor();assert.equal(await f.page.locator('#detail-dialog').evaluate(d=>d.open),false);
});


test('twenty-item checkout exposes a preparation failure by its button and retries successfully',async t=>{
 const f=await fixture(t,{listingCount:20,checkout:true,failPrepareAt:11});await f.open();f.release();await ready(f.page).waitFor();
 const add=f.page.locator('[data-action="thot-cart-toggle"]');for(let i=0;i<20;i++)await add.nth(i).click();
 await f.page.getByRole('button',{name:'Cart (20)',exact:true}).click();
 const review=f.page.getByRole('button',{name:'Review checkout',exact:true});await review.click();
 await f.page.locator('#cart-checkout-status[role="alert"]').waitFor();assert.match(await f.page.locator('#cart-checkout-status').innerText(),/limit/);
 assert(await review.isEnabled());const bounds=await review.boundingBox();assert(bounds.y>=0&&bounds.y+bounds.height<=1000);await f.snapshot('cart-limit-feedback');await review.click();
 await f.page.getByRole('button',{name:'Pay 20 THOT',exact:true}).waitFor();assert.equal(await f.page.evaluate(()=>window.fixturePayments.length),0);
 await f.snapshot('cart-twenty-review');
});
