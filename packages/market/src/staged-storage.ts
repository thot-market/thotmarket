import {canonicalHash,canonicalJson,uuidv7} from '../../protocol/src/index.ts';
import {Database,DomainError,ensure,wire,TRANSACTION_TIMING_BOUNDS_MS,type Document,type Transaction} from '../../storage/src/index.ts';
import type {PrivacyFacade} from './service.ts';

const LEASE_MS=180_000;
export const MAX_STAGED_OPERATIONS=16;
export type StorageOperation='import'|'part'|'capture'|'projection';
export interface ObjectTiming {operation:StorageOperation;kind:'read'|'write';outcome:'success'|'failure';duration_ms:number}
export interface PreparedStorage {
  seal(value:unknown):Promise<Document>;
  open(ref:Document):Promise<any>;
  /** Call only inside the commit callback when no staged references are published. */
  discard():void;
}
type Commit<T>=(tx:Transaction)=>Promise<T>;

/** External I/O never runs inside an application transaction. Every upload has
 * an owner-bound durable identity before it starts; expired attempts are fenced
 * from publishing metadata. Pending/ambiguous objects remain conservatively charged. */
export class StagedStorage {
  private objectTimings=new Map<string,{operation:StorageOperation;kind:ObjectTiming['kind'];outcome:ObjectTiming['outcome'];count:number;sum_ms:number;max_ms:number;buckets:number[]}>();
  private observe(timing:Readonly<ObjectTiming>){
    const key=[timing.operation,timing.kind,timing.outcome].join(':');
    let series=this.objectTimings.get(key);
    if(!series){series={operation:timing.operation,kind:timing.kind,outcome:timing.outcome,count:0,sum_ms:0,max_ms:0,buckets:Array(TRANSACTION_TIMING_BOUNDS_MS.length+1).fill(0)};this.objectTimings.set(key,series);}
    series.count++;series.sum_ms+=timing.duration_ms;series.max_ms=Math.max(series.max_ms,timing.duration_ms);
    const bucket=TRANSACTION_TIMING_BOUNDS_MS.findIndex(bound=>timing.duration_ms<=bound);series.buckets[bucket<0?TRANSACTION_TIMING_BOUNDS_MS.length:bucket]++;
    try{this.onObjectTiming?.(timing);}catch{/* optional observers cannot change persistence */}
  }
  metrics(){return {in_flight_operations:this.running.size,max_in_flight_operations:MAX_STAGED_OPERATIONS,upper_bounds_ms:[...TRANSACTION_TIMING_BOUNDS_MS],series:[...this.objectTimings.values()].map(series=>({...series,buckets:[...series.buckets]}))};}
  private running=new Map<string,{digest:string;promise:Promise<any>}>();
  onObjectTiming?:(timing:Readonly<ObjectTiming>)=>void;
  private db:Database;private privacy:PrivacyFacade;
  constructor(db:Database,privacy:PrivacyFacade){this.db=db;this.privacy=privacy;}

  run<T>(owner:string,key:string,request:unknown,operation:StorageOperation,prepare:(stage:PreparedStorage)=>Promise<Commit<T>>):Promise<T>{
    ensure(typeof key==='string'&&key.length>=8&&key.length<=200,'IDEMPOTENCY_KEY_REQUIRED');
    const identity=canonicalHash({owner,key}),digest=canonicalHash(request),prior=this.running.get(identity);
    if(prior){ensure(prior.digest===digest,'IDEMPOTENCY_CONFLICT',409);return prior.promise;}
    ensure(this.running.size<MAX_STAGED_OPERATIONS,'STORAGE_BUSY',503);
    const promise=this.execute(owner,key,digest,operation,prepare).finally(()=>this.running.delete(identity));
    this.running.set(identity,{digest,promise});return promise;
  }

