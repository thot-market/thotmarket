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
export function historySetupCommands(origin,client){
  const kind=client==='codex'?'codex':'claude',helper='"$HOME/.local/bin/thot-history"';
  const quotedOrigin="'"+origin.replaceAll("'","'\"'\"'")+"'";
  return {install:'node scripts/install-capture-helper.ts --thot-url '+quotedOrigin,check:helper+' --help',connect:helper+' connect --client '+kind+' --source "$HOME/.'+(kind==='codex'?'codex/sessions':'claude/projects')+'"',run:helper+' run --id CONNECTION_ID',status:helper+' status --id CONNECTION_ID',enable:helper+' enable --id CONNECTION_ID'};
}
export function createHistorySyncUI({state,api,openDialog,dialog,escape,toast,refresh,fetch:send=window.fetch.bind(window),pairing=parseHistorySyncFragment()}){
  let request=pairing,owner=null,handoff=null,busy=false;
  const owned=()=>owner&&owner.id===state.actor?.id&&owner.generation===state.generation&&state.role==='user';
  const guard=()=>{if(!owned())throw Error('Your account changed. Restart the history connection.');};
  function reset(){request=null;owner=null;handoff=null;busy=false;}
  function setup(client){
    const tool=client==='codex'?'Codex':'Claude Code',commands=historySetupCommands(window.location.origin,client);
    const command=value=>`<div class="setup-command"><code>${escape(value)}</code><button class="text-button" data-action="copy-setup-command" data-command="${escape(value)}">Copy</button></div>`;
    openDialog('Upload '+tool+' history daily','Save privately. Review separately before selling.',`<ol><li><strong>Install and check the helper</strong><p>Install Node.js 24 or later and make <code>node --version</code> work in your terminal. <a href="https://github.com/thot-market/thotmarket/releases" target="_blank" rel="noopener">Download a reviewed THOT source release</a>, extract it, and open that folder in your terminal.</p>${command(commands.install)}${command(commands.check)}<p>Continue after the help text appears. These commands use the installed path and work in a fresh terminal without adding the helper to PATH. Keep the extracted folder in place.</p></li><li><strong>Choose a folder and approve private uploads</strong><p>Check the suggested history folder or replace it with a narrower folder. Keep paths in quotes, including paths with spaces. Sign in and approve the connection in the browser.</p>${command(commands.connect)}</li><li><strong>Upload once, then choose a schedule</strong><p>Replace <code>CONNECTION_ID</code> with the ID printed in your terminal.</p>${command(commands.run)}${command(commands.status)}<p>Daily uploads are optional. On Linux with a working systemd user session, or on macOS, enable them explicitly:</p>${command(commands.enable)}</li></ol><p>Only new JSONL paths are included by default. Existing files stay local unless you add <code>--backfill</code> when connecting. Imports are private and unverified; uploading grants no sale permission.</p><details><summary>Prerequisites, timing and controls</summary><p>History upload needs Node.js 24+, an existing history folder and browser sign-in. It does not need a provider API key, a running coding client, Python or tmux. Manual file import is also available from Add a trace.</p><p>Repeat <code>--source</code> for another chosen folder. Default schedule: 02:00 UTC; choose <code>--time HH:MM</code> when connecting. Your computer and user session must be available. Missed work catches up after resume/login, with a 15-minute check on macOS. Windows scheduling is unsupported; run uploads manually.</p><p>Use <code>"$HOME/.local/bin/thot-history" status --id CONNECTION_ID</code> to inspect the local schedule. Use <code>pause</code>, <code>resume</code>, <code>disable</code> or <code>disconnect</code> with the same ID. Signing out here leaves upload permission active. Access expires after 30 days without a successful upload.</p><p>Only JSONL files unchanged for two minutes are read. Up to 20 files upload per run, with a 2 MB limit per file. Active, oversized and unsupported files remain local with a status code. Changed histories create immutable private versions; earlier deposits stay unchanged. Credentials are encrypted and owner-only.</p></details>`, '<button class="button secondary" data-action="history-sync-manage">Manage daily uploads</button>');
  }
  async function manage(){
    const id=state.actor?.id,generation=state.generation;const result=await api('/v1/contributor/history-devices');if(state.actor?.id!==id||state.generation!==generation||state.role!=='user')return;
    const choices='<div class="connection-actions"><button class="button secondary" data-action="history-sync-open" data-client="claude">Set up Claude Code uploads</button><button class="button secondary" data-action="history-sync-open" data-client="codex">Set up Codex uploads</button></div>';
    const labels={CONNECTED:'Upload permission active',PAUSED:'Upload permission paused',DISCONNECTED:'Disconnected',EXPIRED:'Permission expired'};
    openDialog('Daily history uploads','Save selected histories privately; review separately before selling.',result.devices.length?'<p>Upload permission does not confirm that your computer has a daily schedule. Check the local schedule and last run with the helper’s <code>status</code> command.</p>'+result.devices.map(d=>`<article class="connection-card"><h3>${escape(d.client==='codex'?'Codex':'Claude Code')} · ${escape(labels[d.status]??d.status.toLowerCase())}</h3><p>${d.source_count} selected folder(s) · requested time ${escape(d.daily_time_utc)} UTC · ${d.backfill?'existing histories included':'new paths only'}</p><p>Last saved: ${escape(d.last_saved_at??'No successful upload yet')}<br>Access expires: ${escape(d.expires_at)}</p>${!d.last_saved_at?'<p>Return to the helper and run once. If there are no new histories, create a new session or reconnect with <code>--backfill</code> to include existing files.</p>':''}${d.status==='CONNECTED'?`<button class="button secondary small" data-action="history-sync-pause" data-id="${escape(d.device_id)}">Pause uploads</button>`:''}${d.status==='PAUSED'?`<button class="button secondary small" data-action="history-sync-resume" data-id="${escape(d.device_id)}">Resume on server</button><p>If paused from the terminal, also run the local resume command.</p>`:''}${['CONNECTED','PAUSED'].includes(d.status)?` <button class="button secondary small" data-action="history-sync-disconnect" data-id="${escape(d.device_id)}">Disconnect</button>`:''}</article>`).join('')+choices:'<p>No uploader connected yet. Choose your tool to install the local helper, select folders and approve private uploads. Daily scheduling is a separate, optional step.</p>'+choices);
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
      reset();openDialog('History uploader connected','Return to your terminal to run once or explicitly enable daily uploads.','<p>No history was uploaded and no schedule was installed by this browser approval. Your helper prints the connection ID and exact commands.</p>', '<button class="button secondary" data-action="history-sync-manage">View daily uploads</button>');
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
