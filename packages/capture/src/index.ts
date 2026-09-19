import {createServer, type IncomingMessage} from 'node:http';
import {randomBytes} from 'node:crypto';
import {canonicalHash} from '../../protocol/src/index.ts';
import {CAPTURE_REQUEST_BYTES,CAPTURE_RESPONSE_BYTES,CAPTURE_MAX_EXCHANGES} from './limits.ts';

export type CaptureClient='claude'|'codex';
export interface ProxyExchange {
  request_encoding?:'identity'|'gzip'|'zstd';request_method?:'POST'|'GET';
  sequence:number;upstream:'https://api.anthropic.com'|'https://chatgpt.com';path:string;
  request_body_b64:string;response_body_b64:string;status:number;content_type:string;
  started_at:string;finished_at:string;complete:boolean;commitment:string;
}
export interface ProxyCaptureBundle {
  format:'thot.proxy-capture/1';capture_id:string;client:CaptureClient;
  started_at:string;finished_at:string;exchanges:ProxyExchange[];root:string;
}
export interface ProxyCaptureManifest {
 format:'thot.proxy-capture/2';capture_id:string;client:CaptureClient;started_at:string;finished_at:string;parts:{sequence:number;commitment:string}[];root:string;
}
const MAX_BODY=4*1024*1024,MAX_SESSION=6*1024*1024;
const allowedPath=(client:CaptureClient,path:string)=>client==='claude'
  ? ['/v1/messages','/v1/messages/count_tokens'].includes(path)
  : ['/backend-api/codex/responses','/backend-api/codex/responses/compact','/backend-api/codex/models'].includes(path);
const hop=new Set(['connection','proxy-connection','keep-alive','transfer-encoding','upgrade','host','content-length','proxy-authorization','proxy-authenticate','trailer','te','x-thot-recorder-request']);
async function body(req:IncomingMessage,limit=MAX_BODY){const parts:Buffer[]=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>limit)throw new Error('CAPTURE_REQUEST_TOO_LARGE');parts.push(Buffer.from(part));}return Buffer.concat(parts);}

/** Child-process-only reverse proxy. No global configuration or authentication changes.
 * Transport is injectable for local protocol tests; production always uses the pinned hosts.
 * This local observer emits integrity commitments, never a provider signature or TEE quote.
 */
