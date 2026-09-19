import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createExample} from '../packages/provenance/examples/generate-receipt-format.ts';
// @ts-expect-error Browser module is JavaScript.
import {writeCaptureExport,chooseEmptyExportDirectory} from '../apps/dashboard/capture-export-ui.js';
// @ts-expect-error Independent verifier is standalone JavaScript.
import {verifyDirectory} from '../packages/provenance/portable/verify.mjs';
async function setup(t:any){const dir=await mkdtemp(join(tmpdir(),'thot-browser-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=createExample(),calls:string[]=[],files:string[]=[];let inFlight=0,maxFlight=0;
 const options={captureId:f.example.bundle.capture_id,api:async(path:string)=>{calls.push(path);inFlight++;maxFlight=Math.max(maxFlight,inFlight);await new Promise(r=>setTimeout(r,1));inFlight--;if(path.endsWith('/proof'))return {bundle:{...f.example.bundle,tee_evidence:f.example.evidence},receipt:{upload_token:'SHOULD_NOT_COPY'}};return {part:f.parts[Number(path.split('/').at(-1))-1]};},write:async(path:string,text:string)=>{files.push(path);await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),text);},readAsset:async(name:string)=>readFile(new URL('../packages/provenance/portable/'+name,import.meta.url),'utf8')};
 return {dir,f,calls,files,options,maxFlight:()=>maxFlight};}
test('vault browser download is sequential, standalone-verifiable and excludes receipt credentials',async t=>{const s=await setup(t);const r=await writeCaptureExport(s.options);assert.equal(r.exchanges,2);assert.equal(s.maxFlight(),1);assert.equal(s.files.at(-1),'export.json');assert.equal((await verifyDirectory(s.dir)).integrity,'VALID');assert.doesNotMatch(await readFile(join(s.dir,'export.json'),'utf8'),/upload_token|SHOULD_NOT_COPY/);});
test('changed part or signer and lost authentication prevent a completed export manifest',async t=>{for(const failure of ['part','signature','account']){const s=await setup(t);if(failure==='part')s.f.parts[0].response_body_b64='dGFtcGVy';if(failure==='signature')s.f.example.evidence.signature=Buffer.alloc(64).toString('base64');await assert.rejects(writeCaptureExport({...s.options,checkOwner:()=>{if(failure==='account'&&s.calls.length>1)throw Error('ACCOUNT_CHANGED');}}));await assert.rejects(lstat(join(s.dir,'export.json')),{code:'ENOENT'});}});
test('picker rejects existing directory contents without modifying files',async()=>{let changed=false;await assert.rejects(chooseEmptyExportDirectory(async()=>({async *keys(){yield 'existing.txt';},getFileHandle(){changed=true;}})),/empty folder/);assert.equal(changed,false);});
