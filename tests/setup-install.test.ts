import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,lstat,readFile,writeFile,rm,mkdir,symlink,readlink,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {createServer as createHttpServer} from 'node:http';

function run(args:string[],env:NodeJS.ProcessEnv,cwd?:string){return new Promise<{code:number|null;output:string}>(resolve=>{const child=spawn(process.execPath,args,{env,cwd,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('close',code=>resolve({code,output}));});}
// Installing changes executable bits. Always install copied fixture scripts so
// tests cannot mutate the source checkout. Keep actual implementation bytes.
async function installerSource(root:string){
  const source=join(root,'source checkout');
  const files=JSON.parse(await readFile(resolve('packages/thot-cli/reviewed-source-files.json'),'utf8')).files;
  for(const file of new Set<string>([...files,'package.json','scripts/install-capture-helper.ts','scripts/thot-link.ts'])){
    const target=join(source,file);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(file),target);
  }
  return source;
}
// The real installer downloads the pinned verifier, so these tests serve the
// pinned bytes from a local fixture instead of the network. The served script
// only answers readiness probes; it is not a proof-producing verifier.
async function verifierFixture(root:string){
  const bytes=Buffer.from(`#!/bin/sh\ncase "$1" in --help) exit 0;; *) exit 1;; esac\n`);
  let served=0;
  const server=createHttpServer((request,response)=>{served++;response.setHeader('Content-Type','application/octet-stream');response.end(bytes);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port,url='http://127.0.0.1:'+port+'/dcap-qvl';
  const pin=join(root,'verifier-pin.json');
  await writeFile(pin,JSON.stringify({format:'thot.dcap-qvl-pin/1',version:'0.6.1',platforms:{'linux-x86_64-musl':{asset:'dcap-qvl-linux-x86_64-musl',url,sha256:createHash('sha256').update(bytes).digest('hex')}}},null,2)+'\n');
  return {server,pin,downloads:()=>served,url,sha256:createHash('sha256').update(bytes).digest('hex')};
}
// These two bridge/setup tests never perform hardware verification. Make their
// prerequisite probes hermetic; the actual DCAP verifier has its own test gate.
// Refuse every invocation except readiness probes so this fixture cannot be
// mistaken for an account-capture or proof-producing verifier.
async function bridgeReadiness(root:string){
  const executable=join(root,'readiness-only.mjs');
  await writeFile(executable,`#!${process.execPath}\nconst a=process.argv.slice(2);process.exit(a.length===1&&a[0]==='--help'||a.length===2&&a[0]==='-c'&&a[1]==='import browser_capture'?0:1);\n`,{mode:0o700});
  return {TV_DCAP_QVL:executable,THOT_CAPTURE_PYTHON:executable};
}
test('empty THOT home installs helpers once and readiness explains missing prerequisites',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-first-install-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=await installerSource(root),verifier=await verifierFixture(root);t.after(()=>new Promise<void>(r=>verifier.server.close(()=>r())));
  const env={...process.env,THOT_USER_HOME:root,THOT_VERIFIER_PIN_FILE:verifier.pin};
  const args=['scripts/install-capture-helper.ts','--thot-url','https://thot.example'];
  assert.equal((await run(args,env,source)).code,0);assert.equal((await run(args,env,source)).code,0);
  for(const command of ['thot-capture','thot-link','thot-setup'])assert.equal((await lstat(join(root,'.local/bin',command))).isSymbolicLink(),true);
  assert.equal(JSON.parse(await readFile(join(root,'.config/thot/capture.json'),'utf8')).thot_url,'https://thot.example');
  // The pinned verifier downloaded from the fixture is installed once and
  // recorded; the second installer run downloads nothing new.
  const installed=join(root,'.local/share/thot/bin/dcap-qvl');
  assert.equal((await lstat(installed)).mode&0o111,0o111);
  assert.equal(JSON.parse(await readFile(join(root,'.config/thot/verifier.json'),'utf8')).sha256,verifier.sha256);
  assert.equal(verifier.downloads(),1);
  const check=await run(['scripts/thot-setup.ts','robinhood'],{...env,TV_DCAP_QVL:join(root,'missing-verifier'),THOT_CAPTURE_PYTHON:join(root,'missing-python')});
  assert.equal(check.code,1);assert.match(check.output,/Next: Install Python 3/);assert.doesNotMatch(check.output,/prerequisites are ready/);
  const existing=join(root,'existing-connector.json');await writeFile(existing,'{}',{mode:0o600});
  assert.equal((await run(['scripts/install-capture-helper.ts','--robinhood-config',existing],env,source)).code,0);
  assert.equal(JSON.parse(await readFile(join(root,'.config/thot/robinhood.json'),'utf8')).config_file,existing);
  // Legacy --thot-url is still accepted (writes the thot config) and still redacts secrets.
  const rejected=await run(['scripts/install-capture-helper.ts','--thot-url','https://secret:password@thot.example'],env,source);assert.equal(rejected.code,1);assert.doesNotMatch(rejected.output,/secret:password/);
});

test('upgrade removes only this checkout retired capture link and preserves other commands',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-helper-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'.local/bin');await mkdir(bin,{recursive:true});
  const legacy=join(bin,'thot');
  const source=await installerSource(root);
  await symlink(join(source,'scripts/thot.ts'),legacy);
  const unrelated=join(bin,'unrelated-helper'),unrelatedTarget=resolve('scripts/nonexistent-user-helper.ts');
  await symlink(unrelatedTarget,unrelated);
  const env={...process.env,THOT_USER_HOME:root,THOT_VERIFIER_AUTO_INSTALL:'0'};
  const result=await run(['scripts/install-capture-helper.ts'],env,source);
  assert.equal(result.code,0,result.output);assert.match(result.output,/Removed 1 stale helper/);
  await assert.rejects(lstat(legacy),{code:'ENOENT'});
  assert.equal(await readlink(unrelated),unrelatedTarget);
  assert.equal(await readlink(join(bin,'thot-capture')),join(source,'scripts/thot-capture.ts'));
  // A same-named command owned by another checkout must never be removed.
  const otherTarget=join(root,'other-checkout/scripts/thot.ts');
  await symlink(otherTarget,legacy);
  assert.equal((await run(['scripts/install-capture-helper.ts'],env,source)).code,0);
  assert.equal(await readlink(legacy),otherTarget);
  await rm(legacy);await writeFile(legacy,'user-owned command');
  assert.equal((await run(['scripts/install-capture-helper.ts'],env,source)).code,0);
  assert.equal(await readFile(legacy,'utf8'),'user-owned command');
});

