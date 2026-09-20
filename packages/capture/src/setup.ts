import {access,constants,readFile,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export function thotUserHome(){const path=process.env.THOT_USER_HOME??process.env.THOT_USER_HOME??homedir();if(!isAbsolute(path))throw Error('INVALID_THOT_USER_HOME');return path;}

export function thotOrigin(value:string) {
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw Error('INVALID_THOT_ORIGIN');
  return url.origin;
}
// Prefer ~/.config/thot; read the legacy ~/.config/thot so existing installs keep working.
async function savedConfig(name:string) {
  for(const dir of ['.config/thot','.config/thot']){
    const path=join(thotUserHome(),dir,name);
    try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||(stat.mode&0o077))throw Error('CAPTURE_CONFIG_PERMISSIONS');return JSON.parse(await readFile(path,'utf8'));}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  }
  return undefined;
}
export async function savedThotOrigin() {
  const value=await savedConfig('capture.json');
  return value?thotOrigin(value.thot_url??value.thot_url):undefined;
}
export async function savedRobinhoodConfig() {
  const value=await savedConfig('robinhood.json');
  if(!value)return undefined;
  if(typeof value.config_file!=='string'||!isAbsolute(value.config_file))throw Error('INVALID_ROBINHOOD_CONFIG');
  return value.config_file as string;
}
export async function executable(name:string) {
  for(const candidate of isAbsolute(name)?[name]:(process.env.PATH??'').split(':').filter(isAbsolute).map(dir=>join(dir,name))) {
    try{await access(candidate,constants.X_OK);if((await lstat(candidate)).isDirectory())continue;return candidate;}catch{}
  }
  return undefined;
}
export async function probe(command:string,args:string[],cwd?:string) {
  return new Promise<boolean>(resolve=>{
    const child=spawn(command,args,{cwd,stdio:'ignore',shell:false});
    const timer=setTimeout(()=>child.kill('SIGKILL'),15_000);
    child.once('error',()=>{clearTimeout(timer);resolve(false);});
    child.once('close',code=>{clearTimeout(timer);resolve(code===0);});
  });
}
export type SetupCheck={id:string;label:string;ok:boolean;next:string};
export async function readiness(target:'codex'|'claude'|'robinhood') {
  const qvl=await executable(process.env.TV_DCAP_QVL??'dcap-qvl');
  const python=await executable(process.env.THOT_CAPTURE_PYTHON??process.env.THOT_CAPTURE_PYTHON??'python3');
  const checks:SetupCheck[]=[{id:'node',label:'Node 24 or later',ok:Number(process.versions.node.split('.')[0])>=24,next:'Install Node 24 or later, then rerun this command.'}];
  if(target!=='robinhood') {
    const client=await executable(target);
    checks.push({id:'client',label:target==='codex'?'Codex installed':'Claude Code installed',ok:!!client,next:`Install ${target==='codex'?'Codex':'Claude Code'}, then rerun this command.`});
  }
  const pythonOK=!!python&&await probe(python,['-c',target==='robinhood'?'import browser_capture':'import json, ssl'],target==='robinhood'?fileURLToPath(new URL('../../../trace-vault/',import.meta.url)):undefined);
  checks.push({id:'python',label:target==='robinhood'?'Python account verifier dependencies':'Python 3',ok:pythonOK,next:target==='robinhood'?'Install Python 3 with cryptography and certifi. See the first-time setup guide.':'Install Python 3, then rerun this command.'});
  checks.push({id:'verifier',label:'Hardware verifier executable (required for strict reference mode)',ok:!!qvl&&await probe(qvl,['--help']),next:'Install the reviewed dcap-qvl executable to enable independent hardware verification.'});
  return {ready:checks.filter(c=>target==='robinhood'||!['verifier','python'].includes(c.id)).every(c=>c.ok),checks,python,qvl};
}
