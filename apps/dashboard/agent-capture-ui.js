import {writeCaptureExport,chooseEmptyExportDirectory} from './capture-export-ui.js';
import {captureSetup} from './setup-ui.js';
const CLIENTS = { codex: 'Codex', claude: 'Claude Code' };
const TERMINAL = new Set(['SAVED', 'FAILED', 'EXPIRED', 'CANCELLED']);

// Independent browser recheck of the downloaded private operator bundle. Hash
// consistency does not authenticate its provider or upgrade it to TEE evidence.
export async function verifyProxyCapture(bundle,loadPart) {
  const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');
  let exchanges,interrupted=0;
  if(bundle?.format==='thot.proxy-capture/2'){
    if(!Array.isArray(bundle.parts)||!bundle.parts.length||bundle.parts.length>4096||typeof loadPart!=='function')throw new Error('Capture parts are required for verification.');
    const {format,capture_id,client,started_at,finished_at,parts}=bundle;
    if(await hash({format,capture_id,client,started_at,finished_at,parts})!==bundle.root)throw new Error('Capture manifest integrity check failed.');
    exchanges=parts.length;
    for(const [i,descriptor]of parts.entries()){
      if(descriptor.sequence!==i+1)throw new Error('Capture part order is invalid.');
      const part=await loadPart(descriptor.sequence),{commitment,...record}=part;
      if(part.sequence!==descriptor.sequence||commitment!==descriptor.commitment||await hash(record)!==commitment)throw new Error('Capture part integrity check failed.');
      if(!part.complete)interrupted++;
    }
  }else{
    if(bundle?.format!=='thot.proxy-capture/1'||!Array.isArray(bundle.exchanges)||!bundle.exchanges.length||bundle.exchanges.length>100)throw new Error('This capture bundle is invalid.');
    exchanges=bundle.exchanges.length;
    for(const [i,e]of bundle.exchanges.entries()){
      const {commitment,...record}=e;
      if(e.sequence!==i+1||await hash(record)!==commitment)throw new Error('Capture integrity check failed. Content has changed.');
      if(!e.complete)interrupted++;
    }
    const {format,capture_id,client,started_at,finished_at}=bundle;
    if(await hash({format,capture_id,client,started_at,finished_at,commitments:bundle.exchanges.map(e=>e.commitment)})!==bundle.root)throw new Error('Capture integrity check failed. The session root does not match.');
  }
  if(bundle.tee_evidence){
    const {tee_evidence:evidence,...original}=bundle;
    if(evidence.statement?.purpose!=='thot.tee-capture-seal/1'||evidence.statement.bundle_hash!==await hash(original)||evidence.statement.capture_id!==bundle.capture_id||evidence.statement.session_root!==bundle.root)throw new Error('TEE capture binding check failed.');
    const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey('spki',bytes(evidence.attestation.statement.signing_key),{name:'Ed25519'},false,['verify']);
    if(!await crypto.subtle.verify('Ed25519',key,bytes(evidence.signature),new TextEncoder().encode(canonical(evidence.statement))))throw new Error('TEE capture signature check failed.');
  }
  return {exchanges,interrupted,root:bundle.root,tee:!!bundle.tee_evidence};
}

export function parseAgentCaptureFragment(location = window.location, history = window.history) {
  const fragment=location.hash ?? '';
  if (!fragment.startsWith('#thot=')) return null;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const match = /^#thot=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match) return { error: 'This capture link is invalid or incomplete.' };
  try {
    const encoded = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
    if (!value || !Object.hasOwn(CLIENTS, value.client) || !validCallback(value.callback)) return { error: 'This capture link is invalid or incomplete.' };
    if(value.version!==undefined&&value.version!==2)return {error:'This helper version is unsupported.'};
    if(value.version===2&&(typeof value.device_name!=='string'||value.device_name.length<1||value.device_name.length>80||/[\x00-\x1f\x7f]/.test(value.device_name)))return {error:'This computer name is invalid.'};
    return Object.freeze({ client: value.client, callback: value.callback,...(value.version===2?{version:2,device_name:value.device_name}:{}) });
  } catch { return { error: 'This capture link is invalid or incomplete.' }; }
}