  private async execute<T>(owner:string,key:string,digest:string,operation:StorageOperation,prepare:(stage:PreparedStorage)=>Promise<Commit<T>>):Promise<T>{
    const transaction=<T>(work:(tx:Transaction)=>Promise<T>)=>this.db.transaction(work,operation);
    const deadline=performance.now()+LEASE_MS;
    for(let retry=0;retry<3;retry++){
      const remaining=Math.ceil(deadline-performance.now());
      ensure(remaining>0,'STORAGE_OPERATION_EXPIRED',503);
      const attempt=uuidv7();
      const reservation=await transaction(async tx=>{
        const prior=(await tx.sql.query('SELECT request_hash,response FROM idempotency_keys WHERE actor_id=$1 AND key=$2',[owner,key])).rows[0];
        if(prior){ensure(prior.request_hash===digest,'IDEMPOTENCY_CONFLICT',409);return {replay:true,response:prior.response};}
        const claim=(await tx.sql.query('SELECT * FROM storage_command_claims WHERE actor_id=$1 AND key=$2',[owner,key])).rows[0];
        if(claim){
          ensure(claim.request_hash===digest,'IDEMPOTENCY_CONFLICT',409);
          if(claim.attempt_id){
            const active=(await tx.sql.query("SELECT id FROM storage_write_attempts WHERE id=$1 AND status='active' AND expires_at>now()",[claim.attempt_id])).rows[0];
            ensure(!active,'STORAGE_OPERATION_IN_PROGRESS',503);
            await tx.sql.query("UPDATE storage_write_attempts SET status='abandoned' WHERE id=$1 AND status='active'",[claim.attempt_id]);
          }
          await tx.sql.query('UPDATE storage_command_claims SET attempt_id=$3 WHERE actor_id=$1 AND key=$2',[owner,key,attempt]);
        }else await tx.sql.query('INSERT INTO storage_command_claims(actor_id,key,request_hash,attempt_id) VALUES($1,$2,$3,$4)',[owner,key,digest,attempt]);
        const leaseRemaining=Math.ceil(deadline-performance.now());ensure(leaseRemaining>0,'STORAGE_OPERATION_EXPIRED',503);
        await tx.sql.query("INSERT INTO storage_write_attempts(id,owner_id,status,expires_at) VALUES($1,$2,'active',clock_timestamp()+($3 * interval '1 millisecond'))",[attempt,owner,leaseRemaining]);
        return {replay:false};
      });
      if(reservation.replay)return reservation.response as T;
      let discard=false;
      const check=async(tx:Transaction)=>{
        ensure(performance.now()<deadline,'STORAGE_OPERATION_EXPIRED',503);
        const live=(await tx.sql.query("SELECT a.id FROM storage_write_attempts a JOIN storage_command_claims c ON c.attempt_id=a.id WHERE a.id=$1 AND c.actor_id=$2 AND c.key=$3 AND a.status='active' AND a.expires_at>clock_timestamp()",[attempt,owner,key])).rows[0];
        ensure(live,'STORAGE_OPERATION_EXPIRED',503);
      };
      const timed=async<T>(kind:ObjectTiming['kind'],work:()=>Promise<T>)=>{
        const start=performance.now();let outcome:ObjectTiming['outcome']='failure';
        try{const result=await work();outcome='success';return result;}
        finally{this.observe(Object.freeze({operation,kind,outcome,duration_ms:performance.now()-start}));}
      };
      const stage:PreparedStorage={
        discard:()=>{discard=true;},
        open:async ref=>{await transaction(check);return timed('read',()=>this.privacy.open(owner,ref));},
        seal:async value=>{
          const ref={ownerUserId:owner,objectId:uuidv7()};
          await transaction(async tx=>{await check(tx);await tx.sql.query("UPDATE storage_write_attempts SET objects=objects || $2::jsonb WHERE id=$1",[attempt,canonicalJson([{ref,status:'pending'}])]);});
          const stored=await timed('write',()=>this.privacy.seal(owner,value,ref.objectId));
          ensure(canonicalHash(stored)===canonicalHash(ref),'STAGED_OBJECT_REFERENCE_MISMATCH');
          // Record a confirmed write even if its lease expired while uploading.
          // It is then reclaimable, but the fenced commit still cannot publish it.
          await transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET objects=(SELECT jsonb_agg(CASE WHEN item->'ref'=$2::jsonb THEN jsonb_set(item,'{status}','\"stored\"') ELSE item END) FROM jsonb_array_elements(objects) item) WHERE id=$1",[attempt,canonicalJson(ref)]);});
          return ref;
        }
      };
      try{
        const commit=await prepare(stage);
        return await transaction(async tx=>{
          await check(tx);
          const actor=await tx.maybe('users',owner);ensure(!actor||actor.disabled!==true,'AUTH_ACTOR_UNAVAILABLE',403);
          const result=wire(await commit(tx));
          await tx.sql.query('INSERT INTO idempotency_keys(actor_id,key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)',[owner,key,digest,canonicalJson(result)]);
          if(discard)await tx.sql.query("UPDATE storage_write_attempts SET status='abandoned' WHERE id=$1",[attempt]);
          else await tx.sql.query("DELETE FROM storage_write_attempts WHERE id=$1 AND status='active' AND NOT objects @> '[{\"status\":\"pending\"}]'::jsonb",[attempt]);
          await tx.sql.query('DELETE FROM storage_command_claims WHERE actor_id=$1 AND key=$2 AND attempt_id=$3',[owner,key,attempt]);
          return result;
        });
      }catch(error){
        await transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET status='abandoned' WHERE id=$1 AND status='active'",[attempt]);await tx.sql.query('UPDATE storage_command_claims SET attempt_id=NULL WHERE actor_id=$1 AND key=$2 AND attempt_id=$3',[owner,key,attempt]);});
        if(error instanceof DomainError&&error.code==='STAGED_STATE_CHANGED'&&retry<2)continue;
        throw error;
      }
    }
    throw new DomainError('STAGED_STATE_CHANGED',409);
  }

