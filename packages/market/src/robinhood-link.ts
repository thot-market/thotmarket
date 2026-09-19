import { createHash, createPrivateKey, createPublicKey, createHmac, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { canonicalHash, canonicalJson, uuidv7 } from '../../protocol/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';
import type { Actor, ThotService } from './service.ts';
import type { PrivacyIntegrations } from './integrations.ts';
import type { RobinhoodBrowserConfig } from './robinhood-browser.ts';

export interface RobinhoodConfig {
  verifierExecutable: string; verifierArgs: string[]; witnessUrl: string; appraiserUrl: string;
  timeoutMs?: number;
  /** Explicit opt-in to the bounded trade-proof CLI, separate from account control. */
  tradeVerifierArgs?: string[];
  browser?: RobinhoodBrowserConfig;
}
export type EvidenceVerifier = (evidence: Document, ticket: string) => Promise<Document>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const user=(actor:Actor)=>ensure(actor.role==='user','FORBIDDEN',403);

/** Only the operator's fixed verifier process receives signed public evidence, never session secrets. */
export function externalBrokerageVerifier(config:RobinhoodConfig,publicKey:string):EvidenceVerifier {
  ensure(isAbsolute(config.verifierExecutable)&&Array.isArray(config.verifierArgs)&&config.verifierArgs.every(a=>typeof a==='string'),'INVALID_ROBINHOOD_CONFIG');
  const timeout=config.timeoutMs??60_000;
  ensure(Number.isInteger(timeout)&&timeout>=1000&&timeout<=120_000,'INVALID_ROBINHOOD_CONFIG');
  return async(evidence,ticket)=>new Promise((resolve,reject)=>{
    const child=spawn(config.verifierExecutable,config.verifierArgs,{shell:false,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
    let output='',done=false;
    const finish=(error?:string)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(new Error(error));return;}
      try {const result=JSON.parse(output);ensure(result&&result.verified===true,'ROBINHOOD_EVIDENCE_REJECTED');resolve(result);}catch{reject(new Error('ROBINHOOD_EVIDENCE_REJECTED'));}};
    const timer=setTimeout(()=>finish('ROBINHOOD_VERIFIER_TIMEOUT'),timeout);
    child.on('error',()=>finish('ROBINHOOD_VERIFIER_UNAVAILABLE'));
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>64_000)finish('ROBINHOOD_VERIFIER_OUTPUT_LIMIT');});
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>finish('ROBINHOOD_VERIFIER_UNAVAILABLE'));
    child.on('close',code=>finish(code===0?undefined:'ROBINHOOD_EVIDENCE_REJECTED'));
    child.stdin.end(JSON.stringify({evidence,link_ticket:ticket,thot_public_key_pem:publicKey}));
  });
}

