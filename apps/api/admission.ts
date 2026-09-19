import {createHash} from 'node:crypto';
import {ensure} from '../../packages/storage/src/index.ts';

export type AdmissionClass='account'|'capture';
export type AdmissionLimits={
  window_ms:number;public_requests:number;preauth_requests:number;credential_requests:number;
  verified_requests:number;account_requests:number;capture_requests:number;
  requests_in_flight:number;auth_in_flight:number;account_in_flight:number;capture_in_flight:number;
  bodies_in_flight:number;body_bytes_in_flight:number;credential_keys:number;tenant_keys:number;
};

export const defaultAdmissionLimits:AdmissionLimits={
  window_ms:60_000,public_requests:6_000,preauth_requests:12_000,credential_requests:360,
  verified_requests:30_000,account_requests:240,capture_requests:600,
  requests_in_flight:256,auth_in_flight:64,account_in_flight:8,capture_in_flight:16,
  bodies_in_flight:16,body_bytes_in_flight:128*1024*1024,credential_keys:4_096,tenant_keys:2_048,
};

type Window={start:number;requests:number};
type Slot={inFlight:number;window:Window};
const releaseOnce=(release:()=>void)=>{let released=false;return()=>{if(!released){released=true;release();}};};

/**
 * Process-local load shedding. Credential fingerprints only bound authentication
 * work; tenant capacity is granted solely after the caller has been verified.
 * Body bytes cover concurrent JSON input buffering and are released after parsing;
 * handler-owned parsed objects and other process memory are outside that bound.
 */
export class ApiAdmission {
  readonly limits:AdmissionLimits;
  private readonly clock:()=>number;
  private publicWindow:Window={start:0,requests:0};
  private preauthWindow:Window={start:0,requests:0};
  private verifiedWindow:Window={start:0,requests:0};
  private credentialOverflow:Window={start:0,requests:0};
  private tenantOverflow:Record<AdmissionClass,Slot>={account:{inFlight:0,window:{start:0,requests:0}},capture:{inFlight:0,window:{start:0,requests:0}}};
  private readonly credentials=new Map<string,Window>();
  private readonly tenants=new Map<string,Slot>();
  private requestsInFlight=0;
  private authInFlight=0;
  private bodiesInFlight=0;
  private bodyBytesInFlight=0;
  private credentialGeneration=-1;
  private tenantGeneration=-1;

