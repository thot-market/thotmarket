import {createOpenRouterUI} from './openrouter-ui.js';
import {createWalletAuth} from './wallet-auth-ui.js';
import {createThotUI} from './thot-ui.js';
import {bindStakingPreview} from './staking-ui.js';
import {createThotAnalyticsUI} from './thot-analytics-ui.js';
import {createMoneyUI} from './money-ui.js';
import { createInferenceUI } from './inference-ui.js';
import { createMandateEditor } from './mandate-editor.js';
import { createOperationsUI } from './operations-ui.js';
import {createLibraryUI,createTraceExplorerUI} from './library-ui.js';
import { createContributorUI } from './contributor-ui.js';
import { createClerkAuthUI } from './clerk-auth-ui.js';
import { createAgentCaptureUI } from './agent-capture-ui.js';
import { createRobinhoodSetupUI } from './robinhood-setup-ui.js';
import { copySetupCommand } from './setup-ui.js';
const state = { token: null, actor: null, role: 'user', view: 'vault', traces: [], candidates: [], earnings: { entitlements: [], settlements: [], burn_allocations: [] }, mandates: [], contributorPortfolio: {items:[],robinhood:{status:'not_linked'}}, loaded: false, generation: 0, inferenceCapabilities: {enabled:false}, inferenceRequests: [] };
const main = document.querySelector('#main');
bindStakingPreview(main);
const dialog = document.querySelector('#detail-dialog');
const pendingKeys = new Map();
const sessionRecoveries = new Map();
const inferenceFlows = new Map();
let toastTimer;
let activePreview = null;
let activeInference = null;
let authMode='development';
let clerkAuth=null;
let walletAuth=null;
let privyAuth=null, privyConfig=null, privyLoading=null;
let earningsTimer=null, earningsRefreshRunning=false, fullRefreshCount=0;
let earningsUpdatedAt=null, earningsRefreshError=false;
let signingOut=false, walletLoginAttempt=0;
const initialView=role=>role==='user'?'vault':['buyer_admin','buyer_member'].includes(role)?'market':'operator';
const isThotMode=mode=>['thot-anvil','thot-testnet','thot-production'].includes(mode);

function stopEarningsRefresh() { clearTimeout(earningsTimer); earningsTimer=null; }
function earningsVisible() {
  return !signingOut && state.loaded && state.actor && (state.token || ['clerk','wallet_siwe'].includes(authMode)) && state.role==='user' && state.view==='earnings' && !document.hidden;
}
function scheduleEarningsRefresh() {
  stopEarningsRefresh();
  if (!earningsVisible()) return;
  earningsTimer=setTimeout(async()=>{
    earningsTimer=null;
    try { await refreshEarnings(); } finally { scheduleEarningsRefresh(); }
  },15000);
}
async function refreshEarnings() {
  if (!earningsVisible() || earningsRefreshRunning || fullRefreshCount || dialog.open) return;
  earningsRefreshRunning=true;
  const current=captureScope();
  try {
    if(isThotMode(state.thot?.capabilities.mode)){
      const workspace=await api('/v1/thot/workspace');
      current();
      if(!isThotMode(workspace?.capabilities?.mode))throw new Error('THOT contract state is unavailable.');
      state.thot=workspace;
    }else{
      const [earnings,candidates]=await Promise.all([api('/v1/earnings'),api('/v1/candidates')]);
      current();
      state.earnings=earnings;state.candidates=candidates;
    }
    earningsUpdatedAt=new Date();earningsRefreshError=false;
    if (earningsVisible()) render();
  } catch(error) {
    if(error.name!=='StaleWorkspaceError'){
      earningsRefreshError=true;
      const note=document.querySelector('#earnings-freshness');
      if(note&&earningsVisible())note.textContent='Could not refresh. Showing the last saved results; retrying automatically.';
    }
  } finally { earningsRefreshRunning=false; }
}

