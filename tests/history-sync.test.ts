import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,utimes,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHistoryState,historyDirectory,historyLock,historyPost,historyGateHeaders,historyCandidates,runHistorySync,pauseHistoryLocally,loadHistoryState,HISTORY_LIMITS,type HistoryState} from '../packages/capture/src/history-sync.ts';
import {storePrivate,loadPrivate} from '../packages/capture/src/local-state.ts';
import {connectHistory} from '../packages/capture/src/history-connect.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';

const text=(value='Synthetic history')=>JSON.stringify({type:'assistant',sessionId:'synthetic',message:{role:'assistant',content:value}})+'\n';
async function fixture(t:any,backfill=false){
  const root=await mkdtemp(join(tmpdir(),'thot-history-sync-')),source=join(root,'selected');await mkdir(source);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const old=join(source,'existing.jsonl');await writeFile(old,text('Existing file'));await utimes(old,1,1);
  const state=await createHistoryState({origin:'https://history.invalid',client:'claude',paths:[source],backfill});
  state.grant={device_id:'00000000-0000-4000-8000-000000000001',device_token:'a'.repeat(43),account_id:'synthetic-owner',client:'claude',source_ids:state.sources.map(s=>s.id),backfill,daily_time_utc:state.daily_time_utc,expires_at:new Date(Date.now()+86400000).toISOString(),private_only:true};
  const dir=historyDirectory(join(root,'state'),state.id);await storePrivate(dir,state);return {root,source,old,state,dir};
}
function transport(){const imports:any[]=[];return {imports,send:(async(url:string,init:RequestInit)=>{if(url.endsWith('/status'))return Response.json({status:'CONNECTED',account_id:'synthetic-owner'});const body=JSON.parse(String(init.body));imports.push(body);return Response.json({trace_id:'synthetic-trace-'+imports.length,version_id:body.version_id,private_only:true,duplicate:false,status:'PRIVATE'});}) as typeof fetch};}

test('new-only excludes existing paths forever; retry/restart avoids duplicates and changed snapshots are versions',async t=>{
  const {source,old,dir}=await fixture(t),remote=transport();await chmod(old,0);
  const fresh=join(source,'new.jsonl');await writeFile(fresh,text());await utimes(fresh,1,1);
  const first=await runHistorySync(dir,{transport:remote.send});assert.equal(first.status,'COMPLETE');assert.equal(remote.imports.length,1);
  await runHistorySync(dir,{transport:remote.send});assert.equal(remote.imports.length,1);
  await chmod(old,0o600);await writeFile(old,text('Changed excluded history'));await utimes(old,1,1);
  await writeFile(fresh,text('Changed included history'));await utimes(fresh,1,1);
  await runHistorySync(dir,{transport:remote.send});assert.equal(remote.imports.length,2);assert.equal(remote.imports[1].previous_version_id,remote.imports[0].version_id);assert.notEqual(remote.imports[1].version_id,remote.imports[0].version_id);
  assert.ok(!JSON.stringify(remote.imports).includes(source));
  const stored=await readFile(join(dir,'pending.enc'));assert.ok(!stored.includes(Buffer.from('synthetic-owner')));assert.ok(!stored.includes(Buffer.from('a'.repeat(43))));assert.equal((await lstat(dir)).mode&0o077,0);assert.equal((await lstat(join(dir,'local.key'))).mode&0o077,0);
});

test('backfill is explicit; symlinks, active files and oversized files are never uploaded',async t=>{
  const {root,source,dir}=await fixture(t,true),remote=transport();
  await writeFile(join(root,'outside.jsonl'),text('Excluded outside'));await symlink(join(root,'outside.jsonl'),join(source,'linked.jsonl'));
  await writeFile(join(source,'active.jsonl'),text('Recently changed'));
  await writeFile(join(source,'large.jsonl'),'x'.repeat(HISTORY_LIMITS.file_bytes+1));await utimes(join(source,'large.jsonl'),1,1);
  const result=await runHistorySync(dir,{transport:remote.send});assert.equal(result.status,'NEEDS_ATTENTION');assert.equal(remote.imports.length,1);assert.match(remote.imports[0].text,/Existing file/);
  const state=await loadHistoryState(dir);assert.ok(state.last_run!.errors.some(e=>e.code==='HISTORY_SYMLINK_REJECTED'));assert.ok(state.last_run!.errors.some(e=>e.code==='IMPORT_TOO_LARGE'));assert.equal(state.last_run!.deferred,1);
  await symlink(source,join(root,'root-link'));await assert.rejects(historyCandidates(join(root,'root-link')),/NO_SYMLINKS/);
});

test('lost acknowledgements retry the same version; pause, remote pause and not-due checks precede file reads',async t=>{
  const {dir,state}=await fixture(t,true),remote=transport();let first=true;
  const flaky=(async(url:string,init:RequestInit)=>{const response=await remote.send(url,init);if(url.endsWith('/imports')&&first){first=false;throw Error('Network failure with private detail');}return response;}) as typeof fetch;
  await assert.rejects(runHistorySync(dir,{transport:flaky}),/HISTORY_NETWORK_UNAVAILABLE/);assert.equal(Object.keys((await loadHistoryState(dir)).receipts).length,0);
  await runHistorySync(dir,{transport:flaky});assert.equal(remote.imports.length,2);assert.equal(remote.imports[0].version_id,remote.imports[1].version_id);
  await pauseHistoryLocally(dir);await rm(state.sources[0]!.path,{recursive:true});assert.equal((await runHistorySync(dir,{transport:remote.send})).status,'PAUSED');
  await pauseHistoryLocally(dir,false);assert.equal((await runHistorySync(dir,{transport:remote.send,scheduled:true,now:Date.parse(state.created_at)})).status,'NOT_DUE');
  const paused=(async()=>Response.json({status:'PAUSED'})) as typeof fetch;assert.equal((await runHistorySync(dir,{transport:paused})).status,'PAUSED');
  const pauseDuringStatus=(async()=>{await pauseHistoryLocally(dir);return Response.json({status:'CONNECTED',account_id:'synthetic-owner'});}) as typeof fetch;assert.equal((await runHistorySync(dir,{transport:pauseDuringStatus})).status,'PAUSED');
});

