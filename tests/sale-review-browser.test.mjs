import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Real dashboard modules in Chromium; synthetic API and a wallet whose
// signature prompt is an in-page overlay (the embedded-wallet shape). The
// prompt must be the topmost interactive element while it is open (#78), the
// review must name the exact signed commitments (#79/#80), and the finished
// listing must surface its public share URL (#97).
const origin='https://sale.example.test';
const wallet='0x0000000000000000000000000000000000000001';
const chainId=31337,disputeSeconds=43200;
const cap={mode:'thot-anvil',chain_id:chainId,test_assets:true,production_enabled:false,automatic_sales:true,confirmations:1,dispute_seconds:disputeSeconds,market:'0x0000000000000000000000000000000000000009'};
const contentHash='0x'+'7'.repeat(64);
const evidenceHash='0x'+'aa'.repeat(64),licenseHash='0x'+'bb'.repeat(64);
const typedData={domain:{name:'thot market',version:'1',chainId,verifyingContract:cap.market},types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],SaleAuthorization:[{name:'seller',type:'address'},{name:'evidenceHash',type:'bytes32'},{name:'licenseHash',type:'bytes32'},{name:'gross',type:'uint256'}]},primaryType:'SaleAuthorization',message:{seller:wallet,evidenceHash,licenseHash,gross:'100000000000000000000'}};
const libraryItem={trace_id:'synthetic-trace-000001',title:'My private synthetic conversation',source:'Codex',state:'IMPORTED',origin:'upload',turn_count:2,created_at:'2026-01-01T00:00:00Z',sale_eligibility:{can_list:true,reason_code:'EXPLICIT_AUTOMATIC_SALE_CONSENT_REQUIRED'}};
const library={items:[libraryItem],summary:{saved:1,added_week:0,recording:0,bookmarked:0},total_matches:1,attempts:[],refreshed_at:'2026-01-01T00:00:00Z'};
const prepared={id:'listing:018fsyntheticsharepage0000000001',public_path:'/l/018fsyntheticsharepage0000000001',content_kind:'trace',title:'Useful research',price_atoms:'100000000000000000000',license:'Non-exclusive evaluation licence, 30 days.',typed_data:typedData,created_at:'2026-10-25T00:00:00Z'};
const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return{promise,resolve,reject};};
let browser;
before(async()=>{
  assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must name Chromium');
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});

