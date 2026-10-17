#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat} from 'node:fs/promises';
import {thotUserHome,savedThotOrigin} from '../packages/capture/src/setup.ts';
import {loadPrivate,storePrivate} from '../packages/capture/src/local-state.ts';
import {createHistoryState,historyDirectory,historyLock,historyPaused,pauseHistoryLocally,historyPost,historyGateHeaders,runHistorySync,loadHistoryState,type HistoryClient,type HistoryState,HISTORY_LIMITS} from '../packages/capture/src/history-sync.ts';
import {connectHistory} from '../packages/capture/src/history-connect.ts';
import {installHistorySchedule,removeHistorySchedule} from '../packages/capture/src/history-schedule.ts';

const argv=process.argv.slice(2),command=argv.shift();
if(!command||command==='--help'||command==='-h'){
  console.log(`Usage: thot-history connect --client claude|codex --source DIRECTORY [--source DIRECTORY] [--thot-url ORIGIN] [--backfill] [--time HH:MM] [--gate-config FILE]
       thot-history run|status|pause|resume|enable|disable|disconnect --id CONNECTION_ID

Connect reads names and sizes only, then asks your signed-in browser for private-upload consent.
Only explicitly selected directories are scanned. New-only is the default: every existing JSONL path is excluded permanently. --backfill includes existing files.
Run uploads stable snapshots now. Changed snapshots create immutable private versions; earlier versions are never overwritten. Uploading never authorizes a sale.
Enable installs an explicit per-user daily schedule on Linux (systemd user) or macOS (LaunchAgent); default 02:00 UTC. This does not install or run during package installation.
The computer must be on, the user session available, and the source checkout/package retained. Missed work catches up after login/resume; macOS checks due work within 15 minutes. Linux needs a working systemd user session; this command does not enable lingering.
Pause stops local reading immediately and requests server pause. Resume requires server confirmation. Disconnect revokes uploads and retains saved vault history. Browser sign-out does not revoke this grant.
Limits: ${HISTORY_LIMITS.file_bytes} bytes per JSONL file, ${HISTORY_LIMITS.uploads_per_run} uploads/run, 2 minutes unchanged; unsupported/malformed files remain local with safe error codes. No provider credentials, model calls or live capture are used.
Connections expire after 30 days without a successful upload. Review status and reconnect when required.
Private environment operators may explicitly use --gate-config FILE: an existing owner-only JSON file with url, username and password. Its origin must match. Only its path is saved; credentials stay in that file and are sent solely to the selected origin. Public production needs no gate configuration.`);process.exit(0);
}
const flags=new Map<string,string>(),sources:string[]=[];let backfill=false,scheduled=false,noOpen=false;
for(let i=0;i<argv.length;i++){
  const arg=argv[i]!;if(arg==='--backfill'){backfill=true;continue;}if(arg==='--scheduled'){scheduled=true;continue;}if(arg==='--no-open'){noOpen=true;continue;}
  if(!['--client','--source','--thot-url','--time','--id','--state-root','--gate-config'].includes(arg)||!argv[i+1])throw Error('INVALID_HISTORY_ARGUMENT');const value=argv[++i]!;if(arg==='--source')sources.push(value);else{if(flags.has(arg))throw Error('DUPLICATE_HISTORY_ARGUMENT');flags.set(arg,value);}
}
const root=resolve(flags.get('--state-root')??join(thotUserHome(),'.local/state/thot/history'));
const inactiveGrant=new Set(['HISTORY_DEVICE_REVOKED','HISTORY_DEVICE_EXPIRED','INVALID_HISTORY_DEVICE']);
async function exists(path:string){try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
try{
  if(command==='connect'){
    const client=flags.get('--client') as HistoryClient,origin=flags.get('--thot-url')??process.env.THOT_URL??await savedThotOrigin();if(!origin)throw Error('HISTORY_ORIGIN_REQUIRED');
    const state=await createHistoryState({origin,client,paths:sources,backfill,time:flags.get('--time')}),dir=historyDirectory(root,state.id);
    if(flags.has('--gate-config')){state.gate_config=resolve(flags.get('--gate-config')!);await historyGateHeaders(state.gate_config,state.origin);}
    await historyLock(dir,async()=>{
      if(await exists(join(dir,'pending.enc'))){const old=await loadHistoryState(dir);if(old.schedule)throw Error('HISTORY_DISABLE_PREVIOUS_SCHEDULE_FIRST');if(!old.disconnected){let inactive=false;try{await historyPost(old,'status');}catch(error){if(error instanceof Error&&inactiveGrant.has(error.message))inactive=true;else throw error;}if(!inactive)throw Error('HISTORY_ALREADY_CONNECTED_DISCONNECT_FIRST');}}
      console.log('Selected '+state.sources.length+' '+client+' history folder(s). '+(backfill?'Existing history is included.':'Existing JSONL paths are excluded, including later edits.'));
      for(const source of state.sources)console.log('Local scope: '+source.path);
      await connectHistory(state,dir,{...(noOpen?{open:async()=>false}:{})});await pauseHistoryLocally(dir,false);
    });
    console.log('Private history connection: '+state.id+'\nUpload once: thot-history run --id '+state.id+'\nEnable daily uploads: thot-history enable --id '+state.id+'\nNo upload or schedule has started yet.');
  }else{
    if(sources.length||backfill||flags.has('--client')||flags.has('--time')||flags.has('--thot-url')||flags.has('--gate-config'))throw Error('HISTORY_CONNECT_FLAGS_ONLY');
    const dir=historyDirectory(root,flags.get('--id')??''),state=await loadHistoryState(dir);
    const schedule={id:state.id,home:thotUserHome(),stateRoot:root,entry:fileURLToPath(import.meta.url),time:state.daily_time_utc};
    if(command==='run')console.log(JSON.stringify(await runHistorySync(dir,{scheduled})));
    else if(command==='status'){
      const remote=state.disconnected?{status:'DISCONNECTED'}:await historyPost(state,'status');
      console.log(JSON.stringify({connection_id:state.id,client:state.client,source_count:state.sources.length,backfill:state.backfill,locally_paused:await historyPaused(dir),schedule_requested:state.schedule??null,next_run_at:state.next_run_at,remote,last_run:state.last_run??null,limits:HISTORY_LIMITS},null,2));
    }else if(command==='pause'){
      await pauseHistoryLocally(dir);await historyPost(state,'pause');console.log('Paused locally and on THOT. Saved histories remain private.');
    }else if(command==='resume'){
      if(state.disconnected)throw Error('HISTORY_DISCONNECTED');await historyPost(state,'resume');await pauseHistoryLocally(dir,false);console.log('Uploads resumed. Run now or wait for the enabled schedule.');
    }else if(command==='enable'){
      if(state.disconnected)throw Error('HISTORY_DISCONNECTED');const remote=await historyPost(state,'status');if(remote.status!=='CONNECTED'||await historyPaused(dir))throw Error('HISTORY_RESUME_BEFORE_SCHEDULING');
      await historyLock(dir,async()=>{const current=await loadPrivate(dir) as HistoryState;current.schedule='pending-'+process.platform;await storePrivate(dir,current);const result=await installHistorySchedule(schedule);current.schedule=result.platform;await storePrivate(dir,current);});
      console.log('Daily private uploads scheduled at '+state.daily_time_utc+' UTC while your user session is available. Keep this installation in place.');
    }else if(command==='disable'){
      await pauseHistoryLocally(dir);await removeHistorySchedule(schedule);await historyLock(dir,async()=>{const current=await loadPrivate(dir) as HistoryState;delete current.schedule;await storePrivate(dir,current);});console.log('Schedule removed; local uploads paused.');
    }else if(command==='disconnect'){
      await pauseHistoryLocally(dir);let schedulerFailed=false;if(state.schedule)try{await removeHistorySchedule(schedule);}catch{schedulerFailed=true;}
      if(!state.disconnected)try{await historyPost(state,'disconnect');}catch(error){if(!(error instanceof Error&&inactiveGrant.has(error.message)))throw error;}await historyLock(dir,async()=>{const current=await loadPrivate(dir) as HistoryState;current.disconnected=true;if(!schedulerFailed)delete current.schedule;await storePrivate(dir,current);});
      console.log('Disconnected. Upload access and local reads are stopped. Saved vault histories are unchanged.'+(schedulerFailed?' Scheduler removal needs attention; any remaining job is blocked by the local pause marker.':''));
    }else throw Error('INVALID_HISTORY_COMMAND');
  }
}catch(error){console.error(error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'HISTORY_COMMAND_FAILED');process.exitCode=1;}
