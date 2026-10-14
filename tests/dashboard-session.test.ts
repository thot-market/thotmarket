import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
// @ts-expect-error Production browser helper intentionally uses JavaScript.
import {isClosedUnpaidPurchase} from '../apps/dashboard/thot-ui.js';

const applicationSource = await readFile(new URL('../apps/dashboard/app.js', import.meta.url), 'utf8');
// Execute the repository's actual dashboard logic, not a copied API implementation. UI module factories are
// replaced by inert collaborators and only the automatic initial network bootstrap is disabled.
const source = applicationSource.replace(/^import .*;\r?\n/gm, '').replace('import(`./privy-auth/v1/${attemptNamespace}/privy-auth.bundle.js`)', 'globalThis.importPrivyModule(`./privy-auth/v1/${attemptNamespace}/privy-auth.bundle.js`)').replace(/^void safely\((?:async\(\)=>\{const capability=.*|startAuthentication)\);?\r?$/m, '') + `
globalThis.testDriver = { api, safely, session, showIdentityLogin, runAction, state, pendingKeys, earningsRecords, earnings, market, thot, render, refreshEarnings, startAuthentication, loadPrivyAuth, openPrivyLogin, rememberView, restoredView, forgetView, refreshPurchases, pendingPurchases, refresh, acceptClerkSession, loadCatalogue, renderCatalogue, acceptMarketFragment, invalidatePrivateState,
  setAuthMode(value) { authMode = value; }, setClerkAuth(value) { clerkAuth = value; } };
`;
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const response = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const stale = (error: any) => error?.name === 'StaleWorkspaceError';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function resourceObserverFixture() {
  const observers:Array<any>=[];
  class Observer {
    active=false;
    callback:(list:any)=>void;
    constructor(callback:(list:any)=>void){this.callback=callback;observers.push(this);}
    observe(options:any){assert.equal(options.type,'resource');assert.equal(options.buffered,undefined);this.active=true;}
    disconnect(){this.active=false;}
  }
  return {Observer,active:()=>observers.filter(observer=>observer.active).length,
    emit(patch:Record<string,unknown>={}){const entry={entryType:'resource',initiatorType:'script',startTime:101,name:'https://workspace.example.test/privy-auth/v1/0/privy-auth-chunks/shared.js',...patch};for(const observer of observers)if(observer.active)observer.callback({getEntries:()=>[entry]});}};
}

function documentFixture() {
  const documentHandlers=new Map<string,Array<(event:any)=>unknown>>();
  const elements = new Map<string, any>();
  const make = (name: string) => {
    let html = ''; const handlers = new Map<string, Array<(event: any) => unknown>>(), children = new Map<string, any>();
    const element: any = { name, hidden: true, disabled: false, open: false, value: '', textContent: '', isConnected: true, dataset: {},
      classList: { toggle() {} }, addEventListener(type: string, handler: (event: any) => unknown) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
      querySelector(selector: string) { if (!children.has(selector)) children.set(selector, make(name + ' ' + selector)); return children.get(selector); },
      querySelectorAll() { return []; }, insertAdjacentHTML(_position: string, content: string) { html += content; },
      scrollIntoView() {}, remove() { element.isConnected = false; }, append() {}, click() {}, setAttribute(key:string,value:string){element[key]=value;},
      close() { element.open = false; for (const callback of handlers.get('close') ?? []) callback({ target: element }); },
      showModal() { element.open = true; },
      dispatch(type: string) { for (const callback of handlers.get(type) ?? []) callback({ preventDefault() {}, currentTarget: element, target: element }); },
    };
    Object.defineProperty(element, 'innerHTML', { get: () => html, set(value: string) {
      html = value;
      if (name === '#main') {
        const old = elements.get('#identity-form'); if (old) old.isConnected = false;
        elements.delete('#identity-form'); elements.delete('#identity-token');
        if (value.includes('id="identity-form"')) {
          elements.set('#identity-form', make('#identity-form')); elements.set('#identity-token', make('#identity-token'));
        }
      }
    } });
    return element;
  };
  for (const selector of ['#wallet-summary', '#main', '#detail-dialog', '#dialog-content', '#dialog-error', '#notice', '#toast', '#role', '.brand', '.environment', '.local-tools']) elements.set(selector, make(selector));
  const document = { querySelector(selector: string) { return elements.get(selector) ?? null; }, querySelectorAll() { return []; }, addEventListener(type:string,handler:(event:any)=>unknown) {documentHandlers.set(type,[...(documentHandlers.get(type)??[]),handler]);},
    dispatch(type:string,event:any){for(const callback of documentHandlers.get(type)??[])callback(event);},
    createElement: (name: string) => make(name), body: make('body') };
  return { document, elements };
}
function dashboard(t: any, transport: (url: string, init: any) => Promise<any>, options: { thotTransport?: (url: string, init: any)=>Promise<any>; librarySubmit?: (form:any)=>Promise<boolean>; walletAuthFactory?:(config:any)=>any; importPrivyModule?:(url?:string)=>Promise<any>; privyTimeoutMs?:number; privyResourceObserver?:any; storage?:any; hash?:string } = {}) {
  const dom = documentFixture(), calls: Array<{ url: string; init: any }> = [], timers = new Set<ReturnType<typeof setTimeout>>(), controllers = new Set<AbortController>();
  const context: any = { isClosedUnpaidPurchase, bindStakingPreview:()=>()=>{}, window:{addEventListener(){},sessionStorage:options.storage,PerformanceObserver:options.privyResourceObserver,performance:{now:()=>100},location:{origin:'https://workspace.example.test',hash:options.hash??'',pathname:'/app',search:''}}, createRobinhoodSetupUI:()=>({authReady(){},authLost(){},handle:async()=>false,onDialogCancel(){}}), document: dom.document, AbortController:class extends AbortController{constructor(){super();controllers.add(this);}}, URL, Blob, crypto: { randomUUID },
    setTimeout(callback: () => void, duration: number) { const delay=options.privyTimeoutMs===undefined?duration:duration===30000?options.privyTimeoutMs:duration===90000?options.privyTimeoutMs*3:duration;const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { clearTimeout(timer); timers.delete(timer); },
    fetch(url: string, init: any = {}) { calls.push({ url, init }); return url==='/v1/thot/workspace'?(options.thotTransport?.(url,init)??Promise.resolve(response({capabilities:{mode:'unconfigured'}}))):url==='/v1/money/capabilities'?Promise.resolve(response({mode:'mock'})):transport(url, init); },
    createInferenceUI: () => ({ actionHTML: () => '', historyHTML: () => '', handle: async () => false }),
    createThotUI:()=>({catalogueHTML:(catalogue:any)=>'<section id="market-catalogue">'+(catalogue?.listings?.map((l:any)=>l.title).join('|')??'Loading listings')+'</section>',purchasesHTML:()=>'<h2>Updated purchase cards</h2>',walletSummaryHTML:()=>'',offersHTML:()=>'<h1>Offers renderer</h1>',earningsHTML:()=>'<h1>Earnings renderer</h1>',tokenHTML:()=>'<h1>THOT renderer</h1>',valuationsHTML:()=>'',samplingHTML:()=>'<h1>Treasury sampler</h1>',action:async()=>false}),
    createThotAnalyticsUI:()=>({referralsHTML:()=>'<h2>Referral receipts</h2>',portfolioHTML:()=>'',leaderboardHTML:()=>'<h1>Market activity</h1>',ready:async()=>{},handle:async()=>false,onSubmit:async()=>false,reset(){}}),
    createMoneyUI:()=>({active:()=>false,action:async()=>false,decorate(){}}),
    createMandateEditor: () => ({}), createOperationsUI: () => ({ sectionHTML: () => '', handle: async () => false }),
    createContributorUI: () => ({ sectionHTML: () => '', handle: async () => false, onChange: () => false, onSubmit: async () => false, reset() {}, resetPreview() {} }),
    createWalletAuth: options.walletAuthFactory??(() => ({})), importPrivyModule:options.importPrivyModule??(()=>{throw Error('Unexpected Privy import');}),
    createOpenRouterUI: () => ({reset(){},intro:()=>'',handle:async()=>false}),
    createAgentCaptureUI: () => ({ authReady() {}, authLost() {}, onDialogClose() {}, handle: async () => false, onChange: () => false }),
    createLibraryUI: () => ({ reset() {}, ready() {}, queryString: () => '', sectionHTML: () => '', handle: async () => false, onChange: () => false, onSubmit: options.librarySubmit??(async () => false), acceptFragment: async () => {} }),
    createTraceExplorerUI: () => ({ reset() {}, sectionHTML: () => '', handle: async () => false, onChange: () => false }),
  };
  runInNewContext(source, context, { filename: 'apps/dashboard/app.js', timeout: 1000 });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const driver = context.testDriver;
  const identity = (id = 'user-old', role = 'user', token = 'old-token') => {
    Object.assign(driver.state, { generation: driver.state.generation + 1, actor: { id, role }, role, token, loaded: true });
  };
  identity();
  const login = (token: string) => {
    const form = dom.document.querySelector('#identity-form'); assert.ok(form);
    dom.document.querySelector('#identity-token').value = token; form.dispatch('submit'); return form;
  };
  return { ...dom, driver, calls, identity, login, browser:context.window, abortRequests(){for(const controller of controllers)controller.abort();} };
}

test('dashboard retries transient GET responses once within the original private request scope',async t=>{
  for(const status of [500,502,503,504]){
    let reads=0,cancelled=0;
    const a=dashboard(t,async()=>++reads===1?{...response({error:'INTERNAL_ERROR'},status),body:{async cancel(){cancelled++;}}}:response({balance:'0.3',status:'finalized'}));
    const pending=a.driver.api('/v1/private-workspace');await flush();
    assert.equal(a.calls.length,1,'retry is delayed rather than immediate');
    const result=await pending;assert.equal(result.balance,'0.3');assert.equal(reads,2);assert.equal(cancelled,1);
    assert.equal(a.calls[0].init.signal,a.calls[1].init.signal,'retry shares the original timeout');
    for(const {init}of a.calls){assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer old-token');assert.equal(init.headers['Idempotency-Key'],undefined);assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');}
  }
});

test('persistent server errors stop after one GET retry and never replay a financial mutation',async t=>{
  const a=dashboard(t,async()=>response({error:'INTERNAL_ERROR'},500));
  await assert.rejects(a.driver.api('/v1/private-workspace'),/service could not finish/);assert.equal(a.calls.length,2);
  for(const method of ['POST','PATCH'])for(const status of [500,502,503,504]){
    const m=dashboard(t,async()=>response({error:'INTERNAL_ERROR'},status));
    await assert.rejects(m.driver.api('/v1/private-mutation',{method,body:{amount:'1'},idempotencyKey:'original-key'}));
    assert.equal(m.calls.length,1);assert.equal(m.calls[0].init.headers['Idempotency-Key'],'original-key');assert.equal(m.driver.pendingKeys.size,1);
  }
});

test('validation and wallet authentication failures are never retried as transient GET failures',async t=>{
  for(const status of [400,401,403,404,409,429]){
    const a=dashboard(t,async()=>response({error:status===401?'UNAUTHENTICATED':'FORBIDDEN'},status));a.driver.setAuthMode('wallet_siwe');
    await assert.rejects(a.driver.api('/v1/private-workspace'));assert.equal(a.calls.length,1);
  }
});

test('a workspace switch during read backoff prevents the retry with the former credentials',async t=>{
  const a=dashboard(t,async()=>response({error:'INTERNAL_ERROR'},500));
  const pending=a.driver.api('/v1/private-workspace'),rejected=assert.rejects(pending,stale);await flush();
  a.identity('new-user','user','new-token');await rejected;
  assert.equal(a.calls.length,1);assert.equal(a.driver.state.token,'new-token');
});

test('aborting during read backoff cancels the delayed request instead of restarting its timeout',async t=>{
  const a=dashboard(t,async()=>response({error:'INTERNAL_ERROR'},500));
  const pending=a.driver.api('/v1/private-workspace'),rejected=assert.rejects(pending,/server took too long/);await flush();a.abortRequests();await rejected;
  assert.equal(a.calls.length,1);assert.equal(a.calls[0].init.signal.aborted,true);
});

test('dashboard actual API still returns current-scope results and reconnects once with the exact original mutation key/body', async t => {
  let attempts = 0;
  const a = dashboard(t, async (url, init) => {
    if (url === '/v1/dev/session') return response({ token: 'recovered-token', actor: { id: 'user-old', role: 'user' } });
    assert.equal(url, '/v1/private-mutation'); attempts++;
    return attempts === 1 ? response({ error: 'UNAUTHENTICATED' }, 401) : response({ success: true });
  });
  const result = await a.driver.api('/v1/private-mutation', { method: 'POST', body: { private_value: 'fixture' }, idempotencyKey: 'stable-mutation-key' });
  assert.equal(result.success, true); assert.equal(a.driver.state.token, 'recovered-token'); assert.equal(a.calls.length, 3);
  const mutationCalls = a.calls.filter(call => call.url === '/v1/private-mutation');
  assert.equal(mutationCalls[0]!.init.body, mutationCalls[1]!.init.body);
  assert.equal(mutationCalls[0]!.init.headers['Idempotency-Key'], 'stable-mutation-key');
  assert.equal(mutationCalls[1]!.init.headers['Idempotency-Key'], 'stable-mutation-key');
  assert.equal(a.driver.pendingKeys.size, 0);
});

test('private-import preparation submits through the library handler instead of navigating the page',async t=>{
 let prevented=0,submitted:any;
 const a=dashboard(t,async()=>{throw new Error('Unexpected request');},{librarySubmit:async form=>{submitted=form;return true;}});
 const form={id:'library-prepare-sale',querySelector(){return null;}};
 a.document.dispatch('submit',{target:form,preventDefault(){prevented++;}});await flush();
 assert.equal(prevented,1);assert.equal(submitted,form);assert.equal(a.calls.length,0);
});

test('actual role switch prevents a delayed former-account delivery action from reopening a private dialog', async t => {
  const pending = deferred();
  const a = dashboard(t, async url => {
    if (url === '/v1/buyer/deliveries/old-license') return pending.promise;
    if (url === '/v1/dev/session') return response({ token: 'buyer-new-token', actor: { id: 'buyer-new', role: 'buyer_admin' } });
    if (url === '/v1/buyer/mandates') return response([]);
    throw new Error('Unexpected fixture request: ' + url);
  });
  const oldAction = a.driver.safely(() => a.driver.runAction('delivery', { dataset: { id: 'old-license' } }));
  await flush(); await a.driver.session('buyer_admin');
  pending.resolve(response({ private_content: 'PRIVATE-FORMER-ACCOUNT-DELIVERY' })); await oldAction;
  assert.equal(a.driver.state.actor.id, 'buyer-new'); assert.equal(a.driver.state.token, 'buyer-new-token');
  assert.equal(a.document.querySelector('#detail-dialog').open, false);
  assert.ok(!a.document.querySelector('#dialog-content').innerHTML.includes('PRIVATE-FORMER'));
  assert.equal(a.document.querySelector('#notice').hidden, true, 'stale results do not overwrite the new workspace with an error');
});

test('actual sign-out state transition discards a detail response whose JSON parsing completes later', async t => {
  const json = deferred(), parsing = deferred<void>();
  const a = dashboard(t, async () => ({ status: 200, ok: true, json() { parsing.resolve(); return json.promise; } }));
  a.driver.setAuthMode('external_jwt');
  const oldAction = a.driver.safely(() => a.driver.runAction('trace', { dataset: { id: 'private-old-trace' } }));
  await parsing.promise; a.document.querySelector('#wallet-summary').innerHTML='PRIVATE-BALANCE';a.document.querySelector('#wallet-summary').hidden=false;
 a.driver.showIdentityLogin('Signed out.');
 assert.equal(a.document.querySelector('#wallet-summary').innerHTML,'');assert.equal(a.document.querySelector('#wallet-summary').hidden,true); const loginForm = a.document.querySelector('#identity-form');
  json.resolve({ category: 'general', status: 'AVAILABLE', provenance: { private: 'PRIVATE-TRACE-RECEIPT' }, rights: {} }); await oldAction;
  assert.equal(a.driver.state.token, null); assert.equal(a.driver.state.actor, null);
  assert.equal(a.document.querySelector('#identity-form'), loginForm); assert.equal(a.document.querySelector('#detail-dialog').open, false);
  assert.ok(!a.document.querySelector('#main').innerHTML.includes('PRIVATE-TRACE'));
});

test('same actor with a newer workspace generation invalidates JSON-awaiting results before success or mutation-key deletion', async t => {
  const json = deferred(), parsing = deferred<void>();
  const a = dashboard(t, async () => ({ status: 200, ok: true, json() { parsing.resolve(); return json.promise; } }));
  const pending = a.driver.api('/v1/private-mutation', { method: 'POST', body: { marker: 'old-mutation' }, idempotencyKey: 'pending-original-key' });
  const rejected = assert.rejects(pending, stale); await parsing.promise;
  a.identity('user-old', 'user', 'superseding-token'); json.resolve({ success: true }); await rejected;
  assert.equal(a.driver.state.token, 'superseding-token'); assert.equal(a.driver.pendingKeys.size, 1);
});

test('stale 401 responses neither reconnect a development session nor clear a newer external identity', async t => {
  for (const mode of ['development', 'external_jwt']) {
    const pending = deferred(); let reads = 0;
    const a = dashboard(t, async () => pending.promise); a.driver.setAuthMode(mode);
    const request = a.driver.api('/v1/private-old-record'); const rejected = assert.rejects(request, stale);
    a.identity('new-identity', 'operator_security', 'new-identity-token');
    pending.resolve({ status: 401, ok: false, async json() { reads++; return { error: 'UNAUTHENTICATED' }; } }); await rejected;
    assert.equal(a.calls.length, 1); assert.equal(reads, 0); assert.equal(a.driver.state.actor.id, 'new-identity');
    assert.equal(a.driver.state.token, 'new-identity-token'); assert.equal(a.document.querySelector('#identity-form'), null);
  }
});

test('an already-pending reconnect cannot overwrite a superseding same-account token or retry the old request', async t => {
  const recovering = deferred(), started = deferred<void>();
  const a = dashboard(t, async url => {
    if (url === '/v1/dev/session') { started.resolve(); return recovering.promise; }
    return response({ error: 'UNAUTHENTICATED' }, 401);
  });
  const pending = a.driver.api('/v1/old-mutation', { method: 'POST', body: { old: true } }); const rejected = assert.rejects(pending, stale);
  await started.promise; a.identity('user-old', 'user', 'newer-same-account-token');
  recovering.resolve(response({ token: 'stale-recovered-token', actor: { id: 'user-old', role: 'user' } })); await rejected;
  assert.equal(a.driver.state.token, 'newer-same-account-token'); assert.equal(a.calls.length, 2);
});

test('Clerk obtains a fresh SDK token for each request and never replays an expired mutation', async t => {
  const a = dashboard(t, async () => response({ error: 'UNAUTHENTICATED' }, 401));
  let issued = 0;
  a.driver.setAuthMode('clerk');
  a.driver.setClerkAuth({ getToken: async () => `fresh-sdk-token-${++issued}`, mountSignIn() {} });
  await assert.rejects(a.driver.api('/v1/sale-authorizations', { method: 'POST', body: { candidate_id: 'candidate-1' } }), stale);
  assert.equal(a.calls.length, 1, 'an authorization mutation is not replayed after an expired Clerk session');
  assert.equal(a.calls[0].init.headers.Authorization, 'Bearer fresh-sdk-token-1');
  assert.equal(a.driver.state.actor, null);
  assert.equal(a.driver.pendingKeys.size, 1, 'the original idempotency key remains available for an explicit retry after sign-in');
});

test('direct external login response cannot reconnect an identity after its form has been replaced', async t => {
  const pending = deferred(); const a = dashboard(t, async () => pending.promise); a.driver.setAuthMode('external_jwt');
  a.driver.showIdentityLogin(); const oldForm = a.login('old.header.signature');
  a.driver.showIdentityLogin('A newer sign-in is required.'); const currentForm = a.document.querySelector('#identity-form');
  assert.notEqual(currentForm, oldForm);
  pending.resolve(response({ actor: { id: 'stale-login-identity', role: 'operator_security' } })); await flush();
  assert.equal(a.driver.state.actor, null); assert.equal(a.driver.state.token, null);
  assert.equal(a.document.querySelector('#identity-form'), currentForm); assert.equal(a.document.querySelector('#notice').hidden, true);
});

test('late login JSON cannot replace a newer successfully verified identity; current login still connects normally', async t => {
  const oldJson = deferred(), parsing = deferred<void>();
  const a = dashboard(t, async (_url, init) => {
    if (init.headers.Authorization === 'Bearer old.header.signature') return { status: 200, ok: true, json() { parsing.resolve(); return oldJson.promise; } };
    assert.equal(init.headers.Authorization, 'Bearer new.header.signature');
    return response({ actor: { id: 'current-operator', role: 'operator_security' } });
  });
  a.driver.setAuthMode('external_jwt'); a.driver.showIdentityLogin(); a.login('old.header.signature'); await parsing.promise;
  a.driver.showIdentityLogin(); a.login('new.header.signature'); await flush();
  assert.equal(a.driver.state.actor.id, 'current-operator'); assert.equal(a.driver.state.token, 'new.header.signature');
  oldJson.resolve({ actor: { id: 'stale-contributor', role: 'user' } }); await flush();
  assert.equal(a.driver.state.actor.id, 'current-operator'); assert.equal(a.driver.state.token, 'new.header.signature');
  assert.equal(a.driver.state.role, 'operator_security');
  assert.equal(a.calls.filter(c => c.url === '/v1/auth/session').length, 2);
  assert.ok(a.calls.slice(2).every(c => ['/v1/operator/trace-explorer','/v1/money/capabilities','/v1/thot/capabilities','/v1/thot/workspace','/v1/thot/sampling'].includes(c.url)));
});

test('late external-login network and JSON failures cannot replace the newer login form with an error', async t => {
  for (const phase of ['fetch', 'json']) {
    const failed = deferred(), parsing = deferred<void>();
    const a = dashboard(t, async () => phase === 'fetch' ? failed.promise : { status: 200, ok: true, json() { parsing.resolve(); return failed.promise; } });
    a.driver.setAuthMode('external_jwt'); a.driver.showIdentityLogin(); a.login('old.header.signature');
    if (phase === 'json') await parsing.promise;
    a.driver.showIdentityLogin('Keep this current sign-in screen.'); const form = a.document.querySelector('#identity-form');
    failed.reject(new Error('OLD-LOGIN-TRANSPORT-ERROR')); await flush();
    assert.equal(a.driver.state.actor, null); assert.equal(a.document.querySelector('#identity-form'), form);
    assert.equal(a.document.querySelector('#notice').hidden, true);
    assert.ok(!a.document.querySelector('#main').innerHTML.includes('OLD-LOGIN-TRANSPORT-ERROR'));
  }
});

test('earnings reconciles a licensed sale exactly once and never counts an orphan allocation as paid', t => {
  const a=dashboard(t,async()=>{throw new Error('Unexpected request');});
  const item={entitlement_id:'entitlement-1',settlement_id:'settlement-1',license_id:'license-1',currency:'USD',amount_minor:'6500',status:'AVAILABLE',disposition:'inference_credit'};
  a.driver.state.candidates=[{candidate_id:'candidate-1',license_id:'license-1',status:'LICENSED'}];
  a.driver.state.earnings={entitlements:[item],settlements:[],burn_allocations:[]};
  let records=a.driver.earningsRecords();
  assert.equal(records.pending.length,1);assert.equal(records.pending[0].license_id,'license-1');
  assert.equal(records.recordedCount,0);assert.equal(records.paidCount,0);
  assert.match(a.driver.earnings(),/unconfirmed allocation/);
  assert.doesNotMatch(a.driver.earnings(),/test tokens received|Completed demo settlements/);
  a.driver.state.earnings.settlements=[{settlement_id:'settlement-1',license_id:'different-license'}];
  assert.equal(a.driver.earningsRecords().recordedCount,0,'a settlement for another license cannot confirm the allocation');
  a.driver.state.earnings.settlements=[{settlement_id:'settlement-1',license_id:'license-1',contributor_minor:'6500',burn_minor:'2000',operator_minor:'1500'}];
  records=a.driver.earningsRecords();
  assert.equal(records.pending.length,0);assert.equal(records.recordedCount,1);assert.equal(records.paidCount,0);
  const html=a.driver.earnings();assert.match(html,/Recorded demo allocations/);assert.match(html,/no cash payout/);
  assert.doesNotMatch(html,/Demo settlement pending|test tokens received|License <\/span>/);
  a.driver.state.candidates=[{candidate_id:'legacy-candidate',status:'LICENSED'}];
  assert.equal(a.driver.earningsRecords().pending.length,0,'an absent license ID cannot create a blank phantom payment');
});

test('earnings requires a matching non-simulated Anvil receipt before saying test tokens were received', t => {
  const a=dashboard(t,async()=>{throw new Error('Unexpected request');});
  const item={entitlement_id:'entitlement-1',settlement_id:'settlement-1',license_id:'license-1',currency:'USDC',amount_minor:'6500',status:'TOKEN_WITHDRAWN',disposition:'token',test_assets:true,thot_atoms:'123',transaction_hash:'transaction-1'};
  const settlement:any={settlement_id:'settlement-1',license_id:'license-1'};
  a.driver.state.earnings={entitlements:[item],settlements:[settlement],burn_allocations:[]};
  assert.equal(a.driver.earningsRecords().paidCount,0,'entitlement flags alone cannot prove payment');
  settlement.chain_receipt={test_assets:true,simulated:false,approval_hash:'approval-1',transaction_hash:'transaction-1',paid_thot_atoms:'123'};
  assert.equal(a.driver.earningsRecords().paidCount,1);assert.match(a.driver.earnings(),/test tokens received/);
  settlement.chain_receipt.transaction_hash='another-transaction';assert.equal(a.driver.earningsRecords().paidCount,0);
  settlement.chain_receipt.transaction_hash='transaction-1';settlement.chain_receipt.simulated=true;
  assert.equal(a.driver.earningsRecords().paidCount,0,'a fabricated local receipt is not an Anvil payout');
});

test('THOT earnings refreshes confirmed workspace once without polling or crediting legacy estimates', async t => {
  const pending=deferred();
  const a=dashboard(t,async()=>{throw new Error('THOT earnings must not request legacy ledgers');},{thotTransport:async()=>pending.promise});
  const old={capabilities:{mode:'thot-anvil'},account:{claimable:'0',balance:'1000000000000000000'}};
  const latest={capabilities:{mode:'thot-anvil'},account:{claimable:'30000000000000000000000',balance:'1000000000000000000',block:{number:123}},orders:[{receipt:{status:5}}]};
  a.driver.state.view='earnings';a.driver.state.thot=old;
  const legacy={entitlements:[{status:'DEMO_ESTIMATE',amount_minor:'99999999'}],settlements:[],burn_allocations:[]};
  a.driver.state.earnings=legacy;
  const refresh=a.driver.refreshEarnings();await flush();await a.driver.refreshEarnings();
  assert.equal(a.calls.length,1,'a timer tick cannot overlap an in-flight refresh');
  assert.equal(a.calls[0]!.url,'/v1/thot/workspace');assert.equal(a.driver.state.thot,old);
  pending.resolve(response(latest));await refresh;
  assert.equal(a.driver.state.thot,latest);assert.equal(a.driver.state.earnings,legacy);
  assert.equal(a.driver.state.thot.account.claimable,'30000000000000000000000');
});

test('a delayed THOT earnings response cannot replace a newer role workspace', async t => {
  const json=deferred(),parsing=deferred<void>();
  const a=dashboard(t,async()=>{throw new Error('Unexpected legacy request');},{thotTransport:async()=>({ok:true,status:200,json(){parsing.resolve();return json.promise;}})});
  a.driver.state.view='earnings';a.driver.state.thot={capabilities:{mode:'thot-anvil'},account:{claimable:'0'}};
  const refresh=a.driver.refreshEarnings();await parsing.promise;
  a.identity('new-buyer','buyer_admin','new-buyer-token');a.driver.state.view='market';
  const buyerWorkspace={capabilities:{mode:'thot-anvil'},account:{claimable:'777'},orders:[]};a.driver.state.thot=buyerWorkspace;
  json.resolve({capabilities:{mode:'thot-anvil'},account:{claimable:'PRIVATE-OLD-CLAIM'},orders:[]});await refresh;
  assert.equal(a.driver.state.thot,buyerWorkspace);assert.equal(a.driver.state.actor.id,'new-buyer');
  assert.equal(a.document.querySelector('#notice').hidden,true);assert.equal(a.calls.length,1);
});

test('THOT refresh keeps prior contract balances when its service becomes unconfigured', async t => {
  const a=dashboard(t,async()=>{throw new Error('Unexpected legacy request');});
  const previous={capabilities:{mode:'thot-anvil'},account:{claimable:'123'}};
  a.driver.state.view='earnings';a.driver.state.thot=previous;
  await a.driver.refreshEarnings();assert.equal(a.driver.state.thot,previous);
  assert.equal(a.calls.length,1);assert.equal(a.calls[0]!.url,'/v1/thot/workspace');
});

test('THOT earnings polling does not reset an open form or poll the Offers and THOT views', async t => {
  const a=dashboard(t,async()=>{throw new Error('Unexpected request');},{thotTransport:async()=>{throw new Error('No polling outside visible unobstructed earnings');}});
  a.driver.state.thot={capabilities:{mode:'thot-anvil'}};
  for(const view of ['market','thot']){a.driver.state.view=view;await a.driver.refreshEarnings();}
  a.driver.state.view='earnings';a.document.querySelector('#detail-dialog').open=true;
  await a.driver.refreshEarnings();assert.equal(a.calls.length,0);
});

test('dashboard routes Offers, Earnings and THOT to different renderers',t=>{
 const a=dashboard(t,async()=>{throw new Error('Rendering should not request data');});
 a.driver.state.thot={capabilities:{mode:'thot-anvil'}};
 assert.equal(a.driver.market(),'<h1>Offers renderer</h1>');
 assert.equal(a.driver.earnings(),'<h1>Earnings renderer</h1>');
 assert.equal(a.driver.thot(),'<h1>THOT renderer</h1>');
});

test('sign-out clears THOT balances and sidebar rendering cannot replace the login screen',t=>{
 const a=dashboard(t,async()=>{throw new Error('No requests while signed out');});
 a.driver.state.thot={capabilities:{mode:'thot-anvil'},wallet:'PRIVATE-WALLET',account:{claimable:'123'},orders:[{title:'PRIVATE-SALE'}]};
 a.document.querySelector('#wallet-summary').innerHTML='PRIVATE-BALANCE';a.document.querySelector('#wallet-summary').hidden=false;
 a.driver.showIdentityLogin('Signed out.');
 assert.equal(a.document.querySelector('#wallet-summary').innerHTML,'');assert.equal(a.document.querySelector('#wallet-summary').hidden,true);
 assert.equal(a.driver.state.thot,null);
 const login=a.document.querySelector('#main').innerHTML;
 for(const view of ['earnings','thot','market']){a.driver.state.view=view;a.driver.render();assert.equal(a.document.querySelector('#main').innerHTML,login);}
 assert.doesNotMatch(login,/PRIVATE-WALLET|PRIVATE-SALE/);
});

test('an unsuccessful role switch clears the previous THOT account before loading new records',async t=>{
 const a=dashboard(t,async()=>response({error:'UNAVAILABLE'},503));
 a.driver.state.thot={wallet:'PRIVATE-OLD-WALLET',orders:[{title:'PRIVATE-OLD-SALE'}]};
 a.document.querySelector('#wallet-summary').innerHTML='PRIVATE-OLD-BALANCE';
 await assert.rejects(a.driver.session('buyer_admin'));
 assert.equal(a.document.querySelector('#wallet-summary').innerHTML,'');
 assert.equal(a.driver.state.thot,null);assert.equal(a.driver.state.loaded,false);
 a.driver.state.view='thot';a.driver.render();
 assert.doesNotMatch(a.document.querySelector('#main').innerHTML,/PRIVATE-OLD/);
});

test('Robinhood testnet keeps Offers, Earnings and THOT on their dedicated renderers',t=>{
 const a=dashboard(t,async()=>response({}));a.driver.state.thot={capabilities:{mode:'thot-testnet',chain_id:46630}};
 assert.equal(a.driver.market(),'<h1>Offers renderer</h1>');assert.equal(a.driver.earnings(),'<h1>Earnings renderer</h1>');assert.equal(a.driver.thot(),'<h1>THOT renderer</h1>');
});

test('Robinhood testnet earnings refresh reads contract workspace rather than legacy simulated earnings',async t=>{
 const latest={capabilities:{mode:'thot-testnet',chain_id:46630},account:{claimable:'30'}};
 const a=dashboard(t,async()=>response({}),{thotTransport:async()=>response(latest)});a.driver.state.view='earnings';a.driver.state.thot={capabilities:{mode:'thot-testnet',chain_id:46630},account:{claimable:'0'}};
 await a.driver.refreshEarnings();assert.equal(a.driver.state.thot.account.claimable,'30');assert.deepEqual(a.calls.map(c=>c.url),['/v1/thot/workspace']);
});


const walletCapability={mode:'wallet_siwe',wallet:{chain_id:46630,rpc_url:'https://rpc.testnet.chain.robinhood.com'},privy:{app_id:'cmu2kc1sv03370dla944rfnb7',chain_id:46630,rpc_url:'https://rpc.testnet.chain.robinhood.com'}};

test('wallet workspace banner names the selected local, testnet, or mainnet environment',async t=>{
  for(const [chainId,label] of [[31337,'local Anvil'],[46630,'testnet'],[4663,'mainnet']] as const){
    const capability={...walletCapability,wallet:{...walletCapability.wallet,chain_id:chainId}};
    const a=dashboard(t,async()=>response(capability),{walletAuthFactory:()=>({async restore(){return false;}})});
    await a.driver.startAuthentication();
    const banner=a.elements.get('.environment').innerHTML;
    assert.match(banner,new RegExp(`Wallet workspace · ${label}`));
    if(chainId===4663)assert.doesNotMatch(banner,/testnet|test assets/i);
  }
});

test('dashboard renders one Privy sign-in action before restore and leaves the SDK unloaded',async t=>{
  let imports=0,restores=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async()=>{imports++;throw Error('Must stay lazy');},walletAuthFactory:()=>({async restore(){restores++;assert.match(a.document.querySelector('#main').innerHTML,/data-privy-login>Sign in<\/button>/);assert.doesNotMatch(a.document.querySelector('#main').innerHTML,/data-wallet-login|Your wallet is your account|Sign-in does not approve/);return false;}})});
  await a.driver.startAuthentication();assert.equal(restores,1);assert.equal(imports,0);assert.equal(a.driver.state.actor,null);
});

