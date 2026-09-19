import {join} from 'node:path';
import {readdir,writeFile,open,rm,lstat} from 'node:fs/promises';
import {canonicalHash} from '../../protocol/src/index.ts';
import {loadPrivate,storePrivate} from './local-state.ts';
import {CAPTURE_STORAGE_BYTES} from './limits.ts';

export type CaptureConnection={origin:string;capture_id:string;upload_token:string;expires_at?:string;local_retention?:'keep'|'until-saved'};
export type SyncProgress={saved:number;pending:number;syncing:boolean;error?:string;traceId?:string;projection?:string;saveMsP50?:number;saveMsLast?:number;oldestPendingAt?:number;uploadBps?:number};
const p50=(samples:number[])=>samples.length?[...samples].sort((a,b)=>a-b)[Math.floor((samples.length-1)/2)]:undefined;
export function captureOrigin(value:string){
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw Error('INVALID_THOT_ORIGIN');
  return url.origin;
}
export async function capturePost(connection:CaptureConnection,route:string,body:unknown,key:string,transport:typeof fetch=fetch){
  const response=await transport(captureOrigin(connection.origin)+'/v1/agent-captures/'+encodeURIComponent(connection.capture_id)+'/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.upload_token,'Idempotency-Key':key},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  const result=await response.json().catch(()=>({})) as any;
  if(!response.ok){const code=typeof result.error==='string'&&/^[A-Z0-9_]{1,100}$/.test(result.error)?result.error:'CAPTURE_HTTP_'+response.status;throw Error(code);}
  return result;
}
export function checkSave(result:any,pending:any,final:boolean){
  if(typeof result.trace_id!=='string'||result.status!==(final?'SAVED':'CHECKPOINT_SAVED')||result.capture_receipt?.commitments?.session_root!==pending.bundle.root||result.capture_id!==pending.capture_id)throw Error('INVALID_CAPTURE_SAVE_RESPONSE');
  if(pending.evidence&&result.capture_receipt?.confidence_tier!=='P2_TEE')throw Error('CAPTURE_VERIFICATION_NOT_CONFIRMED');
}

/** Local fsync is awaited by the relay; all vault traffic is independent of the
 * client's response path. Local bodies survive staging acknowledgements. */
export async function captureSync(connection:CaptureConnection,dir:string,onProgress:(state:SyncProgress)=>void=()=>{},transport:typeof fetch=fetch){
  const parts=new Map<number,string>(),partSizes=new Map<number,number>(),uploaded=new Set<number>();let checkpoint:any,saved=0,traceId:string|undefined,projection:string|undefined,localBytes=0;
  const saveSamples:number[]=[],pendingSince=new Map<number,number>();let saveMsLast:number|undefined,uploadBps:number|undefined;
  const recordSave=(ms:number)=>{saveMsLast=ms;saveSamples.push(ms);if(saveSamples.length>20)saveSamples.shift();};
  let running:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false,error:string|undefined,retries=0;
  for(const name of await readdir(join(dir,'parts')).catch(()=>[]))if(/^[1-9][0-9]*$/.test(name)){
    const path=join(dir,'parts',name),stat=await lstat(join(path,'pending.enc')),size=stat.size;
    parts.set(Number(name),path);partSizes.set(Number(name),size);pendingSince.set(Number(name),stat.mtimeMs);localBytes+=size;
  }
  try{checkpoint=await loadPrivate(join(dir,'checkpoint'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const snapshot=():SyncProgress=>{
    const oldestPendingAt=pendingSince.size?Math.min(...pendingSince.values()):undefined;
    return {saved,pending:Math.max(0,parts.size-saved),syncing:!!running,...(error?{error}:{}),...(traceId?{traceId}:{}),...(projection?{projection}:{}),...(saveMsLast!==undefined?{saveMsLast,saveMsP50:p50(saveSamples)}:{}),...(oldestPendingAt!==undefined?{oldestPendingAt}:{}),...(uploadBps!==undefined?{uploadBps}:{})};
  };
  const notify=()=>onProgress(snapshot());
  function schedule(delay=50){if(closed||timer||running)return;timer=setTimeout(()=>{timer=undefined;void run();},delay);timer.unref();}
  async function uploadParts(){
    const start=performance.now();let bytes=0;
    for(const sequence of [...parts.keys()].sort((a,b)=>a-b)){
      if(uploaded.has(sequence))continue;
      const {part}=await loadPrivate(parts.get(sequence)!);
      const ack=await capturePost(connection,'parts',{part},'capture-part-'+connection.capture_id+'-'+sequence,transport);
      if(ack.sequence!==sequence||ack.commitment!==part.commitment||ack.stored!==true)throw Error('INVALID_CAPTURE_PART_ACK');
      uploaded.add(sequence);bytes+=Buffer.byteLength(JSON.stringify({part}));
    }
    const ms=performance.now()-start;if(bytes>0&&ms>0)uploadBps=bytes/(ms/1000);
  }
  async function synchronize(){
    await uploadParts();
    const pending=checkpoint;
    if(pending&&pending.bundle.parts.length>saved&&pending.bundle.parts.every((p:any)=>uploaded.has(p.sequence))){
      const t=performance.now();
      const result=await capturePost(connection,'checkpoint',{bundle:pending.bundle,evidence:pending.evidence},'checkpoint-'+pending.bundle.root,transport);
      checkSave(result,pending,false);recordSave(performance.now()-t);saved=pending.bundle.parts.length;traceId=result.trace_id;projection=result.projection?.status;
      for(const part of pending.bundle.parts)pendingSince.delete(part.sequence);
      await writeFile(join(dir,'checkpoint-saved.json'),JSON.stringify(result),{mode:0o600});
    }
  }
  function run(){
    if(running)return running;
    running=synchronize().then(()=>{error=undefined;retries=0;}).catch(e=>{error=e instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'CAPTURE_SYNC_UNAVAILABLE';retries++;}).finally(()=>{
      running=undefined;notify();if(!closed&&(error||uploaded.size<parts.size||(checkpoint?.bundle.parts.length??0)>saved))schedule(error?Math.min(1000*2**Math.min(retries-1,4),10000):uploaded.size<parts.size?50:1000);
    });notify();return running;
  }
  return {
    async part(part:any){
      const {commitment,...record}=part;if(canonicalHash(record)!==commitment)throw Error('CAPTURE_PART_COMMITMENT_MISMATCH');
      const size=Buffer.byteLength(JSON.stringify({part}))+28,previous=partSizes.get(part.sequence)??0;
      if(localBytes-previous+size>CAPTURE_STORAGE_BYTES)throw Error('THOT_LOCAL_CAPTURE_STORAGE_FULL');
      localBytes+=size-previous;partSizes.set(part.sequence,size);
      const path=join(dir,'parts',String(part.sequence));await storePrivate(path,{part});parts.set(part.sequence,path);
      if(part.sequence>saved&&!pendingSince.has(part.sequence))pendingSince.set(part.sequence,Date.now());notify();schedule();
    },
    async checkpoint(value:any){
      if(checkpoint&&checkpoint.bundle.parts.length>=value.bundle.parts.length)return;
      const pending={...connection,...value};await storePrivate(join(dir,'checkpoint'),pending);checkpoint=pending;notify();schedule();
    },
    async flush(){clearTimeout(timer);timer=undefined;await run();if(error)throw Error(error);},
    async finish(value:any){
      closed=true;clearTimeout(timer);timer=undefined;await running;
      const pending={...connection,...value};await storePrivate(dir,pending);
      await uploadParts();
      const t=performance.now();
      const result=await capturePost(connection,'complete',{bundle:pending.bundle,...(pending.evidence?{evidence:pending.evidence}:{})},'capture-complete-'+connection.capture_id,transport);
      checkSave(result,pending,true);recordSave(performance.now()-t);saved=pending.bundle.parts?.length??pending.bundle.exchanges?.length??0;traceId=result.trace_id;projection=result.projection?.status;error=undefined;
      // Keep owner evidence by default. Explicit until-saved retention can reclaim
      // bodies only after the matching final receipt is durably stored locally.
      const receipt=await open(join(dir,'saved.json'),'w',0o600);
      try{await receipt.writeFile(JSON.stringify(result));await receipt.sync();}finally{await receipt.close();}
      const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
      if(connection.local_retention==='until-saved')for(const path of parts.values())await rm(path,{recursive:true,force:true}).catch(()=>{});
      parts.clear();pendingSince.clear();notify();return result;
    },
    close(){closed=true;clearTimeout(timer);},
    get progress(){return snapshot();}
  };
}
