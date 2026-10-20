import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,copyFile,lstat,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {loadPrivate,storePrivate} from '../packages/capture/src/local-state.ts';
// @ts-expect-error Dashboard modules are browser JavaScript.
import {historySetupCommands} from '../apps/dashboard/history-sync-ui.js';

const root=resolve(import.meta.dirname,'..'),quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
function processRun(command:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv}={}){
  const child=spawn(command,args,{...options,detached:true,stdio:['ignore','pipe','pipe']});
  const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  let output='',stdout='';const done=new Promise<{code:number|null;output:string;stdout:string}>((resolve,reject)=>{
    const timer=setTimeout(stop,60_000);
    child.stdout.on('data',chunk=>{output+=chunk;stdout+=chunk;});child.stderr.on('data',chunk=>output+=chunk);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve({code,output,stdout});});
  });
  return {child,done,stop,get output(){return output;}};
}
async function checked(command:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv}={}){
  const result=await processRun(command,args,options).done;assert.equal(result.code,0,result.output);return result.stdout;
}
async function packagedSource(destination:string){
  const dependencies=JSON.parse(await readFile(join(root,'packages/thot-cli/reviewed-source-files.json'),'utf8')).files;
  const packageFiles=['package.json','build.mjs','reviewed-source-files.json','README.md','LICENSE','bin/thot.js'];
  for(const name of new Set<string>([...dependencies,'LICENSE','package.json','scripts/install-capture-helper.ts','scripts/thot-link.ts',...packageFiles.map(name=>'packages/thot-cli/'+name)])){
    const target=join(destination,name);await mkdir(dirname(target),{recursive:true});await copyFile(join(root,name),target);
  }
}
const claude=(text:string)=>JSON.stringify({type:'assistant',sessionId:'synthetic-installed-history',message:{role:'assistant',content:text}})+'\n';
const codex=(text:string)=>JSON.stringify({type:'session_meta',payload:{id:'synthetic-installed-codex'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})+'\n';
async function stableFile(path:string,text:string){await writeFile(path,text);const old=new Date(Date.now()-180_000);await utimes(path,old,old);}

test('source-installed and npm-installed history executables complete a synthetic private lifecycle in fresh shells',async t=>{
  const temporary=await mkdtemp(join(tmpdir(),'thot installed history '));
  const app=await createApplication({dataDir:join(temporary,'backend'),memory:true});
  const server=createHttpServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await app.close();await rm(temporary,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const source=join(temporary,'reviewed source');await packagedSource(source);
  const taskEnv={...process.env,THOT_URL:'',NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_CACHE:join(temporary,'npm cache')};
  const sourceHome=join(temporary,'source user'),packageHome=join(temporary,'package user'),prefix=join(temporary,'installed package');
  const installCommands=historySetupCommands(origin,'claude');
  await checked('/bin/sh',['-c',installCommands.install],{cwd:source,env:{...taskEnv,THOT_USER_HOME:sourceHome}});
  const printed=await checked(process.execPath,['scripts/install-capture-helper.ts','--thot-url',origin],{cwd:source,env:{...taskEnv,THOT_USER_HOME:sourceHome}});
  assert.match(printed,/Installation alone does not connect an account, upload files or install a schedule/);
  const helpCommand=printed.split('\n').find(line=>line.endsWith("' --help"))!;
  assert.ok(helpCommand);
  const cleanPath=join(temporary,'only node on PATH');await mkdir(cleanPath);await symlink(process.execPath,join(cleanPath,'node'));
  const cleanEnv={...taskEnv,PATH:cleanPath,THOT_USER_HOME:sourceHome};
  assert.match(await checked('/bin/sh',['-c',helpCommand],{cwd:temporary,env:cleanEnv}),/Usage: thot-history connect/);
  assert.equal((await processRun('/bin/sh',['-c','command -v thot-history'],{env:cleanEnv}).done).code,127);
  // The web command intentionally uses the normal home. Isolated tests use the
  // installer's printed absolute path, without repurposing HOME or shell files.
  assert.equal(installCommands.check,'"$HOME/.local/bin/thot-history" --help');
  assert.match(installCommands.connect,/"\$HOME\/\.claude\/projects"/);
  const packed=JSON.parse(await checked('npm',['pack','--json','--pack-destination',temporary],{cwd:join(source,'packages/thot-cli'),env:taskEnv}))[0];
  await checked('npm',['install','--global','--prefix',prefix,'--ignore-scripts','--offline','--no-audit','--no-fund',join(temporary,packed.filename)],{cwd:temporary,env:taskEnv});
  assert.equal((await lstat(join(prefix,'bin/thot'))).isSymbolicLink(),true);
  const modes=[
    {kind:'source',home:sourceHome,client:'claude',backfill:false,invoke:quote(join(sourceHome,'.local/bin/thot-history')),format:claude},
    {kind:'package',home:packageHome,client:'codex',backfill:true,invoke:quote(join(prefix,'bin/thot'))+' history',format:codex},
  ];
  for(const mode of modes){
    const actor={id:mode.kind==='source'?'demo-user':'other-user',role:'user' as const},selected=join(mode.home,'selected histories with spaces');
    await mkdir(selected,{recursive:true});await stableFile(join(selected,'existing.jsonl'),mode.format('Synthetic existing response'));
    const env={...cleanEnv,THOT_USER_HOME:mode.home};
    const run=(command:string)=>checked('/bin/sh',['-c',command],{cwd:temporary,env});
    const help=await run(mode.invoke+' --help');assert.match(help,/private-upload consent/);
    const missing=await processRun('/bin/sh',['-c',mode.invoke+' connect --client '+mode.client+' --thot-url '+quote(origin)+' --source '+quote(join(mode.home,'missing folder'))],{env}).done;
    assert.equal(missing.code,1);assert.match(missing.output,/HISTORY_DIRECTORY_NOT_FOUND\nNext: Choose an existing/);
    const connecting=processRun('/bin/sh',['-c',mode.invoke+' connect --client '+mode.client+' --thot-url '+quote(origin)+' --source '+quote(selected)+(mode.backfill?' --backfill':'')+' --no-open'],{cwd:temporary,env});
    t.after(connecting.stop);
    const started=Date.now();let fragment:string|undefined;
    while(!(fragment=connecting.output.match(/#thot-history=([A-Za-z0-9_-]+)/)?.[1])){
      assert.ok(Date.now()-started<10_000,'installed helper did not request pairing');
      await new Promise(r=>setTimeout(r,10));
    }
    const request=JSON.parse(Buffer.from(fragment,'base64url').toString());
    assert.equal(request.backfill,mode.backfill);assert.equal(request.client,mode.client);assert.equal(request.source_ids.length,1);
    assert.equal(JSON.stringify(request).includes(selected),false,'local path must not enter browser request');
    // A real backend grants scope; consent is a direct test fixture here. Real
    // browser clicks/sign-in are covered by the separate browser journey.
    const grant=await app.historyDevices.create(actor,{client:request.client,source_ids:request.source_ids,backfill:request.backfill,daily_time_utc:request.daily_time_utc,consent:'private-history-upload-v1'});
    const paired=await fetch(request.callback,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(grant)});
    assert.equal(paired.status,200);assert.equal((await paired.json()).paired,true);
    const result=await connecting.done;assert.equal(result.code,0,result.output);
    assert.doesNotMatch(result.output,new RegExp(grant.device_token));
    const id=result.output.match(/Private history connection: ([a-f0-9]{24})/)![1];
    const commands=Object.fromEntries(result.output.split('\n').filter(line=>/^(Upload once|Check status|Enable daily uploads): /.test(line)).map(line=>{const at=line.indexOf(': ');return [line.slice(0,at),line.slice(at+2)];}));
    const initial=JSON.parse(await run(commands['Check status']));
    assert.equal(initial.schedule_requested,null);assert.equal(initial.remote.last_saved_at,null);
    await stableFile(join(selected,'new.jsonl'),mode.format('Synthetic new response'));
    const first=JSON.parse(await run(commands['Upload once']));assert.equal(first.saved,mode.backfill?2:1);assert.equal(first.excluded,mode.backfill?0:1);
    const repeat=JSON.parse(await run(commands['Upload once']));assert.equal(repeat.saved,0);assert.equal(repeat.unchanged,mode.backfill?2:1);
    // Simulate an acknowledged upload whose local receipt was not retained.
    // The server must return the original private version on a fresh retry.
    const directory=join(mode.home,'.local/state/thot/history',id),state=await loadPrivate(directory);
    const originalReceipts=structuredClone(state.receipts);
    state.receipts={};await storePrivate(directory,state);
    const retry=JSON.parse(await run(commands['Upload once']));assert.equal(retry.saved+retry.duplicates,mode.backfill?2:1);
    const retried=await loadPrivate(directory);
    assert.deepEqual(Object.values(retried.receipts).map((receipt:any)=>receipt.trace_id).sort(),Object.values(originalReceipts).map((receipt:any)=>receipt.trace_id).sort());
    assert.equal((await app.db.transaction(tx=>tx.list('traces',actor.id))).length,mode.backfill?2:1);
    await stableFile(join(selected,'new.jsonl'),mode.format('Synthetic immutable changed response'));
    const changed=JSON.parse(await run(commands['Upload once']));assert.equal(changed.saved,1);
    assert.match(await run(mode.invoke+' pause --id '+id),/Paused locally and on THOT/);
    assert.equal(JSON.parse(await run(commands['Upload once'])).status,'PAUSED');
    assert.match(await run(mode.invoke+' resume --id '+id),/Uploads resumed/);
    assert.equal(JSON.parse(await run(commands['Check status'])).locally_paused,false);
    let scheduledSaves=0;
    if(process.env.THOT_TEST_NATIVE_SCHEDULER==='1'&&mode.kind==='source'){
      assert.equal(process.platform,'linux','This native scheduler check requires Linux systemd.');
      const unit='thot-history-fixture-'+randomBytes(8).toString('hex');
      const scheduled=await loadPrivate(directory);scheduled.next_run_at=new Date(Date.now()-1000).toISOString();await storePrivate(directory,scheduled);
      await stableFile(join(selected,'scheduled.jsonl'),mode.format('Synthetic timer response'));
      try{
        await checked('systemd-run',['--user','--unit='+unit,'--on-active=1s','--timer-property=AccuracySec=1s','--collect','--property=UMask=0077',process.execPath,join(sourceHome,'.local/bin/thot-history'),'run','--id',id,'--state-root',dirname(directory),'--scheduled'],{env:taskEnv});
        const deadline=Date.now()+20_000;
        while(Date.now()<deadline){
          const after=await loadPrivate(directory);
          if(Date.parse(after.next_run_at)>Date.now()){assert.equal(after.last_run.saved,1);scheduledSaves=1;break;}
          await new Promise(r=>setTimeout(r,100));
        }
        assert.equal(scheduledSaves,1,'The native Linux timer must execute the installed helper.');
        t.diagnostic('Native Linux transient systemd timer executed the source-installed helper; no persistent user schedule was installed.');
      }finally{
        await processRun('systemctl',['--user','stop',unit+'.timer',unit+'.service'],{env:taskEnv}).done;
        await processRun('systemctl',['--user','reset-failed',unit+'.timer',unit+'.service'],{env:taskEnv}).done;
      }
    }
    // No systemctl/launchctl is available in this isolated PATH. The real
    // executable must fail clearly, never claim a daily schedule succeeded.
    const failedSchedule=await processRun('/bin/sh',['-c',commands['Enable daily uploads']],{env}).done;
    assert.equal(failedSchedule.code,1);assert.match(failedSchedule.output,/HISTORY_SCHEDULER_UNAVAILABLE\nNext: The daily schedule is not confirmed/);
    assert.doesNotMatch(failedSchedule.output,/Daily private uploads scheduled/);
    assert.match(await run(mode.invoke+' disconnect --id '+id),/Disconnected.*Upload access and local reads are stopped/);
    await assert.rejects(app.historyDevices.status(grant.device_id,grant.device_token),/HISTORY_DEVICE_REVOKED/);
    const blocked=await processRun('/bin/sh',['-c',commands['Upload once']],{env}).done;
    assert.equal(blocked.code,1);assert.match(blocked.output,/HISTORY_DISCONNECTED\nNext: Run connect/);
    const traces=await app.db.transaction(tx=>tx.list('traces',actor.id));
    assert.equal(traces.length,(mode.backfill?3:2)+scheduledSaves);
    assert.ok(traces.every(trace=>trace.save_privately&&trace.provenance_status==='IMPORTED_UNVERIFIED'));
    assert.equal((await app.db.transaction(tx=>tx.list('thot_records',actor.id))).filter(row=>row.kind==='listing').length,0);
    assert.equal((await lstat(join(directory,'pending.enc'))).mode&0o077,0);
  }
});