test('without resource observation a slow Privy download times out without accepting late completion',async t=>{
  const download=deferred();let created=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:10,importPrivyModule:()=>download.promise,walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const html=a.document.querySelector('#main').innerHTML;
  await assert.rejects(a.driver.loadPrivyAuth(),/download timed out/);assert.equal(a.document.querySelector('#main').innerHTML,html);assert.equal(a.driver.state.actor,null);
  download.resolve({createPrivyAuth(){created++;return {};}});await flush();assert.equal(created,0,'a timed-out import never mounts an SDK instance');assert.equal(a.driver.state.actor,null);
});

test('completed resources in the current download extend only the idle budget and clean up on success',async t=>{
  const resources=resourceObserverFixture(),download=deferred();let created=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:60,privyResourceObserver:resources.Observer,importPrivyModule:()=>download.promise,walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const pending=a.driver.loadPrivyAuth();
  assert.equal(resources.active(),1);
  const interval=setInterval(()=>resources.emit(),25);t.after(()=>clearInterval(interval));
  await new Promise(resolve=>setTimeout(resolve,100));
  download.resolve({createPrivyAuth(){created++;return {async initialize(){},mount(){},destroy(){}};}});
  await pending;clearInterval(interval);
  assert.equal(created,1);assert.equal(resources.active(),0);
});

