import {access,constants,lstat,readFile,writeFile,mkdir,open,unlink,rename,chmod} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {thotUserHome,readThotConfigRecord} from './user-home.ts';

export interface VerifierPinEntry {asset:string;url:string;sha256:string}
export interface VerifierPin {version:string;platforms:Record<string,VerifierPinEntry>}
export type VerifierRecord={path:string;version:string;sha256:string;source_url?:string};
export type EnsureVerifierResult=
  |{status:'installed';path:string;version:string;sha256:string}
  |{status:'present';path:string;version:string;sha256:string}
  |{status:'unsupported';instructions:string}
  |{status:'disabled'}
  |{status:'env';path:string};
const PIN_FORMAT='thot.dcap-qvl-pin/1',RECORD_FORMAT='thot.verifier-record/1',MAX_VERIFIER_BYTES=512_000_000;
export function parseVerifierPin(text:string):VerifierPin {
  let value:any;
  try{value=JSON.parse(text);}catch{throw Error('INVALID_VERIFIER_PIN:unreadable JSON');}
  if(typeof value!=='object'||value===null||Array.isArray(value))throw Error('INVALID_VERIFIER_PIN:not an object');
  if(value.format!==PIN_FORMAT)throw Error('INVALID_VERIFIER_PIN:format');
  if(typeof value.version!=='string'||!/^\d+\.\d+\.\d+$/.test(value.version))throw Error('INVALID_VERIFIER_PIN:version');
  if(typeof value.platforms!=='object'||value.platforms===null||Array.isArray(value.platforms)||Object.keys(value.platforms).length===0)throw Error('INVALID_VERIFIER_PIN:platforms');
  const platforms:Record<string,VerifierPinEntry>={};
  for(const[platform,entry]of Object.entries(value.platforms as Record<string,any>)){
    if(!/^[a-z0-9][a-z0-9_.-]*$/.test(platform))throw Error('INVALID_VERIFIER_PIN:platform:'+platform);
    if(typeof entry!=='object'||entry===null||typeof entry.asset!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.asset))throw Error('INVALID_VERIFIER_PIN:asset:'+platform);
    if(typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('INVALID_VERIFIER_PIN:sha256:'+platform);
    let url:URL;
    try{url=new URL(entry.url);}catch{throw Error('INVALID_VERIFIER_PIN:url:'+platform);}
    if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))||url.pathname==='/')throw Error('INVALID_VERIFIER_PIN:url:'+platform);
    platforms[platform]={asset:entry.asset,url:url.href,sha256:entry.sha256};
  }
  return {version:value.version,platforms};
}
export function verifierPlatformKey(platform=process.platform,arch=process.arch){
  return platform==='linux'&&arch==='x64'?'linux-x86_64-musl':platform==='linux'&&arch==='arm64'?'linux-aarch64-musl':platform+'-'+arch;
}
export function verifierPinFile(){const override=process.env.THOT_VERIFIER_PIN_FILE;if(override!==undefined){if(!isAbsolute(override))throw Error('INVALID_THOT_VERIFIER_PIN_FILE');return override;}return fileURLToPath(new URL('./verifier-pin.json',import.meta.url));}
export async function loadVerifierPin(){return parseVerifierPin(await readFile(verifierPinFile(),'utf8'));}
export function verifierInstallRoot(home=thotUserHome()){return join(home,'.local/share/thot/bin');}
export function verifierSlot(home=thotUserHome()){return join(verifierInstallRoot(home),'dcap-qvl');}
export function verifierRecordFile(home=thotUserHome()){return join(home,'.config/thot/verifier.json');}
async function sha256File(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path,{highWaterMark:1<<20}))hash.update(chunk);return hash.digest('hex');}
function mismatch(url:string,expected:string,actual:string,at:string){return Error('VERIFIER_HASH_MISMATCH\n  pinned download: '+url+'\n  expected sha256:  '+expected+'\n  actual sha256:    '+actual+'\n  at: '+at+'\nNo unverified binary was installed, executed or recorded. Move the unexpected file away, or set TV_DCAP_QVL to your reviewed absolute dcap-qvl path.');}
function downloadFailed(url:string,sha256:string,detail:string){return Error('VERIFIER_DOWNLOAD_FAILED: '+url+' ('+detail+')\n  expected the pinned release with sha256 '+sha256+'\nNo unverified binary was installed or recorded.');}
/** The recorded install, but only while the file on disk still hashes to the
 * exact bytes the record was written for. Anything else is treated as absent. */