export function validCallback(value) {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.username === '' && url.password === '' &&
      url.port !== '' && Number(url.port) >= 1 && Number(url.port) <= 65535 && url.search === '' && url.hash === '' &&
      /^\/pair\/[A-Za-z0-9]{32,}$/.test(url.pathname);
  } catch { return false; }
}

export async function prepareCaptureSalePolicy({state,api,getProvider,current,price,treasuryOptIn}) {
  const provider=getProvider(),wallet=state.thot?.wallet,caps=state.thot?.capabilities??{};
  if(!provider?.request||!/^0x[0-9a-f]{40}$/i.test(wallet??'')||caps.stream_sales!==true)throw Error('Connect your THOT wallet before enabling automatic sales.');
  const accounts=await provider.request({method:'eth_accounts'});current();
  if(accounts?.[0]?.toLowerCase()!==wallet.toLowerCase())throw Error('Choose the wallet linked to this account.');
  const chain=await provider.request({method:'eth_chainId'});current();
  if(BigInt(chain)!==BigInt(caps.chain_id))throw Error('Switch to the configured THOT network.');
  if(!/^[1-9]\d{0,8}(\.\d{1,18})?$/.test(price??''))throw Error('Enter a positive THOT asking price.');
  const prepared=await api('/v1/thot/streams/prepare',{method:'POST',body:{price_thot:price,treasury_sampling_opt_in:treasuryOptIn}});current();
  const typed=prepared.typed_data;
  if(!typed?.domain||BigInt(typed.domain.chainId??0)!==BigInt(caps.chain_id)||typed.domain.verifyingContract?.toLowerCase()!==caps.market?.toLowerCase()||typed.message?.seller?.toLowerCase()!==wallet.toLowerCase())throw Error('The sale authorization does not match this wallet and market.');
  const signature=await provider.request({method:'eth_signTypedData_v4',params:[wallet,JSON.stringify(typed)]});current();
  const after=await provider.request({method:'eth_accounts'});current();
  if(provider!==getProvider()||after?.[0]?.toLowerCase()!==wallet.toLowerCase())throw Error('Wallet changed while signing. Reconnect with the original wallet.');
  return {sale_policy_id:prepared.id,sale_policy_signature:signature,rights_confirmed:true,model_output_licensed:true};
}

