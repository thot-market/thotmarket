import {createServer} from 'node:http';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {publicDer,channelKey,encrypt,decrypt} from './channel.ts';
import {canonicalHash} from '../../../protocol/src/canonical.ts';
import type {CaptureTiming} from '../timing.ts';
import {CAPTURE_REQUEST_BYTES} from '../limits.ts';
import {verifyRecorder,verifySeal,type RecorderPolicy} from './attestation.ts';
export async function startTeeCapture(options:{client:'codex'|'claude';captureId:string;uploadToken:string;policy:RecorderPolicy;onTiming?:CaptureTiming;onPart?:(part:any)=>Promise<void>;onCheckpoint?:(checkpoint:any)=>Promise<void>;onState?:(state:'recording'|'interrupted',detail?:string)=>void},verifyIdentity:(attestation:any,policy:RecorderPolicy)=>Promise<unknown>=verifyRecorder,transport:typeof fetch=fetch){
 const timing=options.onTiming??(()=>{});let requestSequence=0;
 const origin=new URL(options.policy.url);if(origin.protocol!=='https:'||origin.pathname!=='/')throw Error('INVALID_RECORDER_URL');
 const attRes=await transport(origin.origin+'/attestation',{redirect:'error',signal:AbortSignal.timeout(30_000)});if(!attRes.ok)throw Error('RECORDER_UNAVAILABLE');
 const attestation=await attRes.json();timing('attestation_received');await verifyIdentity(attestation,options.policy);timing('attestation_verified');
 const pair=generateKeyPairSync('x25519'),key=channelKey(pair.privateKey,(attestation as any).statement.channel_key),nonce=randomBytes(16).toString('hex');
 const open=await transport(origin.origin+'/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({peer:publicDer(pair.publicKey),nonce,data:encrypt(key,{capture_id:options.captureId,client:options.client,upload_token:options.uploadToken,incremental:!!options.onPart,checkpoints:!!options.onCheckpoint},'open:'+nonce)}),redirect:'error',signal:AbortSignal.timeout(30_000)});
 if(!open.ok){const body=await open.json().catch(()=>({})) as any;throw Error(['CAPTURE_AUTHORIZATION_REJECTED','CAPTURE_AUTHORIZATION_UNAVAILABLE','RECORDER_BUSY'].includes(body.error)?body.error:'TEE_SESSION_REJECTED');}const {id,checkpoints}=decrypt(key,(await open.json() as any).data,'opened:'+nonce);
 if(options.onCheckpoint&&checkpoints!==true)throw Error('RECORDER_CHECKPOINTS_REQUIRED');
 if(!/^[a-f0-9]{48}$/.test(id))throw Error('INVALID_TEE_SESSION');
 const secret=randomBytes(24).toString('hex');let closed=false;const tasks=new Set<Promise<void>>();
 const server=createServer((req,res)=>{const work=(async()=>{
  const addr=server.address(),host=addr&&typeof addr!=='string'?'127.0.0.1:'+addr.port:'';
  if(closed||req.headers.host!==host||req.headers.origin||req.headers['sec-fetch-site']||!req.url?.startsWith('/r/'+secret+'/')){res.writeHead(403);res.end();return;}
  const path=req.url.slice(('/r/'+secret).length),chunks:Buffer[]=[];let bytes=0;
  const requestLimit=options.onPart?CAPTURE_REQUEST_BYTES:4_000_000;
  if(Number(req.headers['content-length']??0)>requestLimit){req.resume();res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"THOT_CAPTURE_REQUEST_TOO_LARGE"}');options.onState?.('interrupted','THOT_CAPTURE_REQUEST_TOO_LARGE');return;}
  let oversized=false;
  for await(const c of req){bytes+=c.length;if(bytes>requestLimit){oversized=true;chunks.length=0;}else if(!oversized)chunks.push(c);}
  if(oversized){res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"THOT_CAPTURE_REQUEST_TOO_LARGE"}');options.onState?.('interrupted','THOT_CAPTURE_REQUEST_TOO_LARGE');return;}
  const requestBody=Buffer.concat(chunks);const sequence=++requestSequence;timing('request_buffered',{sequence,bytes:requestBody.length});
  const requestNonce=randomBytes(16).toString('hex'),headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
  timing('relay_begin',{sequence});
  const response=await transport(origin.origin+'/sessions/'+id+'/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:requestNonce,data:encrypt(key,{path,method:req.method,headers,body:requestBody.toString('base64')},'relay:'+id+':'+requestNonce)}),redirect:'error',signal:AbortSignal.timeout(330_000)});
  if(!response.ok||!response.body)throw Error('TEE_RELAY_REJECTED');let buffer='',index=0,ended=false,recorded=false,firstChunk=true;
  for await(const chunk of response.body){buffer+=Buffer.from(chunk).toString();if(buffer.length>24_000_000)throw Error('FRAME_LIMIT');let newline;
   while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);const frame=decrypt(key,JSON.parse(line).data,'response:'+id+':'+requestNonce+':'+index++);
    if(ended)throw Error('FRAME_AFTER_END');
    if(frame.type==='headers'&&index===1){for(const [k,v]of Object.entries(frame.headers))if(!['content-length','content-encoding','transfer-encoding','connection','set-cookie'].includes(k))res.setHeader(k,String(v));res.writeHead(frame.status);res.flushHeaders();timing('response_headers',{sequence,status:frame.status});}
    else if(frame.type==='chunk'&&index>1){if(firstChunk){timing('first_stream_chunk',{sequence});firstChunk=false;}if(!res.destroyed)res.write(Buffer.from(frame.body,'base64'));}
    else if(frame.type==='part'&&index>1&&options.onPart&&!recorded){
      const part={...frame.record,request_body_b64:requestBody.toString('base64')};const {commitment,...record}=part;
      if(canonicalHash(record)!==commitment)throw Error('CAPTURE_PART_COMMITMENT_MISMATCH');
      recorded=true;timing('response_recorded',{sequence,part_sequence:part.sequence,model_request:Number(/^\/(v1\/messages|backend-api\/codex\/responses)(\?|$|\/)/.test(path))});await options.onPart(part);timing('part_local_saved',{sequence});
      if(options.onCheckpoint&&frame.checkpoint){const checkpoint=frame.checkpoint;if(JSON.stringify(checkpoint.evidence.attestation)!==JSON.stringify(attestation))throw Error('RECORDER_IDENTITY_CHANGED');verifySeal(checkpoint.bundle,checkpoint.evidence,options.captureId);await options.onCheckpoint(checkpoint);timing('checkpoint_local_saved',{sequence});}
      if(!part.complete)options.onState?.('interrupted','An upstream response ended early; earlier exchanges are retained.');
    }
    else if(frame.type==='end'&&index>1){ended=true;timing('response_end',{sequence});if(options.onPart&&!recorded&&/^\/(v1\/messages|backend-api\/codex\/responses)(\?|$|\/)/.test(path))options.onState?.('interrupted','A request was rejected before recording.');res.end();}else throw Error('INVALID_FRAME');
   }
  }
  if(!ended||buffer)throw Error('INCOMPLETE_TEE_RESPONSE');
 })();tasks.add(work);void work.catch((error)=>{options.onState?.('interrupted',error instanceof Error?error.message:'CAPTURE_INTERRUPTED');if(!res.headersSent){const limit=error instanceof Error&&error.message==='THOT_CAPTURE_REQUEST_TOO_LARGE';res.writeHead(limit?400:502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:limit?'THOT_CAPTURE_REQUEST_TOO_LARGE':'TEE_CAPTURE_INTERRUPTED'}));}else res.destroy();}).finally(()=>tasks.delete(work));});
 server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('BRIDGE_START_FAILED');
 return {baseUrl:'http://127.0.0.1:'+address.port+'/r/'+secret+(options.client==='codex'?'/backend-api/codex':''),async finish(){
  closed=true;const stop=new Promise<void>(resolve=>server.close(()=>resolve()));await Promise.allSettled([...tasks]);server.closeAllConnections();await stop;
  const nonce=randomBytes(16).toString('hex');const response=await transport(origin.origin+'/sessions/'+id+'/finish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,data:encrypt(key,{},'finish:'+id+':'+nonce)}),redirect:'error',signal:AbortSignal.timeout(60_000)});
  if(!response.ok)throw Error('TEE_FINALIZE_FAILED');const result=decrypt(key,(await response.json() as any).data,'finished:'+id+':'+nonce);
  if(JSON.stringify(result.evidence.attestation)!==JSON.stringify(attestation))throw Error('RECORDER_IDENTITY_CHANGED');verifySeal(result.bundle,result.evidence,options.captureId);return result;
 }};
}