  /** Only unreferenced confirmed uploads may be removed. Ambiguous writes are
   * retained for cross-store reconciliation; never release their quota on timeout. */
  async cleanup(limit=16){
    ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=64,'INVALID_CLEANUP_LIMIT');
    const attempts=await this.db.transaction(async tx=>{
      await tx.sql.query("UPDATE storage_write_attempts SET status='abandoned' WHERE status='active' AND expires_at<=clock_timestamp()");
      return (await tx.sql.query("SELECT id,owner_id,objects FROM storage_write_attempts WHERE status='abandoned' AND (objects @> '[{\"status\":\"stored\"}]'::jsonb OR EXISTS (SELECT 1 FROM jsonb_array_elements(objects) item WHERE item->>'status'='delete_failed' AND (item->>'retry_after')::timestamptz<=clock_timestamp())) ORDER BY (objects @> '[{\"status\":\"stored\"}]'::jsonb) DESC,created_at LIMIT $1",[limit])).rows;
    },'cleanup');
    let removed=0,failed=0,next=0;
    const objects=attempts.flatMap(attempt=>attempt.objects.filter((object:Document)=>object.status==='stored'||(object.status==='delete_failed'&&Date.parse(object.retry_after)<=Date.now())).map((object:Document)=>({attempt,object}))).sort((a,b)=>Number(b.object.status==='stored')-Number(a.object.status==='stored')).slice(0,limit);
    await Promise.all(Array.from({length:Math.min(4,objects.length)},async()=>{
      while(next<objects.length){
        const {attempt,object}=objects[next++]!;
        try{
          await this.privacy.remove(attempt.owner_id,object.ref);
          await this.db.transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET objects=(SELECT jsonb_agg(CASE WHEN item->'ref'=$2::jsonb AND item->>'status' IN ('stored','delete_failed') THEN jsonb_set(item,'{status}','\"removed\"') ELSE item END) FROM jsonb_array_elements(objects) item) WHERE id=$1 AND status='abandoned'",[attempt.id,canonicalJson(object.ref)]);});removed++;
        }catch{const retryAfter=new Date(Date.now()+60_000).toISOString();await this.db.transaction(async tx=>{await tx.sql.query("UPDATE storage_write_attempts SET objects=(SELECT jsonb_agg(CASE WHEN item->'ref'=$2::jsonb AND item->>'status' IN ('stored','delete_failed') THEN jsonb_set(jsonb_set(item,'{status}','\"delete_failed\"'),'{retry_after}',$3::jsonb) ELSE item END) FROM jsonb_array_elements(objects) item) WHERE id=$1 AND status='abandoned'",[attempt.id,canonicalJson(object.ref),canonicalJson(retryAfter)]);});failed++;}
      }
    }));
    return {removed,failed};
  }
}
