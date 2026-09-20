import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const applicationSource = await readFile(new URL('../apps/dashboard/app.js', import.meta.url), 'utf8');
// Execute the repository's actual dashboard logic, not a copied API implementation. UI module factories are
// replaced by inert collaborators and only the automatic initial network bootstrap is disabled.
const source = applicationSource.replace(/^import .*;\r?\n/gm, '').replace("import('./privy-auth.bundle.js')", 'globalThis.importPrivyModule()').replace(/^void safely\((?:async\(\)=>\{const capability=.*|startAuthentication)\);?\r?$/m, '') + `
globalThis.testDriver = { api, safely, session, showIdentityLogin, runAction, state, pendingKeys, earningsRecords, earnings, market, thot, render, refreshEarnings, startAuthentication, loadPrivyAuth, openPrivyLogin,
  setAuthMode(value) { authMode = value; }, setClerkAuth(value) { clerkAuth = value; } };
`;
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const response = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const stale = (error: any) => error?.name === 'StaleWorkspaceError';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function documentFixture() {
  const documentHandlers=new Map<string,Array<(event:any)=>unknown>>();
  const elements = new Map<string, any>();
  const make = (name: string) => {
    let html = ''; const handlers = new Map<string, Array<(event: any) => unknown>>(), children = new Map<string, any>();
    const element: any = { name, hidden: true, disabled: false, open: false, value: '', textContent: '', isConnected: true, dataset: {},
      classList: { toggle() {} }, addEventListener(type: string, handler: (event: any) => unknown) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
      querySelector(selector: string) { if (!children.has(selector)) children.set(selector, make(name + ' ' + selector)); return children.get(selector); },
      querySelectorAll() { return []; }, insertAdjacentHTML(_position: string, content: string) { html += content; },
      scrollIntoView() {}, remove() { element.isConnected = false; }, append() {}, click() {},
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
  for (const selector of ['#main', '#detail-dialog', '#dialog-content', '#dialog-error', '#notice', '#toast', '#role', '.brand', '.environment', '.local-tools']) elements.set(selector, make(selector));
  const document = { querySelector(selector: string) { return elements.get(selector) ?? null; }, querySelectorAll() { return []; }, addEventListener(type:string,handler:(event:any)=>unknown) {documentHandlers.set(type,[...(documentHandlers.get(type)??[]),handler]);},
    dispatch(type:string,event:any){for(const callback of documentHandlers.get(type)??[])callback(event);},
    createElement: (name: string) => make(name), body: make('body') };
  return { document, elements };
}
function dashboard(t: any, transport: (url: string, init: any) => Promise<any>, options: { thotTransport?: (url: string, init: any) => Promise<any>; librarySubmit?: (form:any)=>Promise<boolean>; walletAuthFactory?:(config:any)=>any; importPrivyModule?:()=>Promise<any>; privyTimeoutMs?:number } = {}) {
  const dom = documentFixture(), calls: Array<{ url: string; init: any }> = [], timers = new Set<ReturnType<typeof setTimeout>>(), controllers = new Set<AbortController>();
  const context: any = { bindStakingPreview:()=>()=>{}, window:{addEventListener(){}}, createRobinhoodSetupUI:()=>({authReady(){},authLost(){},handle:async()=>false,onDialogCancel(){}}), document: dom.document, AbortController:class extends AbortController{constructor(){super();controllers.add(this);}}, URL, Blob, crypto: { randomUUID },
    setTimeout(callback: () => void, duration: number) { const timer = setTimeout(callback, duration===30000?(options.privyTimeoutMs??duration):duration); timers.add(timer); return timer; },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { clearTimeout(timer); timers.delete(timer); },
    fetch(url: string, init: any = {}) { calls.push({ url, init }); return url==='/v1/thot/workspace'?(options.thotTransport?.(url,init)??Promise.resolve(response({capabilities:{mode:'unconfigured'}}))):url==='/v1/money/capabilities'?Promise.resolve(response({mode:'mock'})):transport(url, init); },
    createInferenceUI: () => ({ actionHTML: () => '', historyHTML: () => '', handle: async () => false }),
    createThotUI:()=>({offersHTML:()=>'<h1>Offers renderer</h1>',earningsHTML:()=>'<h1>Earnings renderer</h1>',tokenHTML:()=>'<h1>THOT renderer</h1>',valuationsHTML:()=>'',samplingHTML:()=>'<h1>Treasury sampler</h1>',action:async()=>false}),
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
  return { ...dom, driver, calls, identity, login, abortRequests(){for(const controller of controllers)controller.abort();} };
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
  await parsing.promise; a.driver.showIdentityLogin('Signed out.'); const loginForm = a.document.querySelector('#identity-form');
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
 a.driver.showIdentityLogin('Signed out.');
 assert.equal(a.driver.state.thot,null);
 const login=a.document.querySelector('#main').innerHTML;
 for(const view of ['earnings','thot','market']){a.driver.state.view=view;a.driver.render();assert.equal(a.document.querySelector('#main').innerHTML,login);}
 assert.doesNotMatch(login,/PRIVATE-WALLET|PRIVATE-SALE/);
});

test('an unsuccessful role switch clears the previous THOT account before loading new records',async t=>{
 const a=dashboard(t,async()=>response({error:'UNAVAILABLE'},503));
 a.driver.state.thot={wallet:'PRIVATE-OLD-WALLET',orders:[{title:'PRIVATE-OLD-SALE'}]};
 await assert.rejects(a.driver.session('buyer_admin'));
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

test('slow Privy bundle download times out without replacing the sign-in action or accepting late completion',async t=>{
  const download=deferred();let created=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:10,importPrivyModule:()=>download.promise,walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();const html=a.document.querySelector('#main').innerHTML;
  await assert.rejects(a.driver.loadPrivyAuth(),/took too long to load/);assert.equal(a.document.querySelector('#main').innerHTML,html);assert.equal(a.driver.state.actor,null);
  download.resolve({createPrivyAuth(){created++;return {};}});await flush();assert.equal(created,0,'a timed-out import never mounts an SDK instance');assert.equal(a.driver.state.actor,null);
});

test('Privy readiness is bounded after download and failure allows a fresh retry',async t=>{
  const readiness=deferred();let imports=0,destroyed=0,logins=0;
  const a=dashboard(t,async()=>response(walletCapability),{privyTimeoutMs:10,importPrivyModule:async()=>{imports++;return {createPrivyAuth:()=>({initialize:()=>imports===1?readiness.promise:Promise.resolve(),mount(){},destroy(){destroyed++;},async login(){logins++;}})};},walletAuthFactory:()=>({async restore(){return false;}})});
  await a.driver.startAuthentication();await assert.rejects(a.driver.loadPrivyAuth(),/took too long/);assert.equal(destroyed,1);
  await a.driver.openPrivyLogin();assert.equal(imports,2);assert.equal(logins,1);readiness.resolve(null);await flush();assert.equal(logins,1);
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
  assert.match(main.innerHTML,/took too long to load/);assert.doesNotMatch(main.innerHTML,/data-wallet-login/);assert.match(main.innerHTML,/data-privy-login>Sign in<\/button>/);assert.ok(!main.innerHTML.includes('workspace is unavailable'));assert.equal(a.driver.state.actor,null);
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
