import {validCallback} from './agent-capture-ui.js';

export function parseHistorySyncFragment(location=window.location,history=window.history){
  if(!location.hash?.startsWith('#thot-history='))return null;
  const fragment=location.hash;history.replaceState(history.state,'',location.pathname+location.search);
  try{
    if(fragment.length>4000)throw Error();const encoded=fragment.slice('#thot-history='.length);if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error();
    const r=JSON.parse(atob(encoded.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-encoded.length%4)%4)));
    if(r.version!==1||!['claude','codex'].includes(r.client)||!validCallback(r.callback)||typeof r.backfill!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.daily_time_utc)||!Array.isArray(r.source_ids)||!r.source_ids.length||r.source_ids.length>10||new Set(r.source_ids).size!==r.source_ids.length||r.source_ids.some(s=>typeof s!=='string'||!/^[a-f0-9]{32}$/.test(s)))throw Error();
    return {client:r.client,callback:r.callback,source_ids:r.source_ids,backfill:r.backfill,daily_time_utc:r.daily_time_utc};
  }catch{return {error:'This history connection link is invalid. Restart the helper.'};}
}
export function createHistorySyncUI({state,api,openDialog,dialog,escape,toast,refresh,fetch:send=window.fetch.bind(window),pairing=parseHistorySyncFragment()}){
  let request=pairing,owner=null,handoff=null,busy=false;
  const owned=()=>owner&&owner.id===state.actor?.id&&owner.generation===state.generation&&state.role==='user';
  const guard=()=>{if(!owned())throw Error('Your account changed. Restart the history connection.');};
  function reset(){request=null;owner=null;handoff=null;busy=false;}
  function setup(client){
    const tool=client==='codex'?'Codex':'Claude Code',kind=client==='codex'?'codex':'claude';
    const origin=window.location.origin,install='node scripts/install-capture-helper.ts --thot-url '+origin,connect='thot-history connect --client '+kind+' --source "$HOME/.'+(kind==='codex'?'codex/sessions':'claude/projects')+'"';
    const command=value=>`<div class="setup-command"><code>${escape(value)}</code><button class="text-button" data-action="copy-setup-command" data-command="${escape(value)}">Copy</button></div>`;
    openDialog('Upload '+tool+' history daily','Save privately. Review separately before selling.',`<ol><li><strong>Install from reviewed source</strong><p><a href="https://github.com/thot-market/thotmarket/releases" target="_blank" rel="noopener">Download a THOT source release</a>, extract it, and open its folder in your terminal. Node 24+ is required.</p>${command(install)}</li><li><strong>Choose your history folder</strong><p>The command suggests the usual location. Change it to the folder you want to upload.</p>${command(connect)}</li><li><strong>Approve, then turn on daily uploads</strong><p>Approve the browser connection. Return to the terminal and use the connection ID it prints.</p>${command('thot-history enable --id CONNECTION_ID')}</li></ol><p>Only new JSONL paths are included by default. Imports are private and unverified; this grants no sale permission.</p><details><summary>Existing history, timing and controls</summary><p>Add <code>--backfill</code> when connecting to include existing files; otherwise every existing path stays excluded, including later edits. Repeat <code>--source</code> for another chosen folder.</p><p>Default schedule: 02:00 UTC. Choose <code>--time HH:MM</code> when connecting. Linux systemd user sessions and macOS LaunchAgents are supported. Your computer and user session must be available; missed work catches up after resume/login, with a 15-minute check on macOS. Keep the helper installation in place.</p><p>To upload once, run <code>thot-history run --id CONNECTION_ID</code>. Use <code>status</code>, <code>pause</code>, <code>resume</code> or <code>disconnect</code> with the same ID. Signing out of this page leaves uploads connected. Access expires after 30 days without a successful upload.</p><p>Only JSONL files unchanged for two minutes are read. Up to 20 files upload per run, with a 2 MB limit per file. Active, oversized and unsupported files remain local with a status code. Changed histories create immutable private versions; earlier deposits stay unchanged. Credentials are encrypted and owner-only.</p></details>`, '<button class="button secondary" data-action="history-sync-manage">Manage daily uploads</button>');
  }
  async function manage(){
    const id=state.actor?.id,generation=state.generation;const result=await api('/v1/contributor/history-devices');if(state.actor?.id!==id||state.generation!==generation||state.role!=='user')return;
    openDialog('Daily history uploads','Each connection can only save private imported history.',result.devices.length?result.devices.map(d=>`<article class="connection-card"><h3>${escape(d.client==='codex'?'Codex':'Claude Code')} · ${escape(d.status.toLowerCase())}</h3><p>${d.source_count} selected folder(s) · ${escape(d.daily_time_utc)} UTC · ${d.backfill?'existing histories included':'new paths only'}</p><p>Last saved: ${escape(d.last_saved_at??'No successful upload yet')}<br>Access expires: ${escape(d.expires_at)}</p>${d.status==='CONNECTED'?`<button class="button secondary small" data-action="history-sync-pause" data-id="${escape(d.device_id)}">Pause uploads</button>`:''}${d.status==='PAUSED'?`<button class="button secondary small" data-action="history-sync-resume" data-id="${escape(d.device_id)}">Resume on server</button><p>If paused from the terminal, also run the local resume command.</p>`:''}${['CONNECTED','PAUSED'].includes(d.status)?` <button class="button secondary small" data-action="history-sync-disconnect" data-id="${escape(d.device_id)}">Disconnect</button>`:''}</article>`).join(''):'<p>No daily history uploader connected yet. Choose Claude Code or Codex to connect one.</p>');
  }
  function authReady(){
    if(!request||owner||!state.loaded)return;
    if(request.error){const message=request.error;reset();openDialog('Cannot connect history uploads',message,'');return;}
    if(state.role!=='user'){reset();openDialog('Contributor account required','Sign in with your contributor account, then restart the helper.','');return;}
    owner={id:state.actor?.id,generation:state.generation};
    openDialog('Allow private history uploads?','Connect '+(request.client==='codex'?'Codex':'Claude Code')+' history from this computer.',`<p>The helper selected ${request.source_ids.length} folder(s), shown in your terminal. Folder paths stay on your computer.</p><p>${request.backfill?'Existing and future JSONL histories in those folders are included.':'Existing JSONL paths are excluded, including later edits. Only new paths are included.'} Stable file versions will save privately to this signed-in account.</p><p>The schedule is ${escape(request.daily_time_utc)} UTC when you explicitly enable it in the terminal. Access expires after 30 days without a successful upload. You can pause or disconnect it here. Signing out leaves it connected.</p><p>Prompts, answers, tool output, code and personal information can be included. Imported history is unverified. This permission does not authorize listing, sale or access to your vault.</p><label class="consent-label"><input type="checkbox" id="history-private-consent"> Allow the selected histories to be uploaded privately.</label>`, '<button class="button secondary" data-action="history-sync-cancel">Cancel</button><button class="button" data-action="history-sync-confirm">Connect private uploads</button>');
  }
  async function confirm(){
    guard();if(!request||!dialog.querySelector('#history-private-consent')?.checked)throw Error('Confirm private history upload permission first.');if(busy)return;busy=true;
    const current=request;
    try{
      const result=handoff??await api('/v1/contributor/history-devices',{method:'POST',body:{client:current.client,source_ids:current.source_ids,backfill:current.backfill,daily_time_utc:current.daily_time_utc,consent:'private-history-upload-v1'}});guard();if(current!==request)throw Error('History connection changed.');handoff=result;
      const response=await send(current.callback,{method:'POST',mode:'cors',cache:'no-store',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});guard();
      if(!response.ok)throw Error('The local helper could not accept this connection. Keep it open and retry.');const ack=await response.json();guard();if(ack.paired!==true||ack.private_only!==true)throw Error('The helper did not confirm private upload permission.');
      reset();openDialog('History uploader connected','Return to your terminal to run once or explicitly enable daily uploads.','<p>No history was uploaded by this browser approval. Your helper prints the connection ID and exact commands. You can close this page.</p>');
    }finally{busy=false;}
  }
  async function handle(action,button){
    if(action==='history-sync-open'){setup(button?.dataset.client);return true;}
    if(action==='history-sync-manage'){await manage();return true;}
    if(action==='history-sync-confirm'){await confirm();return true;}
    if(action==='history-sync-cancel'){reset();dialog.close();return true;}
    const control=/^history-sync-(pause|resume|disconnect)$/.exec(action);
    if(control){const id=state.actor?.id,generation=state.generation;await api('/v1/contributor/history-devices/'+encodeURIComponent(button.dataset.id)+'/'+control[1],{method:'POST',body:{}});if(state.actor?.id!==id||state.generation!==generation)return true;await manage();toast(control[1]==='disconnect'?'Upload permission revoked. Saved history is unchanged.':control[1]==='pause'?'Uploads paused on THOT.':'Uploads resumed on THOT. Locally paused helpers also need the resume command.');return true;}
    return false;
  }
  return {handle,authReady,acceptFragment(){const next=parseHistorySyncFragment();if(!next)return false;reset();request=next;authReady();return true;},authLost(){if(owner)reset();},reset,onDialogClose(){if(request&&owner)reset();}};
}