export async function startCaptureProxy(options:{client:CaptureClient;captureId:string;transport?:typeof fetch;onActivity?:(count:number)=>void;onRejected?:(path:string,reason:string)=>void;incremental?:boolean;onExchange?:(exchange:ProxyExchange,tag:string)=>void}){
  const exchanges:ProxyExchange[]=[],started_at=new Date().toISOString(),nonce=randomBytes(24).toString('hex');
  const upstream:ProxyExchange['upstream']=options.client==='claude'?'https://api.anthropic.com':'https://chatgpt.com';
  let sequence=0,total=0,active=0,closed=false;
  const summaries:{sequence:number;commitment:string}[]=[];
  const limit=options.incremental?CAPTURE_MAX_EXCHANGES:100;
  const tasks=new Set<Promise<void>>();
  const server=createServer((req,res)=>{
    const work=(async()=>{
      res.setHeader('Cache-Control','no-store');
      const fail=(status:number,code:string)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{type:'capture_error',message:code}}));}else res.destroy();};
      const address=server.address();if(!address||typeof address==='string')return fail(503,'CAPTURE_NOT_READY');
      const host='127.0.0.1:'+address.port;
      // Browser requests and redirects must never turn this into a credential relay.
      if(closed||req.headers.host!==host||req.headers.origin||req.headers['sec-fetch-site'])return fail(403,'CAPTURE_LOCAL_CLIENT_REQUIRED');
      const url=new URL(req.url??'/',`http://${host}`),prefix='/r/'+nonce;
      if(!url.pathname.startsWith(prefix+'/'))return fail(404,'CAPTURE_ROUTE_UNAVAILABLE');
      const path=url.pathname.slice(prefix.length);
      if(!allowedPath(options.client,path)||!(req.method==='POST'||(req.method==='GET'&&options.client==='codex'&&path==='/backend-api/codex/models'))){options.onRejected?.(path,'CAPTURE_ROUTE_UNAVAILABLE');return fail(404,'CAPTURE_ROUTE_UNAVAILABLE');}
      if(sequence>=limit||active>=4)return fail(409,'THOT_CAPTURE_CAPACITY');
      const encoding=req.headers['content-encoding']??'identity';if(!['identity','gzip','zstd'].includes(String(encoding)))return fail(415,'CAPTURE_COMPRESSED_REQUEST_UNSUPPORTED');
      let input:Buffer;active++;
      try{input=await body(req,options.incremental?CAPTURE_REQUEST_BYTES:MAX_BODY);}catch{active--;return fail(options.incremental?400:413,'THOT_CAPTURE_REQUEST_TOO_LARGE');}
      if(sequence>=limit){active--;return fail(409,'THOT_CAPTURE_CAPACITY');}
      if(!options.incremental&&total+input.length>MAX_SESSION){active--;return fail(413,'CAPTURE_SESSION_TOO_LARGE');}
      total+=input.length;
      const index=++sequence,begin=new Date().toISOString(),controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),300_000);
      const parts:Buffer[]=[];let status=0,contentType='',complete=false,responseBytes=0;let drainTimeout:ReturnType<typeof setTimeout>|undefined;
      // Codex closes after its terminal SSE event. Drain the remaining HTTP EOF
      // briefly so a completed protocol response is not mislabeled as truncated.
      res.on('close',()=>{if(!res.writableEnded)drainTimeout=setTimeout(()=>controller.abort(),2000);});
      try {
        const headers=new Headers();
        const connectionHeaders=new Set(String(req.headers.connection??'').toLowerCase().split(',').map(s=>s.trim()));
        for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&!hop.has(key)&&!connectionHeaders.has(key))headers.set(key,Array.isArray(value)?value.join(', '):value);
        // Preserve request bytes and client OAuth/beta/account headers. No reconstructed prompts.
        headers.set('accept-encoding','identity');
        const response=await (options.transport??fetch)(upstream+path+url.search,{method:req.method,headers,...(req.method==='POST'?{body:new Uint8Array(input)}:{}),redirect:'error',signal:controller.signal});
        status=response.status;contentType=response.headers.get('content-type')??'application/octet-stream';
        for(const [key,value]of response.headers)if(!hop.has(key)&&!['content-encoding','set-cookie'].includes(key))res.setHeader(key,value);
        res.writeHead(status);res.flushHeaders();
        if(response.body)for await(const chunk of response.body){
          total+=chunk.length;responseBytes+=chunk.length;if(options.incremental?responseBytes>CAPTURE_RESPONSE_BYTES:total>MAX_SESSION){controller.abort();throw new Error('CAPTURE_SESSION_TOO_LARGE');}
          const bytes=Buffer.from(chunk);parts.push(bytes);
          if(!res.destroyed&&!res.writableEnded&&!res.write(bytes))await new Promise<void>((resolve,reject)=>{const cleanup=()=>{res.off('drain',drain);res.off('close',close);};const drain=()=>{cleanup();resolve();};const close=()=>{cleanup();resolve();};res.once('drain',drain);res.once('close',close);});
        }
        complete=true;res.end();
      }catch{fail(502,'CAPTURE_INTERRUPTED');}
      finally{
        clearTimeout(timeout);clearTimeout(drainTimeout);active--;
        const record={request_method:req.method as 'POST'|'GET',request_encoding:encoding as 'identity'|'gzip'|'zstd',sequence:index,upstream,path:path+url.search,request_body_b64:input.toString('base64'),response_body_b64:Buffer.concat(parts).toString('base64'),status,content_type:contentType,started_at:begin,finished_at:new Date().toISOString(),complete};
        const exchange={...record,commitment:canonicalHash(record)};
        summaries.push({sequence:index,commitment:exchange.commitment});
        if(!options.incremental)exchanges.push(exchange);
        options.onExchange?.(exchange,String(req.headers['x-thot-recorder-request']??''));options.onActivity?.(summaries.length);
      }
    })();tasks.add(work);void work.catch(()=>{res.destroy();}).finally(()=>tasks.delete(work));
  });
  server.on('upgrade',(_req,socket)=>{socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('CAPTURE_START_FAILED');
  const origin=`http://127.0.0.1:${address.port}`,base=origin+'/r/'+nonce;
  function checkpointManifest():ProxyCaptureManifest|undefined {
    const sorted=[...summaries].sort((a,b)=>a.sequence-b.sequence),parts:typeof summaries=[];
    for(const descriptor of sorted){if(descriptor.sequence!==parts.length+1)break;parts.push({...descriptor});}
    if(!parts.length)return;
    const value={format:'thot.proxy-capture/2' as const,capture_id:options.captureId,client:options.client,started_at,finished_at:new Date().toISOString(),parts};
    return {...value,root:canonicalHash(value)};
  }
  return {baseUrl:options.client==='codex'?base+'/backend-api/codex':base,checkpointManifest,
    async finishManifest():Promise<ProxyCaptureManifest>{
      if(!options.incremental)throw Error('INCREMENTAL_CAPTURE_REQUIRED');
      closed=true;const stopping=new Promise<void>(resolve=>server.close(()=>resolve()));await Promise.allSettled([...tasks]);server.closeAllConnections();await stopping;
      summaries.sort((a,b)=>a.sequence-b.sequence);
      const value={format:'thot.proxy-capture/2' as const,capture_id:options.captureId,client:options.client,started_at,finished_at:new Date().toISOString(),parts:summaries};return {...value,root:canonicalHash(value)};
    },
    async finish():Promise<ProxyCaptureBundle>{
      closed=true;const stopping=new Promise<void>(resolve=>server.close(()=>resolve()));
      await Promise.allSettled([...tasks]);server.closeAllConnections();await stopping;
      exchanges.sort((a,b)=>a.sequence-b.sequence);
      const value={format:'thot.proxy-capture/1' as const,capture_id:options.captureId,client:options.client,started_at,finished_at:new Date().toISOString()};
      return {...value,exchanges,root:canonicalHash({...value,commitments:exchanges.map(e=>e.commitment)})};
    }};
}

export function clientInvocation(client:CaptureClient,baseUrl:string,args:string[],environment:NodeJS.ProcessEnv=process.env){
  const env={...environment};
  // Native clients can discover an OS proxy while ignoring its loopback bypass
  // list. Route only this child's local capture bridge directly; preserve the
  // caller's proxy and existing exclusions for all other destinations.
  if(['127.0.0.1','localhost','[::1]'].includes(new URL(baseUrl).hostname)){
    const bypass=[...new Set([env.NO_PROXY,env.no_proxy,'127.0.0.1','localhost','::1']
      .filter(Boolean).flatMap(value=>value!.split(',')).map(value=>value.trim()).filter(Boolean))].join(',');
    env.NO_PROXY=bypass;env.no_proxy=bypass;
  }
  if(client==='claude'){
    if(env.ANTHROPIC_API_KEY||env.ANTHROPIC_AUTH_TOKEN)throw new Error('USE_SUBSCRIPTION_LOGIN_REMOVE_API_OVERRIDE');
    env.ANTHROPIC_BASE_URL=baseUrl;
    // This relay forwards unchanged to api.anthropic.com. Preserve the installed
    // Claude CLI's first-party subscription/context behavior for this child only.
    env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL='1';
    return {command:'claude',args,env};
  }
  // A scoped custom Responses provider preserves ChatGPT auth and uses SSE. Global
  // config and credential files are untouched. WebSocket capture is not claimed.
  const settings={model_provider:'thot_capture','model_providers.thot_capture.name':'OpenAI',
    'model_providers.thot_capture.base_url':baseUrl,'model_providers.thot_capture.wire_api':'responses',
    'model_providers.thot_capture.requires_openai_auth':true,'model_providers.thot_capture.supports_websockets':false};
  // Codex 0.154.0 drops root-level -c values when resume/exec also has -c.
  // Keep mandatory routing overrides in the final parser scope, after caller
  // options but before an explicit -- that starts literal prompt arguments.
  const delimiter=args.indexOf('--'),at=delimiter<0?args.length:delimiter;
  const overrides=Object.entries(settings).flatMap(([k,v])=>['-c',k+'='+JSON.stringify(v)]);
  return {command:'codex',args:[...args.slice(0,at),...overrides,...args.slice(at)],env};
}
