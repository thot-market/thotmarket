import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {openBrowser} from './browser.ts';
import {storePrivate} from './local-state.ts';
import {pairingMode,createDevicePairing,awaitDevicePairing,printDevicePairing,type PairingMode} from './device-pairing.ts';
import {historyPost,type HistoryState,type HistoryGrant} from './history-sync.ts';

/** Separate from live capture. Only a new browser-confirmed history grant can
 * be stored here; the callback requires both the unpredictable nonce and origin. */
export async function connectHistory(state:HistoryState,dir:string,options:{open?:(url:string)=>Promise<boolean>;log?:(text:string)=>void;transport?:typeof fetch;timeoutMs?:number;pairing?:PairingMode;fallbackMs?:number}={}){
  const log=options.log??(text=>process.stdout.write(text+'\n')),transport=options.transport??fetch;
  // The loopback callback and the device-code poll deliver the same grant;
  // either way it must match this connection's request exactly and be checked
  // against the service before anything is stored.
  const accept=async(grant:HistoryGrant)=>{
    if(!/^[a-f0-9-]{36}$/.test(grant.device_id)||!/^[A-Za-z0-9_-]{43}$/.test(grant.device_token)||grant.client!==state.client||grant.private_only!==true||typeof grant.account_id!=='string'||grant.account_id.length>256||grant.backfill!==state.backfill||grant.daily_time_utc!==state.daily_time_utc||JSON.stringify(grant.source_ids)!==JSON.stringify(state.sources.map(s=>s.id))||!Number.isFinite(Date.parse(grant.expires_at))||Date.parse(grant.expires_at)<=Date.now())throw Error('INVALID_HISTORY_PAIR');
    const candidate={...state,grant};const status=await historyPost(candidate,'status',{},transport);if(status.status!=='CONNECTED'||status.account_id!==grant.account_id)throw Error('INVALID_HISTORY_PAIR');
    await storePrivate(dir,candidate);return grant;
  };
  let settled=false;
  async function pairByCode(openUrl:boolean){
    const session=await createDevicePairing(state.origin,{flow:'history',client:state.client,device_name:hostname().slice(0,80),source_ids:state.sources.map(s=>s.id),backfill:state.backfill,daily_time_utc:state.daily_time_utc},transport);
    printDevicePairing(session,log);
    if(openUrl)await (options.open??openBrowser)(session.verification_uri_complete);
    return accept(await awaitDevicePairing(state.origin,session,{transport,shouldStop:()=>settled}) as HistoryGrant);
  }
  if((options.pairing??pairingMode())==='code'){
    log('Approve private history uploads from a browser on any signed-in device. No file bodies have been read.');
    return await pairByCode(true);
  }
  const nonce=randomBytes(24).toString('hex');let accepting=false;
  let complete!:(grant:HistoryGrant)=>void,fail!:(error:Error)=>void;
  const result=new Promise<HistoryGrant>((resolve,reject)=>{complete=v=>{settled=true;resolve(v);};fail=e=>{settled=true;reject(e);};});
  const server=createServer(async(req,res)=>{
    const address=server.address(),host=address&&typeof address!=='string'?'127.0.0.1:'+address.port:'';
    res.setHeader('Cache-Control','no-store');
    if(req.headers.host!==host||req.headers.origin!==state.origin||req.url!=='/pair/'+nonce){res.writeHead(403);res.end();return;}
    res.setHeader('Access-Control-Allow-Origin',state.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Private-Network','true');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method!=='POST'||accepting){res.writeHead(409);res.end();return;}accepting=true;
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('INVALID_HISTORY_PAIR');}
      const grant=await accept(JSON.parse(raw) as HistoryGrant);
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"paired":true,"private_only":true}');complete(grant);
    }catch{accepting=false;res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"HISTORY_CONNECTION_FAILED"}');}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('HISTORY_PAIRING_FAILED');
  const value={version:1,callback:'http://127.0.0.1:'+address.port+'/pair/'+nonce,client:state.client,source_ids:state.sources.map(s=>s.id),backfill:state.backfill,daily_time_utc:state.daily_time_utc};
  const url=state.origin+'/app#thot-history='+Buffer.from(JSON.stringify(value)).toString('base64url');
  const timeout=setTimeout(()=>fail(Error('HISTORY_PAIRING_EXPIRED')),options.timeoutMs??600000);
  // If the browser cannot reach this helper's loopback callback, continue by code.
  const fallback=setTimeout(()=>void pairByCode(false).then(complete,error=>{if((error as Error).message!=='PAIRING_SUPERSEDED'&&!settled)fail(error as Error);}),Math.min(options.fallbackMs??30_000,options.timeoutMs??600000));
  try{log('Approve private history uploads in your signed-in THOT browser. No file bodies have been read.');if(!await(options.open??openBrowser)(url))log('Open this link to connect:\n'+url);return await result;}
  finally{clearTimeout(timeout);clearTimeout(fallback);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