for(const [description,patch] of Object.entries({
  'old attempt':{name:'https://workspace.example.test/privy-auth/v1/0/privy-auth-chunks/shared.js'},
  'another origin':{name:'https://other.example.test/privy-auth/v1/1/privy-auth-chunks/shared.js'},
  'another namespace':{name:'https://workspace.example.test/privy-auth/v1/10/privy-auth-chunks/shared.js'},
  'non-script resource':{initiatorType:'fetch'},
  'historical resource':{startTime:99},
}))test(`${description} cannot extend a newer download's idle deadline`,async t=>{
  const resources=resourceObserverFixture();let imports=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:60,privyResourceObserver:resources.Observer,importPrivyModule:()=>++imports===1?Promise.reject(new Error('first request failed')):new Promise(()=>{}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await assert.rejects(a.driver.loadPrivyAuth(),/could not download/);
  assert.equal(resources.active(),0);
  const pending=a.driver.loadPrivyAuth().then(()=> 'unexpected success',(error:Error)=>error.message);
  const emit=setTimeout(()=>resources.emit({name:'https://workspace.example.test/privy-auth/v1/1/privy-auth-chunks/shared.js',...patch}),30);t.after(()=>clearTimeout(emit));
  const result=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('idle deadline was incorrectly extended'),75))]);
  assert.match(String(result),/download timed out/);assert.equal(resources.active(),0);
});