async function fixture(t,{authMode='wallet_siwe',privy=null}={}){
  const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage();
  const requests=[],errors=[];const signing=deferred();
  t.after(async()=>{await context.close();});
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await context.addInitScript(({wallet,chainId})=>{
    // An embedded-wallet-shaped provider: its prompt is an element in this page.
    window.fixtureSignature=()=>{
      const overlay=document.createElement('div');
      overlay.id='wallet-prompt';overlay.style.cssText='position:fixed;inset:0;z-index:2147483000;background:#082322cc;display:flex;align-items:center;justify-content:center';
      const box=document.createElement('div');box.style.cssText='width:312px;max-width:90vw;background:white;border-radius:12px;padding:18px';
      box.innerHTML='<h2>Confirm signature</h2><p id="wallet-prompt-message" style="overflow-wrap:anywhere">https://sale.example.test wants you to sign in with your Ethereum account: <code>'+wallet+'</code></p><button id="wallet-prompt-confirm">Confirm</button> <button id="wallet-prompt-cancel">Cancel</button>';
      overlay.appendChild(box);document.body.appendChild(overlay);
      overlay.querySelector('#wallet-prompt-confirm').addEventListener('click',()=>window.fixtureResolveSignature('0x'+'ab'.repeat(65)));
      overlay.querySelector('#wallet-prompt-cancel').addEventListener('click',()=>window.fixtureRejectSignature(Object.assign(new Error('User rejected'),{code:4001})));
    };
    window.ethereum={isMetaMask:false,request:async p=>{
      if(p.method==='eth_accounts'||p.method==='eth_requestAccounts')return [wallet];
      if(p.method==='eth_chainId')return '0x'+chainId.toString(16);
      if(p.method==='eth_signTypedData_v4'){window.fixtureDialogOpenAtRequest=!!document.querySelector('dialog[open]');window.fixtureSignature();return window.fixtureSignaturePromise;}
      throw Error('Unsupported method '+p.method);
    },on(){},removeListener(){}};
  },{wallet,chainId});
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url()),path=u.pathname;
    if(u.origin!==origin)return route.abort();
    const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(body)});
    if(path.startsWith('/v1/')){
      requests.push({path,method:route.request().method()});
      if(path==='/v1/auth/capabilities')return send({mode:authMode,wallet:{chain_id:chainId,rpc_url:origin+'/rpc'},...(privy?{privy}: {})});
      if(path==='/v1/auth/session')return send({actor:{id:'synthetic-seller',role:'user'},wallet_address:wallet,chain_id:chainId});
      if(path==='/v1/thot/workspace')return send({workspace_scope:'full',capabilities:cap,market_paused:false,wallet,account:{balance:'10000000000000000000',claimable:'0'},listings:[],own_listings:[],orders:[],valuations:[],holder_rewards:null,staking:null});
      if(path==='/v1/thot/catalog')return send({capabilities:cap,wallet,listings:[]});
      if(path==='/v1/money/capabilities')return send({mode:'mock'});
      if(path==='/v1/contributor/library')return send(library);
      if(path==='/v1/thot/listings/metadata')return send({trace_id:libraryItem.trace_id,content_hash:contentHash,rights_status:'READY',provenance:'P1_ATTESTED',capture_model:{evidence:'user_supplied',claimed_model:'glm-5.3'},trade_evidence:[]});
      if(path==='/v1/thot/listings/preview')return send({trace_id:libraryItem.trace_id,content_hash:contentHash,content:{turns:[{role:'user',content:'Private synthetic question'},{role:'assistant',content:'Private synthetic answer'}]},sale_eligibility:{can_list:true},exclusion:{supported:false},content_kind:'trace'});
      if(path==='/v1/thot/listings')return send(prepared);
      if(path==='/v1/thot/listings/activate')return send({...prepared,evidence_hash:evidenceHash,license_hash:licenseHash,automatic_sales:true});
      if(path==='/v1/auth/session/revoke')return send({});
      return send({items:[],enabled:false,entitlements:[],settlements:[],burn_allocations:[],candidates:[],traces:[],orders:[],mandates:[]});
    }
    const relative=path==='/app'?'index.html':path.slice(1);
    if(!/^(?:[a-z0-9-]+\.(?:js|css)|index\.html)$/.test(relative))return route.abort();
    try{
      const body=await readFile(new URL('../apps/dashboard/'+relative,import.meta.url));
      return route.fulfill({status:200,contentType:relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html',body});
    }catch{return route.fulfill({status:404,body:''});}
  });
  return {page,requests,signing,
    async open(hash=''){await page.goto(origin+'/app'+hash,{waitUntil:'domcontentloaded'});},
    armSignature(){page.evaluate(()=>{window.fixtureSignaturePromise=new Promise((resolve,reject)=>{window.fixtureResolveSignature=resolve;window.fixtureRejectSignature=reject;});});},
    resolveSignature:signature=>page.evaluate(signature=>window.fixtureResolveSignature(signature),'0x'+'ab'.repeat(65)),
    rejectSignature:()=>page.evaluate(()=>'window.fixtureRejectSignature' in window)
  };
}

