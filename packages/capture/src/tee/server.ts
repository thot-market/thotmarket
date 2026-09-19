import {createServer,type IncomingMessage,type Server} from 'node:http';
import {createCipheriv,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {CAPTURE_RELAY_JSON_BYTES,CAPTURE_MAX_EXCHANGES} from '../limits.ts';
import {startCaptureProxy} from '../index.ts';
import {canonicalHash,canonicalJson} from '../../../protocol/src/canonical.ts';
import {publicDer,channelKey,encrypt,decrypt} from './channel.ts';
import {getQuote} from './attestation.ts';

export interface TeeRecorderCapacity {
  maxActiveSessions:number;
  maxCompletedResults:number;
  maxActiveRequests:number;
  maxBufferedRequestBytes:number;
  maxCompletedResultBytes:number;
  completedResultTtlMs:number;
}

export interface TeeRecorderReadiness {
  mode:'tee-recorder';ready:boolean;draining:boolean;
  active_sessions:number;pending_opens:number;completed_results:number;
  active_requests:number;buffered_request_bytes:number;completed_result_bytes:number;
  limits:TeeRecorderCapacity;
}

export interface TeeRecorderControl {
  readiness:()=>TeeRecorderReadiness;
  drain:()=>TeeRecorderReadiness;
  resume:()=>TeeRecorderReadiness;
  whenDrained:()=>Promise<void>;
}

export type TeeRecorderServer=Server&{recorder:TeeRecorderControl};

const DEFAULT_CAPACITY:TeeRecorderCapacity={
  // Keep the historical admission default. The scaling plan's eight-session
  // candidate is an explicit deployment setting until it has measured support.
  maxActiveSessions:16,
  maxCompletedResults:16,
  maxActiveRequests:32,
  maxBufferedRequestBytes:128*1024*1024,
  maxCompletedResultBytes:128*1024*1024,
  completedResultTtlMs:300_000
};

type Proxy=Awaited<ReturnType<typeof startCaptureProxy>>;
type Session={key:Buffer;proxy:Proxy;capture_id:string;consent_hash:string;expires:number;seen:Set<string>;closing:boolean;incremental:boolean;checkpoints:boolean;authorization:any;authorized_at:number;records:Map<string,any>};
type Completed={key:Buffer;capture_id:string;expires:number;seen:Set<string>;resultJson:string;bytes:number};
type JsonBody={value:any;release:()=>void};

function capacityOptions(value:Partial<TeeRecorderCapacity>|undefined):TeeRecorderCapacity {
  const limits={...DEFAULT_CAPACITY,...value};
  for(const key of Object.keys(limits) as (keyof TeeRecorderCapacity)[]){
    const n=limits[key];
    if(!Number.isSafeInteger(n)||n<0||(key!=='maxCompletedResults'&&n===0))throw Error('INVALID_RECORDER_CAPACITY');
  }
  return limits;
}

// The normal channel encoder stringifies its value. Finished results keep the
// exact JSON once, so retries neither retain a second object graph nor stringify
// a potentially large legacy bundle again. This is byte-for-byte the same
// AES-GCM channel construction and AAD domain used by encrypt().
function encryptJson(key:Buffer,json:string,aad:string){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes=Buffer.concat([cipher.update(json),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
}

export async function createTeeRecorder(options:{authorize:(capture:any)=>Promise<any>;quote?:typeof getQuote;transport?:typeof fetch;capacity?:Partial<TeeRecorderCapacity>}):Promise<TeeRecorderServer>{
  const limits=capacityOptions(options.capacity);
  const signing=generateKeyPairSync('ed25519'),channel=generateKeyPairSync('x25519');
  const statement={purpose:'thot.tee-recorder-key/1',signing_key:publicDer(signing.publicKey),channel_key:publicDer(channel.publicKey)};
  // No dev-mode quote fallback: this process cannot serve without its hardware quote.
  const attestation=await (options.quote??getQuote)(statement);
  const sessions=new Map<string,Session>(),completed=new Map<string,Completed>(),captures=new Set<string>();
  const drainWaiters=new Set<()=>void>();
  let pendingOpens=0,activeRequests=0,bufferedRequestBytes=0,completedResultBytes=0,draining=false,stopped=false;

  const accepting=()=>!draining&&!stopped&&pendingOpens+sessions.size<limits.maxActiveSessions&&activeRequests<limits.maxActiveRequests&&bufferedRequestBytes<limits.maxBufferedRequestBytes;
  const notifyDrained=(force=false)=>{if(force||(pendingOpens===0&&sessions.size===0&&activeRequests===0)){for(const resolve of drainWaiters)resolve();drainWaiters.clear();}};
  const removeCompleted=(id:string,value:Completed)=>{if(completed.get(id)!==value)return;completed.delete(id);completedResultBytes-=value.bytes;captures.delete(value.capture_id);};
  const pruneCompleted=()=>{const now=Date.now();for(const [id,value]of completed)if(value.expires<=now)removeCompleted(id,value);};
  const readiness=():TeeRecorderReadiness=>{pruneCompleted();return {mode:'tee-recorder',ready:accepting(),draining:draining||stopped,active_sessions:sessions.size,pending_opens:pendingOpens,completed_results:completed.size,active_requests:activeRequests,buffered_request_bytes:bufferedRequestBytes,completed_result_bytes:completedResultBytes,limits:{...limits}};};
  const retainCompleted=(id:string,value:Completed)=>{
    pruneCompleted();
    while(completed.size>=limits.maxCompletedResults||completedResultBytes+value.bytes>limits.maxCompletedResultBytes){
      const oldest=completed.entries().next().value as [string,Completed]|undefined;
      if(!oldest)break;
      removeCompleted(oldest[0],oldest[1]);
    }
    if(limits.maxCompletedResults===0||value.bytes>limits.maxCompletedResultBytes||value.expires<=Date.now()){captures.delete(value.capture_id);return;}
    completed.set(id,value);completedResultBytes+=value.bytes;
  };
  const finishProxy=(session:Session)=>session.incremental?session.proxy.finishManifest():session.proxy.finish();
  const expireSession=(id:string,session:Session)=>{
    if(sessions.get(id)!==session)return;
    sessions.delete(id);captures.delete(session.capture_id);session.closing=true;notifyDrained();
    void finishProxy(session).catch(()=>{});
  };

  async function json(req:IncomingMessage,limit=64*1024):Promise<JsonBody>{
    const raw=req.headers['content-length'];
    if(Array.isArray(raw))throw Error('LIMIT');
    let declared:number|undefined;
    if(raw!==undefined){declared=Number(raw);if(!Number.isSafeInteger(declared)||declared<0)throw Error('LIMIT');}
    if((declared??0)>limit){req.resume();throw Error('LIMIT');}
    let reserved=0,released=false;
    const reserve=(bytes:number)=>{if(bufferedRequestBytes+bytes>limits.maxBufferedRequestBytes)throw Error('RECORDER_BUSY');bufferedRequestBytes+=bytes;reserved+=bytes;};
    try{
      if(declared)reserve(declared);
      let bytes=0;const chunks:Buffer[]=[];
      for await(const chunk of req){
        bytes+=chunk.length;
        if(bytes>limit){req.resume();throw Error('LIMIT');}
        if(bytes>reserved)reserve(bytes-reserved);
        chunks.push(Buffer.from(chunk));
      }
      // Let already-admitted requests and health/drain inspection run before a
      // large synchronous parse. Admission bounds how many such parses/buffers
      // can be resident at once; JSON.parse itself remains a Node synchronous API.
      await new Promise<void>(resolve=>setImmediate(resolve));
      const value=JSON.parse(Buffer.concat(chunks).toString());
      return {value,release:()=>{if(!released){released=true;bufferedRequestBytes-=reserved;}}};
    }catch(error){bufferedRequestBytes-=reserved;released=true;throw error;}
  }

  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const reply=(code:number,value:unknown)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const replyData=(data:string)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{"data":"');res.write(data);res.end('"}');};
    let body:JsonBody|undefined,requestReserved=false;
    try {
      const url=new URL(req.url??'/','http://recorder');
      if(req.method==='GET'&&url.pathname==='/health'){const state=readiness();return reply(state.ready?200:503,state);}
      if(req.method==='GET'&&url.pathname==='/attestation')return reply(200,attestation);
      if(req.method!=='POST'||req.headers.origin||req.headers['sec-fetch-site'])return reply(404,{error:'NOT_FOUND'});

      if(url.pathname==='/sessions'){
        if(!accepting())throw Error('RECORDER_BUSY');
        // This synchronous reservation is made before the first body/auth await.
        pendingOpens++;
        let captureId:string|undefined,openedId:string|undefined,proxy:Proxy|undefined,proxyIncremental=false,captureReserved=false,adopted=false;
        try{
          body=await json(req);
          const input=body.value,key=channelKey(channel.privateKey,input.peer),v=decrypt(key,input.data,'open:'+input.nonce);
          if(!/^[a-zA-Z0-9-]{16,80}$/.test(v.capture_id)||!['codex','claude'].includes(v.client)||typeof v.upload_token!=='string')throw Error('INVALID_SESSION');
          const requestedCaptureId:string=v.capture_id;captureId=requestedCaptureId;
          if(captures.has(requestedCaptureId))throw Error('CAPTURE_AUTHORIZATION_REJECTED');
          // Reserve the capture identity across authorization and proxy startup.
          captures.add(requestedCaptureId);captureReserved=true;
          const binding=await options.authorize(v);
          if(binding.capture_id!==v.capture_id||binding.client!==v.client||binding.status!=='AWAITING_UPLOAD'||Date.parse(binding.expires_at)<=Date.now())throw Error('CAPTURE_AUTHORIZATION_REJECTED');
          const incremental=v.incremental===true,records=new Map<string,any>();proxyIncremental=incremental;
          proxy=await startCaptureProxy({client:v.client,captureId:v.capture_id,incremental,transport:options.transport,onExchange:(record,tag)=>{if(incremental)records.set(tag,record);}});
          if(stopped||res.destroyed)throw Error('RECORDER_BUSY');
          const id=randomBytes(24).toString('hex');openedId=id;
          const opened=encrypt(key,{id,checkpoints:v.checkpoints===true},'opened:'+input.nonce);
          sessions.set(id,{key,proxy,capture_id:v.capture_id,consent_hash:binding.consent_hash,expires:Math.min(Date.parse(binding.expires_at),Date.now()+4*3600_000),seen:new Set(),closing:false,incremental,checkpoints:v.checkpoints===true,authorization:v,authorized_at:Date.now(),records});
          replyData(opened);adopted=true;
          return;
        }finally{
          pendingOpens--;
          if(!adopted){
            if(openedId)sessions.delete(openedId);
            if(captureReserved&&captureId)captures.delete(captureId);
            if(proxy)await (proxyIncremental?proxy.finishManifest():proxy.finish()).catch(()=>{});
          }
          notifyDrained();
        }
      }

      const match=/^\/sessions\/([a-f0-9]{48})\/(relay|finish)$/.exec(url.pathname);
      if(!match)return reply(404,{error:'NOT_FOUND'});
      pruneCompleted();
      const id=match[1],action=match[2],session=sessions.get(id),saved=completed.get(id);
      if(session&&session.expires<=Date.now()){expireSession(id,session);throw Error('SESSION_EXPIRED');}
      if(saved&&saved.expires<=Date.now()){removeCompleted(id,saved);throw Error('SESSION_EXPIRED');}
      if(!session&&!saved)throw Error('SESSION_EXPIRED');
      if(action==='relay'&&!session)throw Error('SESSION_CLOSED');
      if(action==='relay'){
        if(activeRequests>=limits.maxActiveRequests)throw Error('RECORDER_BUSY');
        activeRequests++;requestReserved=true;
      }
      // Large envelopes are accepted only for a previously authorized relay session.
      // Handshake and finish requests keep the small request-body budget.
      body=await json(req,action==='relay'?CAPTURE_RELAY_JSON_BYTES:undefined);
      const input=body.value,owner=session??saved!,nonce=input.nonce;
      if(!/^[a-f0-9]{32}$/.test(nonce)||owner.seen.has(nonce)||owner.seen.size>=CAPTURE_MAX_EXCHANGES*3)throw Error('REPLAY_OR_LIMIT');
      const v=decrypt(owner.key,input.data,action+':'+id+':'+nonce,action==='relay'?CAPTURE_RELAY_JSON_BYTES:undefined);owner.seen.add(nonce);

      if(action==='finish'){
        if(saved){replyData(encryptJson(saved.key,saved.resultJson,'finished:'+id+':'+nonce));return;}
        if(session!.closing)throw Error('FINISH_PENDING');
        session!.closing=true;
        const bundle=session!.incremental?await session!.proxy.finishManifest():await session!.proxy.finish();
        const seal={purpose:'thot.tee-capture-seal/1',capture_id:session!.capture_id,client:bundle.client,consent_hash:session!.consent_hash,bundle_hash:canonicalHash(bundle),session_root:bundle.root};
        const result={bundle,evidence:{statement:seal,signature:sign(null,Buffer.from(canonicalJson(seal)),signing.privateKey).toString('base64'),attestation}};
        await new Promise<void>(resolve=>setImmediate(resolve));
        const resultJson=JSON.stringify(result),bytes=Buffer.byteLength(resultJson),expires=Math.min(session!.expires,Date.now()+limits.completedResultTtlMs);
        if(sessions.get(id)===session)sessions.delete(id);
        retainCompleted(id,{key:session!.key,capture_id:session!.capture_id,expires,seen:session!.seen,resultJson,bytes});
        notifyDrained();
        replyData(encryptJson(session!.key,resultJson,'finished:'+id+':'+nonce));
        return;
      }

      if(session!.closing)throw Error('SESSION_CLOSED');
      if(Date.now()-session!.authorized_at>=30000){
        const binding=await options.authorize(session!.authorization);
        if(binding.capture_id!==session!.capture_id||binding.status!=='AWAITING_UPLOAD'||binding.consent_hash!==session!.consent_hash||Date.parse(binding.expires_at)<=Date.now())throw Error('CAPTURE_AUTHORIZATION_REJECTED');
        session!.authorized_at=Date.now();
      }
      const base=session!.proxy.baseUrl.replace(/\/backend-api\/codex$/,'');
      if(typeof v.path!=='string'||!v.path.startsWith('/')||v.path.startsWith('//')||v.path.includes('#'))throw Error('INVALID_PATH');
      // The inner fixed-upstream proxy validates methods/paths and strips authorization from evidence.
      const response=await fetch(base+v.path,{method:v.method,headers:{...v.headers,'x-thot-recorder-request':nonce},...(v.method==='POST'?{body:Buffer.from(v.body,'base64')}:{}),redirect:'error',signal:AbortSignal.timeout(310_000)});
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.flushHeaders();let index=0;
      const frame=async(value:unknown)=>{
        const line=JSON.stringify({data:encrypt(session!.key,value,'response:'+id+':'+nonce+':'+index++)})+'\n';
        if(res.destroyed)throw Error('CHANNEL_CLOSED');
        if(!res.write(line))await new Promise<void>(resolve=>{
          const done=()=>{res.off('drain',done);res.off('close',done);resolve();};
          res.once('drain',done);res.once('close',done);
        });
      };
      await frame({type:'headers',status:response.status,headers:Object.fromEntries(response.headers)});
      try{
        if(response.body)for await(const chunk of response.body)await frame({type:'chunk',body:Buffer.from(chunk).toString('base64')});
      }catch{if(!session!.incremental)throw Error('RELAY_INTERRUPTED');}
      const recorded=session!.records.get(nonce);session!.records.delete(nonce);
      if(session!.incremental&&recorded){
        const {request_body_b64,...part}=recorded;
        const bundle=session!.checkpoints?session!.proxy.checkpointManifest():undefined;
        let checkpoint;
        if(bundle){const seal={purpose:'thot.tee-capture-seal/1',capture_id:session!.capture_id,client:bundle.client,consent_hash:session!.consent_hash,bundle_hash:canonicalHash(bundle),session_root:bundle.root};checkpoint={bundle,evidence:{statement:seal,signature:sign(null,Buffer.from(canonicalJson(seal)),signing.privateKey).toString('base64'),attestation}};}
        await frame({type:'part',record:part,...(checkpoint?{checkpoint}:{})});
      }
      await frame({type:'end'});res.end();
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const code=['CAPTURE_AUTHORIZATION_REJECTED','CAPTURE_AUTHORIZATION_UNAVAILABLE','RECORDER_BUSY'].includes(message)?message:'RECORDER_REQUEST_REJECTED';
      if(!res.headersSent)reply(code==='RECORDER_BUSY'?429:400,{error:code});else res.destroy();
    }finally{
      body?.release();
      if(requestReserved){activeRequests--;notifyDrained();}
    }
  }) as TeeRecorderServer;

  const control:TeeRecorderControl={
    readiness,
    drain(){draining=true;return readiness();},
    resume(){if(!stopped)draining=false;return readiness();},
    whenDrained(){if(stopped||(pendingOpens===0&&sessions.size===0&&activeRequests===0))return Promise.resolve();return new Promise<void>(resolve=>drainWaiters.add(resolve));}
  };
  Object.defineProperty(server,'recorder',{value:Object.freeze(control),enumerable:true});
  server.requestTimeout=330_000;server.headersTimeout=15_000;
  const cleanup=setInterval(()=>{
    for(const [id,session]of sessions)if(session.expires<=Date.now())expireSession(id,session);
    pruneCompleted();
  },60_000).unref();
  server.once('close',()=>{
    clearInterval(cleanup);stopped=true;draining=true;
    for(const [id,session]of sessions)expireSession(id,session);
    for(const [id,value]of completed)removeCompleted(id,value);
    notifyDrained(true);
  });
  return server;
}