test('download progress cannot extend the hard ceiling and observer disconnects after timeout',async t=>{
  const resources=resourceObserverFixture();
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:60,privyResourceObserver:resources.Observer,importPrivyModule:()=>new Promise(()=>{}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const pending=a.driver.loadPrivyAuth().then(()=> 'unexpected success',(error:Error)=>error.message);
  const interval=setInterval(()=>resources.emit(),25);t.after(()=>clearInterval(interval));
  const result=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('hard ceiling was incorrectly extended'),210))]);
  clearInterval(interval);assert.match(String(result),/download timed out/);assert.equal(resources.active(),0);
});

test('an unsupported resource observer retains the ordinary download deadline',async t=>{
  let disconnected=0;
  class UnsupportedObserver{observe(){throw new Error('unsupported resource observation');}disconnect(){disconnected++;}}
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:10,privyResourceObserver:UnsupportedObserver,importPrivyModule:()=>new Promise(()=>{}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await assert.rejects(a.driver.loadPrivyAuth(),/download timed out/);assert.equal(disconnected,1);
});

test('Privy readiness is bounded after download and failure allows a fresh retry',async t=>{
  const readiness=deferred();let imports=0,destroyed=0,logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:10,importPrivyModule:async()=>{imports++;return {createPrivyAuth:()=>({initialize:()=>imports===1?readiness.promise:Promise.resolve(),mount(){},destroy(){destroyed++;},async login(){logins++;}})};},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await assert.rejects(a.driver.loadPrivyAuth(),/service is taking too long/);assert.equal(destroyed,1);
  await a.driver.openPrivyLogin();assert.equal(imports,2);assert.equal(logins,1);readiness.resolve(null);await flush();assert.equal(logins,1);
});

test('a near-deadline download gives authentication readiness a separate full budget',async t=>{
  let created=0,logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:80,importPrivyModule:async()=>{
    await new Promise(resolve=>setTimeout(resolve,55));
    return {createPrivyAuth(){created++;return {initialize:()=>new Promise(resolve=>setTimeout(resolve,55)),mount(){},destroy(){},async login(){logins++;}};}};
  },walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await a.driver.openPrivyLogin();
  assert.equal(created,1);assert.equal(logins,1);assert.doesNotMatch(a.document.querySelector('#main').innerHTML,/timed out|taking too long/);
});

for(const lateResult of ['resolve','reject'] as const)test(`timed-out module ${lateResult} cannot mount a provider or change the newer retry namespace`,async t=>{
  const first=deferred(),second=deferred(),urls:Array<string|undefined>=[];let created=0,mounted=0;
  const module={createPrivyAuth(){created++;return {async initialize(){},mount(){mounted++;},destroy(){}};}};
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:40,importPrivyModule:url=>{urls.push(url);return urls.length===1?first.promise:urls.length===2?second.promise:Promise.resolve(module);},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await assert.rejects(a.driver.loadPrivyAuth(),/download timed out/);
  const retry=a.driver.loadPrivyAuth(),failedRetry=assert.rejects(retry,/could not download/);
  first[lateResult](lateResult==='resolve'?module:new Error('late network failure'));await flush();
  assert.equal(created,0);assert.equal(mounted,0);
  second.reject(new Error('retry network failure'));await failedRetry;
  await a.driver.loadPrivyAuth();
  assert.deepEqual(urls,[0,1,2].map(n=>`./privy-auth/v1/${n}/privy-auth.bundle.js`));
  assert.equal(created,1);assert.equal(mounted,1);
});

test('an account switch during lazy Privy loading cannot open login over the new workspace',async t=>{
  const readiness=deferred();let logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async()=>({createPrivyAuth:()=>({initialize:()=>readiness.promise,mount(){},destroy(){},async login(){logins++;}})}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const pending=a.driver.openPrivyLogin(),rejected=assert.rejects(pending,stale);await flush();a.identity('new-wallet');readiness.resolve(null);await rejected;
  assert.equal(logins,0);assert.equal(a.driver.state.actor.id,'new-wallet');
});


test('the first email-login click survives an anonymous restore completing while Privy loads',async t=>{
  const restored=deferred(),ready=deferred();let logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async()=>({createPrivyAuth:()=>({initialize:()=>ready.promise,mount(){},destroy(){},async login(){logins++;}})}),walletAuthFactory:config=>({async restore(){config.onIdentityChanging({restoring:true});await restored.promise;config.onSignedOut();return false;}})});
  const startup=a.driver.startAuthentication();await flush();const login=a.driver.openPrivyLogin();await flush();
  restored.resolve(null);await startup;ready.resolve(null);await login;assert.equal(logins,1);assert.equal(a.driver.state.actor,null);
});


