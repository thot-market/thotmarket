import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,lstat,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {historyScheduleFiles,installHistorySchedule,removeHistorySchedule} from '../packages/capture/src/history-schedule.ts';

test('native schedule files contain fixed argv, UTC gating, no credentials or shell, and reject unsupported platforms',()=>{
  const base={id:'a'.repeat(24),home:'/synthetic/user',stateRoot:'/synthetic/private state',entry:'/synthetic/source $price% "safe"/thot-history.ts',node:'/usr/bin/node',time:'04:15'};
  const linux=historyScheduleFiles({...base,platform:'linux'});assert.match(linux[0]!.body,/UMask=0077/);assert.match(linux[0]!.body,/\$\$price%%/);assert.match(linux[0]!.body,/--scheduled/);assert.match(linux[1]!.body,/04:15:00 UTC/);assert.match(linux[1]!.body,/Persistent=true/);
  const mac=historyScheduleFiles({...base,platform:'darwin'});assert.match(mac[0]!.body,/ProgramArguments/);assert.match(mac[0]!.body,/&quot;safe&quot;/);assert.match(mac[0]!.body,/<integer>900<\/integer>/);
  for(const file of [...linux,...mac])assert.doesNotMatch(file.body,/device_token|Authorization|\/bin\/sh|bash -c/);
  assert.throws(()=>historyScheduleFiles({...base,platform:'win32'}),/PLATFORM_UNSUPPORTED/);assert.throws(()=>historyScheduleFiles({...base,entry:'/unsafe\nargument'}),/INVALID_HISTORY_SCHEDULE_PATH/);
});

test('explicit schedule installation/removal only touches owned files in a synthetic home',async t=>{
  const home=await mkdtemp(join(tmpdir(),'thot-schedule-'));t.after(()=>rm(home,{recursive:true,force:true}));const calls:Array<[string,string[]]>=[];
  const options={id:'b'.repeat(24),home,stateRoot:join(home,'state'),entry:join(home,'reviewed','thot-history.ts'),time:'02:00',platform:'linux',run:async(command:string,args:string[])=>{calls.push([command,args]);}};
  const result=await installHistorySchedule(options);assert.equal(calls.length,2);for(const file of result.files)assert.equal((await lstat(file)).mode&0o077,0);
  await removeHistorySchedule(options);assert.equal(calls.length,4);for(const file of result.files)await assert.rejects(lstat(file),{code:'ENOENT'});
  await writeFile(result.files[0]!,'Unrelated user unit',{mode:0o600});await assert.rejects(installHistorySchedule(options),/FILE_CONFLICT/);assert.equal(await readFile(result.files[0]!,'utf8'),'Unrelated user unit');
});

test('scheduler rejects symlink files and symlinked directory ancestors',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-schedule-links-'));t.after(()=>rm(root,{recursive:true,force:true}));const home=join(root,'home'),outside=join(root,'outside');await mkdir(home);await mkdir(outside);await symlink(outside,join(home,'.config'));
  const options={id:'c'.repeat(24),home,stateRoot:join(home,'state'),entry:join(home,'history.ts'),time:'02:00',platform:'linux',run:async()=>{throw Error('native commands must not run');}};
  await assert.rejects(installHistorySchedule(options),/FILE_CONFLICT/);
  await rm(join(home,'.config'));await mkdir(join(home,'.config/systemd/user'),{recursive:true});const target=join(outside,'unrelated');await writeFile(target,'private unrelated text');const path=historyScheduleFiles(options)[0]!.path;await symlink(target,path);await assert.rejects(installHistorySchedule(options),/FILE_CONFLICT/);assert.equal(await readFile(target,'utf8'),'private unrelated text');
});
