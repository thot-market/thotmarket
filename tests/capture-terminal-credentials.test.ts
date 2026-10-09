import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {clientInvocation} from '../packages/capture/src/index.ts';
import {captureTerminal} from '../packages/capture/src/terminal.ts';

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'thot-capture-secret-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const token=randomBytes(24).toString('hex'),route='http://127.0.0.1:1234/r/synthetic';
 const invocation=clientInvocation('zai',route,['--settings','{"disableAllHooks":true}','--','literal'],{PATH:process.env.PATH,ANTHROPIC_AUTH_TOKEN:token});
 return {root,token,route,invocation};
}
function setTty(t:any,value:boolean){
 for(const stream of [process.stdin,process.stdout]){
  const previous=Object.getOwnPropertyDescriptor(stream,'isTTY');
  Object.defineProperty(stream,'isTTY',{value,configurable:true});
  t.after(()=>previous?Object.defineProperty(stream,'isTTY',previous):Reflect.deleteProperty(stream,'isTTY'));
 }
}

test('provider settings use a private file and never enter child argv; normal exit removes the file',async t=>{
 const {root,token,route,invocation}=await fixture(t);setTty(t,false);
 const script=join(root,'client.mjs'),result=join(root,'result.json');
 await writeFile(script,`import {readFile,stat,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
const args=process.argv.slice(2),settingsPath=args[args.indexOf('--settings')+1];
const settings=JSON.parse(await readFile(settingsPath,'utf8'));
await writeFile(process.env.TEST_RESULT,JSON.stringify({args,settingsPath,mode:(await stat(settingsPath)).mode&0o777,dirMode:(await stat(dirname(settingsPath))).mode&0o777,route:settings.env.ANTHROPIC_BASE_URL,correctToken:settings.env.ANTHROPIC_AUTH_TOKEN===process.env.ANTHROPIC_AUTH_TOKEN,disableAllHooks:settings.disableAllHooks}),{mode:0o600});
`,{mode:0o600});
 const originalArgs=[...invocation.args];
 invocation.command=process.execPath;invocation.args.unshift(script);invocation.privateSettings!.argumentIndex++;invocation.env.TEST_RESULT=result;
 assert.equal(await captureTerminal().run(invocation,root),0);
 const observed=JSON.parse(await readFile(result,'utf8'));
 assert.equal(observed.mode,0o600);assert.equal(observed.dirMode,0o700);assert.equal(observed.route,route);assert.equal(observed.correctToken,true);assert.equal(observed.disableAllHooks,true);
 assert.equal(JSON.stringify(observed.args).includes(token),false);assert.deepEqual(observed.args.slice(-2),['--','literal']);
 assert.deepEqual(invocation.args.slice(1),originalArgs,'launch must not mutate the caller invocation');
 await assert.rejects(access(observed.settingsPath));await assert.rejects(access(dirname(observed.settingsPath)));
});

test('failed direct startup deletes private settings and returns only a fixed operational error',async t=>{
 const {root,token,invocation}=await fixture(t);setTty(t,false);
 const previous=process.env.TMPDIR;process.env.TMPDIR=root;t.after(()=>{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;});
 invocation.command=join(root,'missing-client');
 await assert.rejects(captureTerminal().run(invocation,root),error=>{
  assert.equal((error as Error).message,'CAPTURE_CLIENT_START_FAILED');assert.equal(String(error).includes(token),false);return true;
 });
 assert.equal((await readdir(root)).some(name=>name.startsWith('thot-client-settings-')),false);
});

test('tmux startup stderr cannot disclose credentials and its failure removes the settings file',async t=>{
 const {root,token,invocation}=await fixture(t);setTty(t,true);
 const bin=join(root,'bin'),observedArgs=join(root,'tmux-args.txt');await mkdir(bin);
 await writeFile(join(bin,'tmux'),'#!/bin/sh\nif [ "$5" = "new-session" ]; then\n printf "%s\\n" "$@" > "$TEST_ARGS"\n printf "%s" "$ANTHROPIC_AUTH_TOKEN" >&2\n exit 1\nfi\nexit 0\n',{mode:0o700});
 invocation.env.PATH=bin;invocation.env.TEST_ARGS=observedArgs;
 await assert.rejects(captureTerminal().run(invocation,root),error=>{
  assert.equal((error as Error).message,'CAPTURE_CLIENT_START_FAILED');assert.equal(String(error).includes(token),false);assert.equal('stderr' in (error as object),false);return true;
 });
 const args=(await readFile(observedArgs,'utf8')).trim().split('\n');
 assert.equal(args.join(' ').includes(token),false);
 const path=args[args.indexOf('--settings')+1];assert(path.endsWith('/settings.json'));
 await assert.rejects(access(path));await assert.rejects(access(dirname(path)));
});