test('the sign-in button timeout keeps one retryable Privy action',async t=>{
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:10,importPrivyModule:()=>new Promise(()=>{}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const main=a.document.querySelector('#main');
  main.querySelector('[data-privy-login]').dispatch('click');await new Promise(resolve=>setTimeout(resolve,25));
  assert.match(main.innerHTML,/download timed out/);assert.doesNotMatch(main.innerHTML,/data-wallet-login/);assert.match(main.innerHTML,/data-privy-login>Try again<\/button>/);assert.ok(!main.innerHTML.includes('workspace is unavailable'));assert.equal(a.driver.state.actor,null);
});

test('sign-in immediately announces progress and remains single-flight across anonymous restore',async t=>{
  const download=deferred(),ready=deferred();let imports=0,logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:()=>{imports++;return download.promise;},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const main=a.document.querySelector('#main'),button=main.querySelector('[data-privy-login]');
  const login=a.driver.openPrivyLogin();
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Opening sign-in…');assert.equal(button['aria-busy'],'true');
  assert.equal(main.querySelector('#privy-login-status').textContent,'Loading secure sign-in…');
  a.driver.showIdentityLogin('Connect your wallet to continue.');
  assert.match(main.innerHTML,/disabled aria-busy="true"/);assert.match(main.innerHTML,/Loading secure sign-in/);
  await a.driver.openPrivyLogin();assert.equal(imports,1);
  download.resolve({createPrivyAuth:()=>({initialize:()=>ready.promise,mount(){},destroy(){},async login(){logins++;}})});await flush();
  assert.equal(main.querySelector('#privy-login-status').textContent,'Connecting to sign-in…');
  ready.resolve(null);await login;assert.equal(logins,1);assert.equal(button.disabled,false);assert.equal(button['aria-busy'],'false');
});

test('retry after a failed module request uses a fresh graph namespace and opens sign-in once',async t=>{
  const urls:Array<string|undefined>=[];let logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async url=>{urls.push(url);if(urls.length===1)throw Error('network unavailable');return {createPrivyAuth:()=>({async initialize(){},mount(){},destroy(){},async login(){logins++;}})};},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await a.driver.openPrivyLogin();
  assert.match(a.document.querySelector('#main').innerHTML,/could not download/);
  await a.driver.openPrivyLogin();
  assert.deepEqual(urls,['./privy-auth/v1/0/privy-auth.bundle.js','./privy-auth/v1/1/privy-auth.bundle.js']);assert.equal(logins,1);assert.equal(a.driver.state.actor,null);
});

test('an initial dialog loading failure destroys its SDK and retries the full graph',async t=>{
  const urls:Array<string|undefined>=[];let destroyed=0,logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async url=>{urls.push(url);return {createPrivyAuth:()=>({async initialize(){},mount(){},destroy(){destroyed++;},async login(){if(++logins===1)throw Object.assign(new Error('Sign-in did not open. Please try again.'),{code:'PRIVY_LOGIN_OPEN_FAILED'});}})};},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await a.driver.openPrivyLogin();
  assert.equal(destroyed,1);assert.match(a.document.querySelector('#main').innerHTML,/Sign-in did not open/);
  await a.driver.openPrivyLogin();
  assert.deepEqual(urls,['./privy-auth/v1/0/privy-auth.bundle.js','./privy-auth/v1/1/privy-auth.bundle.js']);assert.equal(logins,2);assert.equal(destroyed,1);
});

test('ordinary login cancellation keeps the ready SDK for the next sign-in',async t=>{
  let imports=0,destroyed=0,logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async()=>{imports++;return {createPrivyAuth:()=>({async initialize(){},mount(){},destroy(){destroyed++;},async login(){if(++logins===1)throw new Error('Privy login was cancelled.');}})};},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await a.driver.openPrivyLogin();await a.driver.openPrivyLogin();
  assert.equal(imports,1);assert.equal(destroyed,0);assert.equal(logins,2);
});

test('late modal loading failure cannot destroy the authenticated workspace',async t=>{
  const opening=deferred();let destroyed=0;
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async()=>({createPrivyAuth:()=>({async initialize(){},mount(){},destroy(){destroyed++;},login:()=>opening.promise})}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const pending=a.driver.openPrivyLogin(),rejected=assert.rejects(pending,stale);await flush();
  a.identity('new-wallet');opening.reject(Object.assign(new Error('Sign-in did not open.'),{code:'PRIVY_LOGIN_OPEN_FAILED'}));
  await rejected;assert.equal(destroyed,0);assert.equal(a.driver.state.actor.id,'new-wallet');
});

test('a login SDK error raised before login returns remains visible with an enabled retry',async t=>{
  const a=dashboard(t,async()=>response(walletCapability),{importPrivyModule:async()=>({createPrivyAuth:({onError}:any)=>({async initialize(){},mount(){},destroy(){},async login(){onError(new Error('Sign-in service is unavailable.'));}})}),walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await a.driver.openPrivyLogin();
  const main=a.document.querySelector('#main'),button=main.querySelector('[data-privy-login]');
  assert.match(main.innerHTML,/Sign-in service is unavailable/);assert.equal(button.disabled,false);assert.equal(button.textContent,'Try again');
});


test('buyer-member sign-in opens offers and clears the former environment summary',async t=>{
 const a=dashboard(t,async url=>{
  if(url==='/v1/dev/session')return response({token:'buyer-session',actor:{id:'member',role:'buyer_member'}});
  if(url==='/v1/buyer/mandates')return response([]);
  throw Error('Unexpected buyer route: '+url);
 },{thotTransport:async()=>response({capabilities:{mode:'thot-testnet'}})});
 a.driver.state.environmentOverview={private:'former operator environment'};
 await a.driver.session('buyer_member');
 assert.equal(a.driver.state.view,'market');assert.equal(a.driver.state.environmentOverview,null);
 assert.match(a.document.querySelector('#main').innerHTML,/Offers renderer/);
 assert.ok(a.calls.every(({url})=>!url.startsWith('/v1/operator/')));
});

test('operator workspace failure cannot be swallowed into a successful refresh',async t=>{
 const a=dashboard(t,async url=>{
  if(url==='/v1/dev/session')return response({token:'owner-session',actor:{id:'owner',role:'operator_security'}});
  throw Error('Must stop before loading further operator data');
 },{thotTransport:async()=>response({error:'FORBIDDEN'},403)});
 await assert.rejects(a.driver.session('operator_security'));
 assert.equal(a.driver.state.loaded,false);assert.equal(a.driver.state.thot,null);
 assert.ok(a.calls.every(({url})=>!url.startsWith('/v1/operator/')&&url!=='/v1/thot/sampling'));
});

function memoryStorage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)};}
test('navigation memory restores only a permitted view for the same actor and role',t=>{
 const storage=memoryStorage(),a=dashboard(t,async()=>{throw Error('Navigation must not fetch');},{storage});
 a.driver.state.view='market';a.driver.rememberView();a.driver.state.view='vault';assert.equal(a.driver.restoredView(),'market');
 a.identity('other-user');assert.equal(a.driver.restoredView(),'vault');
 a.identity('user-old','buyer_member');assert.equal(a.driver.restoredView(),'market');
 storage.setItem('thot.workspace-view.v1',JSON.stringify({actor:'user-old',role:'buyer_member',view:'vault'}));assert.equal(a.driver.restoredView(),'market');
 a.identity();storage.setItem('thot.workspace-view.v1',JSON.stringify({actor:'user-old',role:'user',view:'operator'}));assert.equal(a.driver.restoredView(),'vault');
 storage.setItem('thot.workspace-view.v1','invalid');assert.equal(a.driver.restoredView(),'vault');
 a.driver.state.view='earnings';a.driver.rememberView();a.driver.forgetView();assert.equal(a.driver.restoredView(),'vault');
});
test('denied browser storage never blocks navigation',t=>{
 const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};
 const a=dashboard(t,async()=>response({}),{storage});a.driver.state.view='market';assert.doesNotThrow(()=>a.driver.rememberView());assert.equal(a.driver.restoredView(),'vault');assert.doesNotThrow(()=>a.driver.forgetView());
});
const pendingBuyerWorkspace=()=>({capabilities:{mode:'thot-anvil'},wallet:'0x1111',account:{balance:'100'},orders:[{id:'purchase',buyer:'0x1111',receipt:{status:2}}]});
function purchasePage(a:any){a.driver.state.view='market';a.driver.state.thot=pendingBuyerWorkspace();const target=a.document.createElement('purchases');a.elements.set('#thot-buyer-purchases',target);return target;}
test('pending buyer refresh reads once and updates only purchase cards without replaying payment',async t=>{
 const pending=deferred(),a=dashboard(t,async()=>{throw Error('No other endpoint');},{thotTransport:async()=>pending.promise});
 const target=purchasePage(a);a.document.querySelector('#main').innerHTML='Contributor form input remains here';
 const checking=a.driver.refreshPurchases();await flush();await a.driver.refreshPurchases();assert.equal(a.calls.length,1);
 const latest=pendingBuyerWorkspace();latest.orders[0].receipt.status=3;pending.resolve(response(latest));await checking;
 assert.equal(a.driver.state.thot,latest);assert.equal(target.innerHTML,'<h2>Updated purchase cards</h2>');assert.equal(a.document.querySelector('#main').innerHTML,'Contributor form input remains here');
 assert.equal(a.calls[0].url,'/v1/thot/workspace');assert.equal(a.calls[0].init.method,'GET');assert.equal(a.driver.pendingPurchases(),false);
});
test('pending delivery polling stops after twelve reads and skips dialogs, other views and other buyers',async t=>{
 const a=dashboard(t,async()=>response({}),{thotTransport:async()=>response(pendingBuyerWorkspace())});purchasePage(a);
 a.document.querySelector('#detail-dialog').open=true;await a.driver.refreshPurchases();assert.equal(a.calls.length,0);
 a.document.querySelector('#detail-dialog').open=false;a.driver.state.view='vault';await a.driver.refreshPurchases();assert.equal(a.calls.length,0);
 a.driver.state.view='market';a.driver.state.thot.orders[0].buyer='other';await a.driver.refreshPurchases();assert.equal(a.calls.length,0);
 a.driver.state.thot=pendingBuyerWorkspace();for(let i=0;i<15;i++)await a.driver.refreshPurchases();assert.equal(a.calls.length,12);
});
test('late purchase refresh cannot overwrite an account switch or an opened dialog',async t=>{
 for(const change of ['account','dialog']){
  const pending=deferred(),a=dashboard(t,async()=>response({}),{thotTransport:async()=>pending.promise});const target=purchasePage(a),before=a.driver.state.thot;
  const checking=a.driver.refreshPurchases();await flush();if(change==='account')a.identity('other-user');else a.document.querySelector('#detail-dialog').open=true;
  pending.resolve(response({...pendingBuyerWorkspace(),account:{balance:'PRIVATE-OLD-BALANCE'}}));await checking;assert.equal(a.driver.state.thot,before);assert.equal(target.innerHTML,'');
 }
});

