import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {loadPrivate,storePrivate} from './local-state.ts';
import {captureOrigin,type CaptureConnection} from './sync.ts';
import {openBrowser} from './browser.ts';
import type {CaptureClient} from './index.ts';

type Device={device_id:string;device_token:string;account_id:string;client:CaptureClient;expires_at:string};
export function connectionDirectory(root:string,origin:string,client:CaptureClient){return join(root,createHash('sha256').update(captureOrigin(origin)+'\n'+client).digest('hex'));}
async function devicePost(origin:string,device:Device,action:string,body:unknown,transport:typeof fetch){
  const response=await transport(captureOrigin(origin)+'/v1/capture-devices/'+encodeURIComponent(device.device_id)+'/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+device.device_token,'Idempotency-Key':randomBytes(16).toString('hex')},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  const result=await response.json().catch(()=>({})) as any;
  if(!response.ok)throw Error(typeof result.error==='string'&&/^[A-Z0-9_]{1,100}$/.test(result.error)?result.error:'THOT_CONNECTION_UNAVAILABLE');
  return result;
}
const reauthorize=new Set(['INVALID_CAPTURE_DEVICE','INVALID_CAPTURE_DEVICE_TOKEN','CAPTURE_DEVICE_REVOKED','CAPTURE_DEVICE_EXPIRED','AUTH_ACTOR_UNAVAILABLE']);
export async function connectCapture(options:{origin:string;client:CaptureClient;project:string;root:string;open?:(url:string)=>Promise<boolean>;log?:(message:string)=>void;transport?:typeof fetch}):Promise<CaptureConnection&{account_id:string;automatic_sales?:boolean}> {
  const origin=captureOrigin(options.origin),transport=options.transport??fetch,log=options.log??(s=>process.stdout.write(s+'\n'));
  const dir=connectionDirectory(options.root,origin,options.client);
  async function begin(device:Device){
    const result=await devicePost(origin,device,'captures',{client:options.client,project:options.project},transport);
    if(!/^[a-zA-Z0-9-]{16,80}$/.test(result.capture_id)||!/^[A-Za-z0-9_-]{43}$/.test(result.upload_token)||result.account_id!==device.account_id||result.client!==options.client||Date.parse(result.expires_at)<=Date.now()||!Number.isFinite(Date.parse(result.expires_at)))throw Error('INVALID_CAPTURE_CONNECTION');
    return {...result,origin};
  }
  try{
    const remembered=await loadPrivate(dir);
    if(remembered.origin!==origin||remembered.device?.client!==options.client)throw Error('INVALID_SAVED_CONNECTION');
    const result=await begin(remembered.device);log('Using your remembered THOT connection for '+options.client+'.');return result;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!reauthorize.has((error as Error).message))throw error;
    if(reauthorize.has((error as Error).message))log('Reconnect this tool: '+(error as Error).message.toLowerCase().replaceAll('_',' ')+'.');
  }
  const nonce=randomBytes(24).toString('hex');let accepting=false,resolvePair!:(v:any)=>void,rejectPair!:(e:Error)=>void;
  const paired=new Promise<CaptureConnection&{account_id:string}>((resolve,reject)=>{resolvePair=resolve;rejectPair=reject;});
  const bridge=createServer(async(req,res)=>{
    const address=bridge.address(),host=address&&typeof address!=='string'?'127.0.0.1:'+address.port:'';
    res.setHeader('Cache-Control','no-store');
    if(req.headers.host!==host||req.headers.origin!==origin||req.url!=='/pair/'+nonce){res.writeHead(403);res.end();return;}
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Private-Network','true');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method!=='POST'||accepting){res.writeHead(409);res.end();return;}accepting=true;
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('INVALID_PAIR');}
      const device=JSON.parse(raw) as Device;
      if(!/^[a-f0-9-]{36}$/.test(device.device_id)||!/^[A-Za-z0-9_-]{43}$/.test(device.device_token)||device.client!==options.client||typeof device.account_id!=='string'||device.account_id.length>256)throw Error('INVALID_PAIR');
      const result=await begin(device);await storePrivate(dir,{origin,device});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({paired:true,capture_id:result.capture_id,automatic_sales:result.automatic_sales===true}));resolvePair(result);
    }catch{accepting=false;res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"CAPTURE_CONNECTION_FAILED"}');}
  });
  await new Promise<void>((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
  const address=bridge.address();if(!address||typeof address==='string')throw Error('PAIR_START_FAILED');
  const value={version:2,callback:`http://127.0.0.1:${address.port}/pair/${nonce}`,client:options.client,device_name:hostname().slice(0,80)};
  const url=origin+'/#thot='+Buffer.from(JSON.stringify(value)).toString('base64url');
  const timeout=setTimeout(()=>rejectPair(Error('PAIRING_EXPIRED_RESTART_HELPER')),10*60_000);
  try{
    log('Opening THOT to connect '+(options.client==='codex'?'Codex':'Claude Code')+' on this computer…');
    if(!await (options.open??openBrowser)(url))log('Open this link in your browser to connect:\n'+url);
    return await paired;
  }finally{clearTimeout(timeout);bridge.closeAllConnections();await new Promise<void>(resolve=>bridge.close(()=>resolve()));}
}
export async function disconnectCapture(root:string,origin:string,client:CaptureClient,transport:typeof fetch=fetch){
  const dir=connectionDirectory(root,origin,client),remembered=await loadPrivate(dir);
  return devicePost(origin,remembered.device,'disconnect',{},transport);
}