export function createAgentCaptureUI({ state, api, openDialog, dialog, refresh, escape, toast, getProvider=()=>globalThis.window?.ethereum, fetch: send = window.fetch.bind(window), pairing = parseAgentCaptureFragment() }) {
  let request = pairing;
  let owner = null;
  let capture = null;
  let handoff = null;
  let pollTimer = null;
  let saleEnrollment=null;
  let confirming=false;
  const name = () => CLIENTS[request?.client] ?? 'coding agent';
  const owned = () => owner && owner.actorId === state.actor?.id && state.role === 'user';

  function clear() { clearTimeout(pollTimer); pollTimer = null; request = null; owner = null; capture = null; handoff = null; saleEnrollment=null; }
  function consentDialog() {
    const tee=state.contributorPortfolio?.capabilities?.tee_capture===true;
    const sales=request?.version===2&&state.thot?.capabilities?.stream_sales===true&&state.thot?.wallet;
    openDialog(`Connect ${name()}`, 'Send this project’s coding session to your private thot market vault.',
      `<div class="capture-summary"><p>${request?.version===2?`Connect ${escape(name())} on ${escape(request.device_name)} once. Future captures from this computer save to this account without reopening your browser.`:`Save this ${escape(name())} session privately as you work.`} A recording bar stays visible in your terminal. Signed checkpoints arrive in your vault while you work.</p>${request?.version===2?'<p>Remembered access expires after 30 days without use. You can disconnect this tool in your vault. Signing out of this page leaves the tool connected.</p>':''}${sales?'<label class="consent-label"><input id="capture-auto-sales" type="checkbox"> Automatically offer my future completed, eligible sessions for sale. I have the rights to contribute the recorded context and model outputs. I authorize a non-exclusive 30-day AI research evaluation licence, with no onward resale, re-identification, account access or public model training.</label><label for="capture-sale-price">Gross asking price per completed session (THOT)</label><input id="capture-sale-price" inputmode="decimal" value="100"><p>Sign once for this connection: up to 10,000 single-use sales over 30 days. Your proceeds are the asking price minus the quoted service fee. Holding or locking THOT does not change the fee. Buyers see the licensed release only after paying. Local filtering may miss confidential prompts, tool output, code, or personal details. Enable automatic sales only for content you are willing to share. Non-conflicted governance reviewers can inspect the exact purchased release only during an onchain dispute. Recording alone earns nothing; a funded purchase is required. Existing private traces are unchanged.</p><label class="consent-label"><input id="capture-treasury-consent" type="checkbox"> Also include these releases in reserve review: authorized DAO reviewers may inspect one complete release per stable group of 20 unique traces.</label><p>Leave automatic sales unchecked to save privately. Disconnect stops new recordings and listings; wallet revocation also invalidates prepared unfunded offers.</p>':'<p>You will review and approve content separately before any release to a buyer.</p>'}<details><summary>How capture works</summary><p>${tee?'Your helper verifies the TEE recorder before starting. thot market verifies its signed capture before saving.':'This development instance uses a local recorder.'} Your existing coding-tool login is used. Only model requests sent through this CLI session are recorded, not ChatGPT or Claude website history. Tool activity outside the proxy is not independently witnessed.</p></details></div>`,
      '<button class="button secondary" data-action="cancel-agent-capture">Cancel</button><button class="button" id="confirm-agent-capture" data-action="confirm-agent-capture">Start private capture</button>');
  }
  function readyDialog() {
    openDialog('Browser approval complete', 'Return to your terminal to finish connecting and start your coding tool.', `<div class="capture-connected"><span aria-hidden="true">✓</span><p>Your vault updates as you work. ${capture?.automatic_sales?'Completed eligible sessions are offered under your signed terms. Earnings follow funded purchases.':'These sessions are saved privately.'} You can close this page.</p></div>`);
  }
  async function poll() {
    if (!capture || !owned()) return clear();
    const id = capture.capture_id;
    const result = await api(`/v1/contributor/agent-captures/${encodeURIComponent(id)}/status`);
    if (!capture || capture.capture_id !== id || !owned()) return;
    const status = String(result.status ?? '').toUpperCase();
    if (!TERMINAL.has(status)) { pollTimer = setTimeout(() => poll().catch(fail), 2000); return; }
    clearTimeout(pollTimer); pollTimer = null;
    if (status === 'SAVED') {
      const automatic=capture.automatic_sales;clear(); if (dialog.open) dialog.close(); state.view='vault'; await refresh(); toast(automatic?'Capture saved. Eligible sessions are offered under your signed terms.':'Capture saved to your private thot market vault.');
    } else {
      clear(); openDialog('Capture did not finish', status === 'EXPIRED' ? 'The connection expired. Start again from your terminal.' : 'Return to your terminal for details, then start a new capture.', '');
    }
  }
  function fail(error) {
    if (!owned()) return clear();
    clearTimeout(pollTimer); pollTimer = null;
    openDialog('Could not check capture status', error.message, '', '<button class="button secondary" data-action="cancel-agent-capture">Close</button><button class="button" data-action="check-agent-capture">Try again</button>');
  }
  async function confirm() {
    if (!request || !owned()) throw new Error('Your account changed. Start the connection again from your terminal.');
    const flowOwner = owner;
    const callback = request.callback;
    const remembered=request.version===2;
    const current=()=>{if(owner!==flowOwner||!owned())throw Error('Your account changed. Start the connection again from your terminal.');};
    const autoSales=remembered&&dialog.querySelector?.('#capture-auto-sales')?.checked===true;
    if(!handoff&&autoSales&&!saleEnrollment)saleEnrollment=await prepareCaptureSalePolicy({state,api,getProvider,current,price:dialog.querySelector('#capture-sale-price')?.value?.trim(),treasuryOptIn:dialog.querySelector('#capture-treasury-consent')?.checked===true});
    current();
    const saleTerms=autoSales?saleEnrollment:null;
    const result = handoff ?? await api(remembered?'/v1/contributor/capture-devices':'/v1/contributor/agent-captures/begin', { method: 'POST', body: { client: request.client, save_privately: !saleTerms,...(remembered?{device_name:request.device_name}:{}),...(saleTerms??{}) } });
    if (remembered?(!result?.device_id||!result?.device_token||!result?.account_id):(!result?.capture_id||!result?.upload_token||!result?.expires_at)) throw new Error('thot market did not return a complete capture connection.');
    if (owner !== flowOwner || !owned()) throw new Error('Your account changed. Start the connection again from your terminal.');
    handoff = result;
    const response = await send(callback, { method: 'POST', mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(remembered?result:{ capture_id: result.capture_id, upload_token: result.upload_token, expires_at: result.expires_at }) });
    if (!response.ok) throw new Error('The local recorder did not accept the connection. Return to your terminal and try again.');
    if (owner !== flowOwner || !owned()) throw new Error('Your account changed. Start the connection again from your terminal.');
    const connected=remembered?await response.json():result;
    if(typeof connected.capture_id!=='string')throw new Error('The helper did not confirm a capture. Return to your terminal.');
    capture = { capture_id: connected.capture_id,automatic_sales:connected.automatic_sales===true }; request = null; handoff = null; readyDialog(); pollTimer = setTimeout(() => poll().catch(fail), 1200);
  }
  function authReady() {
    if (!request || owner || !state.loaded) return;
    if (request.error) { const message=request.error; clear(); openDialog('Cannot connect capture', message, ''); return; }
    if (state.role !== 'user') { clear(); openDialog('Contributor account required', 'Sign in with a contributor account, then open the capture link again.', ''); return; }
    owner = { actorId: state.actor?.id }; consentDialog();
  }
  function authLost() { if (owner) clear(); }
  function onDialogClose() { if (request && owner) clear(); }
  async function handle(action,button) {
    if(action==='export-agent-capture'){
      if(typeof window.showDirectoryPicker!=='function'){openDialog('Keep your recording','Use the helper to export a private copy.',`<p>From your terminal:</p><pre>thot --export ${escape(button.dataset.id)} --output NEW_DIRECTORY</pre><p>Or open this vault in Chrome or Edge to save directly to a folder.</p>`);return true;}
      const actor=state.actor?.id,generation=state.generation;const checkOwner=()=>{if(state.actor?.id!==actor||state.generation!==generation||state.role!=='user')throw Error('Your account changed. Export stopped; the folder may contain partial files.');};
      // Picker must occur in the click's user activation, before network awaits.
      const folder=await chooseEmptyExportDirectory(window.showDirectoryPicker.bind(window));checkOwner();
      openDialog('Keeping your recording','Saving a private copy to the folder you chose.','<p>Original model payloads can contain private information. This may take a moment for a large session.</p>');
      try{const result=await writeCaptureExport({captureId:button.dataset.id,api,write:folder.write,checkOwner,readAsset:async name=>{const r=await send('/capture-verifier/'+name,{credentials:'omit',redirect:'error'});if(!r.ok)throw Error('The verifier download failed.');return r.text();}});checkOwner();openDialog('Your copy is ready',`${result.exchanges} exchanges saved to your folder.`, '<p>Open README.txt for the short guide. Run <code>node verify.mjs</code> to independently check the original bytes and signature.</p><p>The folder contains private plaintext. Hardware verification is a separate check using your trusted policy and collateral.</p>');}
      catch(e){if(state.actor?.id===actor&&state.generation===generation)openDialog('Export did not finish','Your vault recording is unchanged.','<p>The chosen folder may contain partial files. Choose a new empty folder to retry.</p>');throw e;}
      return true;
    }
    if(action==='verify-agent-capture'){
      const generation=state.generation,actor=state.actor?.id;
      const {bundle,receipt}=await api(`/v1/contributor/agent-captures/${encodeURIComponent(button.dataset.id)}/proof`);
      const result=await verifyProxyCapture(bundle,async sequence=>(await api(`/v1/contributor/agent-captures/${encodeURIComponent(button.dataset.id)}/proof/parts/${sequence}`)).part);
      if(generation!==state.generation||actor!==state.actor?.id)throw new Error('Your account changed. Reopen the capture.');
      if(receipt?.confidence_tier==='P2_TEE'){if(!result.tee)throw new Error('TEE evidence missing.');openDialog('TEE capture verified', `${result.exchanges} exchanges checked.${result.interrupted?` ${result.interrupted} interrupted; completed turns were saved.`:' Recorded by the verified TEE proxy.'}`, '<p>thot market verified the Intel hardware quote, approved recorder measurements, and the signed connection to your capture.</p><p>Your browser also checked the original content hashes and recorder signature. The model ran at its provider; the TEE witnessed the exchanges.</p>');return true;}
      openDialog('Capture integrity checked', `${result.exchanges} recorded exchanges match their saved commitments.`, '<p>Your browser independently recalculated the content hashes and session root.</p><p>This checks that the captured bytes match the stored record. It does not authenticate the model provider or establish TEE verification.</p>');return true;
    }
    if (action === 'start-agent-capture') { openDialog('Capture a coding session', 'Choose the tool you already use.', '<p>Your existing subscription login carries over. Capture saves privately to your thot market vault.</p>', '<button class="button" data-action="setup-codex">Set up Codex</button><button class="button secondary" data-action="setup-claude">Set up Claude Code</button>'); return true; }
    if (action === 'setup-codex' || action === 'setup-claude') { const client=action==='setup-codex'?'codex':'claude';openDialog(client==='codex'?'Connect Codex':'Connect Claude Code','Check once, then capture from your project.',captureSetup(client,location.origin,escape),`<button class="button" data-action="capture-start-${client}">Next: start capture</button>`);return true; }
    if(action==='capture-start-codex'||action==='capture-start-claude'){const client=action==='capture-start-codex'?'codex':'claude';openDialog(client==='codex'?'Start Codex capture':'Start Claude Code capture','Run this from the project you want to save.',captureSetup(client,location.origin,escape,'start'),'<button class="button secondary" data-action="close-dialog">Close</button>');return true;}
    if (action === 'cancel-agent-capture') { clear(); dialog.close(); return true; }
    if (action === 'check-agent-capture') { await poll(); return true; }
    if (action === 'confirm-agent-capture') { if(confirming)return true;confirming=true;if(button)button.disabled=true;try{await confirm();}finally{confirming=false;if(button)button.disabled=false;}return true; }
    return false;
  }
  function onChange(target) { if(['capture-auto-sales','capture-sale-price','capture-treasury-consent'].includes((target?.target??target)?.id)){saleEnrollment=null;const button=dialog.querySelector?.('#confirm-agent-capture');if(button)button.textContent=dialog.querySelector('#capture-auto-sales')?.checked?'Sign terms & start capture':'Start private capture';return true;}return false; }
  function acceptFragment(value=parseAgentCaptureFragment()){if(!value)return;clear();request=value;authReady();}
  return { authReady, authLost, onDialogClose, handle, onChange, clear, acceptFragment };
}
