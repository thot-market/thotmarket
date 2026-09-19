import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { canonicalJson, canonicalHash, uuidv7 } from '../../protocol/src/index.ts';

export type Document = Record<string, any>;
export interface Queryable { query<T = Document>(sql: string, params?: any[]): Promise<{ rows: T[] }>; }
export class DomainError extends Error {
  code: string; status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export function ensure(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, status);
}
export const wire = <T>(value: T): T => JSON.parse(canonicalJson(value));
const tables = new Set(["users","user_wallets","buyers","buyer_members","trace_bundles","traces","trace_objects","provenance_receipts","credential_receipts","outcome_receipts","rights_assessments","scrub_receipts","trace_features","user_policies","sale_authorizations","mandates","mandate_funding","mandate_candidates","assay_receipts","release_artifacts","licenses","deliveries","contributor_entitlements","inference_credit_reservations","market_purchase_orders","token_transfers","burn_allocations","chain_transactions","chain_event_cursor","sale_settlements"]);
const mutable = new Set(['users','user_wallets','buyers','buyer_members','traces','trace_objects','trace_features','mandates','mandate_candidates','deliveries','contributor_entitlements','inference_credit_reservations','market_purchase_orders','token_transfers','burn_allocations','chain_transactions','chain_event_cursor']);
tables.add('inference_requests'); mutable.add('inference_requests');
for (const table of ['inference_billing_evidence','inference_billing_reviews','auth_access','operational_controls']) tables.add(table);
mutable.add('auth_access'); mutable.add('operational_controls');
tables.add('agent_captures'); mutable.add('agent_captures');
tables.add('thot_records'); mutable.add('thot_records');
function tableName(table: string): string {
  ensure(tables.has(table), 'UNKNOWN_TABLE'); return table;
}
export class Transaction {
  sql: Queryable;
  constructor(sql: Queryable) { this.sql = sql; }
  async get(table: string, id: string, owner?: string): Promise<Document> {
    const result = await this.sql.query('SELECT * FROM '+tableName(table)+' WHERE id=$1', [id]);
    const row = result.rows[0];
    ensure(row && (owner === undefined || row.owner_id === owner), 'NOT_FOUND', 404);
    return { ...row.document, id: row.id, owner_id: row.owner_id };
  }
  async maybe(table: string, id: string): Promise<Document | undefined> {
    const result = await this.sql.query('SELECT * FROM '+tableName(table)+' WHERE id=$1', [id]);
    const row = result.rows[0]; return row ? { ...row.document, id: row.id, owner_id: row.owner_id } : undefined;
  }
  async list(table: string, owner?: string): Promise<Document[]> {
    const result = await this.sql.query('SELECT * FROM '+tableName(table)+(owner === undefined ? '' : ' WHERE owner_id=$1')+' ORDER BY created_at,id', owner === undefined ? [] : [owner]);
    return result.rows.map(row => ({ ...row.document, id: row.id, owner_id: row.owner_id }));
  }
  async insert(table: string, id: string, owner: string, document: Document): Promise<Document> {
    await this.sql.query('INSERT INTO '+tableName(table)+' (id,owner_id,document) VALUES ($1,$2,$3::jsonb)', [id, owner, canonicalJson(document)]);
    return { ...wire(document), id, owner_id: owner };
  }
  async update(table: string, id: string, document: Document): Promise<void> {
    ensure(mutable.has(table), 'IMMUTABLE_TABLE');
    await this.sql.query('UPDATE '+tableName(table)+' SET document=$2::jsonb WHERE id=$1', [id, canonicalJson(document)]);
  }
  async audit(owner: string, eventType: string, payload: Record<string, string | number | boolean>): Promise<void> {
    // Callers pass identifiers, digests, counters and error codes, never traces or receipt bodies.
    await this.sql.query('INSERT INTO audit_events(id,owner_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)', [uuidv7(),owner,eventType,canonicalJson(payload)]);
  }
  async enqueue(owner: string, eventType: string, payload: Record<string, string>): Promise<void> {
    await this.sql.query('INSERT INTO outbox_events(id,owner_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)', [uuidv7(),owner,eventType,canonicalJson(payload)]);
  }
}
export type TransactionOperation='import'|'part'|'capture'|'projection'|'cleanup';
/** Fixed-cardinality, content-free measurements; emitted once after completion/cleanup. */
export interface TransactionTiming {
  operation?:TransactionOperation;
  backend: 'pglite' | 'postgres';
  outcome: 'success' | 'failure';
  admission_ms: number;
  lock_wait_ms: number;
  hold_ms: number;
  total_ms: number;
}
export interface DatabaseOptions {
  dataDir?: string;
  url?: string;
  /** Synchronous, non-blocking observer. Exceptions cannot change transaction results. */
  onTransactionTiming?: (timing: Readonly<TransactionTiming>) => void;
}
export class Database {
  private embedded?: PGlite;
  private pool?: Pool;
  private onTransactionTiming?: DatabaseOptions['onTransactionTiming'];
  private constructor() {}
  static async open(options: DatabaseOptions = {}): Promise<Database> {
    const db = new Database();
    db.onTransactionTiming = options.onTransactionTiming;
    if (options.url) db.pool = new Pool({ connectionString: options.url, max: 8 });
    else db.embedded = await PGlite.create(options.dataDir || 'memory://');
    try{await db.migrate();}catch(error){await db.close();throw error;}
    return db;
  }
  async query<T = Document>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
    if (this.embedded) return this.embedded.query<T>(sql, params);
    return this.pool!.query(sql, params) as unknown as Promise<{rows:T[]}>;
  }
  private async migrate(): Promise<void> {
    const migrations=await Promise.all(['001_initial.sql','002_inference.sql','003_operations.sql','004_agent_capture.sql','005_thot.sql','006_staged_storage.sql'].map(async name=>{
      const sql=await readFile(new URL('../../../migrations/'+name,import.meta.url),'utf8');
      return {version:name.slice(0,3),sql,digest:createHash('sha256').update(sql).digest('hex')};
    }));
    const apply=async(q:Queryable,exec:(sql:string)=>Promise<unknown>)=>{
      const exists=await q.query("SELECT to_regclass('public.schema_versions') AS name");
      const prior=exists.rows[0]?.name?(await q.query('SELECT version,sha256 FROM schema_versions ORDER BY version')).rows:[];
      ensure(prior.length<=migrations.length,'DATABASE_VERSION_NEWER_THAN_APPLICATION');
      for(let i=0;i<prior.length;i++)ensure(prior[i].version===migrations[i]!.version&&prior[i].sha256===migrations[i]!.digest,'MIGRATION_DRIFT');
      for(const migration of migrations.slice(prior.length)){
        await exec(migration.sql);
        await q.query('INSERT INTO schema_versions(version,sha256) VALUES($1,$2)',[migration.version,migration.digest]);
      }
    };
    if (this.embedded) await this.embedded.transaction(tx=>apply(tx,sql=>tx.exec(sql)));
    else {
      const client = await this.pool!.connect();
      try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(1463896901)'); await apply(client,sql=>client.query(sql)); await client.query('COMMIT'); }
      catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
  }
  async transaction<T>(operation: (tx: Transaction) => Promise<T>,label?:TransactionOperation): Promise<T> {
    ensure(label===undefined||['import','part','capture','projection','cleanup'].includes(label),'INVALID_TRANSACTION_LABEL');
    const started = performance.now();
    let admitted: number | undefined;
    let acquired: number | undefined;
    let outcome: TransactionTiming['outcome'] = 'failure';
    try {
      let result: T;
      if (this.embedded) result = await this.embedded.transaction(async q => {
        admitted = performance.now();
        await q.query('SELECT id FROM service_lock WHERE id=1 FOR UPDATE');
        acquired = performance.now();
        return operation(new Transaction(q));
      });
      else {
        const client = await this.pool!.connect();
        try {
          await client.query('BEGIN');
          admitted = performance.now();
          await client.query('SELECT id FROM service_lock WHERE id=1 FOR UPDATE');
          acquired = performance.now();
          result = await operation(new Transaction(client));
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }
      outcome = 'success';
      return result;
    } finally {
      const finished = performance.now();
      const timing: Readonly<TransactionTiming> = Object.freeze({
        ...(label?{operation:label}:{}),
        backend: this.embedded ? 'pglite' : 'postgres', outcome,
        admission_ms: (admitted ?? finished) - started,
        lock_wait_ms: admitted === undefined ? 0 : (acquired ?? finished) - admitted,
        hold_ms: acquired === undefined ? 0 : finished - acquired,
        total_ms: finished - started,
      });
      // Observability must not alter commit/rollback semantics or expose errors/content.
      try { this.onTransactionTiming?.(timing); } catch { /* ignore observer errors */ }
    }
  }

  async command<T>(actor: string, key: string, request: unknown, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    ensure(typeof key === 'string' && key.length >= 8 && key.length <= 200, 'IDEMPOTENCY_KEY_REQUIRED');
    const digest = canonicalHash(request);
    return this.transaction(async tx => {
      const claim=(await tx.sql.query('SELECT request_hash,attempt_id FROM storage_command_claims WHERE actor_id=$1 AND key=$2',[actor,key])).rows[0];
      if(claim){ensure(claim.request_hash===digest,'IDEMPOTENCY_CONFLICT',409);ensure(!claim.attempt_id,'STORAGE_OPERATION_IN_PROGRESS',503);}
      const prior = (await tx.sql.query('SELECT * FROM idempotency_keys WHERE actor_id=$1 AND key=$2', [actor,key])).rows[0];
      if (prior) { ensure(prior.request_hash === digest, 'IDEMPOTENCY_CONFLICT', 409); return prior.response as T; }
      const result = wire(await operation(tx));
      await tx.sql.query('INSERT INTO idempotency_keys(actor_id,key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)', [actor,key,digest,canonicalJson(result)]);
      return result;
    });
  }
  async close(): Promise<void> { if (this.embedded) await this.embedded.close(); else await this.pool!.end(); }
}

export { TransactionTimingCollector, TRANSACTION_TIMING_BOUNDS_MS, type TimingAggregate, type TransactionTimingSummary } from './timing.ts';
