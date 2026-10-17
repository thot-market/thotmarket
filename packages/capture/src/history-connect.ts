import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {openBrowser} from './browser.ts';
import {storePrivate} from './local-state.ts';
import {historyPost,type HistoryState,type HistoryGrant} from './history-sync.ts';

/** Separate from live capture. Only a new browser-confirmed history grant can
 * be stored here; callback requires both the unpredictable nonce and origin. */
export async function connectHistory(state:HistoryState,dir:string,options:{open?:(url:string)=>Promise<boolean>;log?:(text:string)=>void;transport?:typeof fetch;timeoutMs?:number}={}){
  const nonce=randomBytes(24).toString('hex'),log=options.log??(text=>process.stdout.write(text+'\n'));let accepting=false,complete!:(grant:HistoryGrant)=>void,fail!:(error:Error)=>void;
  const result=new Promise<HistoryGrant>((resolve,reject)=>{complete=resolve;fail=reject;});
  const server=createServer(async(req,res)=>{
    const address=server.address(),host=address&&typeof address!=='string'?'127.0.0.1:'+address.port:'';
    res.setHeader('Cache-Control','no-store');
    if(req.headers.host!==host||req.headers.origin!==state.origin||req.url!=='/pair/'+nonce){res.writeHead(403);res.end();return;}
    res.setHeader('Access-Control-Allow-Origin',state.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Private-Network','true');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method!=='POST'||accepting){res.writeHead(409);res.end();return;}accepting=true;
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('INVALID_HISTORY_PAIR');}
      const grant=JSON.parse(raw) as HistoryGrant;
      if(!/^[a-f0-9-]{36}$/.test(grant.device_id)||!/^[A-Za-z0-9_-]{43}$/.test(grant.device_token)||grant.client!==state.client||grant.private_only!==true||typeof grant.account_id!=='string'||grant.account_id.length>256||grant.backfill!==state.backfill||grant.daily_time_utc!==state.daily_time_utc||JSON.stringify(grant.source_ids)!==JSON.stringify(state.sources.map(s=>s.id))||!Number.isFinite(Date.parse(grant.expires_at))||Date.parse(grant.expires_at)<=Date.now())throw Error('INVALID_HISTORY_PAIR');
      const candidate={...state,grant};const status=await historyPost(candidate,'status',{},options.transport);if(status.status!=='CONNECTED'||status.account_id!==grant.account_id)throw Error('INVALID_HISTORY_PAIR');
      await storePrivate(dir,candidate);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"paired":true,"private_only":true}');complete(grant);
    }catch{accepting=false;res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"HISTORY_CONNECTION_FAILED"}');}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('HISTORY_PAIRING_FAILED');
  const value={version:1,callback:'http://127.0.0.1:'+address.port+'/pair/'+nonce,client:state.client,source_ids:state.sources.map(s=>s.id),backfill:state.backfill,daily_time_utc:state.daily_time_utc};
  const url=state.origin+'/app#thot-history='+Buffer.from(JSON.stringify(value)).toString('base64url');
  const timeout=setTimeout(()=>fail(Error('HISTORY_PAIRING_EXPIRED')),options.timeoutMs??600000);
  try{log('Approve private history uploads in your signed-in THOT browser. No file bodies have been read.');if(!await(options.open??openBrowser)(url))log('Open this link to connect:\n'+url);return await result;}
  finally{clearTimeout(timeout);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
