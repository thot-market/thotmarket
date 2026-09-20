import {readFile,mkdir,writeFile,rm,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,relative,sep} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),output=resolve(here,'runtime');
const policy=JSON.parse(await readFile(resolve(here,'reviewed-source-files.json'),'utf8'));
if(policy.format!=='thot.cli-source-files/1')throw Error('Invalid CLI source manifest');
const approved=new Set(policy.files),seen=new Set();
await rm(output,{recursive:true,force:true});
async function copy(path){
  if(seen.has(path))return;seen.add(path);
  if(!approved.has(path))throw Error('CLI dependency missing from reviewed source manifest: '+path);
  const source=resolve(root,path);
  if(!source.startsWith(root+sep))throw Error('CLI dependency outside source tree');
  let target=resolve(output,path),body=await readFile(source);
  if(/\.(ts|mjs)$/.test(path)){
    let text=body.toString();
    for(const match of text.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)){
      await copy(relative(root,resolve(dirname(source),match[2])));
    }
    if(path.endsWith('.ts')){
      text=stripTypeScriptTypes(text,{mode:'strip'});
      text=text.replace(/(['"])([^'"]*\.ts)\1/g,(_,quote,name)=>quote+name.slice(0,-3)+'.js'+quote);
      target=target.slice(0,-3)+'.js';
    }
    if(path==='scripts/thot-capture.ts'||path==='scripts/thot-setup.ts'){
      text=text.replaceAll('thot-capture','thot').replaceAll('thot-setup','thot setup');
    }
    if(path==='packages/capture/src/terminal.ts')text=text.replaceAll('THOT |','THOT |').replaceAll('THOT capture','Thot capture');
    body=text;
  }
  await mkdir(dirname(target),{recursive:true});await writeFile(target,body);
}
for(const entry of ['scripts/thot-capture.ts','scripts/thot-setup.ts','scripts/capture-terminal-child.ts'])await copy(entry);
for(const name of ['verify.mjs','canonical.mjs','hardware.mjs','verify_dcap.py','requirements.txt','README.txt'])await copy('packages/provenance/portable/'+name);
for(const path of ['packages/provenance/scripts/verify_recorder.py','trace-vault/attestation_verify.py'])await copy(path);
// Production has no accepted API/recorder pair yet. The package must never
// silently select a private development recorder or a placeholder endpoint.
await mkdir(resolve(output,'deploy'),{recursive:true});
await writeFile(resolve(output,'deploy/tee-recorder-policy.json'),JSON.stringify({url:'',instances:{}},null,2)+'\n');
// Hosted descriptors are private operational inputs. The standalone CLI ships
// only the reviewed default policy; operators can explicitly select another file.
await writeFile(resolve(output,'packages/capture/src/tee/policy-file.js'),`import {fileURLToPath} from 'node:url';
export async function recorderPolicyFile(origin,env=process.env){
  return env.THOT_RECORDER_POLICY_FILE ?? env.THOT_RECORDER_POLICY_FILE ?? fileURLToPath(new URL('../../../../deploy/tee-recorder-policy.json',import.meta.url));
}
`);
await chmod(resolve(here,'bin/thot.js'),0o755);
console.error('Prepared Thot CLI runtime from '+seen.size+' reviewed source files.');