test('restoring a wallet session reopens its saved page while another wallet starts in its own vault',async t=>{
 for(const actor of ['returning-user','another-user']){
  const storage=memoryStorage();storage.setItem('thot.workspace-view.v1',JSON.stringify({actor:'returning-user',role:'user',view:'market'}));
  const a=dashboard(t,async url=>url==='/v1/auth/capabilities'?response({mode:'wallet_siwe',wallet:{chain_id:31337}}):response([]),{storage,thotTransport:async()=>response({capabilities:{mode:'thot-anvil'}}),walletAuthFactory:config=>({async restore(){await config.onSession({actor:{id:actor,role:'user'}});return true;}})});
  await a.driver.startAuthentication();assert.equal(a.driver.state.view,actor==='returning-user'?'market':'vault');
 }
});

test('focused receipt summaries and delivery buttons do not prevent pending purchase confirmation',async t=>{
 for(const tagName of ['SUMMARY','BUTTON']){
  const latest=pendingBuyerWorkspace();latest.orders[0].receipt.status=3;
  const a=dashboard(t,async()=>response({}),{thotTransport:async()=>response(latest)}),target=purchasePage(a);
  let restoredFocus=false;
  const control:any={tagName,textContent:'Purchase receipt',dataset:{action:tagName==='BUTTON'?'thot-delivery':undefined,id:'purchase'},closest:()=>({dataset:{purchaseId:'purchase'}}),focus:()=>{restoredFocus=true;}};
  const details={open:false,querySelector:()=>control};
  (a.document as any).activeElement=control;target.contains=()=>true;
  target.querySelectorAll=(selector:string)=>selector==='details[open]'?[details]:selector==='details'?[details]:[control];
  await a.driver.refreshPurchases();assert.equal(a.calls.length,1);assert.equal(a.driver.state.thot.orders[0].receipt.status,3);assert.equal(target.innerHTML,'<h2>Updated purchase cards</h2>');assert.equal(restoredFocus,true);assert.equal(details.open,true);
 }
});
test('editable purchase controls still defer automatic card replacement',async t=>{
 for(const control of [{tagName:'INPUT'},{tagName:'SELECT'},{tagName:'TEXTAREA'},{tagName:'DIV',isContentEditable:true}]){
  const a=dashboard(t,async()=>{throw Error('Editing must not poll');}),target=purchasePage(a);
  (a.document as any).activeElement=control;target.contains=()=>true;await a.driver.refreshPurchases();assert.equal(a.calls.length,0);
 }
});