/** Durable job state lives in the owner-scoped user document, serialized by Database.command. */
export class RobinhoodLinks {
  readonly publicKey:string;
  private signingKey;
  private verifier?:EvidenceVerifier;
  readonly service:ThotService; readonly privacy:PrivacyIntegrations; readonly config?:RobinhoodConfig;
  constructor(service:ThotService,privacy:PrivacyIntegrations,masterKey:Buffer,config?:RobinhoodConfig,verifier?:EvidenceVerifier){
    this.service=service;this.privacy=privacy;this.config=config;
    const seed=createHmac('sha256',masterKey).update('thot-robinhood-link-ticket-v1').digest();
    this.signingKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),type:'pkcs8',format:'der'});
    this.publicKey=createPublicKey(this.signingKey).export({type:'spki',format:'pem'}).toString();
    if(config){for(const address of [config.witnessUrl,config.appraiserUrl]){const url=new URL(address);ensure(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,'INVALID_ROBINHOOD_CONFIG');}}
    this.verifier=verifier??(config?externalBrokerageVerifier(config,this.publicKey):undefined);
  }
  capabilities(){return {robinhood_linking:!!this.verifier,browser_linking:!!this.verifier&&!!this.config?.browser,browser_mode:this.config?.browser?.extensionBridge?'existing_chrome':'connection_window',...(!this.verifier?{reason:'Account verification is not configured on this device.'}:{}),link_issuer_public_key_pem:this.publicKey};}
  view(job:Document){return {job_id:job.job_id,...(job.connector?{connector:job.connector}:{}),status:job.status==='pending'&&Date.parse(job.expires_at)<=Date.parse(this.service.now())?'expired':job.status,stage:job.stage,expires_at:job.expires_at,...(job.credential_id?{credential_id:job.credential_id,verified_at:job.verified_at}:{}),...(job.error?{error:job.error}:{})};}
  async status(actor:Actor){user(actor);return this.service.db.transaction(async tx=>{
    const owner=await tx.get('users',actor.id,actor.id),jobs:Document[]=owner.robinhood_link_jobs??[],now=Date.parse(this.service.now());
    // A cancelled or failed later attempt must not hide a still-valid connection; an in-progress attempt takes precedence.
    const job=jobs.findLast(j=>j.status==='pending'&&Date.parse(j.expires_at)>now)??jobs.findLast(j=>j.status==='linked')??jobs.at(-1);
    if(!job)return {status:'not_linked'};
    if(job.status==='linked'){
      const row=await tx.get('credential_receipts',job.credential_id,actor.id);
      if((owner.revoked_receipts??[]).includes(job.credential_id))return {...this.view(job),status:'disconnected'};
      try{this.privacy.verifyCredential(row.receipt,actor.id);}catch{return {...this.view(job),status:'expired'};}
      return {...this.view(job),expires_at:row.receipt.valid_until,receipt:row.receipt,...(row.private_summary?{summary:row.private_summary}:{})};
    }return this.view(job);
  });}
  async begin(actor:Actor,key:string){user(actor);ensure(this.verifier,'ROBINHOOD_LINKING_UNAVAILABLE',503);
    return this.service.db.command(actor.id,key,{action:'robinhood.begin'},async tx=>{
      const owner=await tx.get('users',actor.id,actor.id),jobs:Document[]=owner.robinhood_link_jobs??[];
      ensure(!jobs.some(j=>j.status==='pending'&&Date.parse(j.expires_at)>Date.parse(this.service.now())),'LINK_ALREADY_PENDING',409);
      // Witness receipts record whole seconds; align challenges to that precision.
      const issued=Math.floor(Date.parse(this.service.now())/1000)*1000;
      const payload={schema_version:'thot.robinhood-link-ticket/1',job_id:uuidv7(),owner_user_id:actor.id,nonce:randomBytes(32).toString('hex'),issued_at:new Date(issued).toISOString(),expires_at:new Date(issued+600_000).toISOString(),audience:'trace-vault-robinhood'};
      const encoded=Buffer.from(canonicalJson(payload)).toString('base64url');
      const ticket=encoded+'.'+sign(null,Buffer.from(encoded),this.signingKey).toString('base64url');
      const job={...payload,status:'pending',stage:'awaiting_local_capture',ticket,ticket_hash:sha(ticket)};
      owner.robinhood_link_jobs=[...jobs.slice(-19),job];await tx.update('users',actor.id,owner);
      await tx.audit(actor.id,'RobinhoodLinkStarted',{job_id:job.job_id});
      return {...this.view(job),link_ticket:ticket,...(this.config?{witness_url:this.config.witnessUrl,appraiser_url:this.config.appraiserUrl}:{}),
        helper_command:'python3 trace-vault/link_capture.py --help'};
    });
  }
  async get(actor:Actor,id:string){user(actor);return this.service.db.transaction(async tx=>{
    const owner=await tx.get('users',actor.id,actor.id),job=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);ensure(job,'NOT_FOUND',404);return this.view(job);
  });}
  async pendingTicket(actor:Actor,id:string){user(actor);ensure(this.config&&this.verifier,'ROBINHOOD_LINKING_UNAVAILABLE',503);return this.service.db.transaction(async tx=>{
    const owner=await tx.get('users',actor.id,actor.id),job=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);
    ensure(job,'NOT_FOUND',404);ensure(job.status==='pending'&&Date.parse(job.expires_at)>Date.parse(this.service.now()),'LINK_NOT_PENDING',409);
    return {link_ticket:job.ticket,witness_url:this.config!.witnessUrl,appraiser_url:this.config!.appraiserUrl,expires_at:job.expires_at};
  });}
  async setBrowserStage(actor:Actor,id:string,stage:string,error?:string){user(actor);
    ensure(['awaiting_browser_login','capturing','verifying','failed'].includes(stage),'INVALID_LINK_STAGE');
    return this.service.db.transaction(async tx=>{
      const owner=await tx.get('users',actor.id,actor.id),job=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);ensure(job,'NOT_FOUND',404);
      if(job.status!=='pending'||Date.parse(job.expires_at)<=Date.parse(this.service.now()))return this.view(job);
      job.stage=stage;
      if(stage==='failed'){job.status='failed';job.error=error??'BROWSER_LINK_FAILED';delete job.ticket;}
      await tx.update('users',actor.id,owner);return this.view(job);
    });
  }
  async proof(actor:Actor,id:string){user(actor);return this.service.db.transaction(async tx=>{
    const row=await tx.get('credential_receipts',id,actor.id);
    ensure(row.receipt.provider==='robinhood'&&row.original_evidence&&row.link_ticket,'NOT_FOUND',404);
    return {evidence:row.original_evidence,link_ticket:row.link_ticket,thot_public_key_pem:this.publicKey};
  });}
  async cancel(actor:Actor,key:string,id:string){user(actor);return this.service.db.command(actor.id,key,{action:'robinhood.cancel',id},async tx=>{
    const owner=await tx.get('users',actor.id,actor.id),job=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);ensure(job,'NOT_FOUND',404);
    ensure(job.status==='pending'||job.status==='cancelled','LINK_NOT_PENDING',409);job.status='cancelled';job.stage='cancelled';delete job.ticket;delete job.link_token;
    await tx.update('users',actor.id,owner);return this.view(job);
  });}
  async complete(actor:Actor,key:string,id:string,evidence:Document){
    user(actor);ensure(this.verifier,'ROBINHOOD_LINKING_UNAVAILABLE',503);
    // The submission is a public signed proof envelope. Secret-bearing capture bundles are rejected.
    ensure(evidence&&Object.keys(evidence).every(k=>['credential','witness_receipts'].includes(k))&&evidence.credential&&Array.isArray(evidence.witness_receipts),'INVALID_CREDENTIAL_ENVELOPE');
    ensure(Buffer.byteLength(JSON.stringify(evidence))<=1_000_000,'CREDENTIAL_EVIDENCE_TOO_LARGE');
    const evidenceHash=canonicalHash(evidence);
    const job=await this.service.db.transaction(async tx=>{const owner=await tx.get('users',actor.id,actor.id);const j=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);ensure(j,'NOT_FOUND',404);return structuredClone(j);});
    if(job.status==='linked'){ensure(job.evidence_hash===evidenceHash,'LINK_ALREADY_COMPLETED',409);return this.get(actor,id);}
    ensure(job.status==='pending'&&Date.parse(job.expires_at)>Date.parse(this.service.now()),'LINK_NOT_PENDING',409);
    let result:Document;
    try{result=await this.verifier(evidence,job.ticket);}catch{
      // Invalid submissions do not consume the challenge or turn into a credential.
      throw new Error('ROBINHOOD_EVIDENCE_REJECTED');
    }
    ensure(result.verified===true&&result.owner_user_id===actor.id&&result.job_id===id&&result.link_ticket_hash===job.ticket_hash,'CREDENTIAL_SUBJECT_MISMATCH');
    ensure(typeof result.subject==='string'&&/^[a-f0-9]{64}$/.test(result.subject),'INVALID_CREDENTIAL_SUBJECT');
    const verified=Date.parse(result.observed_at),now=Date.parse(this.service.now());
    ensure(Number.isFinite(verified)&&verified>=Date.parse(job.issued_at)-30_000&&verified<=now&&now-verified<600_000,'CREDENTIAL_EXPIRED');
    return this.service.db.command(actor.id,key,{action:'robinhood.complete',id,evidenceHash},async tx=>{
      const owner=await tx.get('users',actor.id,actor.id),current=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);
      ensure(current&&current.status==='pending'&&Date.parse(current.expires_at)>Date.parse(this.service.now()),'LINK_NOT_PENDING',409);
      const receipt=this.privacy.normalizeBrokerage(actor.id,result.subject,evidenceHash,result.observed_at,new Date(verified+86400_000).toISOString());
      await tx.insert('credential_receipts',receipt.receipt_id,actor.id,{receipt,original_evidence:evidence,link_ticket:job.ticket});
      for(const trace of await tx.list('traces',actor.id)){if(trace.deleted)continue;trace.credential_ids=[...new Set([...trace.credential_ids,receipt.receipt_id])];await tx.update('traces',trace.trace_id,trace);}
      Object.assign(current,{status:'linked',stage:'verified',credential_id:receipt.receipt_id,verified_at:result.observed_at,evidence_hash:evidenceHash});delete current.ticket;
      await tx.update('users',actor.id,owner);await tx.audit(actor.id,'RobinhoodCredentialLinked',{job_id:id,receipt_id:receipt.receipt_id});await this.service.enqueueMatching(tx);
      return this.view(current);
    });
  }
  async disconnect(actor:Actor,key:string){user(actor);return this.service.db.command(actor.id,key,{action:'robinhood.disconnect'},async tx=>{
    const owner=await tx.get('users',actor.id,actor.id);
    const ids=(await tx.list('credential_receipts',actor.id)).filter(r=>r.receipt.predicate_type==='brokerage_control').map(r=>r.receipt.receipt_id);
    owner.revoked_receipts=[...new Set([...(owner.revoked_receipts??[]),...ids])];
    for(const j of owner.robinhood_link_jobs??[]){j.status='disconnected';j.stage='disconnected';delete j.ticket;delete j.link_token;}
    await tx.update('users',actor.id,owner);await tx.audit(actor.id,'RobinhoodDisconnected',{credentials:ids.length});await this.service.enqueueMatching(tx);return {status:'disconnected'};
  });}
}
