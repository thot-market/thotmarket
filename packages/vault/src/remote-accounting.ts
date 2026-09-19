import {Pool} from 'pg';
import {canonicalJson} from '../../protocol/src/index.ts';

export interface RemoteQuotaLimits {ownerBytes:number;ownerObjects:number;userBytes:number;userObjects:number;journalBytes:number;journalObjects:number;}
export const DEFAULT_REMOTE_QUOTAS:RemoteQuotaLimits={ownerBytes:10*1024**3,ownerObjects:100_000,userBytes:1024**4,userObjects:10_000_000,journalBytes:1024**3,journalObjects:100_000};
export interface QuotaSql {query(sql:string,params?:any[]):Promise<{rows:any[]}>;}
export interface QuotaDatabase {transaction<T>(work:(sql:QuotaSql)=>Promise<T>):Promise<T>;}
export interface RemoteAccounting {
  reserve(id:string,owner:string,bytes:number,journal:boolean):Promise<void>;
  stored(id:string,owner:string,bytes:number):Promise<void>;
  authorizeDelete(id:string,owner:string):Promise<void>;
  removed(id:string,owner:string):Promise<void>;
  usage(owner?:string):Promise<any>;
}
// Tables are deliberately separate from application transactions. A rollback of
// import metadata must not forget ciphertext already accepted by remote storage.
const schema=`
CREATE TABLE IF NOT EXISTS remote_vault_policy(namespace text PRIMARY KEY, limits jsonb NOT NULL, placement text NOT NULL);
CREATE TABLE IF NOT EXISTS remote_vault_usage(namespace text NOT NULL, scope text NOT NULL, bytes bigint NOT NULL DEFAULT 0 CHECK(bytes>=0), objects bigint NOT NULL DEFAULT 0 CHECK(objects>=0), PRIMARY KEY(namespace,scope));
CREATE TABLE IF NOT EXISTS remote_vault_objects(namespace text NOT NULL, id text NOT NULL, owner_id text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0), journal boolean NOT NULL, status text NOT NULL CHECK(status IN ('pending','stored','deleting','deleted')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace,id));
CREATE TABLE IF NOT EXISTS remote_vault_owner_policy(namespace text NOT NULL, owner_id text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0), objects bigint NOT NULL CHECK(objects>0), PRIMARY KEY(namespace,owner_id));
CREATE TABLE IF NOT EXISTS remote_vault_allowance_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, namespace text NOT NULL, owner_id text NOT NULL, prior jsonb NOT NULL, granted jsonb NOT NULL, reason text NOT NULL, actor text NOT NULL DEFAULT current_user, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS remote_vault_objects_owner ON remote_vault_objects(namespace,owner_id,status);
`;
export class SqlRemoteAccounting implements RemoteAccounting {
  private db:QuotaDatabase;private namespace:string;private placement:string;readonly limits:RemoteQuotaLimits;
  constructor(db:QuotaDatabase,namespace:string,limits:RemoteQuotaLimits=DEFAULT_REMOTE_QUOTAS,placement:string=namespace){
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(namespace))throw Error('INVALID_REMOTE_NAMESPACE');
    if(Object.keys(limits).sort().join(',')!==Object.keys(DEFAULT_REMOTE_QUOTAS).sort().join(',')||Object.values(limits).some(v=>!Number.isSafeInteger(v)||v<1))throw Error('INVALID_REMOTE_QUOTAS');
    if(limits.ownerBytes>limits.userBytes||limits.ownerObjects>limits.userObjects)throw Error('INVALID_REMOTE_QUOTAS');
    if(!placement||placement.length>1000)throw Error('INVALID_REMOTE_PLACEMENT');
    this.placement=placement;this.db=db;this.namespace=namespace;this.limits=Object.freeze({...limits});
  }
  async initialize(allowCreate=true){await this.db.transaction(async q=>{
    for(const statement of schema.split(';').filter(s=>s.trim()))await q.query(statement);
    if(allowCreate)await q.query('INSERT INTO remote_vault_policy(namespace,limits,placement) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING',[this.namespace,canonicalJson(this.limits),this.placement]);
    await this.lock(q);
  });return this;}
  private async lock(q:QuotaSql){
    const row=(await q.query('SELECT limits,placement FROM remote_vault_policy WHERE namespace=$1 FOR UPDATE',[this.namespace])).rows[0];
    if(!row)throw Error('REMOTE_QUOTA_NAMESPACE_MISSING');
    if(row.placement!==this.placement||canonicalJson(row.limits)!==canonicalJson(this.limits))throw Error('REMOTE_QUOTA_POLICY_MISMATCH');
  }
  private async charge(q:QuotaSql,scope:string,bytes:number,maxBytes:number,maxObjects:number,code:string){
    await q.query('INSERT INTO remote_vault_usage(namespace,scope) VALUES($1,$2) ON CONFLICT DO NOTHING',[this.namespace,scope]);
    const result=await q.query('UPDATE remote_vault_usage SET bytes=bytes+$3,objects=objects+1 WHERE namespace=$1 AND scope=$2 AND bytes+$3<=$4 AND objects+1<=$5 RETURNING scope',[this.namespace,scope,bytes,maxBytes,maxObjects]);
    if(!result.rows.length)throw Error(code);
  }
  async reserve(id:string,owner:string,bytes:number,journal:boolean){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!owner||owner.length>200||!Number.isSafeInteger(bytes)||bytes<1)throw Error('INVALID_REMOTE_RESERVATION');
    await this.db.transaction(async q=>{
      await this.lock(q);
      if((await q.query('SELECT id FROM remote_vault_objects WHERE namespace=$1 AND id=$2',[this.namespace,id])).rows.length)throw Object.assign(Error('EEXIST'),{code:'EEXIST'});
      const l=this.limits;
      await this.charge(q,journal?'journal':'user',bytes,journal?l.journalBytes:l.userBytes,journal?l.journalObjects:l.userObjects,journal?'VAULT_JOURNAL_CAPACITY':'VAULT_GLOBAL_QUOTA');
      if(!journal){
        const override=(await q.query('SELECT bytes,objects FROM remote_vault_owner_policy WHERE namespace=$1 AND owner_id=$2',[this.namespace,owner])).rows[0];
        await this.charge(q,'owner:'+owner,bytes,Number(override?.bytes??l.ownerBytes),Number(override?.objects??l.ownerObjects),'VAULT_OWNER_QUOTA');
      }
      await q.query("INSERT INTO remote_vault_objects(namespace,id,owner_id,bytes,journal,status) VALUES($1,$2,$3,$4,$5,'pending')",[this.namespace,id,owner,bytes,journal]);
    });
  }
  async stored(id:string,owner:string,bytes:number){await this.db.transaction(async q=>{
    await this.lock(q);
    const row=await q.query("UPDATE remote_vault_objects SET status='stored' WHERE namespace=$1 AND id=$2 AND owner_id=$3 AND bytes=$4 AND status IN ('pending','stored') RETURNING id",[this.namespace,id,owner,bytes]);
    if(!row.rows.length)throw Error('REMOTE_RESERVATION_STATE');
  });}
  async authorizeDelete(id:string,owner:string){await this.db.transaction(async q=>{
    await this.lock(q);
    const row=(await q.query('SELECT * FROM remote_vault_objects WHERE namespace=$1 AND id=$2',[this.namespace,id])).rows[0];
    if(!row||row.owner_id!==owner)throw Error('VAULT_ACCESS_DENIED');
    if(row.status==='pending')throw Error('REMOTE_PENDING_RECONCILIATION_REQUIRED');
    if(row.status!=='deleted')await q.query("UPDATE remote_vault_objects SET status='deleting' WHERE namespace=$1 AND id=$2",[this.namespace,id]);
  });}
  async removed(id:string,owner:string){await this.db.transaction(async q=>{
    await this.lock(q);
    const row=(await q.query('SELECT * FROM remote_vault_objects WHERE namespace=$1 AND id=$2',[this.namespace,id])).rows[0];
    if(!row||row.owner_id!==owner)throw Error('VAULT_ACCESS_DENIED');
    if(row.status==='deleted')return;
    if(row.status!=='deleting')throw Error('REMOTE_RESERVATION_STATE');
    for(const scope of [row.journal?'journal':'user',...(!row.journal?['owner:'+owner]:[])])await q.query('UPDATE remote_vault_usage SET bytes=bytes-$3,objects=objects-1 WHERE namespace=$1 AND scope=$2',[this.namespace,scope,row.bytes]);
    // Retain tombstones: an old reference must never address a new object's bytes.
    await q.query("UPDATE remote_vault_objects SET status='deleted' WHERE namespace=$1 AND id=$2",[this.namespace,id]);
  });}
  /** Trusted operator capability only; never expose this through importer routes.
   * Valuable contributors can grow without changing every replica's config.
   */
  async setOwnerAllowance(owner:string,bytes:number,objects:number,reason:string){
    if(typeof owner!=='string'||!owner||owner.length>200||owner.startsWith('thot-operator:')||!Number.isSafeInteger(bytes)||bytes<1||bytes>this.limits.userBytes||!Number.isSafeInteger(objects)||objects<1||objects>this.limits.userObjects||typeof reason!=='string'||!reason.trim()||reason.length>1000)throw Error('INVALID_OWNER_ALLOWANCE');
    return this.db.transaction(async q=>{
      await this.lock(q);
      const usage=(await q.query('SELECT bytes,objects FROM remote_vault_usage WHERE namespace=$1 AND scope=$2',[this.namespace,'owner:'+owner])).rows[0];
      if(bytes<Number(usage?.bytes??0)||objects<Number(usage?.objects??0))throw Error('OWNER_ALLOWANCE_BELOW_USAGE');
      const prior=(await q.query('SELECT bytes,objects FROM remote_vault_owner_policy WHERE namespace=$1 AND owner_id=$2',[this.namespace,owner])).rows[0]??{bytes:this.limits.ownerBytes,objects:this.limits.ownerObjects};
      await q.query('INSERT INTO remote_vault_owner_policy(namespace,owner_id,bytes,objects) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,owner_id) DO UPDATE SET bytes=EXCLUDED.bytes,objects=EXCLUDED.objects',[this.namespace,owner,bytes,objects]);
      await q.query('INSERT INTO remote_vault_allowance_audit(namespace,owner_id,prior,granted,reason) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[this.namespace,owner,canonicalJson({bytes:Number(prior.bytes),objects:Number(prior.objects)}),canonicalJson({bytes,objects}),reason.trim()]);
      return {bytes,objects};
    });
  }
  async usage(owner?:string){return this.db.transaction(async q=>{
    await this.lock(q);
    const rows=(await q.query('SELECT scope,bytes,objects FROM remote_vault_usage WHERE namespace=$1 AND scope=ANY($2::text[])',[this.namespace,['user','journal',...(owner?['owner:'+owner]:[])]] )).rows;
    const total=(scope:string)=>{const r=rows.find(r=>r.scope===scope);return {bytes:Number(r?.bytes??0),objects:Number(r?.objects??0)};};
    return {user:total('user'),journal:total('journal'),owner:total('owner:'+owner),limits:this.limits};
  });}
}
export async function openPostgresAccounting(url:string,namespace:string,limits?:RemoteQuotaLimits,placement?:string,allowCreate=false){
  const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
  let initializing=true;
  const db:QuotaDatabase={async transaction(work){const c=await pool.connect();try{await c.query('BEGIN');if(initializing)await c.query('SELECT pg_advisory_xact_lock(1463896913)');const value=await work(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  try{const accounting=await new SqlRemoteAccounting(db,namespace,limits,placement).initialize(allowCreate);initializing=false;return {accounting,close:()=>pool.end()};}catch(e){await pool.end();throw e;}
}