/** axe-equivalent: every interactive element must expose an accessible name. */
async function assertNamedControls(page,scope){
  return page.evaluate(selector=>{
    const root=document.querySelector(selector);if(!root)throw Error('missing scope '+selector);
    const nameOf=element=>{
      if(element.hasAttribute('aria-labelledby'))return element.getAttribute('aria-labelledby').split(/\s+/).map(id=>(document.getElementById(id)||{}).textContent||'').join(' ').trim();
      if(element.hasAttribute('aria-label'))return (element.getAttribute('aria-label')||'').trim();
      const direct=[...root.querySelectorAll('label[for]')].find(label=>label.htmlFor===element.id);
      if(direct)return direct.textContent.trim();
      const wrapping=element.closest('label');
      if(wrapping&&wrapping!==element)return wrapping.textContent.trim();
      if(element.hasAttribute('title'))return (element.getAttribute('title')||'').trim();
      return element.textContent.trim();
    };
    const controls=[...root.querySelectorAll('button,input,select,textarea,a[href]')].filter(element=>!element.hidden&&!element.closest('[hidden]')&&element.type!=='hidden');
    return controls.map(element=>({tag:element.tagName,id:element.id||element.dataset.action||'',name:nameOf(element)})).filter(entry=>!entry.name);
  },scope);
}

test('sale review names exact commitments, keeps the wallet prompt on top, then shares the public URL',async t=>{
  const f=await fixture(t);await f.open();
  await f.page.getByRole('button',{name:'Review & sell',exact:true}).waitFor();
  // The sale review itself states the off-chain signature and dispute window (#80).
  await f.page.getByRole('button',{name:'Review & sell',exact:true}).click();
  await f.page.locator('#detail-dialog').waitFor();
  await f.page.locator('#detail-dialog .thot-sale-details summary').click();
  const details=await f.page.locator('#detail-dialog .thot-sale-details').innerText();
  assert.match(details,/off-chain wallet signature: it is not a blockchain transaction and costs no gas/);
  assert.match(details,new RegExp(disputeSeconds/3600+'-hour dispute window'));
  assert.deepEqual(await assertNamedControls(f.page,'#detail-dialog'),[],'every control in the sale review is named');
  await f.page.locator('#thot-price').fill('100');
  await f.page.locator('#thot-list-consent').check();
  await f.page.getByRole('button',{name:/Sign & list/}).click();
  // #79: the exact hashes being signed are shown and explained before signing.
  await f.page.getByRole('heading',{name:'Review the exact commitments'}).waitFor();
  const review=await f.page.locator('#detail-dialog').innerText();
  assert.ok(review.includes(evidenceHash),'evidenceHash shown');
  assert.ok(review.includes(licenseHash),'licenseHash shown');
  assert.match(review,/complete release envelope[\s\S]*licence text you reviewed|release envelope/);
  assert.match(review,/no gas is charged/);
  assert.match(review,new RegExp(disputeSeconds/3600+'-hour dispute window'));
  assert.deepEqual(await assertNamedControls(f.page,'#detail-dialog'),[],'every control in the signature review is named');
  // #78: while the wallet prompt is open, no application dialog covers it.
  f.armSignature();
  await f.page.getByRole('button',{name:'Open wallet to sign'}).click();
  await f.page.locator('#wallet-prompt').waitFor();
  assert.equal(await f.page.evaluate(()=>document.querySelector('dialog[open]')),null,'the review dialog is closed while signing');
  assert.equal(await f.page.evaluate(()=>window.fixtureDialogOpenAtRequest),false,'no dialog was open when the signature was requested');
  const topmost=await f.page.evaluate(()=>{
    const prompt=document.querySelector('#wallet-prompt');
    const box=prompt.querySelector('div');
    const rect=box.getBoundingClientRect();
    const atCenter=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    const button=prompt.querySelector('button');
    const buttonRect=button.getBoundingClientRect();
    const atButton=document.elementFromPoint(buttonRect.left+buttonRect.width/2,buttonRect.top+buttonRect.height/2);
    return {atCenter:atCenter?.closest('#wallet-prompt')?.id??null,atButton:atButton?.id??null};
  });
  assert.equal(topmost.atCenter,'wallet-prompt','the prompt is the topmost element at its centre');
  assert.equal(topmost.atButton,'wallet-prompt-confirm','the prompt confirm button is the topmost interactive element');
  await f.resolveSignature();
  await f.page.getByRole('heading',{name:'Your item is listed'}).waitFor();
  assert.match(await f.page.locator('#thot-listing-url').inputValue(),/\/l\/018fsyntheticsharepage0000000001$/);
  await f.page.getByRole('button',{name:'Copy link'}).click();
  await f.page.getByText('Public listing link copied.').waitFor();
});

