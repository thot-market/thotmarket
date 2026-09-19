import {createWalletAuth} from './wallet-auth-ui.js';
import {createEnvironmentUI} from './environment-ui.js';
import {createOperationsUI} from './operations-ui.js';

const state={actor:null,role:null,generation:0,environmentOverview:null,activityQuery:{q:'',group:'',status:''}};
const main=document.querySelector('#main');
const dialog=document.querySelector('#detail-dialog');
const notice=document.querySelector('#notice');
const identity=document.querySelector('#operator-identity');
const refreshButton=document.querySelector('[data-action="refresh"]');
const signOutButton=document.querySelector('[data-action="sign-out"]');
let walletAuth=null,toastTimer;

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const json=value=>escape(JSON.stringify(value,null,2));
const money=value=>{try{if(!/^-?\d+$/.test(String(value)))return 'Unavailable';const amount=BigInt(value),negative=amount<0n,absolute=negative?-amount:amount;return `${negative?'−':''}$${(absolute/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${(absolute%100n).toString().padStart(2,'0')}`;}catch{return 'Unavailable';}};
const stale=()=>{const error=new Error('The verified session changed while this request was in progress.');error.name='StaleSessionError';return error;};
function scope(){const generation=state.generation,actor=state.actor?.id;return()=>{if(generation!==state.generation||actor!==state.actor?.id)throw stale();};}
function clearPrivateDOM(){state.generation++;state.actor=null;state.role=null;state.environmentOverview=null;state.activityQuery={q:'',group:'',status:''};main.replaceChildren();refreshButton.disabled=true;signOutButton.hidden=true;identity.textContent='No verified session';document.querySelector('#dialog-content').replaceChildren();document.querySelector('#toast').hidden=true;if(dialog.open)dialog.close();}
function forgetSession(){clearPrivateDOM();}
function showNotice(message){notice.textContent=message;notice.hidden=false;}
function clearNotice(){notice.hidden=true;notice.textContent='';}
function toast(message){const node=document.querySelector('#toast');node.textContent=message;node.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.hidden=true,6500);}
function openDialog(title,subtitle,body,footer=''){
  document.querySelector('#dialog-content').innerHTML=`<header class="dialog-head"><div><h2 id="dialog-title">${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close-button" data-action="close-dialog" aria-label="Close dialog">×</button></header><div class="dialog-body"><div id="dialog-error" class="dialog-error" role="alert" hidden></div>${body}</div>${footer?`<footer class="dialog-footer">${footer}</footer>`:''}`;
  if(!dialog.open)dialog.showModal();
}
function errorMessage(response,data){
  const code=typeof data?.error==='string'?data.error:data?.error?.code??data?.code;
  if(response.status===401)return 'Your operator session expired. Sign in with the configured wallet again.';
  if(response.status===403)return 'This verified wallet does not have operator access.';
  return code&&/^[A-Z0-9_]{1,90}$/.test(code)?`The request could not be completed (${code}).`:'The service could not complete this request. Refresh to inspect current state.';
}
async function api(path,options={}){
  if(state.role!=='operator_security')throw new Error('Operator permission is required before private operational data can be requested.');
  const check=scope(),method=options.method??'GET';
  const headers={Accept:'application/json'};
  if(options.body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['Idempotency-Key']=options.idempotencyKey??crypto.randomUUID();
  const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15_000),headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});check();
  const data=await response.json().catch(()=>null);check();
  if(response.status===401){loginHTML('Your operator session expired. Sign in with the configured wallet again.');throw stale();}
  if(response.status===403){deniedHTML();throw stale();}
  if(!response.ok)throw new Error(errorMessage(response,data));
  return data;
}
const operationsUI=createOperationsUI({api,refresh,openDialog,dialog,toast,state,escape,json,money});
const environmentUI=createEnvironmentUI({state,escape,controlsHTML:operationsUI.sectionHTML});