test('closed unfunded attempts do not poll; unknown payments and funded purchases still do',async t=>{
 const a=dashboard(t,async()=>response({}),{thotTransport:async()=>response(pendingBuyerWorkspace())});purchasePage(a);
 const closed={id:'expired',buyer:'0x1111',job_status:'blocked',last_error:'AUTHORIZATION_UNAVAILABLE',receipt:{status:0}};
 a.driver.state.thot.orders=[closed];assert.equal(a.driver.pendingPurchases(),false);await a.driver.refreshPurchases();assert.equal(a.calls.length,0);
 for(const extra of [{job_status:'complete'},{job_status:'awaiting_funding'},{job_status:'blocked',last_error:'AUTOMATION_PENDING'},{receipt:{status:2}}]){
  a.driver.state.thot.orders=[{...closed,...extra}];assert.equal(a.driver.pendingPurchases(),extra.job_status!=='complete');
 }
 a.driver.state.thot.orders=[closed,{id:'funded',buyer:'0x1111',receipt:{status:2}}];await a.driver.refreshPurchases();assert.equal(a.calls.length,1);assert.equal(a.calls[0].init.method,'GET');
});


const catalogueFixture=()=>({capabilities:{mode:'thot-production'},wallet:'0x1111',listings:[{id:'listed',title:'Listed research'}]});
function startMarket(a:any){a.driver.state.loaded=false;a.driver.state.view='market';a.driver.setAuthMode('wallet_siwe');}