test('a cancelled listing signature returns to the exact commitments without activating',async t=>{
  const f=await fixture(t);await f.open();
  await f.page.getByRole('button',{name:'Review & sell',exact:true}).click();
  await f.page.locator('#thot-price').fill('100');
  await f.page.locator('#thot-list-consent').check();
  await f.page.getByRole('button',{name:/Sign & list/}).click();
  await f.page.getByRole('heading',{name:'Review the exact commitments'}).waitFor();
  f.armSignature();
  await f.page.getByRole('button',{name:'Open wallet to sign'}).click();
  await f.page.locator('#wallet-prompt').waitFor();
  await f.page.evaluate(()=>window.fixtureRejectSignature(Object.assign(new Error('User rejected'),{code:4001})));
  await f.page.getByRole('heading',{name:'Review the exact commitments'}).waitFor();
  assert.match(await f.page.locator('#dialog-error').innerText(),/cancelled|rejected|User/i);
  assert.equal(f.requests.some(r=>r.path==='/v1/thot/listings/activate'),false);
});

test('signed-out Marketplace keeps a buyer sign-in state across Back and Forward (#83)',async t=>{
  const f=await fixture(t);await f.open('');
  await f.page.locator('[data-action="identity-sign-out"]').waitFor({state:'attached'});
  await f.page.locator('.journey-menu>summary').click();
  await f.page.locator('[data-action="identity-sign-out"]').click();
  await f.page.getByRole('heading',{name:/Sign in with your wallet/}).waitFor();
  assert.equal(await f.page.title(),'My data · thot market');
  await f.page.getByRole('button',{name:'Marketplace',exact:true}).click();
  await f.page.getByText(/Sign in.*browse data|browse data/i).first().waitFor();
  assert.equal(await f.page.title(),'Marketplace · thot market');
  assert.match(await f.page.locator('[data-view="market"]').getAttribute('class'),/active/);
  assert.doesNotMatch(await f.page.locator('[data-view="vault"]').getAttribute('class'),/active/);
  await f.page.goBack();
  await f.page.waitForFunction(()=>document.title==='My data · thot market');
  await f.page.getByRole('heading',{name:/Sign in with your wallet/}).waitFor();
  await f.page.goForward();
  await f.page.waitForFunction(()=>document.title==='Marketplace · thot market');
  await f.page.getByText(/browse data/i).first().waitFor();
  // A buyer deep link lands in the buyer state directly.
  await f.page.goto(origin+'/app#thot-available',{waitUntil:'domcontentloaded'});
  await f.page.getByText(/browse data/i).first().waitFor();
  assert.equal(await f.page.title(),'Marketplace · thot market');
  assert.match(await f.page.locator('[data-view="market"]').getAttribute('class'),/active/);
});

test('email sign-in discloses both stages up front (#88)',async t=>{
  const f=await fixture(t,{privy:{app_id:'syntheticprivyapplication1234567890',chain_id:chainId,rpc_url:origin+'/rpc'}});
  await f.open('');
  await f.page.locator('[data-action="identity-sign-out"]').waitFor({state:'attached'});
  await f.page.locator('.journey-menu>summary').click();
  await f.page.locator('[data-action="identity-sign-out"]').click();
  await f.page.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  assert.match(await f.page.locator('#privy-signin-stages').innerText(),/Verify your email, then sign a free message to unlock your workspace\./);
});