  constructor(options:{clock?:()=>number;limits?:Partial<AdmissionLimits>}={}){
    this.clock=options.clock??Date.now;this.limits={...defaultAdmissionLimits,...options.limits};
    for(const value of Object.values(this.limits))ensure(Number.isSafeInteger(value)&&value>=1,'INVALID_API_ADMISSION_LIMITS');
  }
  private now(){const value=this.clock();ensure(Number.isSafeInteger(value)&&value>=0,'INVALID_API_ADMISSION_CLOCK');return value;}
  private consume(window:Window,limit:number,code:string){
    const now=this.now();if(now-window.start>=this.limits.window_ms||now<window.start){window.start=now;window.requests=0;}
    ensure(window.requests<limit,code,429);window.requests++;
  }
  enterRequest(){
    ensure(this.requestsInFlight<this.limits.requests_in_flight,'SERVER_BUSY',503);this.requestsInFlight++;
    return releaseOnce(()=>{this.requestsInFlight--;});
  }
  public(){this.consume(this.publicWindow,this.limits.public_requests,'PUBLIC_RATE_LIMIT');}
  enterAuthentication(token:string){
    const generation=Math.floor(this.now()/this.limits.window_ms);
    if(generation!==this.credentialGeneration){this.credentialGeneration=generation;this.credentials.clear();this.credentialOverflow={start:this.now(),requests:0};}
    this.consume(this.preauthWindow,this.limits.preauth_requests,'AUTHENTICATION_RATE_LIMIT');
    const fingerprint=createHash('sha256').update(token).digest('hex');
    let window=this.credentials.get(fingerprint);
    if(!window&&this.credentials.size<this.limits.credential_keys){window={start:this.now(),requests:0};this.credentials.set(fingerprint,window);}
    this.consume(window??this.credentialOverflow,this.limits.credential_requests,'CREDENTIAL_RATE_LIMIT');
    ensure(this.authInFlight<this.limits.auth_in_flight,'AUTHENTICATION_BUSY',503);this.authInFlight++;
    return releaseOnce(()=>{this.authInFlight--;});
  }
  enterVerified(kind:AdmissionClass,tenantId:string){
    ensure(typeof tenantId==='string'&&tenantId.length>=1,'INVALID_VERIFIED_TENANT');
    const generation=Math.floor(this.now()/this.limits.window_ms);
    if(generation!==this.tenantGeneration){
      this.tenantGeneration=generation;
      // Reclaim stale keys without replacing slots held by boundary-crossing
      // requests. Overflow slots likewise retain their active counts.
      for(const[key,slot]of this.tenants)if(slot.inFlight===0)this.tenants.delete(key);
    }
    this.consume(this.verifiedWindow,this.limits.verified_requests,'VERIFIED_RATE_LIMIT');
    const key=kind+':'+tenantId;let slot=this.tenants.get(key);
    if(!slot&&this.tenants.size<this.limits.tenant_keys){slot={inFlight:0,window:{start:this.now(),requests:0}};this.tenants.set(key,slot);}
    slot??=this.tenantOverflow[kind];
    const requestLimit=kind==='account'?this.limits.account_requests:this.limits.capture_requests;
    const inFlightLimit=kind==='account'?this.limits.account_in_flight:this.limits.capture_in_flight;
    this.consume(slot.window,requestLimit,kind==='account'?'ACCOUNT_ADMISSION_LIMIT':'CAPTURE_ADMISSION_LIMIT');
    ensure(slot.inFlight<inFlightLimit,kind==='account'?'ACCOUNT_BUSY':'CAPTURE_BUSY',503);slot.inFlight++;
    return releaseOnce(()=>{slot!.inFlight--;});
  }
  openBody(contentLength:string|undefined,requestLimit:number){
    ensure(Number.isSafeInteger(requestLimit)&&requestLimit>=1,'INVALID_BODY_LIMIT');
    let declared=0;
    if(contentLength!==undefined){ensure(/^\d+$/.test(contentLength),'INVALID_CONTENT_LENGTH');declared=Number(contentLength);ensure(Number.isSafeInteger(declared),'INVALID_CONTENT_LENGTH');}
    ensure(declared<=requestLimit,'REQUEST_TOO_LARGE',413);
    ensure(this.bodiesInFlight<this.limits.bodies_in_flight,'BODY_ADMISSION_BUSY',503);
    ensure(this.bodyBytesInFlight+declared<=this.limits.body_bytes_in_flight,'BODY_ADMISSION_BUSY',503);
    this.bodiesInFlight++;this.bodyBytesInFlight+=declared;let reserved=declared;
    const add=(bytes:number)=>{
      ensure(Number.isSafeInteger(bytes)&&bytes>=0,'INVALID_BODY_SIZE');
      if(declared===0){ensure(reserved+bytes<=requestLimit,'REQUEST_TOO_LARGE',413);ensure(this.bodyBytesInFlight+bytes<=this.limits.body_bytes_in_flight,'BODY_ADMISSION_BUSY',503);reserved+=bytes;this.bodyBytesInFlight+=bytes;}
    };
    const release=releaseOnce(()=>{this.bodiesInFlight--;this.bodyBytesInFlight-=reserved;});
    return {add,release};
  }
  snapshot(){return {credential_keys:this.credentials.size,tenant_keys:this.tenants.size,requests_in_flight:this.requestsInFlight,auth_in_flight:this.authInFlight,bodies_in_flight:this.bodiesInFlight,body_bytes_in_flight:this.bodyBytesInFlight};}
}