test('an explicit marketplace fragment overrides remembered navigation without bypassing role rules',t=>{
 const storage=memoryStorage();storage.setItem('thot.workspace-view.v1',JSON.stringify({actor:'user-old',role:'user',view:'vault'}));
 const a=dashboard(t,async()=>response([]),{storage,hash:'#thot-available'});
 assert.equal(a.driver.restoredView(),'market');
 a.browser.location.hash='#thot-contribute';a.identity('user-old','buyer_member');assert.equal(a.driver.restoredView(),'market');
 a.browser.location.hash='#operator';a.identity();assert.equal(a.driver.restoredView(),'vault');
 a.browser.location.hash='#trace=preserved-library-link';assert.equal(a.driver.restoredView(),'vault');
});

test('catalogue paints before the chain workspace and keeps private balances unknown',async t=>{
 const workspace=deferred(),a=dashboard(t,async url=>url==='/v1/thot/catalog'?response(catalogueFixture()):response([]),{hash:'#thot-available',thotTransport:()=>workspace.promise});
 startMarket(a);const loading=a.driver.refresh();await flush();
 assert.match(a.document.querySelector('#main').innerHTML,/Listed research/);assert.equal(a.driver.state.loaded,false);assert.equal(a.driver.state.thot,undefined);
 assert.match(a.document.querySelector('#wallet-summary').innerHTML,/Loading balance/);assert.doesNotMatch(a.document.querySelector('#wallet-summary').innerHTML,/0\.0000/);
 assert.equal(a.calls.filter(c=>c.url==='/v1/thot/catalog').length,1);assert.ok(a.calls.some(c=>c.url==='/v1/thot/workspace'));
 workspace.resolve(response({capabilities:{mode:'thot-production'},orders:[]}));await loading;
 assert.equal(a.driver.state.loaded,true);assert.match(a.document.querySelector('#main').innerHTML,/Offers renderer/);
});

test('unrelated slow contributor reads do not hide the already loaded catalogue',async t=>{
 const library=deferred(),a=dashboard(t,async url=>url==='/v1/thot/catalog'?response(catalogueFixture()):url.startsWith('/v1/contributor/library')?library.promise:response([]),{thotTransport:async()=>response({capabilities:{mode:'thot-production'},orders:[]})});
 startMarket(a);const loading=a.driver.refresh();await flush();
 assert.match(a.document.querySelector('#main').innerHTML,/Listed research/);assert.equal(a.driver.state.loaded,false);
 library.resolve(response({items:[]}));await loading;assert.equal(a.driver.state.loaded,true);
});

test('an accepted wallet session survives account data failure and leaves catalogue readable',async t=>{
 const workspace=deferred(),a=dashboard(t,async url=>url==='/v1/thot/catalog'?response(catalogueFixture()):response([]),{hash:'#thot-available',thotTransport:()=>workspace.promise});
 startMarket(a);const accepted=a.driver.acceptClerkSession({actor:{id:'accepted',role:'user'}});await flush();
 const before=a.document.querySelector('#main').innerHTML;workspace.reject(Error('RPC unavailable'));await accepted;
 assert.equal(a.driver.state.actor.id,'accepted');assert.equal(a.driver.state.workspaceError,true);assert.equal(a.driver.state.loaded,false);
 assert.equal(a.document.querySelector('#main').innerHTML,before,'failure updates status without replacing browse controls');
 assert.match(a.document.querySelector('#wallet-summary').innerHTML,/Balance unavailable/);
 assert.match(a.document.querySelector('#main').querySelector('[data-catalogue-account-status]').textContent,/could not load/);
});

test('late catalogue cannot replace a complete account view',async t=>{
 const catalog=deferred(),a=dashboard(t,async url=>url==='/v1/thot/catalog'?catalog.promise:response([]),{thotTransport:async()=>response({capabilities:{mode:'thot-production'},orders:[]})});
 startMarket(a);await a.driver.refresh();const before=a.document.querySelector('#main').innerHTML;
 catalog.resolve(response(catalogueFixture()));await flush();
 assert.equal(a.driver.state.loaded,true);assert.equal(a.document.querySelector('#main').innerHTML,before);assert.equal(a.driver.state.catalogue,null);
});

test('account changes and logout discard in-flight catalogue and chain responses',async t=>{
 for(const change of ['switch','logout']){
  const catalog=deferred(),workspace=deferred(),a=dashboard(t,async()=>catalog.promise,{thotTransport:()=>workspace.promise});
  startMarket(a);const loading=a.driver.refresh(),rejected=assert.rejects(loading,stale);await flush();
  a.driver.invalidatePrivateState();if(change==='switch')a.identity('other-user');
  a.document.querySelector('#main').innerHTML='New account';catalog.resolve(response(catalogueFixture()));workspace.resolve(response({capabilities:{mode:'thot-production'},account:{balance:'old-private-balance'}}));
  await rejected;await flush();assert.equal(a.driver.state.catalogue,null);assert.equal(a.document.querySelector('#main').innerHTML,'New account');
 }
});

test('partial catalogue blocks mutation dispatch until the full account is ready',async t=>{
 const a=dashboard(t,async()=>{throw Error('Must not fetch');});startMarket(a);
 for(const action of ['thot-buy','thot-reserve-buy','thot-unlist','thot-send','thot-list-configure','import'])await assert.rejects(a.driver.runAction(action,{dataset:{id:'listed'}}),/Account details are still loading/);
 assert.equal(a.calls.length,0);
});

test('same-page marketplace fragment selects Offers and scrolls the mounted section once',async t=>{
 const a=dashboard(t,async()=>response([]),{hash:'#thot-available'});let scrolls=0;
 const target=a.document.createElement('available');target.scrollIntoView=()=>scrolls++;a.elements.set('#thot-available',target);
 a.driver.state.view='vault';a.driver.state.thot={capabilities:{mode:'thot-production'}};
 assert.equal(a.driver.acceptMarketFragment(),true);assert.equal(a.driver.state.view,'market');assert.equal(scrolls,1);
 a.driver.render();assert.equal(scrolls,1,'routine rendering must not scroll the reader back');
});