test('bounded uploads, invalid moved-state bindings, and concurrent/crashed helpers fail safely',async t=>{
  const {source,dir,root}=await fixture(t,true),remote=transport();
  for(let i=0;i<21;i++){const path=join(source,'new-'+i+'.jsonl');await writeFile(path,text('Fixture '+i));await utimes(path,1,1);}
  const result=await runHistorySync(dir,{transport:remote.send});assert.equal(remote.imports.length,HISTORY_LIMITS.uploads_per_run);assert.equal(result.status,'PENDING');
  let release!:()=>void;const held=historyLock(dir,()=>new Promise<void>(r=>release=r));while(!release)await new Promise(r=>setTimeout(r,1));await assert.rejects(historyLock(dir,async()=>{}),/HISTORY_RUN_ALREADY_ACTIVE/);release();await held;
  const module=resolve('packages/capture/src/history-sync.ts');const child=spawn(process.execPath,['--input-type=module','-e',`import {historyLock} from ${JSON.stringify(module)};await historyLock(${JSON.stringify(dir)},async()=>{process.stdout.write('ready');await new Promise(()=>{});});`],{stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(Error('child exited before lock')));});child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));await historyLock(dir,async()=>{});
  const moved=historyDirectory(join(root,'moved'),'f'.repeat(24));await storePrivate(moved,await loadPrivate(dir));await assert.rejects(loadHistoryState(moved),/HISTORY_STATE_INVALID/);
  await symlink(join(root,'state'),join(root,'state-alias'));const alias=join(root,'state-alias',dir.split('/').at(-1)!);await assert.rejects(historyLock(alias,async()=>{}),/NO_SYMLINKS/);await assert.rejects(loadHistoryState(alias),/NO_SYMLINKS/);
});

test('real synthetic pairing and scheduled helper upload reach the private library without sale consent',async t=>{
  const {root,source}=await fixture(t,true),appDir=await mkdtemp(join(tmpdir(),'thot-history-http-')),app=await createApplication({dataDir:appDir,memory:true}),server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await app.close();await rm(appDir,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+(server.address() as any).port,state=await createHistoryState({origin,client:'claude',paths:[source],backfill:true}),dir=historyDirectory(join(root,'connected'),state.id);
  let callbacks=0;
  await connectHistory(state,dir,{log:()=>{},open:async url=>{
    const request=JSON.parse(Buffer.from(new URL(url).hash.slice('#thot-history='.length),'base64url').toString());
    const grant=await app.historyDevices.create({id:'demo-user',role:'user'},{client:request.client,source_ids:request.source_ids,backfill:request.backfill,daily_time_utc:request.daily_time_utc,consent:'private-history-upload-v1'});
    assert.equal((await fetch(request.callback,{method:'POST',headers:{Origin:'https://untrusted.invalid'},body:JSON.stringify(grant)})).status,403);
    const result=await fetch(request.callback,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(grant)});assert.equal(result.status,200);callbacks++;return true;
  }});
  assert.equal(callbacks,1);assert.equal((await app.library.list({id:'demo-user',role:'user'},{})).items.length,0);
  const result=await runHistorySync(dir,{scheduled:true,now:Date.parse(state.next_run_at)+1});assert.equal(result.status,'COMPLETE');
  const library=await app.library.list({id:'demo-user',role:'user'},{});assert.equal(library.items.length,1);assert.equal(library.items[0]!.evidence,'IMPORTED_UNVERIFIED');assert.equal(library.items[0]!.sale_eligibility.can_list,false);
  await historyPost(await loadHistoryState(dir),'disconnect');await assert.rejects(runHistorySync(dir),/HISTORY_DEVICE_REVOKED/);
});

test('explicit private gate transport keeps credentials in the protected source file and binds its origin',async t=>{
  const {root,state,dir}=await fixture(t,true),path=join(root,'synthetic-gate.json');
  await writeFile(path,JSON.stringify({url:state.origin,username:'synthetic-gate-user',password:'synthetic-gate-password'}),{mode:0o600});state.gate_config=path;await storePrivate(dir,state);
  let calls=0;
  const send=(async(url:string,init:RequestInit)=>{calls++;assert.equal(new URL(url).origin,state.origin);const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Basic '+Buffer.from('synthetic-gate-user:synthetic-gate-password').toString('base64'));assert.equal(headers.get('x-thot-history-token'),state.grant!.device_token);return Response.json({status:'CONNECTED',account_id:state.grant!.account_id});}) as typeof fetch;
  await historyPost(state,'status',{},send);assert.equal(calls,1);
  const decrypted=JSON.stringify(await loadHistoryState(dir));assert.ok(!decrypted.includes('synthetic-gate-password'));assert.ok(!decrypted.includes('synthetic-gate-user'));
  await assert.rejects(historyGateHeaders(path,'https://different.invalid'),/HISTORY_GATE_CONFIG_INVALID/);
  await chmod(path,0o644);await assert.rejects(historyPost(state,'status',{},send),/HISTORY_GATE_CONFIG_INVALID/);assert.equal(calls,1);
  await chmod(path,0o600);const link=join(root,'gate-link.json');await symlink(path,link);await assert.rejects(historyGateHeaders(link,state.origin),/HISTORY_GATE_CONFIG_INVALID/);
});
