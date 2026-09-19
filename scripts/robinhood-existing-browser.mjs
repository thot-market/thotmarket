// One active, owner-bound account check. Only this local companion receives the
// browser token; the THOT API receives signed public evidence, never credentials.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
let child,server,stopping=false,claimed=false,extensionSeen=false;
const emit=value=>new Promise(resolve=>process.stdout.write(JSON.stringify(value)+'\n',resolve));
async function stop(code=0){if(stopping)return;stopping=true;child?.kill('SIGKILL');server?.closeAllConnections();server?.close();process.exit(code);}
const codes=new Set(['APPRAISER_IDENTITY_INVALID','CAPTURE_OR_APPRAISAL_FAILED','INVALID_LINK_TICKET','INVALID_OUTCOME_REQUEST','INVALID_ORDERS_SCHEMA','APPRAISAL_HTTP_REJECTED','APPRAISAL_SCHEMA_REJECTED','APPRAISAL_TLS_REJECTED','APPRAISAL_WITNESS_REJECTED','CAPTURE_FAILED']);
async function fail(error){await emit({error:codes.has(error?.message)?error.message:'CAPTURE_FAILED'});await stop(1);}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>stop(1));
process.on('uncaughtException',()=>fail());process.on('unhandledRejection',()=>fail());
async function read(stream,limit){let raw='';for await(const chunk of stream){raw+=chunk;if(Buffer.byteLength(raw)>limit)throw Error('INPUT_LIMIT');}return JSON.parse(raw);}
function bridge(config,mode,token,trade){return new Promise((resolve,reject)=>{
  child=spawn(config.python_executable,[config.bridge_path,mode],{shell:false,stdio:['pipe','pipe','pipe']});const current=child;
  let output='',diagnostic='',finished=false;
  const done=error=>{if(finished)return;finished=true;clearTimeout(timer);if(child===current)child=null;
    if(error){current.kill('SIGKILL');let parsed;try{parsed=JSON.parse(diagnostic).error;}catch{}reject(Error(codes.has(parsed)?parsed:'CAPTURE_FAILED'));return;}
    try{resolve(JSON.parse(output));}catch{reject(Error('CAPTURE_FAILED'));}};
  const timer=setTimeout(()=>done(true),120_000);
  current.on('error',()=>done(true));current.stdin.on('error',()=>done(true));current.on('close',code=>done(code!==0));
  current.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1_000_000)done(true);});
  current.stderr.on('data',chunk=>{if(diagnostic.length<1024)diagnostic+=chunk.toString().slice(0,1024-diagnostic.length);});
  current.stdin.end(JSON.stringify({link_ticket:config.link_ticket,witness_url:config.witness_url,appraiser_url:config.appraiser_url,thot_public_key_pem:config.thot_public_key_pem,measurements:config.measurements,dcap_qvl:config.dcap_qvl,...(token?{token}:{}),...(trade?{purpose:'traded',request:trade}:{})}));
});}
async function main(){
  const config=await read(process.stdin,64_000),local=config.extension_bridge;
  if(!local||!Number.isInteger(local.port)||local.port<1024||local.port>65535||!/^[a-f0-9]{64}$/.test(local.capability)||!/^chrome-extension:\/\/[a-p]{32}$/.test(local.origin))throw Error('INVALID_CONFIG');
  for(const key of ['python_executable','bridge_path','measurements','dcap_qvl'])if(!isAbsolute(config[key]??''))throw Error('INVALID_CONFIG');
  const traded=config.purpose==='traded';
  if(traded){const r=config.request;if(!r||typeof r.symbol!=='string'||!/^[A-Za-z0-9._-]{1,32}$/.test(r.symbol)||!Number.isInteger(r.window_days)||r.window_days<1||r.window_days>365||typeof r.trace_ts!=='string')throw Error('INVALID_CONFIG');}
  if((await bridge(config,'preflight')).ready!==true)throw Error('APPRAISER_IDENTITY_INVALID');
  server=createServer(async(req,res)=>{
    const respond=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':local.origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});res.end(JSON.stringify(body));};
    if(req.headers.host!==`127.0.0.1:${local.port}`||(req.headers.origin&&req.headers.origin!==local.origin))return respond(403,{error:'FORBIDDEN'});
    if(![`/${local.capability}/ready`,`/${local.capability}/capture`].includes(req.url))return respond(404,{error:'NOT_FOUND'});
    if(req.method==='OPTIONS')return respond(200,{});
    if(req.method==='GET'&&req.url.endsWith('/ready')){if(config.report_extension_ready&&!extensionSeen&&!claimed){extensionSeen=true;await emit({stage:'awaiting_account_request'});}return respond(200,{ready:!claimed&&!stopping});}
    if(req.method!=='POST'||!req.url.endsWith('/capture')||req.headers['content-type']!=='application/json')return respond(400,{error:'INVALID_REQUEST'});
    if(claimed)return respond(409,{error:'ALREADY_CLAIMED'});
    try{
      let body=await read(req,20_000);
      if(Object.keys(body).length!==1||typeof body.token!=='string'||!/^[A-Za-z0-9._~+\/-]{16,16384}={0,2}$/.test(body.token))return respond(400,{error:'INVALID_REQUEST'});
      if(claimed)return respond(409,{error:'ALREADY_CLAIMED'});
      claimed=true;respond(202,{accepted:true});await emit({stage:'capturing'});
      const pending=bridge(config,traded?'capture-traded':'capture',body.token,traded?config.request:undefined);body=null;const evidence=await pending;
      if(!evidence?.credential||!Array.isArray(evidence.witness_receipts)||Object.keys(evidence).some(k=>!['credential','witness_receipts'].includes(k)))throw Error('INVALID_PROOF');
      await emit({stage:'verifying'});await emit({evidence});await stop(0);
    }catch(error){if(!res.headersSent)respond(400,{error:'INVALID_REQUEST'});if(claimed)await fail(error);}
  });
  server.requestTimeout=10_000;server.headersTimeout=5_000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(local.port,'127.0.0.1',resolve);});
  await emit({stage:'awaiting_browser_login'});
  setTimeout(()=>stop(1),9*60_000).unref();
}
main().catch(fail);