export async function recordedVerifier(home=thotUserHome()):Promise<VerifierRecord|undefined> {
  const value=await readThotConfigRecord('verifier.json',home);
  if(!value||value.format!==RECORD_FORMAT||typeof value.path!=='string'||!isAbsolute(value.path)||typeof value.version!=='string'||!/^\d+\.\d+\.\d+$/.test(value.version)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))return undefined;
  try{await access(value.path,constants.R_OK|constants.X_OK);}catch{return undefined;}
  if(await sha256File(value.path)!==value.sha256)return undefined;
  return {path:value.path,version:value.version,sha256:value.sha256,...(typeof value.source_url==='string'?{source_url:value.source_url}:{})};
}
export function manualVerifierInstructions(pin:VerifierPin,key:string,home=thotUserHome()){
  return 'No automatic hardware verifier install exists for '+key+' yet. Install the pinned dcap-qvl '+pin.version+' by hand:\n'
    +Object.entries(pin.platforms).map(([platform,entry])=>'- '+platform+': download '+entry.url+'\n  verify its sha256 is '+entry.sha256+'\n  place the executable at '+verifierSlot(home)+' and make it executable').join('\n')
    +'\nThen rerun thot-setup (or the installer): it verifies the hash and records the path. Alternatively set TV_DCAP_QVL to an absolute reviewed dcap-qvl path.';
}
async function writeVerifierRecord(home:string,record:VerifierRecord){
  const dir=join(home,'.config/thot');await mkdir(dir,{recursive:true,mode:0o700});
  const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('CAPTURE_CONFIG_PERMISSIONS');
  const path=verifierRecordFile(home);
  try{const existing=await lstat(path);if(!existing.isFile()||existing.isSymbolicLink())throw Error('CAPTURE_CONFIG_PERMISSIONS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await writeFile(path,JSON.stringify({format:RECORD_FORMAT,...record},null,2)+'\n',{mode:0o600});await chmod(path,0o600);
}
/** Install the pinned verifier for this platform. An explicit TV_DCAP_QVL is
 * never overridden; a disabled auto install changes nothing; every failure
 * names the pinned URL and expected hash and leaves no executable behind. */
export async function ensureVerifierInstalled(options:{pin?:VerifierPin;platformKey?:string;home?:string;fetchImpl?:typeof fetch}={}):Promise<EnsureVerifierResult> {
  if(process.env.TV_DCAP_QVL)return {status:'env',path:process.env.TV_DCAP_QVL};
  if(process.env.THOT_VERIFIER_AUTO_INSTALL==='0')return {status:'disabled'};
  const pin=options.pin??await loadVerifierPin(),key=options.platformKey??verifierPlatformKey(),home=options.home??thotUserHome();
  const entry=pin.platforms[key],slot=verifierSlot(home);
  let record:VerifierRecord|undefined;
  try{record=await recordedVerifier(home);}catch{}
  let slotHash:string|undefined;
  try{await access(slot,constants.F_OK);slotHash=await sha256File(slot);}catch{}
  if(slotHash!==undefined){
    if(entry&&slotHash===entry.sha256){await writeVerifierRecord(home,{path:slot,version:pin.version,sha256:slotHash,source_url:entry.url});return {status:'present',path:slot,version:pin.version,sha256:slotHash};}
    const recordedHere=record!==undefined&&record.path===slot&&record.sha256===slotHash?record.version:undefined;
    if(recordedHere!==undefined&&!entry)return {status:'present',path:slot,version:recordedHere,sha256:slotHash};
    if(!entry){
      const any=Object.values(pin.platforms).find(candidate=>candidate.sha256===slotHash);
      if(any){await writeVerifierRecord(home,{path:slot,version:pin.version,sha256:slotHash,source_url:any.url});return {status:'present',path:slot,version:pin.version,sha256:slotHash};}
      throw mismatch(Object.values(pin.platforms)[0].url,Object.values(pin.platforms)[0].sha256,slotHash,slot);
    }
    // A file we installed ourselves (record matches bytes) may be upgraded to a
    // newer pin; anything else at this thot-owned path is refused.
    if(recordedHere===undefined)throw mismatch(entry.url,entry.sha256,slotHash,slot);
  }
  if(!entry)return {status:'unsupported',instructions:manualVerifierInstructions(pin,key,home)};
  const dir=verifierInstallRoot(home);
  try{await mkdir(dir,{recursive:true,mode:0o700});}catch(e){throw Error('VERIFIER_INSTALL_LOCATION_UNAVAILABLE:'+dir+':'+(e as Error).message);}
  const temp=join(dir,'.dcap-qvl-download-'+randomBytes(8).toString('hex'));
  try{
    let response:Response;
    try{response=await (options.fetchImpl??fetch)(entry.url,{redirect:'follow',signal:AbortSignal.timeout(300_000)});}
    catch(e){throw downloadFailed(entry.url,entry.sha256,(e as Error).message);}
    if(!response.ok||!response.body)throw downloadFailed(entry.url,entry.sha256,'HTTP '+(response.status??'no status'));
    const hash=createHash('sha256');const handle=await open(temp,'w',0o600);let size=0;
    try{
      for await(const chunk of response.body){size+=chunk.length;if(size>MAX_VERIFIER_BYTES)throw downloadFailed(entry.url,entry.sha256,'larger than '+MAX_VERIFIER_BYTES+' bytes');hash.update(chunk as Buffer);await handle.write(chunk);}
    }finally{await handle.close();}
    const actual=hash.digest('hex');
    if(actual!==entry.sha256)throw mismatch(entry.url,entry.sha256,actual,temp);
    await chmod(temp,0o555);
    await rename(temp,slot);
  }catch(e){await unlink(temp).catch(()=>{});const message=(e as Error).message;throw message.startsWith('VERIFIER_')?e:downloadFailed(entry.url,entry.sha256,message);}
  await writeVerifierRecord(home,{path:slot,version:pin.version,sha256:entry.sha256,source_url:entry.url});
  return {status:'installed',path:slot,version:pin.version,sha256:entry.sha256};
}