function loginHTML(message='Connect the configured EVM wallet and sign a one-time message to access this private console.'){
  forgetSession();
  main.innerHTML=`<section class="page-heading"><div><p class="eyebrow">PRIVATE OPERATOR ACCESS</p><h1>THOT operations</h1><p>${escape(message)}</p></div></section><section class="panel audit-card"><h2>Wallet verification required</h2><p>This console only loads operational observations after the server recognizes an operator-security wallet. Signing in does not authorize transfers or change incident controls.</p><div class="operator-actions"><a class="button secondary" href="/app">Sign in with email or wallet</a><button class="button" data-wallet-login="metamask">MetaMask</button><button class="button secondary" data-wallet-login="phantom">Phantom · EVM</button><button class="button secondary" data-wallet-login="injected">Other EVM wallet</button></div></section>`;
  for(const button of main.querySelectorAll('[data-wallet-login]'))button.addEventListener('click',()=>void safely(()=>walletAuth?.signIn(button.dataset.walletLogin),button));
}
function configurationHTML(message){
  forgetSession();
  main.innerHTML=`<section class="page-heading"><div><p class="eyebrow">OPERATOR AUTHENTICATION</p><h1>THOT operations</h1><p>${escape(message)}</p></div></section><section class="panel audit-card"><h2>Wallet SIWE is required</h2><p>This private console has no development role selector or alternate consumer sign-in flow.</p></section>`;
}
function deniedHTML(){
  clearPrivateDOM();
  signOutButton.hidden=false;
  main.innerHTML='<section class="page-heading"><div><p class="eyebrow">ACCESS DENIED</p><h1>THOT operations</h1><p>This wallet is authenticated but does not have the operator-security role.</p></div></section><section class="panel audit-card"><h2>No operational data was loaded.</h2><p>Use a configured operator wallet to access environment observations, incident controls and reconciliation records.</p></section>';
}
function render(){
  if(state.role!=='operator_security')return deniedHTML();
  clearNotice();refreshButton.disabled=false;signOutButton.hidden=false;identity.textContent='Verified operator';
  main.innerHTML=environmentUI.sectionHTML();
}
async function refresh(){
  if(state.role!=='operator_security')return;
  const generation=state.generation;
  refreshButton.disabled=true;clearNotice();
  const observed=await Promise.allSettled(['/v1/operator/environment','/v1/operator/operations','/v1/operator/reconciliation','/v1/operator/product','/v1/operator/fleet',activityPath()].map(api));
  if(generation!==state.generation)throw stale();
  state.environmentOverview={refreshed_at:new Date().toISOString(),...Object.fromEntries(['environment','operations','reconciliation','product','fleet','activity'].map((key,index)=>[key,observed[index].status==='fulfilled'?{value:observed[index].value}:{reason:'Observation unavailable'}]))};
  render();
}
function activityPath(){
  const query=new URLSearchParams();
  if(state.activityQuery.q)query.set('q',state.activityQuery.q);
  if(state.activityQuery.group)query.set('group',state.activityQuery.group);
  if(state.activityQuery.status)query.set('status',state.activityQuery.status);
  const suffix=query.toString();return '/v1/operator/activity'+(suffix?'?'+suffix:'');
}
async function searchActivity(){
  const form=main.querySelector('#activity-search');if(!form)return;
  state.activityQuery={q:String(form.elements.q?.value??'').trim().slice(0,64),group:String(form.elements.group?.value??''),status:String(form.elements.status?.value??'')};
  await refresh();
}
async function acceptSession({actor}){
  state.generation++;state.actor=actor;state.role=actor?.role??null;
  if(state.role!=='operator_security'){deniedHTML();return;}
  main.innerHTML='<div class="loading"><span class="spinner"></span><p>Reading operator observations…</p></div>';
  await refresh();
}
async function inspectReconciliation(){const record=await api('/v1/operator/reconciliation');openDialog('Operator reconciliation','Current recorded ledger and work queue state.',`<p>Balanced journals establish accounting conservation for recorded data. They do not establish chain settlement or payment.</p><pre class="json-view" tabindex="0" aria-label="Operator reconciliation JSON">${json(record)}</pre>`);}
async function inspectInventory(){const record=await api('/v1/operator/trace-explorer');openDialog('Trace inventory','Operational inventory metadata only. Private conversation content is excluded.',`<p>This inspection is requested explicitly and does not expose private prompts or responses.</p><pre class="json-view" tabindex="0" aria-label="Trace inventory JSON">${json(record)}</pre>`);}
async function runAction(action,button){
  if(action==='close-dialog'){dialog.close();return;}
  if(action==='refresh'){await refresh();return;}
  if(action==='sign-out'){await walletAuth?.signOut();return;}
  if(action==='reconciliation'){await inspectReconciliation();return;}
  if(action==='open-trace-explorer'){await inspectInventory();return;}
  if(action==='activity-search'){await searchActivity();return;}
  if(await operationsUI.handle(action,button))return;
}
async function safely(task,button){
  if(button)button.disabled=true;
  try{await task();}catch(error){if(error.name==='StaleSessionError')return;const target=dialog.open&&document.querySelector('#dialog-error');if(target){target.textContent=error.message;target.hidden=false;}else showNotice(error.message);}
  finally{if(button?.isConnected)button.disabled=false;}
}
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;if(button.dataset.action)void safely(()=>runAction(button.dataset.action,button),button);});

async function start(){
  const response=await fetch('/v1/auth/capabilities',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{Accept:'application/json'}});
  const capability=await response.json().catch(()=>null);
  if(!response.ok)throw new Error('Operator authentication configuration could not be read.');
  if(capability?.mode!=='wallet_siwe'||!capability.wallet){configurationHTML('This operator console requires configured wallet SIWE authentication.');return;}
  walletAuth=createWalletAuth({window,fetch,chainId:capability.wallet.chain_id,rpcUrl:capability.wallet.rpc_url,onSession:acceptSession,onIdentityChanging:()=>{forgetSession();main.innerHTML='<div class="loading"><span class="spinner"></span><p>Verifying wallet session…</p></div>';},onSignedOut:()=>loginHTML('Connect the configured EVM wallet to access THOT operations.'),onError:error=>loginHTML(error.message)});
  await walletAuth.restore();
}
void safely(start);
