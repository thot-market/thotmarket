import {validCallback} from './agent-capture-ui.js';
import {installHelp,setupCommand} from './setup-ui.js';

export function parseRobinhoodFragment(location=window.location,history=window.history) {
  if(!location.hash.startsWith('#thot-robinhood='))return null;
  const value=location.hash.slice('#thot-robinhood='.length);history.replaceState(history.state,'',location.pathname+location.search);
  try{if(!/^[A-Za-z0-9_-]{1,1500}$/.test(value))throw Error();const data=JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)));if(!data||Object.keys(data).some(k=>!['callback','trade_request'].includes(k))||!validCallback(data.callback))throw Error();if(Object.hasOwn(data,'trade_request')){const r=data.trade_request;if(!r||typeof r.trace_id!=='string'||Object.keys(r).sort().join(',')!=='symbol,trace_id,window_days'||!/^[-A-Za-z0-9:_]{1,200}$/.test(r.trace_id)||!/^[A-Z][A-Z0-9.-]{0,14}$/.test(r.symbol)||!Number.isInteger(r.window_days)||r.window_days<1||r.window_days>365)throw Error();}return {callback:data.callback,...(data.trade_request?{trade_request:data.trade_request}:{})};}catch{return {error:'This connection link is incomplete. Run thot-link robinhood again.'};}
}
export function createRobinhoodSetupUI({state,api,openDialog,dialog,refresh,toast,escape,fetch:send=window.fetch.bind(window),pairing=parseRobinhoodFragment()}) {
  let request=pairing,owner=null,job=null,timer=null,paired=false,busy=false,stage='',evidence=null,extensionDir='';
  const owned=()=>owner&&state.actor?.id===owner&&state.role==='user';
  const check=(expected=request)=>{if(!owned()||request!==expected){const error=Error('Your account changed. Restart the connection from your terminal.');error.name='StaleSetupError';throw error;}};
  const clear=()=>{clearTimeout(timer);timer=null;request=null;owner=null;job=null;paired=false;busy=false;stage='';evidence=null;};
  async function local(path='',body) {
    const current=request;check(current);const response=await send(current.callback+path,{method:body===undefined?'GET':'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10_000)});check(current);
    if(!response.ok)throw Error('The helper could not accept this step. Keep its terminal open and try again.');const value=await response.json();check(current);return value;
  }
  function showStatus(next) {
    if(next===stage)return;stage=next;
    if(request?.trade_request&&['capturing','verifying','saving'].includes(next)){openDialog(next==='saving'?'Saving your trade proof':'Checking trade evidence','',`<p>${next==='capturing'?'The local helper is capturing the requested orders and instrument evidence.':'Verifying the bounded proof before saving it privately.'}</p>`,next==='saving'?'':'<button class="text-button" data-action="cancel-robinhood-setup">Cancel</button>');return;}
    const cancel='<button class="text-button" data-action="cancel-robinhood-setup">Cancel connection</button>';
    if(next==='awaiting_extension') {
      openDialog('Open Robinhood in Chrome','The helper is ready. Waiting to hear from your Chrome connector.',`<p>Open or refresh Robinhood in your usual Chrome profile. This also thots an already-installed connector.</p><a class="button" href="https://robinhood.com/" target="_blank" rel="noopener noreferrer">Open Robinhood ↗</a><details class="setup-install"><summary>First time, or still waiting?</summary><p>Open <strong>chrome://extensions</strong>. If THOT Robinhood Connector is listed, enable it, then refresh Robinhood.</p>${extensionDir?`<p>If it is not listed, turn on <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and select:</p><code class="setup-path">${escape(extensionDir)}</code>`:'<p>If it is not listed, ask the demo operator to restore your configured extension.</p>'}</details><p>Leave thot market open. It will continue when the connector responds.</p>`,cancel);return;
    }
    if(next==='awaiting_account_request'){
      openDialog('Open your Robinhood account','Chrome is connected. Now we need one account check.',`<p>If Robinhood is already open, refresh that tab. Otherwise open it below. Use your existing login.</p><a class="button" href="https://robinhood.com/" target="_blank" rel="noopener noreferrer">Open Robinhood ↗</a><p>Return here after the page loads. thot market will finish automatically.</p>`,cancel);return;
    }
    const text={checking_services:['Checking the verifier','Checking the secure account verifier before using your browser session.'],capturing:['Checking your account','The connector received the account request. You can leave Robinhood open.'],verifying:['Verifying your connection','Checking the signed account proof.'],saving:['Saving your verified connection','thot market is verifying the proof before showing Connected.']}[next]??['Checking your helper','Keep the terminal open while we check the connection.'];
    openDialog(text[0],'',`<div class="link-progress simple" role="status"><span class="spinner"></span><p>${text[1]}</p></div>`,next==='saving'?'':cancel);
  }
  function failed(error){if(error.name==='StaleSetupError')return;clearTimeout(timer);timer=null;busy=false;if(!owned())return;openDialog('Connection needs attention','No new connection has been confirmed.',`<p>${escape(error instanceof TypeError||error.name==='TimeoutError'?'thot market cannot reach the helper on this computer. Start thot-link robinhood and open its latest link.':error.message)}</p><p>Keep the helper terminal open. If Chrome asks for local-network access, allow it, then try again.</p>`,'<button class="text-button" data-action="cancel-robinhood-setup">Cancel connection</button><button class="button" data-action="retry-robinhood-setup">Try again</button>');}
  async function save() {
    const current=request;check(current);showStatus('saving');const trade=!!current.trade_request;const result=await api(trade?'/v1/thot/trade-evidence/complete':`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(job.job_id)}/complete`,{method:'POST',body:trade?{job_id:job.job_id,evidence}:{evidence}});check(current);
    if(trade?!result.id:result.status!=='linked'&&result.status!=='verified')throw Error('The account proof was not accepted. Restart the connection.');
    // The API result, not the helper's status, is authoritative. A lost cleanup ack
    // cannot turn a verified account into a UI failure.
    await local('/saved',{}).catch(()=>{});check(current);const completedOwner=owner;clear();await refresh();if(state.actor?.id!==completedOwner||state.role!=='user')return;
    if(trade){openDialog('Trade proof verified','Choose whether to share it with a listing.',`<p>The proof is saved privately. Open Market, preview the selected trace, and explicitly select the proof for disclosure.</p><p>It can be shared after ${escape(result.available_after)} when its capture ticket expires. It does not establish P&amp;L or research causality.</p>`,'<button class="button" data-action="close-dialog">Done</button>');toast('Trade proof verified.');return;}
    openDialog('Robinhood connected','Your account check was verified.',`<p>Your connection is valid for 24 hours. When it expires, choose <strong>Renew Robinhood connection</strong> to check again.</p><p>This confirms account control. Your conversations stay private until you approve a release.</p>`,'<button class="button" data-action="close-dialog">Done</button>');toast('Robinhood connected.');
  }
  async function poll() {
    const current=request,status=await local('/status');check(current);if(status.extension_dir)extensionDir=String(status.extension_dir);
    if(status.error)throw Error(status.error==='CONNECTOR_ENDED_WITHOUT_PROOF'?'The connector stopped before receiving a verified proof. Run thot-link robinhood again.':'The account check failed. Restart the helper; contact the demo operator if it repeats.');
    if(status.stage==='proof_ready'){evidence=status.evidence;await save();return;}
    showStatus(status.stage);timer=setTimeout(()=>void poll().catch(failed),1500);
  }
  async function connect(){if(busy)return;busy=true;const current=request;
    try{
      // Readiness before creating a server job prevents dead local links from
      // replacing the visible account state with an unnecessary pending attempt.
      const initial=await local('/status');check(current);
      if(job&&initial.stage!=='helper_ready')paired=true;
      if(!job){const result=await api(current.trade_request?'/v1/thot/trade-evidence/begin':'/v1/contributor/robinhood/link-jobs',{method:'POST',body:current.trade_request??{claim:'controls_brokerage'}});check(current);job=result;}
      if(!paired){await local('',{link_ticket:job.link_ticket,witness_url:job.witness_url,appraiser_url:job.appraiser_url,thot_public_key_pem:state.contributorPortfolio.capabilities.link_issuer_public_key_pem,...(current.trade_request?{purpose:'traded',request:job.request}:{})});paired=true;}
      await poll();
    }catch(error){failed(error);}finally{if(request===current)busy=false;}
  }
  async function cancel(){clearTimeout(timer);timer=null;if(owned()){
    await local('/cancel',{}).catch(()=>{});
    if(job&&!request.trade_request)await api(`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(job.job_id)}/cancel`,{method:'POST',body:{}});
  }clear();dialog.close();await refresh();}
  function authReady(){if(!request||owner||!state.loaded)return;if(request.error){const message=request.error;clear();openDialog('Cannot connect Robinhood',message,'');return;}if(state.role!=='user'){clear();return;}owner=state.actor?.id;
    if(request.trade_request){const r=request.trade_request;openDialog('Add a trade proof','Use the helper you started on this computer.',`<p>Check for a filled ${escape(r.symbol)} trade within ${escape(r.window_days)} days before or after the selected trace’s recorded start.</p><p>The helper uses your Robinhood session locally. THOT receives a bounded proof. This saves proof privately; sharing it with a listing requires separate consent.</p>`,'<button class="text-button" data-action="cancel-robinhood-setup">Cancel</button><button class="button" data-action="confirm-robinhood-setup">Check trade proof</button>');return;}
    openDialog('Connect Robinhood','Use the helper you started on this computer.',`<p>thot market will check that you control your Robinhood account using your existing Chrome login.</p><p>This creates a 24-hour account credential. It does not place trades or share your conversations.</p>`,'<button class="text-button" data-action="cancel-robinhood-setup">Cancel</button><button class="button" data-action="confirm-robinhood-setup">Check connection</button>');
  }
  function authLost(){if(owner){if(request)void send(request.callback+'/cancel',{method:'POST',mode:'cors',credentials:'omit',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)}).catch(()=>{});clear();}}
  function acceptFragment(){const value=parseRobinhoodFragment();if(!value)return;if(owner){toast('Finish or cancel the current Robinhood connection first.');return;}request=value;authReady();}
  async function handle(action){
    if(action==='link-robinhood'&&state.contributorPortfolio?.capabilities?.browser_linking!==true){
      openDialog('Connect Robinhood','Start the helper on the computer where you use Robinhood.',`<p>Run this in your terminal, then open the link it prints:</p>${setupCommand(`thot-link robinhood --thot-url ${location.origin}`,escape)}${installHelp(location.origin,escape)}<details class="setup-install"><summary>Check my prerequisites</summary>${setupCommand('thot-setup robinhood',escape)}<p>The next page checks the extension and guides the account check.</p></details>`,'<button class="button secondary" data-action="close-dialog">Close</button>');return true;
    }
    if(action==='close-dialog'&&request&&owner){if(stage==='saving'){toast('Please wait for verification to finish.');return true;}await cancel();return true;}
    if(action==='confirm-robinhood-setup'||action==='retry-robinhood-setup'){if(evidence)await save().catch(failed);else await connect();return true;}
    if(action==='cancel-robinhood-setup'){await cancel();return true;}return false;
  }
  function onDialogCancel(event){if(!request||!owner)return;event.preventDefault();if(stage!=='saving')void cancel().catch(failed);}
  return {handle,authReady,authLost,acceptFragment,clear,onDialogCancel};
}
