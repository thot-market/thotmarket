import {appendFile,writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

// Opt-in benchmark metadata only. No paths, bodies, headers, tokens or identity.
export type CaptureTiming=(event:string,values?:Record<string,number>)=>void;
export function captureTiming():{emit:CaptureTiming;flush:()=>Promise<void>} {
  const path=process.env.THOT_CAPTURE_TIMING_FILE;
  if(!path)return {emit:()=>{},flush:async()=>{}};
  if(!isAbsolute(path))throw Error('TIMING_PATH_MUST_BE_ABSOLUTE');
  let count=0,disabled=false;
  let writes=writeFile(path,'',{mode:0o600,flag:'wx'}).catch(()=>{disabled=true;});
  return {
    emit(event,values={}){
      if(++count>20000||!/^[a-z_]{1,48}$/.test(event))return;
      const numbers=Object.fromEntries(Object.entries(values).filter(([k,v])=>/^[a-z_]{1,48}$/.test(k)&&Number.isFinite(v)));
      const line=JSON.stringify({event,at_ms:Date.now(),...numbers})+'\n';
      writes=writes.then(async()=>{if(!disabled)await appendFile(path,line);}).catch(()=>{disabled=true;});
    },
    async flush(){await writes;if(disabled)throw Error('TIMING_WRITE_FAILED');}
  };
}
