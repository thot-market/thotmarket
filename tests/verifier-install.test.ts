import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,readdir,lstat,chmod,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {parseVerifierPin,verifierPlatformKey,recordedVerifier,ensureVerifierInstalled,verifierSlot,verifierRecordFile} from '../packages/capture/src/verifier.ts';
import {readiness,resolveVerifierExecutable} from '../packages/capture/src/setup.ts';
import {verifyRecorder} from '../packages/capture/src/tee/attestation.ts';

const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function run(args:string[],env:NodeJS.ProcessEnv,cwd?:string){return new Promise<{code:number|null;output:string}>(resolve=>{const child=spawn(process.execPath,args,{env,cwd,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('close',code=>resolve({code,output}));});}
// A fixture checkout keeps installer runs from touching this source tree.
async function installerSource(root:string){
  const source=join(root,'source checkout');
  const files=JSON.parse(await readFile(resolve('packages/thot-cli/reviewed-source-files.json'),'utf8')).files;
  for(const file of new Set<string>([...files,'package.json','scripts/install-capture-helper.ts','scripts/thot-link.ts'])){
    const target=join(source,file);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(file),target);
  }
  return source;
}
// The installer's pinned download, served locally. The good bytes only answer
// readiness probes; this is not a proof-producing verifier.
async function pinFixture(root:string,corrupt=false){
  const bytes=Buffer.from(`#!/bin/sh\ncase "$1" in --help) exit 0;; *) exit 1;; esac\n`);
  const served=corrupt?Buffer.concat([bytes,Buffer.from('corrupted')]):bytes;
  let downloads=0;
  const server=createServer((_request,response)=>{downloads++;response.end(served);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+((server.address() as {port:number}).port)+'/dcap-qvl';
  const pin=join(root,corrupt?'corrupt-pin.json':'verifier-pin.json');
  await writeFile(pin,JSON.stringify({format:'thot.dcap-qvl-pin/1',version:'0.6.1',platforms:{'linux-x86_64-musl':{asset:'dcap-qvl-linux-x86_64-musl',url,sha256:sha256(bytes)}}},null,2)+'\n');
  return {server,pin,url,sha:sha256(bytes),downloads:()=>downloads,good:served};
}
const goodPin=()=>JSON.stringify({format:'thot.dcap-qvl-pin/1',version:'0.6.1',platforms:{'linux-x86_64-musl':{asset:'dcap-qvl-linux-x86_64-musl',url:'https://github.com/Phala-Network/dcap-qvl/releases/download/v0.6.1/dcap-qvl-linux-x86_64-musl',sha256:'84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b'}}});

test('verifier pin parsing accepts only the reviewed release shape',async()=>{
  const pin=parseVerifierPin(goodPin());
  assert.equal(pin.version,'0.6.1');
  assert.equal(pin.platforms['linux-x86_64-musl'].asset,'dcap-qvl-linux-x86_64-musl');
  assert.equal(pin.platforms['linux-x86_64-musl'].url,'https://github.com/Phala-Network/dcap-qvl/releases/download/v0.6.1/dcap-qvl-linux-x86_64-musl');
  assert.equal(pin.platforms['linux-x86_64-musl'].sha256,'84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b');
  assert.equal(verifierPlatformKey('linux','x64'),'linux-x86_64-musl');
  assert.equal(verifierPlatformKey('linux','arm64'),'linux-aarch64-musl');
  assert.equal(verifierPlatformKey('darwin','arm64'),'darwin-arm64');
  for(const[name,text]of[
    ['format',goodPin().replace('thot.dcap-qvl-pin/1','other/1')],
    ['version',goodPin().replace('"0.6.1"','"0.6"')],
    ['empty platforms',JSON.stringify({format:'thot.dcap-qvl-pin/1',version:'0.6.1',platforms:{}})],
    ['asset path',goodPin().replace('dcap-qvl-linux-x86_64-musl","url','../dcap-qvl","url')],
    ['short hash',goodPin().replace('84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b','84bd')],
    ['credentials in url',goodPin().replace('https://github.com','https://user:secret@github.com')],
    ['query in url',goodPin().replace('/dcap-qvl-linux-x86_64-musl','/dcap-qvl-linux-x86_64-musl?token=1')],
    ['plain http url',goodPin().replace('https://github.com','http://example.invalid')],
    ['unparseable','not json'],
  ]as[string,string][])assert.throws(()=>parseVerifierPin(text),/INVALID_VERIFIER_PIN/,name);
  // The checked-in pin stays readable and keeps the documented release.
  const checkedIn=parseVerifierPin(await readFile(resolve('packages/capture/src/verifier-pin.json'),'utf8'));
  assert.equal(checkedIn.version,'0.6.1');
  assert.equal(checkedIn.platforms['linux-x86_64-musl'].sha256,'84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b');
});

test('recorded verifier resolves without PATH, an explicit TV_DCAP_QVL wins, tampering invalidates the record',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-verifier-resolve-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from(`#!/bin/sh\ncase "$1" in --help) exit 0;; *) exit 1;; esac\n`);
  const slot=verifierSlot(root);await mkdir(dirname(slot),{recursive:true});
  await writeFile(slot,bytes,{mode:0o755});await chmod(slot,0o755);
  await mkdir(dirname(verifierRecordFile(root)),{recursive:true,mode:0o700});
  await writeFile(verifierRecordFile(root),JSON.stringify({format:'thot.verifier-record/1',path:slot,version:'0.6.1',sha256:sha256(bytes),source_url:'https://fixture.invalid/dcap-qvl'}),{mode:0o600});
  const saved={...process.env};
  t.after(()=>{process.env=saved;});
  const fixtureBin=join(root,'bin');await mkdir(fixtureBin);await writeFile(join(fixtureBin,'dcap-qvl'),'unrelated', {mode:0o700});
  process.env.THOT_USER_HOME=root;
  process.env.PATH=fixtureBin;
  delete process.env.TV_DCAP_QVL;
  const record=await recordedVerifier();
  assert.equal(record?.path,slot);assert.equal(record?.version,'0.6.1');
  assert.equal(await resolveVerifierExecutable(),slot);
  const checks=await readiness('codex');
  assert.equal(checks.qvl,slot);
  assert.equal(checks.checks.find(c=>c.id==='verifier')!.ok,true);
  // The recorded install reaches the attestation path lookup unchanged. The
  // "python" is a wrapper executable that records the qvl path it was handed.
  const observed=join(root,'qvl-seen.txt');
  const shim=join(root,'python-shim.mjs');
  await writeFile(shim,`#!${process.execPath}
import{writeFileSync}from'node:fs';let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(observed)},JSON.parse(input).qvl);console.log(JSON.stringify({verified:true,app_id:'a'.repeat(64),compose_hash:'c'.repeat(64),os_image_hash:'o'.repeat(64),quote_hash:'q'.repeat(64),mrtd:'m'.repeat(64),rtmr0:'0'.repeat(64),rtmr1:'1'.repeat(64),rtmr2:'2'.repeat(64)}));});
`,{mode:0o755});
  process.env.THOT_CAPTURE_PYTHON=shim;
  const attestation={statement:{purpose:'thot.tee-recorder-key/1',signing_key:'pub',channel_key:'chan'},quote:'00'};
  const verified=await verifyRecorder(attestation,{url:'https://recorder.example',instances:{}});
  assert.equal(verified.verified,true);
  assert.equal(await readFile(observed,'utf8'),slot);
  // An explicit TV_DCAP_QVL still wins over the recorded install.
  const own=join(root,'own-qvl');await writeFile(own,bytes,{mode:0o755});
  process.env.TV_DCAP_QVL=own;
  assert.equal(await resolveVerifierExecutable(),own);
  delete process.env.TV_DCAP_QVL;
  // Bytes that no longer hash to the record are treated as absent, so the
  // unrelated PATH entry is reached rather than a tampered record.
  await writeFile(slot,Buffer.concat([bytes,Buffer.from('tampered')]),{mode:0o755});
  assert.equal(await recordedVerifier(),undefined);
  assert.equal(await resolveVerifierExecutable(),join(fixtureBin,'dcap-qvl'));
});

test('the real installer downloads the pinned verifier and rejects corrupted bytes by URL and hash',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-verifier-install-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=await installerSource(root),good=await pinFixture(root),corrupt=await pinFixture(root,true);
  t.after(()=>Promise.all([good,corrupt].map(f=>new Promise<void>(r=>f.server.close(()=>r())))));
  const base={...process.env,THOT_USER_HOME:join(root,'home a')};
  // Good bytes: installed once, recorded, and not downloaded again on rerun.
  const first=await run(['scripts/install-capture-helper.ts'],{...base,THOT_VERIFIER_PIN_FILE:good.pin},source);
  assert.equal(first.code,0,first.output);
  assert.match(first.output,/Installed the hardware verifier dcap-qvl 0\.6\.1 at .+dcap-qvl \(sha256 [a-f0-9]{64} verified\)/);
  const home=join(root,'home a'),slot=verifierSlot(home);
  assert.equal((await lstat(slot)).mode&0o111,0o111);
  const record=JSON.parse(await readFile(verifierRecordFile(home),'utf8'));
  assert.equal(record.sha256,good.sha);assert.equal(record.path,slot);assert.equal(record.version,'0.6.1');
  assert.equal((await lstat(verifierRecordFile(home))).mode&0o077,0);
  assert.equal(good.downloads(),1);
  const second=await run(['scripts/install-capture-helper.ts'],{...base,THOT_VERIFIER_PIN_FILE:good.pin},source);
  assert.equal(second.code,0,second.output);
  assert.match(second.output,/already installed at/);
  assert.equal(good.downloads(),1);
  // Corrupted bytes: the installer fails naming the URL and expected hash, and
  // leaves no executable, record or partial download behind.
  const corruptHome=join(root,'home b');
  const failed=await run(['scripts/install-capture-helper.ts'],{...base,THOT_USER_HOME:corruptHome,THOT_VERIFIER_PIN_FILE:corrupt.pin},source);
  assert.equal(failed.code,1);
  assert.match(failed.output,/VERIFIER_HASH_MISMATCH/);
  assert.match(failed.output,new RegExp(corrupt.url.replaceAll('.','\\.')));
  assert.match(failed.output,new RegExp(corrupt.sha));
  assert.match(failed.output,/No unverified binary was installed/);
  await assert.rejects(lstat(verifierSlot(corruptHome)),{code:'ENOENT'});
  await assert.rejects(lstat(verifierRecordFile(corruptHome)),{code:'ENOENT'});
  assert.deepEqual(await readdir(join(corruptHome,'.local/share/thot/bin')),[]);
  // A platform without a pinned entry gets exact manual instructions instead
  // of an install attempt.
  const manual=await ensureVerifierInstalled({pin:parseVerifierPin(goodPin()),platformKey:'darwin-arm64',home:corruptHome});
  assert.equal(manual.status,'unsupported');
  assert.match(manual.instructions,/darwin-arm64/);
  assert.match(manual.instructions,/https:\/\/github\.com\/Phala-Network\/dcap-qvl\/releases\/download\/v0\.6\.1\/dcap-qvl-linux-x86_64-musl/);
  assert.match(manual.instructions,/84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b/);
  assert.match(manual.instructions,new RegExp(verifierSlot(corruptHome).replaceAll('.','\\.')));
});

test('thot-setup installs the verifier on first run and passes its check without PATH or TV_DCAP_QVL',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-verifier-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=await installerSource(root),fixture=await pinFixture(root);
  t.after(()=>new Promise<void>(r=>fixture.server.close(()=>r())));
  const bin=join(root,'bin');await mkdir(bin);
  await writeFile(join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const home=join(root,'home');
  const env={...process.env,THOT_USER_HOME:home,THOT_VERIFIER_PIN_FILE:fixture.pin,PATH:[bin,'/usr/bin',dirname(process.execPath)].join(':')};
  delete (env as Record<string,string|undefined>).TV_DCAP_QVL;
  const result=await run(['scripts/thot-setup.ts','codex'],env,source);
  assert.equal(result.code,0,result.output);
  assert.match(result.output,/Installed the hardware verifier dcap-qvl 0\.6\.1 at /);
  assert.match(result.output,/✓ Hardware verifier executable/);
  assert.match(result.output,/Local prerequisites are ready/);
  assert.equal(fixture.downloads(),1);
  assert.equal(JSON.parse(await readFile(verifierRecordFile(home),'utf8')).path,verifierSlot(home));
  // THOT_VERIFIER_AUTO_INSTALL=0 and an explicit TV_DCAP_QVL both suppress the download.
  const skipped=await run(['scripts/thot-setup.ts','codex'],{...env,THOT_USER_HOME:join(root,'home 2'),THOT_VERIFIER_AUTO_INSTALL:'0'},source);
  assert.match(skipped.output,/disabled \(THOT_VERIFIER_AUTO_INSTALL=0\)/);
  assert.match(skipped.output,/✕ Hardware verifier executable/);
  assert.equal(fixture.downloads(),1);
  const own=join(root,'own-qvl');await writeFile(own,'#!/bin/sh\ncase "$1" in --help) exit 0;; *) exit 1;; esac\n',{mode:0o700});
  const overridden=await run(['scripts/thot-setup.ts','codex'],{...env,THOT_USER_HOME:join(root,'home 3'),TV_DCAP_QVL:own},source);
  assert.match(overridden.output,/named by TV_DCAP_QVL/);
  assert.match(overridden.output,/✓ Hardware verifier executable/);
  assert.equal(fixture.downloads(),1);
});

test('a read-only install location fails specifically while a writable THOT_USER_HOME works',async t=>{
  if(process.getuid&&process.getuid()===0){t.skip('root ignores directory permission bits');return;}
  const root=await mkdtemp(join(tmpdir(),'thot-verifier-readonly-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=await pinFixture(root);
  t.after(()=>new Promise<void>(r=>fixture.server.close(()=>r())));
  const pin=parseVerifierPin(await readFile(fixture.pin,'utf8'));
  const readonly=join(root,'readonly-home');await mkdir(readonly);await chmod(readonly,0o500);
  t.after(()=>chmod(readonly,0o700).catch(()=>{}));
  await assert.rejects(ensureVerifierInstalled({pin,home:readonly}),/VERIFIER_INSTALL_LOCATION_UNAVAILABLE/);
  assert.deepEqual(await readdir(readonly),[]);
  const writable=join(root,'writable-home');await mkdir(writable);
  const installed=await ensureVerifierInstalled({pin,home:writable});
  assert.equal(installed.status,'installed');
  assert.equal(installed.path,verifierSlot(writable));
  assert.equal((await readFile(verifierSlot(writable),'utf8')),fixture.good.toString());
});

test('a download that dies mid-stream fails naming the URL and expected hash',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-verifier-midstream-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const pin=parseVerifierPin(goodPin());
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.error(Error('socket hang up'));}});
  const fetchImpl=(async()=>new Response(stream,{status:200}))as typeof fetch;
  await assert.rejects(ensureVerifierInstalled({pin,home:join(root,'home'),fetchImpl}),error=>{
    const text=(error as Error).message;
    return /VERIFIER_DOWNLOAD_FAILED/.test(text)&&text.includes('https://github.com/Phala-Network/dcap-qvl/releases/download/v0.6.1/dcap-qvl-linux-x86_64-musl')&&text.includes('socket hang up')&&text.includes('84bd935e37decbace7a902da2680d7486caca954438bb3196c8da8ed91f26d7b');
  });
  assert.deepEqual(await readdir(join(root,'home/.local/share/thot/bin')),[]);
});
