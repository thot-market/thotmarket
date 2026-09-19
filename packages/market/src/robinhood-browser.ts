import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ensure, type Document } from '../../storage/src/index.ts';
import type { Actor } from './service.ts';
import type { RobinhoodLinks } from './robinhood-link.ts';

export interface RobinhoodBrowserConfig {
  nodeExecutable:string; scriptPath:string; pythonExecutable:string; bridgePath:string;
  browserExecutable:string; profileDir:string; measurementsPath:string; qvlPath:string;
  timeoutMs?:number; maxOutputBytes?:number;
  extensionBridge?:{port:number;capability:string;origin:string};
}
type Active={actorId:string;jobId:string;child:ChildProcessWithoutNullStreams;timer:NodeJS.Timeout;done:boolean;queue:Promise<void>};
const stages=new Set(['awaiting_browser_login','capturing','verifying']);

export class RobinhoodBrowserCoordinator {
  readonly links:RobinhoodLinks; readonly config?:RobinhoodBrowserConfig; private active?:Active;
  constructor(links:RobinhoodLinks,config?:RobinhoodBrowserConfig){
    this.links=links;this.config=config;
    if(config){
      for(const value of [config.nodeExecutable,config.scriptPath,config.pythonExecutable,config.bridgePath,config.browserExecutable,config.profileDir,config.measurementsPath,config.qvlPath])ensure(typeof value==='string'&&isAbsolute(value),'INVALID_ROBINHOOD_BROWSER_CONFIG');
      ensure(config.timeoutMs===undefined||(Number.isSafeInteger(config.timeoutMs)&&config.timeoutMs>=1_000&&config.timeoutMs<=600_000),'INVALID_ROBINHOOD_BROWSER_CONFIG');
      ensure(config.maxOutputBytes===undefined||(Number.isSafeInteger(config.maxOutputBytes)&&config.maxOutputBytes>=1_024&&config.maxOutputBytes<=1_000_000),'INVALID_ROBINHOOD_BROWSER_CONFIG');
      if(config.extensionBridge)ensure(Number.isInteger(config.extensionBridge.port)&&config.extensionBridge.port>=1024&&config.extensionBridge.port<=65535&&/^[a-f0-9]{64}$/.test(config.extensionBridge.capability)&&/^chrome-extension:\/\/[a-p]{32}$/.test(config.extensionBridge.origin),'INVALID_ROBINHOOD_BROWSER_CONFIG');
    }
  }
  capabilities(){return {browser_linking:!!this.config,...(!this.config?{reason:'The local browser-link companion is not configured.'}:{})};}
  private terminate(active:Active){
    if(active.done)return;active.done=true;clearTimeout(active.timer);
    const pid=active.child.pid;
    try{if(pid&&process.platform!=='win32')process.kill(-pid,'SIGTERM');else active.child.kill('SIGTERM');}catch{}
    setTimeout(()=>{try{if(pid&&process.platform!=='win32')process.kill(-pid,'SIGKILL');else active.child.kill('SIGKILL');}catch{}},1_000).unref();
    if(this.active===active)this.active=undefined;
  }
  private async fail(active:Active,code:string){
    if(active.done)return;this.terminate(active);
    try{await this.links.setBrowserStage({id:active.actorId,role:'user'},active.jobId,'failed',code);}catch{}
  }
  async start(actor:Actor,key:string,jobId:string){
    ensure(this.config,'ROBINHOOD_BROWSER_UNAVAILABLE',503);ensure(typeof key==='string'&&key.length>=8&&key.length<=160,'IDEMPOTENCY_KEY_REQUIRED');
    const ticket=await this.links.pendingTicket(actor,jobId);
    if(this.active){
      ensure(this.active.actorId===actor.id&&this.active.jobId===jobId,'ROBINHOOD_BROWSER_BUSY',409);
      return this.links.get(actor,jobId);
    }
    const remaining=Date.parse(ticket.expires_at)-Date.now();ensure(Number.isFinite(remaining)&&remaining>0,'LINK_NOT_PENDING',409);
    const timeout=Math.min(this.config.timeoutMs??600_000,remaining);
    const allowedEnv:NodeJS.ProcessEnv={};
    for(const name of ['DISPLAY','XAUTHORITY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','HOME','PATH','LANG'])if(process.env[name]!==undefined)allowedEnv[name]=process.env[name];
    const child=spawn(this.config.nodeExecutable,[this.config.scriptPath],{shell:false,detached:process.platform!=='win32',env:allowedEnv,stdio:['pipe','pipe','pipe']});
    const active:Active={actorId:actor.id,jobId,child,timer:setTimeout(()=>{},timeout),done:false,queue:Promise.resolve()};this.active=active;
    clearTimeout(active.timer);active.timer=setTimeout(()=>void this.fail(active,'ROBINHOOD_BROWSER_TIMEOUT'),timeout);active.timer.unref();
    let outputBytes=0,pending='',evidenceSeen=false;
    const consume=async(line:string)=>{
      if(active.done)return;
      let message:unknown;try{message=JSON.parse(line);}catch{throw new Error('ROBINHOOD_BROWSER_INVALID_OUTPUT');}
      ensure(message&&typeof message==='object'&&!Array.isArray(message),'ROBINHOOD_BROWSER_INVALID_OUTPUT');const record=message as Document;
      if(typeof record.error==='string'){
        ensure(Object.keys(record).length===1&&['BROWSER_CLOSED','BROWSER_LOGIN_TIMEOUT','BROWSER_START_FAILED','APPRAISER_IDENTITY_INVALID','CAPTURE_OR_APPRAISAL_FAILED','INVALID_LINK_TICKET','APPRAISAL_HTTP_REJECTED','APPRAISAL_SCHEMA_REJECTED','APPRAISAL_TLS_REJECTED','APPRAISAL_WITNESS_REJECTED','CAPTURE_FAILED'].includes(record.error),'ROBINHOOD_BROWSER_INVALID_OUTPUT');
        await this.fail(active,record.error);return;
      }
      if(typeof record.stage==='string'){
        ensure(Object.keys(record).length===1&&stages.has(record.stage)&&!evidenceSeen,'ROBINHOOD_BROWSER_INVALID_OUTPUT');
        await this.links.setBrowserStage(actor,jobId,record.stage);return;
      }
      ensure(Object.keys(record).length===1&&record.evidence&&typeof record.evidence==='object'&&!evidenceSeen,'ROBINHOOD_BROWSER_INVALID_OUTPUT');evidenceSeen=true;
      ensure(Object.keys(record.evidence).every((name:string)=>['credential','witness_receipts'].includes(name))&&record.evidence.credential&&Array.isArray(record.evidence.witness_receipts),'ROBINHOOD_BROWSER_INVALID_OUTPUT');
      await this.links.complete(actor,key+':complete',jobId,record.evidence);this.terminate(active);
    };
    child.stdout.on('data',chunk=>{
      if(active.done)return;outputBytes+=chunk.length;if(outputBytes>(this.config!.maxOutputBytes??1_000_000)){void this.fail(active,'ROBINHOOD_BROWSER_OUTPUT_LIMIT');return;}
      pending+=chunk.toString('utf8');const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines)if(line.trim())active.queue=active.queue.then(()=>consume(line)).catch(()=>this.fail(active,'ROBINHOOD_BROWSER_INVALID_OUTPUT'));
    });
    child.stderr.on('data',()=>{});
    child.on('error',()=>void this.fail(active,'ROBINHOOD_BROWSER_UNAVAILABLE'));
    child.on('close',()=>{active.queue=active.queue.then(async()=>{if(active.done)return;if(pending.trim())await consume(pending);if(!evidenceSeen)await this.fail(active,'ROBINHOOD_BROWSER_EXITED');}).catch(()=>this.fail(active,'ROBINHOOD_BROWSER_INVALID_OUTPUT'));});
    child.stdin.on('error',()=>void this.fail(active,'ROBINHOOD_BROWSER_UNAVAILABLE'));
    try{
      await this.links.setBrowserStage(actor,jobId,'awaiting_browser_login');
      child.stdin.end(JSON.stringify({link_ticket:ticket.link_ticket,witness_url:ticket.witness_url,appraiser_url:ticket.appraiser_url,thot_public_key_pem:this.links.publicKey,
        python_executable:this.config.pythonExecutable,bridge_path:this.config.bridgePath,browser_executable:this.config.browserExecutable,profile_dir:this.config.profileDir,measurements:this.config.measurementsPath,dcap_qvl:this.config.qvlPath,...(this.config.extensionBridge?{extension_bridge:this.config.extensionBridge}:{})})+'\n');
    }catch(error){this.terminate(active);throw error;}
    return this.links.get(actor,jobId);
  }
  async cancel(actor:Actor,key:string,jobId:string){
    await this.links.get(actor,jobId); // Establish ownership before touching the process group.
    if(this.active?.actorId===actor.id&&this.active.jobId===jobId)this.terminate(this.active);
    return this.links.cancel(actor,key,jobId);
  }
  async close(){const active=this.active;if(!active)return;await this.fail(active,'ROBINHOOD_BROWSER_STOPPED');await new Promise<void>(resolve=>{if(active.child.exitCode!==null||active.child.signalCode!==null)resolve();else{active.child.once('close',()=>resolve());setTimeout(resolve,2_000).unref();}});}
}
