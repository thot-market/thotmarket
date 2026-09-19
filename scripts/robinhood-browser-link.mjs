// Local-only companion: browser authentication stays in this process and the
// private Python stdin pipe. stdout contains progress and signed public proof only.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

let context, activePython, stopped=false;
const emit=value=>new Promise(resolve=>process.stdout.write(JSON.stringify(value)+'\n',resolve));
const failureCodes=new Set(['BROWSER_CLOSED','BROWSER_LOGIN_TIMEOUT','BROWSER_START_FAILED','APPRAISER_IDENTITY_INVALID','CAPTURE_OR_APPRAISAL_FAILED','INVALID_LINK_TICKET','INVALID_OUTCOME_REQUEST','INVALID_ORDERS_SCHEMA','APPRAISAL_HTTP_REJECTED','APPRAISAL_SCHEMA_REJECTED','APPRAISAL_TLS_REJECTED','APPRAISAL_WITNESS_REJECTED','CAPTURE_FAILED']);
async function failed(code){await emit({error:failureCodes.has(code)?code:'CAPTURE_FAILED'});await stop(1);}
async function stop(code=0){
  if(stopped)return;stopped=true;
  activePython?.kill('SIGKILL');
  await context?.close().catch(()=>{});
  process.exit(code);
}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>stop(1));
process.on('uncaughtException',()=>stop(1));
process.on('unhandledRejection',()=>stop(1));

async function input(){let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>64_000)throw Error('INVALID_CONFIG');}return JSON.parse(raw);}
function bridge(config,mode,token,trade){return new Promise((resolve,reject)=>{
  const child=spawn(config.python_executable,[config.bridge_path,mode],{stdio:['pipe','pipe','pipe'],shell:false});activePython=child;
  let raw='',diagnostic='',finished=false;
  const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(activePython===child)activePython=null;
    if(error){child.kill('SIGKILL');let code;try{code=JSON.parse(diagnostic).error;}catch{}reject(Error(failureCodes.has(code)?code:'CAPTURE_FAILED'));return;}
    try{resolve(JSON.parse(raw));}catch{reject(Error('INVALID_PROOF'));}
  };
  const timer=setTimeout(()=>done(true),120_000);
  child.on('error',()=>done(true));child.stdin.on('error',()=>done(true));child.stderr.on('data',chunk=>{if(diagnostic.length<1024)diagnostic+=chunk.toString().slice(0,1024-diagnostic.length);});
  child.stdout.on('data',chunk=>{raw+=chunk;if(Buffer.byteLength(raw)>1_000_000)done(true);});
  child.on('close',code=>done(code!==0));
  const payload={link_ticket:config.link_ticket,witness_url:config.witness_url,appraiser_url:config.appraiser_url,
    thot_public_key_pem:config.thot_public_key_pem,measurements:config.measurements,dcap_qvl:config.dcap_qvl,...(token?{token}:{}),...(trade?{purpose:'traded',request:trade}:{})};
  child.stdin.end(JSON.stringify(payload));
});}

async function main(){
  const config=await input();
  for(const key of ['python_executable','bridge_path','browser_executable','profile_dir','measurements','dcap_qvl'])if(typeof config[key]!=='string'||!isAbsolute(config[key]))throw Error('INVALID_CONFIG');
  const traded=config.purpose==='traded';
  if(traded){const r=config.request;if(!r||typeof r.symbol!=='string'||!/^[A-Za-z0-9._-]{1,32}$/.test(r.symbol)||!Number.isInteger(r.window_days)||r.window_days<1||r.window_days>365||typeof r.trace_ts!=='string')throw Error('INVALID_CONFIG');}
  if((await bridge(config,'preflight')).ready!==true)throw Error('PREFLIGHT_FAILED');
  await mkdir(config.profile_dir,{recursive:true,mode:0o700});
  const stat=await lstat(config.profile_dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('INVALID_PROFILE');
  await chmod(config.profile_dir,0o700);
  context=await chromium.launchPersistentContext(config.profile_dir,{
    executablePath:config.browser_executable,headless:false,viewport:null,acceptDownloads:false,
    chromiumSandbox:true,ignoreDefaultArgs:['--enable-automation'],
    args:['--no-first-run','--disable-extensions','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port=18770'],
  });
  context.on('close',()=>{if(!stopped)failed('BROWSER_CLOSED');});
  let capturing=false;
  context.on('response',async response=>{
    if(capturing||stopped||response.status()!==200)return;
    const request=response.request(),url=new URL(request.url());
    if(url.protocol!=='https:'||url.hostname!=='api.robinhood.com'||request.method()!=='GET')return;
    let authorization=await request.headerValue('authorization');
    if(capturing||!authorization||!/^Bearer [A-Za-z0-9._~-]{16,16384}$/.test(authorization))return;
    capturing=true;emit({stage:'capturing'});
    try{
      const proof=await bridge(config,traded?'capture-traded':'capture',authorization.slice(7),traded?config.request:undefined);authorization=null;
      if(stopped)return;
      if(!proof?.credential||!Array.isArray(proof.witness_receipts)||Object.keys(proof).some(k=>!['credential','witness_receipts'].includes(k)))throw Error('INVALID_PROOF');
      await emit({stage:'verifying'});await emit({evidence:proof});await stop(0);
    }catch(error){authorization=null;await failed(error.message);}
  });
  const page=context.pages()[0]??await context.newPage();
  await page.goto('https://robinhood.com/login',{waitUntil:'domcontentloaded',timeout:45_000});
  if(!capturing)emit({stage:'awaiting_browser_login'});
  setTimeout(()=>failed('BROWSER_LOGIN_TIMEOUT'),9*60_000).unref();
}
main().catch(error=>failed(error.message));
