import {captureOrigin} from './sync.ts';

/** How a helper reaches a signed-in browser: the loopback callback first, or
 * a short device code the person can type on any machine (RFC 8628 shape). */
export type PairingMode='loopback'|'code';
export function pairingMode(explicit?:string|null,env:string|undefined=process.env.THOT_PAIRING):PairingMode{
  const value=(explicit??env)?.trim();
  if(value===undefined||value===''||value==='loopback')return 'loopback';
  if(value==='code')return 'code';
  throw Error('INVALID_PAIRING_MODE');
}
export type DevicePairingSession={device_code:string;user_code:string;verification_uri:string;verification_uri_complete:string;interval:number;expires_in:number};
const code=(error:unknown)=>error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'PAIRING_UNAVAILABLE';
async function pairingPost(origin:string,path:string,body:unknown,transport:typeof fetch){
  const response=await transport(captureOrigin(origin)+'/v1/device-pairing/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)}).catch(()=>{throw Error('PAIRING_UNAVAILABLE');});
  const result=await response.json().catch(()=>({})) as any;
  if(!response.ok)throw Error(typeof result.error==='string'&&/^[A-Z0-9_]{1,100}$/.test(result.error)?result.error:'PAIRING_UNAVAILABLE');
  return result;
}
/** Creates a pairing session. The response is fully validated before use. */
export async function createDevicePairing(origin:string,request:Record<string,unknown>,transport:typeof fetch=fetch):Promise<DevicePairingSession>{
  const result=await pairingPost(origin,'sessions',request,transport);
  if(typeof result.device_code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.device_code)
    ||typeof result.user_code!=='string'||!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(result.user_code)
    ||typeof result.verification_uri!=='string'||!/^https?:\/\/[^/]+\/app#thot-pair=$/.test(result.verification_uri)
    ||result.verification_uri_complete!==result.verification_uri+result.user_code
    ||!Number.isInteger(result.interval)||result.interval<1||result.interval>60
    ||!Number.isInteger(result.expires_in)||result.expires_in<1||result.expires_in>600)throw Error('INVALID_PAIRING_SESSION');
  return result;
}
export function printDevicePairing(session:DevicePairingSession,log:(message:string)=>void){
  log('No browser reached this helper directly. Pair with a code instead:');
  log('  Pairing code: '+session.user_code);
  log('  Open '+session.verification_uri_complete+' on any signed-in device,');
  log('  or visit '+session.verification_uri+' and enter the code there.');
  log('The code works once and expires in '+Math.round(session.expires_in/60)+' minutes. Waiting…');
}
/** Polls until the browser approves or the session ends. Transient transport
 * failures keep polling; a slow-down response backs off like RFC 8628. */
export async function awaitDevicePairing(origin:string,session:DevicePairingSession,options:{transport?:typeof fetch;sleep?:(ms:number)=>Promise<void>;shouldStop?:()=>boolean}={}):Promise<any>{
  const transport=options.transport??fetch,sleep=options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const deadline=Date.now()+session.expires_in*1000+15_000;
  let interval=session.interval;
  for(;;){
    if(options.shouldStop?.())throw Error('PAIRING_SUPERSEDED');
    try{
      const result=await pairingPost(origin,'sessions/token',{device_code:session.device_code},transport);
      if(result.status==='approved')return result;
      if(result.status!=='pending')throw Error('INVALID_PAIRING_SESSION');
    }catch(error){
      if((error as Error).message==='PAIRING_SLOW_DOWN')interval+=5;
      else if((error as Error).message!=='PAIRING_UNAVAILABLE')throw error;
    }
    if(Date.now()>=deadline)throw Error('PAIRING_EXPIRED');
    await sleep(interval*1000);
  }
}
/** Helper-to-browser progress relay for flows whose status the browser used to
 * read over loopback. The response carries the browser's own signals. */
export async function reportDevicePairingEvent(origin:string,deviceCode:string,event:Record<string,unknown>,transport:typeof fetch=fetch){
  const result=await pairingPost(origin,'sessions/events',{device_code:deviceCode,...event},transport) as {saved?:boolean;cancelled?:boolean;status?:string};
  if(typeof result.saved!=='boolean'||typeof result.cancelled!=='boolean')throw Error('INVALID_PAIRING_SESSION');
  return result;
}
export {code as pairingErrorCode};