function staleWorkspace() { const error=new Error('The account view changed while the request was pending.');error.name='StaleWorkspaceError';return error; }
function captureScope() {
  const generation=state.generation,actorId=state.actor?.id,role=state.role;
  return ()=>{if(generation!==state.generation||actorId!==state.actor?.id||role!==state.role)throw staleWorkspace();};
}
function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const json = value => escape(JSON.stringify(value, null, 2));
const externalInference=createInferenceUI({state,api,openDialog,dialog,refresh,escape,json,money,badge});
const thotUI=createThotUI({state,api,openDialog,dialog,refresh,escape,json,toast,getProvider:()=>authMode==='wallet_siwe'?walletAuth?.getProvider():window.ethereum});
const analyticsUI=createThotAnalyticsUI({state,api,escape,toast});
const moneyUI=createMoneyUI({state,api,openDialog,dialog,refresh,escape,json,toast});
const mandateEditor=createMandateEditor({api,refresh,openDialog,dialog,toast,state});
const operationsUI=createOperationsUI({api,refresh,openDialog,dialog,toast,state,escape,json,money});
const short = value => String(value ?? '').length > 14 ? String(value).slice(0, 8) + '…' + String(value).slice(-4) : String(value ?? '');
const categoryName = category => ({ general: 'General trace', research_flow: 'Research Flow', professional_flow: 'Professional Flow' })[category] ?? 'Trace';
const roleName = role => ({ user: 'Contributor', buyer_admin: 'Buyer', buyer_member:'Buyer member',operator_security: 'Operator',operator_support:'Support' })[role]??'Scoped account';
function date(value) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Date unavailable'; }
const traceExplorerUI=createTraceExplorerUI({state,api,escape,openDialog});
const libraryUI=createLibraryUI({state,api,openDialog,dialog,escape,toast});
const contributorUI=createContributorUI({libraryUI,state,api,openDialog,dialog,refresh,toast,escape,json,badge,date,short});
const openrouterUI=createOpenRouterUI({state,api,openDialog,dialog,refresh,escape,toast,getProvider:()=>authMode==='wallet_siwe'?walletAuth?.getProvider():window.ethereum});
const agentCaptureUI=createAgentCaptureUI({state,api,openDialog,dialog,refresh,toast,escape,getProvider:()=>authMode==='wallet_siwe'?walletAuth?.getProvider():window.ethereum});
const robinhoodSetupUI=createRobinhoodSetupUI({state,api,openDialog,dialog,refresh,toast,escape});
function money(value, currency = 'USD') {
  try {
    if (!/^-?\d+$/.test(String(value))) return 'Unavailable';
    const amount = BigInt(value), negative = amount < 0n, absolute = negative ? -amount : amount;
    const decimals = { USD: 2, USDC: 6, THOT: 18 }[currency];
    if (decimals === undefined) return `${value} ${currency} minor units`;
    const base = 10n ** BigInt(decimals), whole = (absolute / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const fraction = (absolute % base).toString().padStart(decimals, '0');
    const displayFraction = currency === 'USD' ? fraction : fraction.replace(/0+$/, '');
    return `${negative ? '−' : ''}${currency === 'USD' ? '$' : ''}${whole}${displayFraction ? '.' + displayFraction : ''}${currency === 'USD' ? '' : ' ' + (state.money?.mode==='anvil'&&currency==='USDC'?'test dollars':currency)}`;
  } catch { return 'Unavailable'; }
}
function totals(records, field) {
  const result = {};
  for (const record of records) { const currency = record.currency ?? 'USD'; result[currency] = (result[currency] ?? 0n) + BigInt(record[field] ?? 0); }
  return Object.entries(result).map(([currency, value]) => money(value, currency)).join(' + ') || '$0.00';
}
function badge(status) {
  const value = String(status ?? 'UNKNOWN').toLowerCase();
  const style = /reject|fail|revoke/.test(value) ? 'error' : /pending|review|defer/.test(value) ? 'warn' : /active|available|verified|eligible|licensed|funded|final|credit/.test(value) ? 'success' : 'neutral';
  return `<span class="pill ${style}">${escape(value.replaceAll('_', ' '))}</span>`;
}
function empty(title, description, action = '') { return `<div class="empty"><span class="empty-symbol" aria-hidden="true">◈</span><h3>${escape(title)}</h3><p>${escape(description)}</p>${action}</div>`; }
function toast(message) {
  const target = document.querySelector('#toast'); target.textContent = message; target.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { target.hidden = true; }, 6500);
}
const errorMessages = {
  INTERNAL_ERROR: 'The service could not finish this request. Refresh to check its current state before retrying an action.',
  NO_ELIGIBLE_SAMPLES: 'No authorized traces match this sampling budget yet. Try a different scope or wait for contributors to opt in. No tokens were spent.',
  SAMPLE_BUDGET_EXCEEDS_CURRENT_ALLOWANCE: 'This budget exceeds the reserve’s current spending allowance. Refresh the balance and choose a smaller budget.',
  AUTHORIZATION_UNAVAILABLE: 'This sale authorization has expired, been revoked or already been used. Refresh to see available traces.',
  LISTING_NOT_PREPARED: 'This listing can no longer be activated. Preview the trace again to prepare fresh sale terms.',
  EXPLICIT_AUTOMATIC_SALE_CONSENT_REQUIRED: 'Review the trace, licence and price, then authorize the automatic sale before enabling it.',
  THOT_DELIVERY_OPERATOR_REQUIRED: 'Your funded release is queued for operator acknowledgment. Its content stays private until delivery is recorded. Retry after the operator processes it.',
  THOT_DAILY_PREPARATION_LIMIT: 'This account has reached its limit of 10 prepared offers in 24 hours. Existing orders remain available.',
  LICENSE_RETENTION_EXPIRED: 'This license’s 30-day retrieval period has ended.',
  FORBIDDEN: 'This action is unavailable for your current account and role.',
  NOT_FOUND: 'That record is unavailable to your current account.',
  POLICY_REQUIRED: 'Create a licensing policy first, then run pending jobs to discover matches.',
  POLICY_CHANGED: 'Your policy changed after this offer was prepared. Refresh the offer before authorizing it.',
  CANDIDATE_EXPIRED: 'This offer has expired. Refresh Offers for current offers.',
  CANDIDATE_ALREADY_AUTHORIZED: 'This offer has already been authorized. Refresh to see its latest status.',
  AUTHORIZATION_HASH_MISMATCH: 'The release commitment changed. Refresh and review the current release.',
  BUDGET_EXHAUSTED: 'This buyer mandate no longer has enough available funding.',
  TOKEN_DISABLED: 'Token payouts are disabled in this environment.',
  DEVELOPMENT_DISABLED: 'Local simulation controls are disabled in this environment.',
  BUNDLE_REQUIRED: 'Choose or paste a supported source bundle before importing.',
  UNAUTHENTICATED: 'The local session could not be restored. Reselect your role to reconnect, then retry the same action.',
};
async function reconnect(actor, role, expiredToken, signal) {
  const checkScope=captureScope();
  if(authMode!=='development'){showIdentityLogin('Your access credential expired or was revoked. Reconnect through your configured issuer; no development identity will be substituted.');throw new Error('A new verified access credential is required.');}
  if (!actor || state.role !== role || state.actor?.id !== actor.id) throw new Error('Your role changed during this request. Continue from the current workspace.');
  if (state.token && state.token !== expiredToken) return state.token;
  if (!sessionRecoveries.has(expiredToken)) {
    const recovery = (async () => {
      const response = await fetch('/v1/dev/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ role }), signal, cache: 'no-store' });
      checkScope();
      let result; try { result = await response.json(); } catch { throw new Error('The local session could not be restored. Reselect your role to reconnect.'); }
      checkScope();
      if (!response.ok || !result.token || result.actor?.id !== actor.id || result.actor?.role !== role) throw new Error('The local session could not be restored for the same account. Reselect your role to reconnect.');
      if (state.role !== role || state.actor?.id !== actor.id) throw new Error('Your role changed during reconnection. Continue from the current workspace.');
      state.token = result.token;
      return result.token;
    })();
    sessionRecoveries.set(expiredToken, recovery);
  }
  try { return await sessionRecoveries.get(expiredToken); }
  finally { sessionRecoveries.delete(expiredToken); }
}
async function api(path, options = {}) {
  const checkScope=captureScope();
  const method = options.method ?? 'GET', body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const actor = state.actor, role = state.role;
  const token = authMode === 'clerk' && path !== '/v1/auth/capabilities' ? await clerkAuth?.getToken() : state.token;
  checkScope();
  const operation = `${actor?.id ?? 'session'}:${method}:${path}:${options.sensitive?'private-connection':body ?? ''}`;
  const headers = { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') { if (options.idempotencyKey) pendingKeys.set(operation, options.idempotencyKey); else if (!pendingKeys.has(operation)) pendingKeys.set(operation, crypto.randomUUID()); headers['Idempotency-Key'] = pendingKeys.get(operation); }
  const verification = /^\/v1\/contributor\/robinhood\/link-jobs\/[^/]+\/complete$/.test(path);
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), verification ? 125000 : 25000);
  let readRetried=false;
  const request=async()=>{
    let response=await fetch(path,{method,headers,body,credentials:'same-origin',redirect:'error',signal:controller.signal,cache:'no-store'});
    checkScope();
    if(method==='GET'&&!readRetried&&[500,502,503,504].includes(response.status)){
      readRetried=true;
      await response.body?.cancel();
      controller.signal.throwIfAborted();
      await new Promise((resolve,reject)=>{
        const aborted=()=>{clearTimeout(timer);reject(controller.signal.reason);};
        const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',aborted);resolve();},1000);
        controller.signal.addEventListener('abort',aborted,{once:true});
      });
      checkScope();controller.signal.throwIfAborted();
      response=await fetch(path,{method,headers,body,credentials:'same-origin',redirect:'error',signal:controller.signal,cache:'no-store'});
      checkScope();
    }
    return response;
  };
  try {
    let response = await request();
    checkScope();
    if(response.status===401&&['clerk','wallet_siwe'].includes(authMode)){
      showIdentityLogin('Your session expired. Sign in again to continue.');
      throw staleWorkspace();
    }
    if (response.status === 401 && token && path !== '/v1/dev/session' && !['clerk','wallet_siwe'].includes(authMode)) {
      headers.Authorization = 'Bearer ' + await reconnect(actor, role, token, controller.signal);
      checkScope();
      // One retry, with the exact original body and Idempotency-Key. Never repeat as a new mutation.
      response = await request();
      checkScope();
    }
    let data; try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Check that the thot market service is running.'); }
    checkScope();
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code ?? data.code;
      const safeCode = /^[A-Z0-9_]{1,90}$/.test(code ?? '') ? code : null;
      throw Object.assign(new Error(errorMessages[safeCode] ?? `The request could not be completed${safeCode ? ' (' + safeCode + ')' : ''}. No success has been recorded in this view.`),{code:safeCode});
    }
    pendingKeys.delete(operation); return data;
  } catch (error) {
    checkScope();
    if (error.name === 'AbortError') throw new Error('The server took too long to respond. Refresh before retrying; the same pending request will keep its idempotency key.');
    if (error instanceof TypeError) throw new Error('Cannot reach the thot market service. Start the server and refresh this page.');
    throw error;
  } finally { clearTimeout(timeout);if(options.sensitive)pendingKeys.delete(operation); }
}
function notice(message) {
  const target = document.querySelector('#notice');
  target.innerHTML = `${escape(message)}<button data-action="refresh">Refresh</button><button data-action="dismiss-notice" aria-label="Dismiss message">Dismiss</button>`;
  target.hidden = false;
}
function loading() { main.innerHTML = '<div class="loading"><span class="spinner"></span><p>Reading your records…</p></div>'; }
async function session(role) {
  if(authMode!=='development')throw new Error('Your verified identity cannot switch to a development role. Sign out to connect another authorized identity.');
  stopEarningsRefresh();earningsUpdatedAt=null;earningsRefreshError=false;
  signingOut=false;
  openrouterUI.reset();
  analyticsUI.reset();
  agentCaptureUI.authLost();
  robinhoodSetupUI.authLost();
  contributorUI.reset();
  state.generation++; state.loaded = false; state.token = null; state.actor = null; state.thot=null; state.thotSampling=null; state.money=null; state.canExplore=false;state.traceExplorer=null; state.role = role;state.environmentOverview=null;
  activePreview = null; if (dialog.open) dialog.close(); loading();
  document.querySelector('#role').value = role;
  const result = await api('/v1/dev/session', { method: 'POST', body: { role } });
  state.token = result.token; state.actor = result.actor;state.canExplore=result.permissions?.trace_explorer===true;
  state.view = initialView(role);
  await refresh();
}
async function refresh() {
  fullRefreshCount++;stopEarningsRefresh();
  try { return await refreshWorkspace(); }
  finally { fullRefreshCount--;scheduleEarningsRefresh(); }
}
async function refreshWorkspace() {
  if (!state.token && !(['clerk','wallet_siwe'].includes(authMode)&&state.actor)) return authMode==='development'?session(state.role):showIdentityLogin();
  const generation = ++state.generation, role = state.role;
  const moneyCapabilities=await api('/v1/money/capabilities');
  const thotWorkspace=['user','buyer_admin','buyer_member','operator_security'].includes(role)?await api('/v1/thot/workspace'):null;
  let sampling=null,disputes=null;
  if(role==='operator_security'||thotWorkspace?.reserve_buyer||thotWorkspace?.account?.dispute_reviewer){const c=await api('/v1/thot/capabilities');if(isThotMode(c.mode))sampling=await api('/v1/thot/sampling');}
  if(thotWorkspace?.account?.dispute_reviewer)disputes=await api('/v1/thot/disputes');
  if(generation!==state.generation)return;
  state.money=moneyCapabilities;state.thot=thotWorkspace;state.thotSampling=sampling;state.thotDisputes=disputes;
  if (!state.loaded) loading();
  if (role === 'user') {
    const [traces, candidates, earnings, inferenceCapabilities, inferenceRequests, contributorPortfolio, traceLibrary] = await Promise.all([api('/v1/traces'), api('/v1/candidates'), api('/v1/earnings'), api('/v1/inference/capabilities'), api('/v1/inference/requests'), api('/v1/contributor/portfolio'), api('/v1/contributor/library'+libraryUI.queryString())]);
    if (generation !== state.generation) return;
    Object.assign(state, { traces, candidates, earnings, inferenceCapabilities, inferenceRequests, contributorPortfolio, traceLibrary });
    earningsUpdatedAt=new Date();earningsRefreshError=false;
  } else if(role==='operator_security'){state.traceExplorer=await api('/v1/operator/trace-explorer');
  } else if (role === 'buyer_admin'||role==='buyer_member') {
    const mandates = await api('/v1/buyer/mandates');
    if (generation !== state.generation) return; state.mandates = mandates;
  }
  if(state.view==='explorer'&&state.canExplore)state.traceExplorer=await api('/v1/operator/trace-explorer');
  state.loaded = true; document.querySelector('#notice').hidden = true; render(); libraryUI.ready(); agentCaptureUI.authReady(); robinhoodSetupUI.authReady();
}
function heading(eyebrow, title, description, action = '') { return `<section class="page-heading"><div><p class="eyebrow">${escape(eyebrow)}</p><h1>${escape(title)}</h1><p>${escape(description)}</p></div>${action}</section>`; }
function journey() {
  const hasTraces = state.traces.length > 0, hasMatches = state.candidates.length > 0, hasSales = state.earnings.settlements.length > 0;
  return `<section class="journey"><div class="section-head"><div><h2>One trace. One deliberate release.</h2><p>Walk through the complete local transaction.</p></div><span class="pill">SIMULATED DATA & FUNDS</span></div><div class="steps">
  <div class="step ${hasTraces ? 'done' : ''}"><span>${hasTraces ? '✓' : '01'}</span><h3>Capture a trace</h3><p>Import a source bundle or create a clearly labeled example.</p><button class="text-button" data-action="import">Add a trace →</button></div>
  <div class="step ${hasMatches ? 'done' : ''}"><span>${hasMatches ? '✓' : '02'}</span><h3>Find a funded match</h3><p>Set a policy, create a buyer mandate, then run pending jobs.</p><button class="text-button" data-action="policy">Set local policy →</button></div>
  <div class="step ${hasSales ? 'done' : ''}"><span>${hasSales ? '✓' : '03'}</span><h3>Review & authorize</h3><p>Approve the exact content, disclosed predicates and license.</p><button class="text-button" data-view="market">Review offers →</button></div>
  <div class="step ${hasSales ? 'done' : ''}"><span>${hasSales ? '✓' : '04'}</span><h3>Follow the value</h3><p>Run settlement jobs. Contributor value and burn stay separate.</p><button class="text-button" data-action="worker">Run pending jobs →</button></div></div></section>`;
}
function vault() {
  const pending = state.candidates.filter(c => c.status === 'USER_AUTH_PENDING').length;
  return heading('Developer example', 'Your trace, from import to receipt.', 'Keep your AI traces private. Choose the useful parts to share, with a record of every claim and permission.', '<button class="button" data-action="import">Add a trace <span>+</span></button>') +
  `<section class="metrics" aria-label="Your account summary"><article class="metric"><span class="metric-symbol" aria-hidden="true">◈</span><small>TRACES IN YOUR VAULT</small><strong>${state.traces.length}</strong><p>${state.traces.filter(t => t.status === 'REJECTED').length} blocked by rights checks</p></article><article class="metric"><span class="metric-symbol" aria-hidden="true">↗</span><small>AWAITING YOUR DECISION</small><strong>${pending}</strong><p>Exact releases ready for review</p></article><article class="metric highlight"><span class="metric-symbol" aria-hidden="true">◒</span><small>CONTRIBUTOR VALUE</small><strong>${escape(totals(state.earnings.entitlements, 'amount_minor'))}</strong><p>Recorded in the local ledger</p></article></section>` + journey() +
  `<div class="content-grid"><section class="panel"><div class="panel-heading"><h2>Your trace library</h2><small>${state.traces.length} ${state.traces.length === 1 ? 'record' : 'records'}</small></div>${state.traces.length ? state.traces.map(trace => `<article class="trace-row"><span class="trace-icon" aria-hidden="true">▤</span><div class="trace-info"><strong>${escape(categoryName(trace.category))}</strong><small>${escape(short(trace.trace_id))} · ${escape(date(trace.created_at))} · ${trace.sale_count ?? 0} licensed</small></div>${badge(trace.status)}<button data-action="trace" data-id="${escape(trace.trace_id)}" aria-label="Inspect ${escape(categoryName(trace.category))} ${escape(short(trace.trace_id))}">↗</button></article>`).join('') : empty('A private place to begin.', 'Add a local example to see provenance, rights checks and a complete licensed sale.', '<button class="button secondary small" data-action="import">Create your first trace</button>')}</section><aside class="aside-card"><h2>Evidence in layers.</h2><p>Each trace carries distinct claims. Inspect what verified and the limits of that evidence.</p><div class="receipt-layers"><div class="receipt-layer">Provenance<span>Where it came from</span></div><div class="receipt-layer">Credential<span>Optional cohort</span></div><div class="receipt-layer">Outcome<span>Optional action</span></div><div class="receipt-layer">Rights & permission<span>What can be shared</span></div></div><p class="footnote">Local example receipts are simulated. Live provider verification requires a configured supported integration.</p></aside></div>`;
}
function market() {
  if(isThotMode(state.thot?.capabilities.mode))return thotUI.offersHTML();
  if (state.role === 'buyer_admin'||state.role==='buyer_member') return buyerMarket();
  return heading('Your offers', 'Good work. Clear terms.', 'A funded buyer mandate becomes an offer only after policy, rights and evidence checks. You approve each exact release.', '<button class="button secondary" data-action="buyer-role">Open buyer workspace ↗</button>') + contributorUI.offerDemoHTML() +
  `<div class="section-head"><h2>Matched offers</h2><button class="text-button" data-action="worker">Refresh matching ↻</button></div><section class="cards">${state.candidates.length ? state.candidates.map(candidate => `<article class="panel candidate-card">${badge(candidate.status)}<h3>${escape(categoryName(state.traces.find(t => t.trace_id === candidate.trace_id)?.category))}</h3><p>Buyer ${escape(short(candidate.buyer_id))}<br>Mandate ${escape(short(candidate.mandate_id))}</p><div class="price">${escape(money(candidate.price_minor, candidate.currency ?? 'USD'))} <small>gross per licensed trace</small></div><div class="meta-pair"><span>Release commitment</span><strong class="mono">${escape(short(candidate.release_hash))}</strong></div><p class="legal-note">Offer expires ${escape(date(candidate.expires_at))}. No release without your exact authorization.</p><button class="button ${candidate.status === 'USER_AUTH_PENDING' ? '' : 'secondary'}" data-action="preview" data-id="${escape(candidate.candidate_id)}">${candidate.status === 'USER_AUTH_PENDING' ? 'Review release & license' : 'Inspect licensed release'} <span>↗</span></button></article>`).join('') : `<div class="panel empty-wide">${empty('Your next match starts here.', 'Set a contributor policy, create a funded mandate in the buyer workspace, and run pending jobs. Eligible matches will appear here.', '<button class="button secondary" data-action="policy">Set local policy</button>')}</div>`}</section>`;
}
function buyerMarket() {
  return heading('Buyer workspace', 'Ask for the work you need.', 'Fund a clear mandate. Receive only licensed releases that satisfy its criteria and the contributor’s permissions.', '<button class="button" data-action="mandate">Create local mandate +</button>') +
  `<section class="metrics"><article class="metric"><small>YOUR MANDATES</small><strong>${state.mandates.length}</strong><p>Across your local buyer account</p></article><article class="metric"><small>ACTIVE MANDATES</small><strong>${state.mandates.filter(m => m.status === 'active').length}</strong><p>Funded and available for matching</p></article><article class="metric highlight"><small>LICENSED RELEASES</small><strong>${state.mandates.reduce((count, m) => count + Number(m.units_sold ?? 0), 0)}</strong><p>Finalized contributor authorizations</p></article></section><div class="section-head"><h2>Your mandates</h2><button class="text-button" data-action="worker">Run matching jobs ↻</button></div><section class="cards">${state.mandates.length ? state.mandates.map(m => `<article class="panel candidate-card">${badge(m.status)}<h3>${escape(m.criteria?.workflow_types?.includes('investment_research') ? 'Research Flow' : (m.criteria?.workflow_types?.includes('legal_research') || m.criteria?.workflow_types?.includes('contract_review')) ? 'Professional Flow' : 'General AI work')}</h3><p>Mandate ${escape(short(m.mandate_id ?? m.id))}<br>Purpose: ${escape(m.license?.purpose ?? 'See license terms')}</p><div class="price">${escape(money(m.economics?.unit_price_minor, m.economics?.currency))} <small>per accepted trace</small></div><div class="meta-pair"><span>Funded budget</span><strong>${escape(money(m.funding?.funded_minor, m.economics?.currency))}</strong></div><div class="meta-pair"><span>Units licensed</span><strong>${m.units_sold ?? 0} / ${m.economics?.max_units ?? '—'}</strong></div><p class="legal-note">${moneyUI.active()?'Deposits and settlement execute on local Anvil with test assets.':'Development funding is simulated. Raw candidates and rejected inventory are not exposed here.'}</p><button class="button secondary" data-action="mandate-stats" data-id="${escape(m.mandate_id ?? m.id)}">View deliveries & budget ↗</button></article>`).join('') : `<div class="panel empty-wide">${empty('Start with a precise request.', 'Create a local fixed-price mandate for general traces, Research Flow or Professional Flow. The template uses simulated funding.', '<button class="button" data-action="mandate">Create a local mandate</button>')}</div>`}</section>`;
}
function earningsRecords() {
  const entitlements=state.earnings.entitlements??[], settlements=state.earnings.settlements??[];
  const validId=value=>typeof value==='string'&&value.length>0;
  const recorded=settlements.filter(s=>validId(s.settlement_id)&&validId(s.license_id));
  const settledIds=new Set(recorded.map(s=>s.license_id));
  const pending=[...new Map((state.candidates??[]).filter(c=>c.status==='LICENSED'&&validId(c.license_id)&&!settledIds.has(c.license_id)).map(c=>[c.license_id,c])).values()];
  const allocations=entitlements.map(item=>{
    const settlement=recorded.find(s=>s.settlement_id===item.settlement_id&&s.license_id===item.license_id);
    const receipt=settlement?.chain_receipt;
    const paid=!!(settlement&&item.status==='TOKEN_WITHDRAWN'&&item.test_assets===true&&typeof item.thot_atoms==='string'&&/^\d+$/.test(item.thot_atoms)&&receipt?.test_assets===true&&receipt.simulated===false&&receipt.approval_hash&&receipt.transaction_hash&&receipt.transaction_hash===item.transaction_hash&&receipt.paid_thot_atoms===item.thot_atoms);
    return {item,settlement,paid};
  });
  return {allocations,pending,recordedCount:new Set(allocations.filter(a=>a.settlement).map(a=>a.settlement.settlement_id)).size,paidCount:new Set(allocations.filter(a=>a.paid).map(a=>a.settlement.settlement_id)).size};
}
function earnings() {
  if(isThotMode(state.thot?.capabilities.mode))return thotUI.earningsHTML({updatedAt:earningsUpdatedAt,error:earningsRefreshError});
  const {allocations,pending,recordedCount,paidCount}=earningsRecords();
  const awaiting=(state.candidates??[]).filter(c=>c.status==='USER_AUTH_PENDING');
  const estimates=(state.contributorPortfolio?.items??[]).map(item=>item.appraisal).filter(Boolean);
  const demo=moneyUI.active()?'Local Anvil receipts · test assets':'Marketplace simulation · no real payments';
  const fresh=earningsUpdatedAt?`Updated ${earningsUpdatedAt.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',second:'2-digit'})}`:'Waiting for a first update';
  const cards=allocations.map(({item,settlement,paid})=>{
    return `<article class="panel earning-card"><header><h3>${paid?escape(money(item.thot_atoms,'THOT'))+' test tokens received':escape(money(item.amount_minor,item.currency))+(settlement?' demo allocation':' unconfirmed allocation')}</h3>${badge(item.disposition)}</header><p>License ${escape(short(item.license_id)||'not recorded')} · ${escape(date(item.created_at))}</p>${paid?'<p>This is a local test-token receipt, not a live THOT payment.</p>':settlement?'<p>Recorded allocation. This amount is not a confirmed token payout or withdrawable cash balance.</p>':'<p>No matching settlement receipt is recorded. This allocation is not counted as settled or paid.</p>'}${settlement?`<div class="money-breakdown"><div><small>Contributor allocation</small><strong>${escape(money(settlement.contributor_minor,item.currency))}</strong></div><div><small>Burn allocation</small><strong>${escape(money(settlement.burn_minor,item.currency))}</strong></div><div><small>Operator allocation</small><strong>${escape(money(settlement.operator_minor,item.currency))}</strong></div></div>`:''}<button class="text-button" data-action="${paid?'money-receipt':'entitlement'}" data-id="${escape(paid?item.license_id:(item.entitlement_id??item.id))}">${paid?'Inspect payment receipt':'Inspect allocation record'}</button>${settlement?burnAction(item)+inferenceAction(item):''}</article>`;
  }).join('');
  return heading('Earnings','The receipt is what counts.','Estimates help you evaluate a trace. Only completed payments belong in your payment history.')+
    `<div class="earnings-status"><p>${escape(demo)}</p><p id="earnings-freshness" role="status">${earningsRefreshError?'Could not refresh. Showing the last saved results.':escape(fresh)} · Refreshes every 15 seconds while this page is visible.</p></div>
    <section class="metrics" aria-label="Payment states"><article class="metric highlight"><small>${moneyUI.active()?'Confirmed test-token payouts':'Recorded demo allocations'}</small><strong>${moneyUI.active()?paidCount:recordedCount}</strong><p>${moneyUI.active()?'Backed by matching Anvil payment receipts.':'Matched to settlement records; no cash payout.'}</p></article><article class="metric"><small>Awaiting settlement</small><strong>${pending.length}</strong><p>Approved licenses with no recorded settlement yet.</p></article><article class="metric"><small>Offers to review</small><strong>${awaiting.length}</strong><p>An offer is not an earned balance.</p></article></section>
    <div class="content-grid"><section class="earnings-list">${cards||`<div class="panel">${empty('Your first receipt belongs here.','Save a supported trace, then review a specific offer. This demo does not issue live THOT or cash.','<button class="button secondary" data-view="market">Review offers</button>')}</div>`}${pending.length?`<section class="panel pending-payments"><h2>Awaiting settlement</h2>${pending.map(c=>`<div class="meta-pair"><span>License ${escape(short(c.license_id))}</span>${moneyUI.active()?`<button class="text-button" data-action="money-receipt" data-id="${escape(c.license_id)}">Check payment</button>`:'<span>Demo settlement pending</span>'}</div>`).join('')}</section>`:''}</section><aside class="aside-card earnings-explanation"><h2>Keep the numbers separate.</h2><p>The existing payment demonstration uses a 65% contributor, 20% burn and 15% operator split. It is not the proposed launch policy.</p><p>The THOT testnet flow pays the seller the purchase price minus a disclosed service fee. Eligible direct referrals receive 20% of net service contribution after quoted direct costs. Holding or locking does not change these terms. This legacy demonstration uses its separate allocation rules.</p><button class="text-button" data-view="thot">See the THOT proposal</button></aside></div>
    <details class="technical-details appraisal-separation"><summary>Trace estimates (${estimates.length}) · separate from earnings</summary><p>The current assay is an illustrative heuristic, not a buyer quote or market valuation. Its dollar estimate cannot be withdrawn or added to payment totals.</p>${estimates.length?`<p>Illustrative inventory estimate: <strong>${escape(totals(estimates.map(a=>({currency:'USD',estimate:a.estimated_value_minor})),'estimate'))}</strong></p>`:'<p>No appraisal records in this account yet.</p>'}</details>`;
}
function thot() {
  if(isThotMode(state.thot?.capabilities.mode))return thotUI.tokenHTML();
  const terms = [
    ['A trace purchase', 'THOT', 'The buyer funds the exact licensed purchase in escrow.'],
    ['Your proceeds', 'Price − fee', 'The quote shows the service fee and your proceeds before authorization.'],
    ['Direct referrals', '20% of net', 'From service contribution after quoted direct costs, when eligible.'],
  ];
  return heading('THOT','A payment for useful work.','Buyers pay for licensed traces. Your quoted proceeds come from that funded purchase.')+
    `<section class="thot-proposal"><div class="thot-proposal-intro"><img src="/assets/thot-logo.png" alt="" class="thot-proposal-logo"><div><p class="proposal-status">Mechanism overview · this workspace has no THOT connection</p><h2>A buyer for your useful work.</h2><p>The testnet mechanism deducts a disclosed service fee from each purchase. At the test calibration, a 1-THOT purchase pays the seller 0.96 THOT; a 100-THOT purchase pays 99.96 THOT. These are test tokens, not dollar prices.</p></div></div><div class="thot-terms">${terms.map(([label, value, description])=>`<article><span>${label}</span><strong>${value}</strong><p>${description}</p></article>`).join('')}</div><p class="thot-terms-note">Holding or locking THOT does not change the tariff. The buyer’s quote fixes the funded amounts, and future fee changes cannot rewrite an existing purchase.</p><div class="thot-unavailable"><a href="/mechanism">Read the mechanism</a></div></section>
    <section class="thot-details"><div><h2>Anyone can buy a trace.</h2><p>There is no membership surcharge. Fund the posted purchase price and receive the licensed release. Ordinary buyers can inspect supported properties before paying; they cannot peek at the conversation.</p><p>Seller proceeds become claimable after the contract’s configured dispute window from recorded delivery. A pending or disputed payment remains distinct from claimable proceeds.</p></div><div><h2>Refer a useful contributor.</h2><p>One direct referrer receives 20% of net service contribution after quoted direct costs on eligible finalized independent purchases. Register before the contributor’s first sale; their first qualifying order must be funded within 90 days, opening a 365-day funding window.</p><p>Treasury-funded, refunded, self, affiliated and reimbursed purchases do not earn referral payments. There are no recursive rewards or payments for token holdings. This workspace is not connected to the THOT contracts.</p></div></section>
    <section class="thot-details"><div><h2>The treasury can buy first.</h2><p>The selected 500 million THOT reserve buys licensed traces through the same escrow and service tariff. It funds actual acquisitions, not an extra bonus on top of seller proceeds.</p><p>The selected campaign authorizes 50 million THOT. The remaining 450 million are reserved for future incentives for people who contribute useful traces. Up to 1 million THOT of gross starter purchases needs no outside spending; beyond that, reviewed independent purchases permit at most 1:1 further treasury spending, within declining daily caps.</p><p>Reserve funds and contributors’ locked principal stay separate. Testnet governance allows any one of the three owners to authorize campaign changes without a governance delay. Owners still choose which traces to buy within the shared limits.</p><a href="/whitepaper">Read the full whitepaper</a></div><div><h2>A useful market can attract demand.</h2><p>Independent buyers may acquire THOT to pay for research. Funded purchases pay contributors, and useful traces may attract more buyers. Treasury payouts and sellers selling their proceeds can offset demand.</p><p>Earnings are completed trace payments. Token holdings and trace estimates are not a holding yield or a cash balance.</p><a href="/read">Why build a market for traces?</a></div></section>`;
}
function inferenceAction(item) {
  const id = item.entitlement_id ?? item.id;
  const pending = inferenceFlows.has(`${state.actor?.id}:${id}`);
  if (!pending && (item.disposition !== 'inference_credit' || BigInt(item.available_minor ?? 0) <= 0n)) return '';
  return `<div class="inference-action"><button class="button secondary small" data-action="inference" data-id="${escape(id)}">${pending ? 'Resume simulated inference' : 'Try simulated inference'} ↗</button><small>Reserve up to ${escape(money('100', item.currency))}; settle 80% of that amount. No model is called.</small></div>`+externalInference.actionHTML(item);
}
function burnStatus(record) {
  if (!record) return '<span class="pill neutral">record unavailable</span>';
  if (record.status === 'BURN_FINAL') return `<span class="pill success">${record.simulated ? 'simulated ' : ''}burn final</span>`;
  if (record.status === 'NO_ALLOCATION') return '<span class="pill neutral">no burn allocation</span>';
  return `<span class="pill warn">${record.simulated ? 'simulated · ' : ''}allocated, not final</span>`;
}
function burnAction(item) {
  const record = (state.earnings.burn_allocations ?? []).find(allocation => allocation.settlement_id === item.settlement_id);
  return `<div class="meta-pair"><span>Separate network burn</span><strong>${burnStatus(record)}</strong></div>${record ? `<button class="text-button" data-action="burn-record" data-id="${escape(record.settlement_id)}">Inspect burn record →</button>` : '<p class="legal-note">Refresh after settlement to load the separate burn record.</p>'}`;
}
function inferenceDialog(id) {
  const entitlement = state.earnings.entitlements.find(item => (item.entitlement_id ?? item.id) === id);
  if (!entitlement || state.role !== 'user') throw new Error('This inference entitlement is unavailable to the current account.');
  const key = `${state.actor.id}:${id}`;
  let flow = inferenceFlows.get(key);
  if (!flow) {
    const available = BigInt(entitlement.available_minor ?? 0);
    if (entitlement.disposition !== 'inference_credit' || available <= 0n) throw new Error('This entitlement has no available inference credit.');
    const reserved = available < 100n ? available : 100n;
    flow = { key, ownerId: state.actor.id, entitlementId: id, currency: entitlement.currency, reserved: reserved.toString(), actual: (reserved * 80n / 100n).toString(), reserveKey: crypto.randomUUID(), settleKey: crypto.randomUUID() };
  }
  openDialog('Try simulated inference', 'A local accounting exercise. No model or external provider is called.', `<div class="meta-pair"><span>Reservation</span><strong>${escape(money(flow.reserved, flow.currency))}</strong></div><div class="meta-pair"><span>Simulated actual usage</span><strong>${escape(money(flow.actual, flow.currency))}</strong></div><div class="meta-pair"><span>Released after settlement</span><strong>${escape(money(BigInt(flow.reserved) - BigInt(flow.actual), flow.currency))}</strong></div><p class="legal-note">This updates your local inference-credit ledger. Actual usage is 80% of the reservation, rounded down to a whole minor unit. Any unused reservation returns to your available credit.</p>${flow.reservation ? `<p class="legal-note">Resuming reservation ${escape(short(flow.reservation.reservation_id))}. The same request keys are retained for safe retry.</p>` : ''}`, '<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" data-action="run-inference">Run local simulation ↗</button>');
  activeInference = flow;
}
async function runInference() {
  const flow = activeInference;
  if (!flow || state.role !== 'user' || state.actor?.id !== flow.ownerId) throw new Error('Reopen the inference simulation in its contributor account.');
  inferenceFlows.set(flow.key, flow);
  if (!flow.reservation) flow.reservation = await api(`/v1/entitlements/${encodeURIComponent(flow.entitlementId)}/inference-reservations`, { method: 'POST', body: { amount_minor: flow.reserved }, idempotencyKey: flow.reserveKey });
  const result = await api('/v1/dev/inference-settle', { method: 'POST', body: { reservation_id: flow.reservation.reservation_id, actual_minor: flow.actual }, idempotencyKey: flow.settleKey });
  await refresh();
  const entitlement = state.earnings.entitlements.find(item => (item.entitlement_id ?? item.id) === flow.entitlementId);
  inferenceFlows.delete(flow.key); activeInference = null;
  openDialog('Simulated inference settled', 'The local ledger was updated. No model was called.', `<div class="meta-pair"><span>Reserved</span><strong>${escape(money(flow.reserved, flow.currency))}</strong></div><div class="meta-pair"><span>Actual simulated usage</span><strong>${escape(money(result.actual_minor, flow.currency))}</strong></div><div class="meta-pair"><span>Released to your credit</span><strong>${escape(money(BigInt(flow.reserved) - BigInt(result.actual_minor), flow.currency))}</strong></div><div class="meta-pair"><span>Available credit now</span><strong>${escape(money(entitlement?.available_minor, flow.currency))}</strong></div><h3>Reservation receipt</h3><pre class="json-view">${json(result)}</pre>`, '<button class="button" data-action="close-dialog">Done</button>');
  render();
}
function receipts() {
  return heading('PORTABLE EVIDENCE / RECEIPTS', 'A record you can take with you.', 'Export your provenance, credential and outcome receipts together with policies, authorizations, licenses and settlements.') +
  `<section class="panel audit-card"><p class="eyebrow">YOUR ACCOUNT / JSON EXPORT</p><h2>The complete permission trail.</h2><p>The export includes your account’s portable records and a canonical content commitment. Raw trace bodies and private credential or brokerage evidence stay outside this audit export.</p><div class="receipt-layers"><div class="receipt-layer">Source and scrub receipts<span>Versioned evidence</span></div><div class="receipt-layer">Policies and authorizations<span>Exact permission</span></div><div class="receipt-layer">Licenses and settlements<span>Economic records</span></div></div><button class="button" data-action="audit">Download audit export ↓</button><p class="legal-note">Exports are generated from the current local database, scoped to your contributor account.</p></section>`;
}
function operator() {
  if(isThotMode(state.thotSampling?.capabilities.mode))return thotUI.samplingHTML();
  return heading('OPERATIONS / LOCAL DEVELOPMENT', 'Move the transaction forward.', 'Process queued work and inspect simulated execution. These controls do not send real payments or submit live blockchain transactions.') +
  `<section class="panel audit-card"><p class="eyebrow">EXPLICIT LOCAL CONTROLS</p><h2>Work queues & mock finality.</h2><p>Pending jobs perform matching and settlement according to recorded permissions. Simulated burn completion exercises the separate network burn path.</p><div class="operator-actions"><button class="button" data-action="worker">Run pending jobs ↻</button><button class="button secondary" data-action="burn">Simulate burn completion ↗</button><button class="button secondary" data-action="reconciliation">Inspect reconciliation ↗</button></div><p class="legal-note">Compute remains future scope. Live providers, token execution and supported attestations require their configured integrations.</p></section>`;
}
function render() {
  if (!state.loaded || !state.actor || (!state.token && !['clerk','wallet_siwe'].includes(authMode)) || signingOut) { stopEarningsRefresh(); return; }
  main.classList.toggle('thot-workspace',(isThotMode(state.thot?.capabilities.mode)&&['thot','market','earnings','vault'].includes(state.view))||(isThotMode(state.thotSampling?.capabilities.mode)&&state.view==='operator'));
  const operationsLink=document.querySelector('#operations-console-link');if(operationsLink)operationsLink.hidden=state.role!=='operator_security';
  const treasuryNav=document.querySelector('[data-view=operator].nav-item');if(treasuryNav)treasuryNav.hidden=!(state.role==='operator_security'||state.thot?.reserve_buyer||state.thot?.account?.dispute_reviewer);
  document.title=({vault:'Your traces',market:'Offers',earnings:'Earnings',thot:'THOT',operator:'Treasury',receipts:'Receipts',explorer:'Trace explorer',referrals:'Referrals',leaderboard:'Market activity'}[state.view]??'Your workspace')+' · thot market';
  for(const view of ['referrals','leaderboard']){const nav=document.querySelector(`[data-view=${view}].nav-item`);if(nav)nav.hidden=!isThotMode(state.thot?.capabilities.mode);}
  scheduleEarningsRefresh();
  const explorerNav=document.querySelector('#trace-explorer-nav');if(explorerNav){explorerNav.hidden=!(state.canExplore||state.role==='operator_security');explorerNav.classList.toggle('active',state.view==='explorer');}
  if(state.view==='explorer'){main.innerHTML=(state.canExplore||state.role==='operator_security')?traceExplorerUI.sectionHTML():empty('Trace explorer unavailable.','This account does not have permission to view operational inventory.');return;}
  document.querySelectorAll('[data-view].nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  if(['referrals','leaderboard'].includes(state.view)&&isThotMode(state.thot?.capabilities.mode)){
    main.innerHTML=state.view==='referrals'?heading('YOUR NETWORK','Referrals','Follow attributed contributors, finalized referral credits and payments.')+analyticsUI.referralsHTML():analyticsUI.leaderboardHTML();
    void safely(()=>analyticsUI.ready());return;
  }
  const needsContributor = ['vault', 'earnings', 'receipts'].includes(state.view) || (state.view === 'market' && state.role === 'operator_security'&&!state.thot?.reserve_buyer);
  if (needsContributor && state.role !== 'user') {
    main.innerHTML = heading('SCOPED WORKSPACES', 'Your role keeps records separate.', `You are viewing as ${roleName(state.role)}. Private traces, earnings and contributor receipts belong to the contributor workspace.`) + `<div class="panel">${authMode==='development'?empty('Open the contributor workspace.', 'Changing the local role selects the separate development account for that role.', '<button class="button" data-action="contributor-role">Switch to contributor</button>'):empty('A contributor identity is required.', 'Sign out and connect an authorized contributor identity to access its private workspace.')}</div>`; return;
  }
  main.innerHTML = state.view==='vault'&&state.role==='user'
    ? contributorUI.sectionHTML()+openrouterUI.intro()+thotUI.valuationsHTML()+(isThotMode(state.thot?.capabilities.mode)?analyticsUI.portfolioHTML():'')+(authMode==='development'&&!isThotMode(state.thot?.capabilities.mode)?`<details class="technical-details"><summary>Developer demo tools</summary>${vault()}</details>`:'')
    : ({ vault, market, earnings, receipts, operator, thot }[state.view] ?? vault)();
  if(state.view==='earnings'&&isThotMode(state.thot?.capabilities.mode))main.insertAdjacentHTML('beforeend',analyticsUI.referralsHTML());
  if(isThotMode(state.thot?.capabilities.mode))void safely(()=>analyticsUI.ready());
  if(state.view==='operator'&&state.role==='operator_security'&&!isThotMode(state.thotSampling?.capabilities.mode)){main.insertAdjacentHTML('afterbegin',traceExplorerUI.sectionHTML());main.insertAdjacentHTML('beforeend',operationsUI.sectionHTML());}
  if(state.view==='earnings'&&state.role==='user'&&!isThotMode(state.thot?.capabilities.mode))main.insertAdjacentHTML('beforeend',externalInference.historyHTML());
  if(state.view==='market'&&state.role==='buyer_admin'&&!isThotMode(state.thot?.capabilities.mode)){
    main.querySelector('.page-heading').insertAdjacentHTML('beforeend','<button class="button secondary" data-action="new-mandate-draft">Draft custom mandate +</button>');
    for(const button of main.querySelectorAll('[data-action="mandate-stats"]')){
      const m=state.mandates.find(m=>(m.mandate_id??m.id)===button.dataset.id);if(!m)continue;
      if(m.status==='draft'||(moneyUI.active()&&m.status==='pending_funding'))button.insertAdjacentHTML('afterend',`<button class="text-button" data-action="edit-mandate-draft" data-id="${escape(m.mandate_id)}">Edit unfunded draft →</button><button class="button secondary" data-action="fund-mandate-draft" data-id="${escape(m.mandate_id)}">Review simulated funding ↗</button>`);
      if(m.status==='funded'||m.status==='paused')button.insertAdjacentHTML('afterend',`<button class="button secondary" data-action="activate-mandate" data-id="${escape(m.mandate_id)}">Activate matching ↗</button>`);
      if(m.status==='active')button.insertAdjacentHTML('afterend',`<button class="text-button" data-action="pause-mandate" data-id="${escape(m.mandate_id)}">Pause matching</button>`);
    }
  }
  bindStakingPreview(main);
  moneyUI.decorate(main);
  if(authMode!=='development'){
    for(const button of main.querySelectorAll('[data-action]'))if(['worker','burn','policy','mandate','buyer-role','contributor-role','fund-mandate-draft','confirm-fund-mandate','inference'].includes(button.dataset.action))button.remove();
    main.querySelector('.journey')?.remove();
  }
  if(state.role==='buyer_member')for(const button of main.querySelectorAll('[data-action="mandate"],[data-action="worker"]'))button.remove();
}
function openDialog(title, subtitle, body, footer = '') {
  activePreview = null;
  activeInference = null;
  document.querySelector('#dialog-content').innerHTML = `<header class="dialog-head"><div><h2 id="dialog-title">${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close-button" data-action="close-dialog" aria-label="Close dialog">×</button></header><div class="dialog-body"><div id="dialog-error" class="dialog-error" role="alert" hidden></div>${body}</div>${footer ? `<footer class="dialog-footer">${footer}</footer>` : ''}`;
  if(authMode!=='development'&&document.querySelector('#import-form')){
    for(const element of document.querySelectorAll('.dialog-body > h3,.dialog-body > .legal-note,.dialog-body > .sample-grid,.dialog-body > .divider'))element.remove();
    document.querySelector('.dialog-head p').textContent='Import a supported source bundle. Its claims must still pass verification.';
  }
  if (!dialog.open) dialog.showModal();
}
function importDialog() {
  if (state.role !== 'user') return session('user').then(importDialog);
  openDialog('Add to Your traces', 'Create a local example or import a supported source bundle.', `<h3>Local examples</h3><p class="legal-note">Every example uses simulated evidence. Research Flow and Professional Flow attach narrowly scoped mock predicates.</p><div class="sample-grid"><button class="sample-button" data-action="sample" data-scenario="coding"><strong>General AI work ↗</strong><small>A rights-cleared coding trace.</small></button><button class="sample-button" data-action="sample" data-scenario="research"><strong>Research Flow ↗</strong><small>Research with a narrow action predicate.</small></button><button class="sample-button" data-action="sample" data-scenario="professional"><strong>Professional Flow ↗</strong><small>Public legal research and cohort evidence.</small></button><button class="sample-button" data-action="sample" data-scenario="privileged"><strong>Rights rejection example ↗</strong><small>Privileged material must be blocked.</small></button></div><hr class="divider"><form id="import-form"><h3>Import a source bundle</h3><div class="field"><label for="bundle-file">Choose a JSON file</label><input id="bundle-file" type="file" accept="application/json,.json"><small>Only supported, configured source formats can verify. A file alone does not establish provenance.</small></div><div class="field"><label for="bundle-json">Source bundle JSON</label><textarea id="bundle-json" required spellcheck="false" placeholder="Paste a supported source bundle here"></textarea></div><div class="field"><label for="bundle-category">Trace category</label><select id="bundle-category"><option value="general">General</option><option value="research_flow">Research Flow</option><option value="professional_flow">Professional Flow</option></select></div><button class="button" type="submit">Import & verify bundle ↗</button></form>`);
}
function policyDialog() {
  openDialog('Set your local licensing policy', 'This template enables matching and keeps manual approval for every sale.', `<p>The local policy permits the demo categories and purposes, narrow credential and outcome predicates, and a scrubbed trace body. Identity disclosure stays off.</p><div class="receipt-layers"><div class="receipt-layer">Authorization mode<span>Manual, per sale</span></div><div class="receipt-layer">Identity disclosure<span>Disabled</span></div><div class="receipt-layer">Payout preference<span>Choose for each sale</span></div></div><p class="legal-note">This replaces the current local policy with the development template. Each later sale still requires your exact release and license approval.</p>`, '<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" data-action="create-policy">Use local policy</button>');
}
function mandateDialog() {
  openDialog('Create a local buyer mandate', 'A fixed-price, funded template using simulated local money.', `<p>Choose the inventory class. This creates and activates the development template. Contributor approval is still required before delivery.</p><div class="sample-grid"><button class="sample-button" data-action="create-mandate" data-category="general"><strong>General AI work ↗</strong><small>Rights-cleared traces with the configured provenance tier.</small></button><button class="sample-button" data-action="create-mandate" data-category="research_flow"><strong>Research Flow ↗</strong><small>Investment research with a qualifying action predicate.</small></button><button class="sample-button" data-action="create-mandate" data-category="professional_flow"><strong>Professional Flow ↗</strong><small>Public professional work and an eligible cohort predicate.</small></button></div><p class="legal-note">Funding here is simulated. Review the created mandate for the exact price, budget, criteria, assay and license.</p>`);
}
async function preview(id) {
  const result = await api(`/v1/candidates/${encodeURIComponent(id)}/preview`);
  const candidate = state.candidates.find(c => c.candidate_id === id);
  let release = result.release; if (typeof release === 'string') { try { release = JSON.parse(release); } catch { /* A text release remains inspectable as text. */ } }
  const currency = result.currency ?? candidate?.currency ?? 'USD';
  const pending = candidate?.status === 'USER_AUTH_PENDING';
  openDialog(pending ? 'Your release. Your decision.' : 'Inspect the licensed release', 'Review the exact artifact and license before making a new authorization.', `<div class="meta-pair"><span>Buyer</span><strong class="mono">${escape(result.buyer_id)}</strong></div><div class="meta-pair"><span>Gross price</span><strong>${escape(money(result.expected_gross_minor, currency))}</strong></div><div class="meta-pair"><span>Maximum direct costs</span><strong>${escape(money(result.expected_direct_costs_max_minor, currency))}</strong></div><div class="meta-pair"><span>Credential / outcome predicates</span><strong>${result.credential_receipt_ids.length} / ${result.outcome_receipt_ids.length}</strong></div><h3>License terms</h3><pre class="json-view">${escape(release?.license?.human_readable_terms ?? 'Inspect the full release below for the exact license.')}</pre><h3>Release commitment</h3><code class="hash">${escape(result.release_artifact_hash)}</code><h3>License commitment</h3><code class="hash">${escape(result.license_hash)}</code><h3>Exact buyer release</h3><pre class="json-view" tabindex="0" aria-label="Exact authorized release JSON">${json(release)}</pre>${pending ? `<div class="field"><label for="payout">Contributor value</label><select id="payout">${moneyUI.active()?'<option value="token">THOT to your wallet · Anvil test tokens</option>':'<option value="inference_credit">Inference credit</option><option value="token" disabled>THOT token — unavailable in this local UI</option>'}</select></div><label class="consent-check"><input id="sale-consent" type="checkbox"><span>I authorize this exact release, its disclosed predicates, the displayed license and maximum direct costs.</span></label><p class="legal-note">The recorded authorization binds these commitments. A changed release or license requires fresh authorization.</p>` : ''}`, pending ? '<button class="button secondary" data-action="close-dialog">Keep private</button><button class="button" id="approve-sale" data-action="approve-sale" disabled>Authorize this exact release ↗</button>' : '<button class="button secondary" data-action="close-dialog">Close</button>');
  activePreview = result;
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function runAction(action, button) {
  if(await analyticsUI.handle(action,button))return;
  if(action==='open-trace-explorer'){
    state.traceExplorer=await api('/v1/operator/trace-explorer');state.view='explorer';render();return;
  }
  const id = button.dataset.id;
  if(action==='copy-setup-command'){await copySetupCommand(button);return;}
  if(await robinhoodSetupUI.handle(action,button))return;
  if(await agentCaptureUI.handle(action,button))return;
  if(await traceExplorerUI.handle(action,button))return;
  if(await libraryUI.handle(action,button))return;
  if(await openrouterUI.handle(action,button))return;
  if(await contributorUI.handle(action,button))return;
  if(await operationsUI.handle(action,button))return;
  if(action==='identity-sign-out'){
    walletLoginAttempt++;signingOut=true;stopEarningsRefresh();
    try { await api('/v1/auth/session/revoke',{method:'POST',body:{}}); }
    finally {
      try { if(authMode==='clerk')await clerkAuth?.signOut();else if(authMode==='wallet_siwe'){if(privyAuth)await privyAuth.signOut();else await walletAuth?.signOut();} }
      finally { showIdentityLogin('Signed out.'); }
    }
    return;
  }
  if(await externalInference.handle(action,button))return;
  if (action === 'refresh') return refresh();
  if (action === 'dismiss-notice') { document.querySelector('#notice').hidden = true; return; }
  if (action === 'close-dialog') { dialog.close(); activePreview = null; return; }
  if (action === 'import') return importDialog();
  if (action === 'policy') { if (state.role !== 'user') await session('user'); return policyDialog(); }
  if (action === 'buyer-role') return session('buyer_admin');
  if (action === 'contributor-role') return session('user');
  if (action === 'mandate') return mandateDialog();
  if(action==='new-mandate-draft')return mandateEditor.openNew('general');
  if(action==='edit-mandate-draft')return mandateEditor.open(state.mandates.find(m=>(m.mandate_id??m.id)===id));
  if(await thotUI.action(action,button))return;
  if(await moneyUI.action(action,button))return;
  if(action==='fund-mandate-draft'){
    const m=state.mandates.find(m=>(m.mandate_id??m.id)===id);
    return openDialog('Review simulated mandate funding','Funding freezes the terms. This does not move real money.',`<p>This records ${escape(money(m.economics.total_budget_minor,m.economics.currency))} of synthetic funding against the exact mandate below. Matching stays inactive until you activate it.</p><pre class="json-view">${json(m)}</pre>`,`<button class="button secondary" data-action="close-dialog">Keep unfunded</button><button class="button" data-action="confirm-fund-mandate" data-id="${escape(id)}" data-revision="${escape(m.draft_revision??1)}">Record simulated funding</button>`);
  }
  if(action==='confirm-fund-mandate'){await api(`/v1/buyer/mandates/${encodeURIComponent(id)}/fund`,{method:'POST',body:{expected_revision:Number(button.dataset.revision)}});dialog.close();await refresh();toast('Synthetic funding recorded. The terms are now frozen; activate matching when ready.');return;}
  if(action==='activate-mandate'||action==='pause-mandate'){await api(`/v1/buyer/mandates/${encodeURIComponent(id)}/${action==='activate-mandate'?'activate':'pause'}`,{method:'POST',body:{}});await refresh();return;}
  if (action === 'sample') {
    const result = await api('/v1/dev/trace', { method: 'POST', body: { scenario: button.dataset.scenario } });
    dialog.close(); await refresh(); toast(result.status === 'REJECTED' ? 'Example imported and blocked by rights checks. Inspect its receipt for the reason.' : 'Local example added to Your traces. Its simulated evidence is ready to inspect.'); return;
  }
  if (action === 'create-policy') { await api('/v1/dev/policy', { method: 'POST', body: {} }); dialog.close(); await refresh(); toast('Local manual-approval policy recorded. Create a buyer mandate, then run pending jobs.'); return; }
  if (action === 'create-mandate') { await api('/v1/dev/mandate', { method: 'POST', body: { category: button.dataset.category } }); dialog.close(); await refresh(); toast('Local mandate created, funded with simulated money, and activated. Run matching jobs next.'); return; }
  if (action === 'worker') {
    const result = await api('/v1/dev/run-worker', { method: 'POST', body: {} }); await refresh();
    const processed = typeof result.processed === 'number' ? result.processed : 'unavailable';
    const failed = typeof result.failed === 'number' ? result.failed : 'unavailable';
    const summary = `This run: ${processed} ${processed === 1 ? 'job' : 'jobs'} processed; ${failed} failed ${failed === 1 ? 'attempt' : 'attempts'}.`;
    toast(summary + (Number(failed) > 0 ? ' Inspect reconciliation as Operator for retry details.' : ' Current records have been refreshed.'));
    if (Number(failed) > 0) notice(summary + ' Select Operator in View as, then choose Inspect reconciliation to review failed jobs and retries.');
    return;
  }
  if (action === 'burn') { await api('/v1/dev/complete-burns', { method: 'POST', body: {} }); await refresh(); toast('Local burn simulation completed. This does not represent a live token burn.'); return; }
  if (action === 'trace') {
    const trace = await api(`/v1/traces/${encodeURIComponent(id)}`);
    openDialog(categoryName(trace.category), 'Separate provenance and rights records, scoped to this trace.', `<div class="meta-pair"><span>Status</span><strong>${badge(trace.status)}</strong></div><div class="meta-pair"><span>Provenance tier</span><strong>${escape(trace.provenance?.confidence_tier ?? 'Unavailable')}</strong></div><h3>Provenance claims & limitations</h3><pre class="json-view">${json(trace.provenance)}</pre><h3>Rights assessment</h3><pre class="json-view">${json(trace.rights)}</pre><p class="legal-note">A provenance tier does not establish identity, credential eligibility or content rights.</p>`,trace.status==='AVAILABLE'?`<button class="button secondary" data-action="similarity-review" data-id="${escape(id)}">Review similar traces →</button>`:''); return;
  }
  if(action==='similarity-review'){const result=await api(`/v1/traces/${encodeURIComponent(id)}/similarity`);openDialog('Similar traces in your vault','Private, advisory text comparison. No sale or reward is changed.',`<p>${escape(result.notice)}</p><pre class="json-view">${json(result)}</pre>`);return;}
  if (action === 'preview') return preview(id);
  if (action === 'inference') return inferenceDialog(id);
  if (action === 'run-inference') return runInference();
  if (action === 'approve-sale') {
    if (!activePreview || !document.querySelector('#sale-consent')?.checked) throw new Error('Review and check the exact-release authorization first.');
    const p = activePreview;
    if(moneyUI.active())return moneyUI.startApproval(p);
    await api('/v1/sale-authorizations', { method: 'POST', body: { candidate_id: p.candidate_id, buyer_id: p.buyer_id, mandate_id: p.mandate_id, release_artifact_hash: p.release_artifact_hash, license_hash: p.license_hash, expected_gross_minor: p.expected_gross_minor, expected_direct_costs_max_minor: p.expected_direct_costs_max_minor, credential_receipt_ids: p.credential_receipt_ids, outcome_receipt_ids: p.outcome_receipt_ids, payout_preference: 'inference_credit' } });
    dialog.close(); activePreview = null; await refresh(); toast('Exact release authorized and license finalized. Run pending jobs to record settlement.'); return;
  }
  if (action === 'entitlement') {
    const entitlement = state.earnings.entitlements.find(e => (e.entitlement_id ?? e.id) === id);
    const settlement = state.earnings.settlements.find(s => s.settlement_id === entitlement?.settlement_id);
    openDialog('Your settlement record', 'Exact minor-unit allocations from the local ledger.', `<pre class="json-view">${json({ entitlement, settlement })}</pre><p class="legal-note">USD amounts use cents; USDC uses six decimal places. A recorded burn allocation alone is not a finalized burn.</p>`); return;
  }
  if (action === 'burn-record') {
    const record = (state.earnings.burn_allocations ?? []).find(allocation => allocation.settlement_id === id);
    if (!record) throw new Error('This settlement’s burn record is unavailable. Refresh your earnings.');
    openDialog('Your separate burn record', record.simulated ? 'Simulated execution. No live token transaction.' : 'Network burn allocation and recorded execution state.', `<div class="meta-pair"><span>Execution state</span><strong>${burnStatus(record)}</strong></div><div class="meta-pair"><span>Allocated value</span><strong>${escape(money(record.amount_minor, record.currency))}</strong></div><p class="legal-note">An allocation reserves value for the network burn path. It is not a completed burn. Finalized retirement is recorded separately, and local mock finality is always simulated. Contributor token payouts remain separate.</p><pre class="json-view" tabindex="0" aria-label="Separate network burn record">${json(record)}</pre>`); return;
  }
  if (action === 'reconciliation') {
    const record = await api('/v1/operator/reconciliation');
    openDialog('Operator reconciliation', 'Current ledger, burn, work queue and failed-job records.', `<div class="meta-pair"><span>Journal balance</span><strong>${record.balanced === true ? '<span class="pill success">balanced</span>' : '<span class="pill warn">requires inspection</span>'}</strong></div><p class="legal-note">Balanced journals establish accounting conservation for the recorded data. Inspect burn statuses and simulation markers separately; pending allocations do not establish finalized burns.</p><pre class="json-view" tabindex="0" aria-label="Operator reconciliation JSON">${json(record)}</pre>`); return;
  }
  if (action === 'mandate-stats') {
    const stats = await api(`/v1/buyer/mandates/${encodeURIComponent(id)}/stats`);
    const mandate = state.mandates.find(m => (m.mandate_id ?? m.id) === id);
    if(moneyUI.active()){
      const records=await Promise.all((stats.license_ids??[]).map(id=>api('/v1/money/settlements/'+id)));
      return openDialog('Your buy order deliveries','Downloads unlock after payment, payout and burn all succeed.',records.length?records.map(r=>`<article class="panel"><p><strong>${r.status==='FINALIZED'?'Paid · ready to download':'Payment pending · trace locked'}</strong></p><button class="button secondary" data-action="money-receipt" data-id="${escape(r.license_id)}">View payment receipt</button>${r.status==='FINALIZED'?`<button class="button" data-action="delivery" data-id="${escape(r.license_id)}">Inspect release ↗</button>`:''}</article>`).join(''):'<p>No approved releases yet. Your funded order is waiting for a match.</p>');
    }
    openDialog('Mandate deliveries & budget', 'Only finalized, authorized releases appear as buyer deliveries.', `<div class="meta-pair"><span>Status</span><strong>${badge(stats.status)}</strong></div><div class="meta-pair"><span>Remaining funded budget</span><strong>${escape(money(stats.remaining_budget_minor, mandate?.economics?.currency))}</strong></div><div class="meta-pair"><span>Licensed releases</span><strong>${stats.delivered ?? 0}</strong></div><h3>Available deliveries</h3>${stats.license_ids?.length ? stats.license_ids.map(license => `<div class="meta-pair"><span class="mono">${escape(short(license))}</span><button class="text-button" data-action="delivery" data-id="${escape(license)}">Inspect release ↗</button></div>`).join('') : '<p class="legal-note">No finalized deliveries yet. Contributors must approve the matched releases.</p>'}<h3>Exact mandate</h3><pre class="json-view">${json(mandate)}</pre>`); return;
  }
  if (action === 'delivery') { const bundle = await api(`/v1/buyer/deliveries/${encodeURIComponent(id)}`); openDialog('Your licensed delivery', 'The authorized release bundle for this buyer account.', `<pre class="json-view" tabindex="0">${json(bundle)}</pre>`, `<button class="button" data-action="download-delivery" data-id="${escape(id)}">Download licensed bundle ↓</button>`); return; }
  if (action === 'download-delivery') { const link=await api(`/v1/buyer/deliveries/${encodeURIComponent(id)}/link`,{method:'POST',body:{ttl_seconds:60}});download(await api(link.download_url), `thot-licensed-release-${id}.json`); return; }
  if (action === 'audit') { download(await api('/v1/audit/export'), `thot-audit-${new Date().toISOString().slice(0, 10)}.json`); toast('Your scoped audit export has been downloaded.'); }
}
async function safely(task, button) {
  if (button) button.disabled = true;
  try { await task(); }
  catch (error) {
    if(error.name==='StaleWorkspaceError')return;
    const target = dialog.open && document.querySelector('#dialog-error');
    if (target) { target.textContent = error.message; target.hidden = false; target.scrollIntoView({ block: 'nearest' }); }
    else { notice(error.message); if (!state.loaded&&!document.querySelector('#identity-form')) main.innerHTML = `<div class="panel">${empty('The workspace is unavailable.', 'Check the local service, then refresh. No account totals are shown until records can be loaded.', '<button class="button" data-action="refresh">Try again ↻</button>')}</div>`; }
  } finally { if (button?.isConnected) button.disabled = false; }
}
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.view) { state.view = button.dataset.view; render(); return; }
  if (button.dataset.action) void safely(() => runAction(button.dataset.action, button), button);
});
// The brand returns to the public homepage; app navigation preserves its own state.
document.querySelector('#role').addEventListener('change', event => { const select = event.target; select.disabled = true; void safely(() => session(select.value)).finally(() => { select.disabled = false; }); });
document.addEventListener('input',event=>{thotUI.onInput?.(event.target);});
document.addEventListener('change', event => {
  if(agentCaptureUI.onChange(event.target))return;
  if(contributorUI.onChange(event.target))return;
  if (event.target.id === 'sale-consent') document.querySelector('#approve-sale').disabled = !event.target.checked;
  if (event.target.id === 'bundle-file') void safely(async () => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error('Choose a JSON source bundle smaller than 2 MB for this local import form.');
    document.querySelector('#bundle-json').value = await file.text();
  });
});
document.addEventListener('submit', event => {
  if(event.target.id==='analytics-profile'){event.preventDefault();void safely(()=>analyticsUI.onSubmit(event.target),event.target.querySelector('button[type=submit]'));return;}
  if(event.target.id==='trace-explorer-filters'){event.preventDefault();void safely(()=>traceExplorerUI.onSubmit(event.target),event.target.querySelector('button[type=submit]'));return;}
  if(['library-search','library-edit','library-prepare-sale'].includes(event.target.id)){event.preventDefault();void safely(()=>libraryUI.onSubmit(event.target),event.target.querySelector('button[type=submit]'));return;}
  if(['research-preview-form','robinhood-proof-form'].includes(event.target.id)){event.preventDefault();const button=event.target.querySelector('button[type=submit]');void safely(()=>contributorUI.onSubmit(event.target),button);return;}
  if (event.target.id !== 'import-form') return; event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  void safely(async () => {
    let bundle; try { bundle = JSON.parse(document.querySelector('#bundle-json').value); } catch { throw new Error('The source bundle is not valid JSON. Check the file or pasted text.'); }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('The source bundle must be a JSON object.');
    const result = await api('/v1/traces/import', { method: 'POST', body: { bundle, category: document.querySelector('#bundle-category').value } });
    dialog.close(); await refresh(); toast(result.duplicate ? 'This conversation already exists in your vault. No duplicate trace was created. No duplicate trace was created.' : 'Source bundle imported. Inspect the returned claims and rights assessment.');
  }, button);
});
dialog.addEventListener('close', () => { activePreview = null; activeInference = null; contributorUI.resetPreview(); agentCaptureUI.onDialogClose(); });
function invalidatePrivateState(){
  analyticsUI.reset();
  state.environmentOverview=null;
  state.thot=null;state.thotSampling=null;state.thotDisputes=null;state.money=null;
  stopEarningsRefresh();earningsUpdatedAt=null;earningsRefreshError=false;
  openrouterUI.reset();
  agentCaptureUI.authLost();
  robinhoodSetupUI.authLost();
  const accountControl=document.querySelector('#clerk-user-button');
  if(accountControl){clerkAuth?.unmountUserButton(accountControl);accountControl.remove();}
  contributorUI.reset();state.generation++;state.token=null;state.actor=null;state.canExplore=false;state.traceExplorer=null;state.loaded=false;state.traces=[];state.candidates=[];state.mandates=[];state.contributorPortfolio={items:[],robinhood:{status:'not_linked'}};state.earnings={entitlements:[],settlements:[],burn_allocations:[]};state.inferenceRequests=[];
  if(dialog.open)dialog.close();
}
async function loadPrivyAuth() {
  if(privyAuth)return privyAuth;
  if(privyLoading)return privyLoading;
  if(!privyConfig)throw new Error('Email wallet login is not configured.');
  let candidate=null,expired=false,timer;
  const run=(async()=>{
    try {
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Sign in took too long to load. Please try again.'));},30000);});
      const initialized=(async()=>{
        const {createPrivyAuth}=await import('./privy-auth.bundle.js');
        if(expired)throw new Error('Email wallet loading expired.');
        candidate=createPrivyAuth({window,document,config:privyConfig,walletAuth,onError:error=>{if(privyAuth===candidate)showIdentityLogin(error.message);}});
        await candidate.initialize();
        if(expired)throw new Error('Email wallet loading expired.');
        return candidate;
      })();
      const ready=await Promise.race([initialized,timeout]);
      privyAuth=ready;ready.mount(document.querySelector('#privy-wallet-choices'));return ready;
    } catch(error) {expired=true;candidate?.destroy();throw error;}
    finally {clearTimeout(timer);}
  })();
  privyLoading=run;
  try{return await run;}finally{if(privyLoading===run)privyLoading=null;}
}
async function openPrivyLogin(){
  const attempt=++walletLoginAttempt;signingOut=false;
  // An anonymous restore may redisplay this login while the SDK loads. It is
  // still the same user action; another login, logout or accepted account is not.
  const current=()=>{if(attempt!==walletLoginAttempt||state.actor||signingOut||authMode!=='wallet_siwe')throw staleWorkspace();};
  try {const auth=await loadPrivyAuth();current();auth.mount(document.querySelector('#privy-wallet-choices'));await auth.login();}
  catch(error){current();showIdentityLogin(error.message);}
}
function showIdentityLogin(message='Use a short-lived access token from your configured identity issuer. This does not log in to the issuer for you.'){
  const operationsLink=document.querySelector('#operations-console-link');if(operationsLink)operationsLink.hidden=true;
  const explorerNav=document.querySelector('#trace-explorer-nav');if(explorerNav)explorerNav.hidden=true;
  const treasuryNav=document.querySelector('[data-view=operator].nav-item');if(treasuryNav)treasuryNav.hidden=true;
  invalidatePrivateState();document.querySelector('#role').disabled=true;
  document.querySelector('.local-tools').hidden=true;
  if(authMode==='wallet_siwe'){
    if(privyConfig){
      const feedback=['Use a short-lived access token from your configured identity issuer. This does not log in to the issuer for you.','Connect your EVM wallet to continue.','Connect your wallet to continue.'].includes(message)?'':message;
      main.innerHTML=`<section class="page-heading"><div><p class="eyebrow">YOUR PRIVATE WORKSPACE</p><h1>Your work. Your wallet.</h1></div></section><section aria-label="Sign in"><button class="button" data-privy-login>Sign in</button>${feedback?`<p role="status">${escape(feedback)}</p>`:''}<div id="privy-wallet-choices"></div></section>`;
    }else{
      main.innerHTML=heading('YOUR PRIVATE WORKSPACE','Sign in with your wallet.',message==='Use a short-lived access token from your configured identity issuer. This does not log in to the issuer for you.'?'Connect an EVM wallet and sign a one-time login message.':message)+`<section class="panel audit-card"><h2>Your wallet is your account.</h2><p>Sign-in does not approve a token transfer or authorize a trace sale.</p><div class="actions"><button class="button secondary" data-wallet-login="metamask">MetaMask</button><button class="button secondary" data-wallet-login="phantom">Phantom · EVM</button><button class="button secondary" data-wallet-login="injected">Other EVM wallet</button></div></section>`;
    }
    const privyButton=main.querySelector('[data-privy-login]');if(privyButton)privyButton.addEventListener('click',()=>void safely(openPrivyLogin,privyButton));
    privyAuth?.mount(document.querySelector('#privy-wallet-choices'));
    for(const button of main.querySelectorAll('[data-wallet-login]'))button.addEventListener('click',()=>{walletLoginAttempt++;signingOut=false;void safely(()=>walletAuth?.signIn(button.dataset.walletLogin),button);});return;
  }
  if(authMode==='clerk'){
    main.innerHTML=heading('YOUR PRIVATE WORKSPACE','Continue with email.',message)+`<section class="panel audit-card"><div id="clerk-sign-in"></div></section>`;
    clerkAuth?.mountSignIn(document.querySelector('#clerk-sign-in'));
    return;
  }
  main.innerHTML=heading('CONFIGURED IDENTITY','Connect your authorized account.',message)+`<section class="panel audit-card"><form id="identity-form"><div class="field"><label for="identity-token">Short-lived access token</label><input id="identity-token" type="password" autocomplete="off" maxlength="16384" required><small>Kept in this page’s memory only. Never enter an API key or signing key. Roles and buyer membership come from the server, not this form.</small></div><button class="button" type="submit">Verify & connect</button></form></section>`;
  document.querySelector('#identity-form').addEventListener('submit',event=>{
    event.preventDefault();const button=event.currentTarget.querySelector('button');
    const form=event.currentTarget,checkScope=captureScope();
    const checkLogin=()=>{checkScope();if(document.querySelector('#identity-form')!==form)throw staleWorkspace();};
    void safely(async()=>{
      const token=document.querySelector('#identity-token').value.trim();document.querySelector('#identity-token').value='';
      if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new Error('Enter the short-lived access token issued for this application, not an API key.');
      const response=await fetch('/v1/auth/session',{headers:{Authorization:'Bearer '+token,Accept:'application/json'},cache:'no-store',redirect:'error'}).catch(error=>{checkLogin();throw error;});
      checkLogin();
      if(!response.ok)throw new Error('The token could not be verified for an approved thot market account. Obtain a current token from the configured issuer.');
      const result=await response.json().catch(error=>{checkLogin();throw error;});checkLogin();signingOut=false;state.token=token;state.actor=result.actor;state.role=result.actor.role;state.canExplore=result.permissions?.trace_explorer===true;state.view=initialView(state.role);
      document.querySelector('#role').innerHTML=`<option>${escape(state.role.replaceAll('_',' '))}</option>`;
      if(!document.querySelector('[data-action="identity-sign-out"]'))document.querySelector('#role').insertAdjacentHTML('afterend','<button class="button secondary small" data-action="identity-sign-out">Sign out</button>');
      await refresh();
    },button);
  });
}
async function acceptClerkSession({actor,permissions}){
  analyticsUI.reset();
  state.thot=null;state.thotSampling=null;state.thotDisputes=null;state.money=null;
  stopEarningsRefresh();earningsUpdatedAt=null;earningsRefreshError=false;
  signingOut=false;
  contributorUI.reset();state.generation++;state.loaded=false;state.token=null;state.actor=actor;state.role=actor.role;state.canExplore=permissions?.trace_explorer===true;
  state.view=initialView(state.role);
  if(dialog.open)dialog.close();
  document.querySelector('#role').innerHTML=`<option>${escape(state.role.replaceAll('_',' '))}</option>`;
  document.querySelector('#role').disabled=true;document.querySelector('.local-tools').hidden=true;
  if(authMode==='clerk'){document.querySelector('#role').insertAdjacentHTML('afterend','<div id="clerk-user-button" aria-label="Your account"></div>');clerkAuth?.mountUserButton(document.querySelector('#clerk-user-button'));}
  if(!document.querySelector('[data-action="identity-sign-out"]'))document.querySelector('#role').insertAdjacentHTML('afterend','<button class="button secondary small" data-action="identity-sign-out">Sign out</button>');
  await refresh();
}
async function startAuthentication(){
  const capability=await api('/v1/auth/capabilities');authMode=capability.mode;
  const environment=document.querySelector('.environment');
  if(environment)environment.innerHTML=`<span class="status-dot"></span>${authMode==='development'?'Local demo workspace':authMode==='wallet_siwe'?`Wallet workspace · ${capability.wallet.chain_id===31337?'local Anvil':'testnet'}`:'Invited reviewer workspace'}`;
  if(authMode!=='development'){
    document.querySelector('#role').hidden=true;
    const roleLabel=document.querySelector('label[for="role"]');if(roleLabel)roleLabel.hidden=true;
    document.querySelector('.local-tools').hidden=true;
  }
  if(authMode==='development')return session('user');
  if(authMode==='wallet_siwe'){
    privyConfig=capability.privy??null;
    walletAuth=createWalletAuth({window,fetch,chainId:capability.wallet.chain_id,rpcUrl:capability.wallet.rpc_url,onSession:acceptClerkSession,onIdentityChanging:({restoring}={})=>{if(restoring)showIdentityLogin('Checking your saved wallet session…');else{invalidatePrivateState();loading();}},onSignedOut:()=>showIdentityLogin('Connect your wallet to continue.'),onError:error=>showIdentityLogin(error.message),additionalProviders:async address=>privyConfig?(await loadPrivyAuth()).providers(address):[]});
    showIdentityLogin('Connect your EVM wallet to continue.');
    await walletAuth.restore();return;
  }
  if(authMode!=='clerk')return showIdentityLogin();
  document.querySelector('#role').hidden=true;
  const roleLabel=document.querySelector('label[for="role"]');if(roleLabel)roleLabel.hidden=true;
  document.querySelector('#role').closest?.('.session-control')?.classList.add('verified-session');
  document.querySelector('.local-tools').hidden=true;
  showIdentityLogin('Enter your email, then use the one-time code sent to you.');
  clerkAuth=createClerkAuthUI({document,window,fetch,onSession:acceptClerkSession,onIdentityChanging:()=>{invalidatePrivateState();loading();},onSignedOut:()=>showIdentityLogin('Enter your email, then use the one-time code sent to you.'),onError:error=>showIdentityLogin(error.message)});
  await clerkAuth.initialize(capability.clerk);
}
void safely(startAuthentication);

window.addEventListener('hashchange',()=>{void libraryUI.acceptFragment();agentCaptureUI.acceptFragment();robinhoodSetupUI.acceptFragment();});
document.addEventListener('visibilitychange',scheduleEarningsRefresh);
window.addEventListener('pagehide',stopEarningsRefresh);

dialog.addEventListener('cancel',event=>robinhoodSetupUI.onDialogCancel(event));
