import {constants} from 'node:fs';
import {lstat,realpath,readdir,open,unlink} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {join,resolve,relative,isAbsolute,sep,parse,basename,dirname} from 'node:path';
import {loadPrivate,storePrivate,privateDirectory} from './local-state.ts';
import {thotOrigin} from './setup.ts';

export const HISTORY_LIMITS=Object.freeze({file_bytes:2_000_000,entries:10000,files:2000,depth:12,uploads_per_run:20,stable_ms:120000});
export type HistoryClient='claude'|'codex';
export type HistoryGrant={device_id:string;device_token:string;account_id:string;client:HistoryClient;source_ids:string[];backfill:boolean;daily_time_utc:string;expires_at:string;private_only:true};
export type HistorySource={id:string;path:string;excluded:string[]};
export type HistoryState={version:1;id:string;origin:string;client:HistoryClient;sources:HistorySource[];backfill:boolean;daily_time_utc:string;created_at:string;next_run_at:string;gate_config?:string;grant?:HistoryGrant;disconnected?:boolean;schedule?:string;receipts:Record<string,{version_id:string;trace_id:string;saved_at:string}>;last_run?:HistoryRun};
export type HistoryRun={at:string;saved:number;duplicates:number;unchanged:number;excluded:number;deferred:number;failed:number;remaining:number;errors:Array<{file_id?:string;code:string}>};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const historyConnectionId=(origin:string,client:HistoryClient)=>hash(thotOrigin(origin)+'\n'+client).slice(0,24);
export function historyDirectory(root:string,id:string){if(!/^[a-f0-9]{24}$/.test(id))throw Error('INVALID_HISTORY_CONNECTION_ID');return join(root,id);}
export async function loadHistoryState(dir:string):Promise<HistoryState>{
  await checkedHistoryRoot(dir);
  const state=await loadPrivate(dir) as HistoryState;
  if(state.version!==1||!['claude','codex'].includes(state.client)||state.id!==basename(dir)||historyConnectionId(state.origin,state.client)!==state.id||!Array.isArray(state.sources)||!state.sources.length||state.sources.length>10||!state.receipts||typeof state.receipts!=='object'||typeof state.backfill!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(state.daily_time_utc)||!Number.isFinite(Date.parse(state.next_run_at)))throw Error('HISTORY_STATE_INVALID');
  const ids=state.sources.map(s=>s.id);if(new Set(ids).size!==ids.length||state.sources.some(s=>!/^[a-f0-9]{32}$/.test(s.id)||!isAbsolute(s.path)||!Array.isArray(s.excluded)||s.excluded.some(id=>!/^[a-f0-9]{64}$/.test(id))))throw Error('HISTORY_STATE_INVALID');
  if(state.gate_config!==undefined&&(typeof state.gate_config!=='string'||!isAbsolute(state.gate_config)))throw Error('HISTORY_STATE_INVALID');
  const grant=state.grant;if(!grant||!/^[-a-f0-9]{36}$/.test(grant.device_id)||!/^[A-Za-z0-9_-]{43}$/.test(grant.device_token)||typeof grant.account_id!=='string'||grant.client!==state.client||grant.backfill!==state.backfill||grant.daily_time_utc!==state.daily_time_utc||grant.private_only!==true||JSON.stringify(grant.source_ids)!==JSON.stringify(ids))throw Error('HISTORY_STATE_BINDING_INVALID');
  return state;
}
export function nextHistoryRun(time:string,now=Date.now()){
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('INVALID_HISTORY_SCHEDULE');
  const date=new Date(now),[hours,minutes]=time.split(':').map(Number);date.setUTCHours(hours!,minutes!,0,0);if(date.getTime()<=now)date.setUTCDate(date.getUTCDate()+1);return date.toISOString();
}
export async function checkedHistoryRoot(input:string){
  const path=resolve(input);if(path===parse(path).root)throw Error('HISTORY_ROOT_TOO_BROAD');
  let cursor=parse(path).root;for(const piece of path.slice(cursor.length).split(sep).filter(Boolean)){cursor=join(cursor,piece);let stat;try{stat=await lstat(cursor);}catch(error){throw Error((error as NodeJS.ErrnoException).code==='ENOENT'?'HISTORY_DIRECTORY_NOT_FOUND':'HISTORY_DIRECTORY_UNREADABLE');}if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('HISTORY_DIRECTORY_REQUIRED_NO_SYMLINKS');}
  if(await realpath(path)!==path)throw Error('HISTORY_DIRECTORY_REQUIRED_NO_SYMLINKS');return path;
}
type Candidate={path:string;relative:string;file_id:string;size:number;mtimeMs:number;ino:number;dev:number};
/** Names and metadata only: enrollment never opens conversation bodies. */
export async function historyCandidates(path:string){
  const root=await checkedHistoryRoot(path),files:Candidate[]=[],errors:string[]=[];let entries=0;
  async function walk(dir:string,depth:number){
    if(depth>HISTORY_LIMITS.depth)throw Error('HISTORY_SCAN_DEPTH_LIMIT');
    // Reject changed parent links before descending, including selected roots.
    if(await realpath(dir)!==dir)throw Error('HISTORY_SYMLINK_REJECTED');
    for(const item of await readdir(dir,{withFileTypes:true})){
      if(++entries>HISTORY_LIMITS.entries)throw Error('HISTORY_SCAN_ENTRY_LIMIT');
      const file=join(dir,item.name);if(item.isSymbolicLink()){errors.push('HISTORY_SYMLINK_REJECTED');continue;}
      if(item.isDirectory()){await walk(file,depth+1);continue;}
      if(!item.isFile()||!item.name.endsWith('.jsonl'))continue;
      const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()){errors.push('HISTORY_SYMLINK_REJECTED');continue;}
      if(files.length>=HISTORY_LIMITS.files)throw Error('HISTORY_SCAN_FILE_LIMIT');
      const rel=relative(root,file);files.push({path:file,relative:rel,file_id:hash(rel),size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino,dev:stat.dev});
    }
  }
  await walk(root,0);return {files:files.sort((a,b)=>a.relative.localeCompare(b.relative)),errors};
}
export async function createHistoryState(options:{origin:string;client:HistoryClient;paths:string[];backfill?:boolean;time?:string;now?:number}):Promise<HistoryState>{
  const origin=thotOrigin(options.origin),now=options.now??Date.now(),time=options.time??'02:00';
  if(!['claude','codex'].includes(options.client)||!options.paths.length||options.paths.length>10)throw Error('INVALID_HISTORY_SOURCES');
  const sources:HistorySource[]=[];
  for(const path of options.paths){const root=await checkedHistoryRoot(path);if(sources.some(s=>root===s.path||root.startsWith(s.path+sep)||s.path.startsWith(root+sep)))throw Error('HISTORY_SOURCES_OVERLAP');const inventory=await historyCandidates(root);sources.push({id:randomBytes(16).toString('hex'),path:root,excluded:options.backfill?[]:inventory.files.map(f=>f.file_id)});}
  return {version:1,id:historyConnectionId(origin,options.client),origin,client:options.client,sources,backfill:options.backfill===true,daily_time_utc:time,created_at:new Date(now).toISOString(),next_run_at:nextHistoryRun(time,now),receipts:{}};
}
export async function historyGateHeaders(path:string,origin:string){
  try{
    if(!isAbsolute(path))throw Error();await checkedHistoryRoot(dirname(path));const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let config:any;
    try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o077)||stat.size>16384||process.getuid&&stat.uid!==process.getuid())throw Error();config=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
    if(thotOrigin(config.url)!==thotOrigin(origin)||typeof config.username!=='string'||typeof config.password!=='string'||!config.username||!config.password||config.username.length>1024||config.password.length>4096||config.username.includes(':')||/[\x00-\x1f\x7f]/.test(config.username+config.password))throw Error();
    return {Authorization:'Basic '+Buffer.from(config.username+':'+config.password).toString('base64')};
  }catch{throw Error('HISTORY_GATE_CONFIG_INVALID');}
}
export async function historyPost(state:HistoryState,action:string,body:unknown={},transport:typeof fetch=fetch){
  if(!state.grant)throw Error('HISTORY_NOT_CONNECTED');
  const credentials:Record<string,string>=state.gate_config?{...await historyGateHeaders(state.gate_config,state.origin),'X-THOT-History-Token':state.grant.device_token}:{Authorization:'Bearer '+state.grant.device_token};
  let response:Response;try{response=await transport(thotOrigin(state.origin)+'/v1/history-devices/'+encodeURIComponent(state.grant.device_id)+'/'+action,{method:'POST',headers:{...credentials,'Content-Type':'application/json','Idempotency-Key':'history-'+randomBytes(16).toString('hex')},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(60000)});}catch{throw Error('HISTORY_NETWORK_UNAVAILABLE');}
  const result=await response.json().catch(()=>({})) as any;
  if(!response.ok)throw Error(typeof result.error==='string'&&/^[A-Z0-9_]{1,100}$/.test(result.error)?result.error:'HISTORY_UPLOAD_UNAVAILABLE');return result;
}
export async function historyPaused(dir:string){try{const stat=await lstat(join(dir,'paused'));if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('HISTORY_STATE_PERMISSIONS');return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
export async function pauseHistoryLocally(dir:string,paused=true){
  await privateDirectory(dir);await checkedHistoryRoot(dir);if(!paused){await unlink(join(dir,'paused')).catch(error=>{if(error.code!=='ENOENT')throw error;});return;}
  const file=await open(join(dir,'paused'),constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);await file.close();
}
export async function historyLock<T>(dir:string,work:()=>Promise<T>):Promise<T>{
  await privateDirectory(dir);await checkedHistoryRoot(dir);
  // The OS releases a loopback socket when a helper dies. Unlike stale PID
  // files this needs no racy unlink/recovery; a port collision fails closed.
  const port=32768+parseInt(hash(resolve(dir)).slice(0,4),16)%32768;
  const mutex=createServer(socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{mutex.once('error',()=>reject(Error('HISTORY_RUN_ALREADY_ACTIVE')));mutex.listen({host:'127.0.0.1',port,exclusive:true},resolve);});
  try{return await work();}finally{await new Promise<void>(resolve=>mutex.close(()=>resolve()));}
}
async function stableRead(root:string,file:Candidate,now:number){
  if(file.size===0||file.size>HISTORY_LIMITS.file_bytes)throw Error(file.size?'IMPORT_TOO_LARGE':'HISTORY_EMPTY_FILE');
  if(now-file.mtimeMs<HISTORY_LIMITS.stable_ms)throw Error('HISTORY_FILE_ACTIVE');
  await checkedHistoryRoot(root);const resolved=await realpath(file.path),rel=relative(root,resolved);
  if(resolved!==file.path||isAbsolute(rel)||rel.startsWith('..'+sep))throw Error('HISTORY_SYMLINK_REJECTED');
  const opened=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await opened.stat();if(!before.isFile()||before.ino!==file.ino||before.dev!==file.dev||before.size!==file.size||before.mtimeMs!==file.mtimeMs)throw Error('HISTORY_FILE_CHANGED');
    // Bounded reads, including when another process appends while reading.
    const bytes=Buffer.alloc(file.size+1);let count=0;while(count<bytes.length){const result=await opened.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}const after=await opened.stat();
    if(count!==file.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||await realpath(file.path)!==file.path)throw Error('HISTORY_FILE_CHANGED');
    const content=bytes.subarray(0,file.size),text=content.toString('utf8');if(!Buffer.from(text).equals(content))throw Error('INVALID_UTF8');return text;
  }finally{await opened.close();}
}
const safeCode=(error:unknown)=>error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'HISTORY_FILE_UNAVAILABLE';
export async function runHistorySync(dir:string,options:{transport?:typeof fetch;now?:number;scheduled?:boolean}={}){
  return historyLock(dir,async()=>{
    const state=await loadHistoryState(dir),now=options.now??Date.now();
    if(state.disconnected)throw Error('HISTORY_DISCONNECTED');if(await historyPaused(dir))return {status:'PAUSED'};
    if(options.scheduled&&Date.parse(state.next_run_at)>now)return {status:'NOT_DUE',next_run_at:state.next_run_at};
    const run:HistoryRun={at:new Date(now).toISOString(),saved:0,duplicates:0,unchanged:0,excluded:0,deferred:0,failed:0,remaining:0,errors:[]};
    const persist=async()=>{state.last_run=run;await storePrivate(dir,state);};
    try{
      const remote=await historyPost(state,'status',{},options.transport);if(remote.status==='PAUSED')return {status:'PAUSED'};
      if(remote.status!=='CONNECTED')throw Error('HISTORY_DEVICE_UNAVAILABLE');
      if(remote.account_id!==state.grant!.account_id)throw Error('HISTORY_STATE_BINDING_INVALID');
      if(await historyPaused(dir))return {status:'PAUSED'};
      let attempted=0;
      for(const source of state.sources){
        const inventory=await historyCandidates(source.path);for(const code of inventory.errors){run.failed++;if(run.errors.length<30)run.errors.push({code});}
        for(const file of inventory.files){
          const identity=hash(source.id+'\n'+file.file_id);
          if(source.excluded.includes(file.file_id)){run.excluded++;continue;}
          if(await historyPaused(dir)){await persist();return {status:'PAUSED',...run};}
          if(attempted>=HISTORY_LIMITS.uploads_per_run){run.remaining++;continue;}
          try{
            const text=await stableRead(source.path,file,now),version=hash(text),prior=state.receipts[identity];
            if(prior?.version_id===version){run.unchanged++;continue;}
            if(!prior&&Object.keys(state.receipts).length>=20000)throw Error('HISTORY_LEDGER_LIMIT');
            if(await historyPaused(dir)){await persist();return {status:'PAUSED',...run};}
            attempted++;
            const result=await historyPost(state,'imports',{source_id:source.id,file_id:file.file_id,version_id:version,...(prior?{previous_version_id:prior.version_id}:{}),text},options.transport);
            if(result.version_id!==version||typeof result.trace_id!=='string'||result.private_only!==true)throw Error('HISTORY_ACKNOWLEDGEMENT_INVALID');
            state.receipts[identity]={version_id:version,trace_id:result.trace_id,saved_at:new Date(now).toISOString()};result.duplicate?run.duplicates++:run.saved++;await persist();
          }catch(error){const code=safeCode(error);if(['HISTORY_FILE_ACTIVE','HISTORY_FILE_CHANGED','HISTORY_EMPTY_FILE'].includes(code))run.deferred++;else run.failed++;if(run.errors.length<30)run.errors.push({file_id:file.file_id,code});await persist();if(/^(HISTORY_(DEVICE_|NETWORK_|UPLOAD_|ACKNOWLEDGEMENT)|INVALID_HISTORY_DEVICE|AUTH_ACTOR)/.test(code))throw error;}
        }
      }
      if(options.scheduled)state.next_run_at=nextHistoryRun(state.daily_time_utc,now);
      await persist();return {status:run.failed?'NEEDS_ATTENTION':run.deferred||run.remaining?'PENDING':'COMPLETE',...run,next_run_at:state.next_run_at};
    }catch(error){const code=safeCode(error);if(!run.errors.some(e=>e.code===code))run.errors.push({code});await persist();throw Error(code);}
  });
}