test('first Robinhood launch generates a private extension without opening a browser or creating a job',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-first-extension-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const child=spawn(process.execPath,['scripts/thot-link.ts','robinhood','--thot-url','https://thot.example'],{env:{...process.env,...await bridgeReadiness(root),THOT_USER_HOME:root},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGTERM'));let output='';
  const url=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('setup timed out')),15_000);child.stdout.on('data',b=>{output+=b;const match=output.match(/https:\/\/thot\.example\/#thot-robinhood=([A-Za-z0-9_-]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.stderr.resume();child.on('close',code=>{if(code)reject(Error('helper failed before pairing'));});});
  const callback=JSON.parse(Buffer.from(url,'base64url').toString()).callback;
  const status=await(await fetch(callback+'/status',{headers:{Origin:'https://thot.example'}})).json();
  assert.equal(status.stage,'helper_ready');assert.equal(status.evidence,undefined);
  const manifest=JSON.parse(await readFile(join(root,'.local/share/thot/robinhood/extension/manifest.json'),'utf8'));
  assert.equal(manifest.name,'THOT Robinhood Connector');assert.ok(manifest.key);
  assert.equal((await lstat(join(root,'.local/share/thot/robinhood/pairing.json'))).mode&0o077,0);
  const closed=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await closed;
});

test('real child-process bridge reports extension readiness and returns only public evidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-child-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=join(root,'verifier.mjs');await writeFile(fixture,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify(process.argv[2]==='preflight'?{ready:true}:{credential:{fixture:true},witness_receipts:[]})));`);
  const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const config=join(root,'config.json'),capability='b'.repeat(64),extensionOrigin='chrome-extension://'+'b'.repeat(32);
  await writeFile(config,JSON.stringify({browser:{pythonExecutable:process.execPath,bridgePath:fixture,measurementsPath:fixture,qvlPath:process.execPath,extensionBridge:{port,capability,origin:extensionOrigin}}}),{mode:0o600});
  const child=spawn(process.execPath,['scripts/thot-link.ts','robinhood','--thot-url','https://thot.example','--config',config],{env:{...process.env,...await bridgeReadiness(root),THOT_USER_HOME:root},stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGTERM'));child.stderr.resume();let output='';
  const callback=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('helper did not start')),15_000);child.stdout.on('data',b=>{output+=b;const match=output.match(/#thot-robinhood=([A-Za-z0-9_-]+)/);if(match){clearTimeout(timer);resolve(JSON.parse(Buffer.from(match[1],'base64url').toString()).callback);}});});
  const headers={Origin:'https://thot.example','Content-Type':'application/json'};
  await fetch(callback,{method:'POST',headers,body:JSON.stringify({link_ticket:'fixture',witness_url:'https://witness.example',appraiser_url:'https://appraiser.example',thot_public_key_pem:'PUBLIC'})});
  const waitStage=async(stage:string)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const value=await(await fetch(callback+'/status',{headers})).json();if(value.stage===stage)return value;await new Promise(r=>setTimeout(r,50));}throw Error('Missing stage: '+stage);};
  await waitStage('awaiting_extension');
  await fetch(`http://127.0.0.1:${port}/${capability}/ready`,{headers:{Origin:extensionOrigin}});await waitStage('awaiting_account_request');
  await fetch(`http://127.0.0.1:${port}/${capability}/capture`,{method:'POST',headers:{Origin:extensionOrigin,'Content-Type':'application/json'},body:JSON.stringify({token:'SYNTHETIC-NOT-A-PROVIDER-TOKEN'})});
  const proof=await waitStage('proof_ready');assert.deepEqual(proof.evidence,{credential:{fixture:true},witness_receipts:[]});
  assert.doesNotMatch(output,/SYNTHETIC-NOT-A-PROVIDER-TOKEN|witness_receipts/);
  const closed=new Promise(r=>child.once('close',r));await fetch(callback+'/saved',{method:'POST',headers,body:'{}'});await closed;
});
