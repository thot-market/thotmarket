import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { canonicalHash, canonicalJson, uuidv7 } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import type { Actor, ThotService } from './service.ts';
import { externalBrokerageVerifier, type EvidenceVerifier, type RobinhoodConfig } from './robinhood-link.ts';

type TradeConfig = RobinhoodConfig & { tradeVerifierArgs?: string[] };
const user = (a: Actor) => ensure(a.role === 'user', 'FORBIDDEN', 403);
const digest = (v: unknown) => canonicalHash(v);
const ticketDigest = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const iso = (v: unknown) => { const n = Date.parse(String(v)); ensure(Number.isFinite(n), 'INVALID_OBSERVATION_TIME'); return new Date(n).toISOString(); };

/** A narrowly scoped, owner-bound witness challenge for a traded outcome. */
export class ThotTradeEvidence {
  readonly service: ThotService;
  readonly publicKey: string;
  private readonly verifier?: EvidenceVerifier;
  private readonly signingKey: ReturnType<typeof createPrivateKey>;
  private inFlight = 0;
  private owners = new Set<string>();
  private readonly config?: TradeConfig;

  constructor(service: ThotService, masterKey: Buffer, config?: TradeConfig, verifier?: EvidenceVerifier) {
    this.service = service; this.config = config;
    const seed = createHmac('sha256', masterKey).update('thot-robinhood-link-ticket-v1').digest();
    this.signingKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der' });
    this.publicKey = createPublicKey(this.signingKey).export({ type: 'spki', format: 'pem' }).toString();
    // Trade verification is deliberately a distinct configuration capability.
    if (verifier) this.verifier = verifier;
    else if (config?.tradeVerifierArgs) this.verifier = externalBrokerageVerifier({ ...config, verifierArgs: config.tradeVerifierArgs }, this.publicKey);
    if (config) for (const address of [config.witnessUrl, config.appraiserUrl]) { const u = new URL(address); ensure(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash, 'INVALID_ROBINHOOD_CONFIG'); }
  }

  enabled() { return !!this.verifier; }

  private ticket(owner: string, jobId: string) {
    const issued = Math.floor(Date.parse(this.service.now()) / 1000) * 1000;
    const payload = { schema_version: 'thot.robinhood-link-ticket/1', job_id: jobId, owner_user_id: owner, nonce: randomBytes(32).toString('hex'), issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 600000).toISOString(), audience: 'trace-vault-robinhood' };
    const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
    return { ...payload, ticket: encoded + '.' + sign(null, Buffer.from(encoded), this.signingKey).toString('base64url') };
  }

  private async current(tx: Transaction, actor: Actor, traceId: string) {
    const t = await tx.get('traces', traceId, actor.id);
    ensure(!t.deleted && (!t.retention_expires_at || Date.parse(t.retention_expires_at) > Date.parse(this.service.now())), 'TRACE_UNAVAILABLE', 410);
    ensure(['eligible', 'eligible_with_restrictions'].includes(t.rights_status), 'TRACE_INELIGIBLE');
    const content = await this.service.privacy.open(actor.id, t.scrub_ref);
    const contentHash = '0x' + digest(content);
    const observed = iso(t.observed_at);
    return { t, contentHash, observed };
  }

  async begin(actor: Actor, key: string, input: Document) {
    user(actor); ensure(this.verifier, 'TRADE_EVIDENCE_UNAVAILABLE', 503);
    ensure(input && Object.keys(input).every(k => ['trace_id', 'symbol', 'window_days'].includes(k)) && typeof input.trace_id === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(input.symbol) && Number.isInteger(input.window_days) && input.window_days >= 1 && input.window_days <= 365, 'INVALID_TRADE_REQUEST');
    return this.service.db.command(actor.id, key, { action: 'tradeEvidence.begin', input }, async tx => {
      const { t, contentHash, observed } = await this.current(tx, actor, input.trace_id);
      const rows = await tx.list('thot_records', actor.id);
      const jobs = rows.filter(r => r.kind === 'trade_evidence_job' && r.trace_id === input.trace_id);
      const pending = jobs.find(j => j.status === 'pending' && Date.parse(j.expires_at) > Date.parse(this.service.now()) && j.content_hash === contentHash && j.symbol === input.symbol && j.window_days === input.window_days);
      if (pending) return this.jobResponse(pending);
      ensure(jobs.length < 3, 'TRADE_EVIDENCE_JOB_LIMIT', 429);
      const base = this.ticket(actor.id, uuidv7());
      const job = { ...base, kind: 'trade_evidence_job', status: 'pending', trace_id: input.trace_id, content_hash: contentHash, symbol: input.symbol, window_days: input.window_days, trace_ts: observed, created_at: this.service.now() };
      await tx.insert('thot_records', 'trade-job:' + job.job_id, actor.id, job);
      await tx.audit(actor.id, 'ThotTradeEvidenceStarted', { job_id: job.job_id, trace_id: input.trace_id, content_hash: contentHash });
      return this.jobResponse(job);
    });
  }

  private jobResponse(j: Document) { return { job_id: j.job_id, link_ticket: j.ticket, expires_at: j.expires_at, request: { symbol: j.symbol, window_days: j.window_days, trace_ts: j.trace_ts }, ...(this.config ? { witness_url: this.config.witnessUrl, appraiser_url: this.config.appraiserUrl } : {}) }; }

  async complete(actor: Actor, key: string, input: Document) {
    user(actor); ensure(this.verifier, 'TRADE_EVIDENCE_UNAVAILABLE', 503);
    const evidence = structuredClone(input?.evidence);
    ensure(evidence && Object.keys(evidence).every(k => k === 'credential' || k === 'witness_receipts') && evidence.credential && Array.isArray(evidence.witness_receipts), 'INVALID_CREDENTIAL_ENVELOPE');
    ensure(Buffer.byteLength(JSON.stringify(evidence)) <= 1_000_000, 'CREDENTIAL_EVIDENCE_TOO_LARGE');
    const prepared = await this.service.db.transaction(async tx => { const j = await tx.get('thot_records', 'trade-job:' + input.job_id, actor.id); ensure(j.kind === 'trade_evidence_job', 'NOT_FOUND', 404); return structuredClone(j); });
    const evidenceHash = digest(evidence);
    if (prepared.status === 'completed') { ensure(prepared.evidence_hash === evidenceHash, 'TRADE_EVIDENCE_ALREADY_COMPLETED', 409); return this.service.db.transaction(async tx => this.summary(await tx.get('thot_records', prepared.evidence_id, actor.id))); }
    ensure(prepared.status === 'pending' && Date.parse(prepared.expires_at) > Date.parse(this.service.now()), 'TRADE_EVIDENCE_JOB_EXPIRED', 409);
    ensure(this.inFlight < 2 && !this.owners.has(actor.id), 'TRADE_EVIDENCE_VERIFIER_BUSY', 429);
    this.inFlight++; this.owners.add(actor.id);
    let result: Document;
    try { result = await this.verifier(evidence, prepared.ticket); } catch { throw new Error('ROBINHOOD_EVIDENCE_REJECTED'); } finally { this.inFlight--; this.owners.delete(actor.id); }
    ensure(result?.verified === true && result.purpose === 'trace-vault.credential.robinhood-traded-outcome.v1' && result.owner_user_id === actor.id && result.job_id === prepared.job_id && result.link_ticket_hash === ticketDigest(prepared.ticket), 'TRADE_EVIDENCE_SUBJECT_MISMATCH');
    ensure(result.symbol === prepared.symbol && result.window_days === prepared.window_days && result.value === true && result.scope === 'observed_records' && result.trace_ts === prepared.trace_ts, 'TRADE_EVIDENCE_REQUEST_MISMATCH');
    const observed = iso(result.observed_at); const observedMs = Date.parse(observed); const nowMs = Date.parse(this.service.now());
    ensure(observedMs >= Date.parse(prepared.issued_at) - 30000 && observedMs <= nowMs && nowMs - observedMs < 600000, 'TRADE_EVIDENCE_TIME_INVALID');
    const expires = new Date(Date.parse(observed) + 86400000).toISOString(); ensure(Date.parse(result.valid_until) === Date.parse(expires), 'TRADE_EVIDENCE_EXPIRY_MISMATCH');
    return this.service.db.command(actor.id, key, { action: 'tradeEvidence.complete', job_id: input.job_id, evidence_hash: evidenceHash }, async tx => {
      const current = await tx.get('thot_records', 'trade-job:' + input.job_id, actor.id);
      if (current.status === 'completed') { ensure(current.evidence_hash === evidenceHash, 'TRADE_EVIDENCE_ALREADY_COMPLETED', 409); return this.summary(await tx.get('thot_records', current.evidence_id, actor.id)); }
      ensure(current.status === 'pending' && current.ticket === prepared.ticket && Date.parse(current.expires_at) > Date.parse(this.service.now()), 'TRADE_EVIDENCE_JOB_CHANGED', 409);
      const source = await this.current(tx, actor, current.trace_id); ensure(source.contentHash === current.content_hash && source.observed === current.trace_ts, 'TRACE_CHANGED', 409);
      const packageValue = { evidence, link_ticket: prepared.ticket, thot_public_key_pem: this.publicKey, verification: result };
      const ref = await this.service.privacy.seal(actor.id, packageValue);
      const id = 'trade-evidence:' + uuidv7();
      const retention = Date.parse(source.t.retention_expires_at);
      const row = { kind: 'trade_evidence', trace_id: current.trace_id, content_hash: current.content_hash, claim: `traded:${current.symbol}:within_${current.window_days}d`, symbol: current.symbol, window_days: current.window_days, value: true, trace_ts: current.trace_ts, observed_at: observed, expires_at: new Date(Number.isFinite(retention) ? Math.min(Date.parse(expires), retention) : Date.parse(expires)).toISOString(), available_after: current.expires_at, evidence_hash: digest(packageValue), scope: 'observed_records', object_ref: ref, created_at: this.service.now() };
      await tx.insert('thot_records', id, actor.id, { ...row, id }); Object.assign(current, { status: 'completed', evidence_id: id, evidence_hash: evidenceHash }); delete current.ticket; await tx.update('thot_records', current.id, current); await tx.audit(actor.id, 'ThotTradeEvidenceCompleted', { job_id: current.job_id, evidence_id: id, evidence_hash: row.evidence_hash });
      return this.summary({ ...row, id });
    });
  }

  private summary(r: Document): Document { return { id: r.id, trade_evidence_id: r.id, trace_id: r.trace_id, content_hash: r.content_hash, claim: r.claim, symbol: r.symbol, window_days: r.window_days, value: true, trace_ts: r.trace_ts, observed_at: r.observed_at, expires_at: r.expires_at, available_after: r.available_after, evidence_hash: r.evidence_hash, scope: r.scope }; }
  async list(tx: Transaction, actor: Actor, traceId: string, contentHash: string): Promise<Document[]>;
  async list(actor: Actor, traceId: string, contentHash: string): Promise<Document[]>;
  async list(a: Transaction | Actor, b: Actor | string, c: string, d?: string): Promise<Document[]> {
    const tx = a instanceof Object && 'get' in a ? a as Transaction : undefined; const actor = (tx ? b : a) as Actor; const traceId = (tx ? c : b) as string; const hash = '0x' + String((tx ? d : c) as string).replace(/^0x/, ''); user(actor);
    const work = async (x: Transaction) => { const now = Date.parse(this.service.now()); let source; try { source = await this.current(x, actor, traceId); } catch { return []; } if (source.contentHash !== hash) return []; return (await x.list('thot_records', actor.id)).filter(r => r.kind === 'trade_evidence' && r.trace_id === traceId && r.content_hash === hash && !r.revoked && Date.parse(r.expires_at) > now).map(r => this.summary(r)); };
    return tx ? work(tx) : this.service.db.transaction(work);
  }

  async attachment(tx: Transaction, actor: Actor, input: Document, trace: string | Document, contentHash: string): Promise<Document | undefined> {
    user(actor); if (!input?.trade_evidence_id && input?.trade_evidence_hash === undefined && input?.trade_evidence_disclosure === undefined) return undefined;
    ensure(input.trade_evidence_id && input.trade_evidence_hash && input.trade_evidence_disclosure === true, 'TRADE_EVIDENCE_CONSENT_REQUIRED');
    const traceId = typeof trace === 'string' ? trace : trace.trace_id; const hash = '0x' + String(contentHash).replace(/^0x/, '');
    const row = await tx.get('thot_records', input.trade_evidence_id, actor.id); ensure(row.kind === 'trade_evidence' && row.trace_id === traceId && row.content_hash === hash && !row.revoked && Date.parse(row.expires_at) > Date.parse(this.service.now()), 'TRADE_EVIDENCE_UNAVAILABLE');
    ensure(input.trade_evidence_hash === row.evidence_hash && Date.parse(this.service.now()) >= Date.parse(row.available_after), 'TRADE_EVIDENCE_UNAVAILABLE');
    const proof = await this.service.privacy.open(actor.id, row.object_ref); ensure(digest(proof) === row.evidence_hash, 'TRADE_EVIDENCE_TAMPERED');
    const { claim, symbol, window_days, value, trace_ts, observed_at, expires_at, scope } = row;
    return { schema_version: 'thot.brokerage-evidence/1', summary: { claim, symbol, window_days, value, trace_ts, observed_at, expires_at, scope }, binding: { trace_content_hash: hash, reference_time_basis: 'trace-observed-start', account_continuity: 'not-established', research_causality: 'not-established' }, proof };
  }

  async cleanup(tx: Transaction, traceId: string) { for (const r of await tx.list('thot_records')) if ((r.kind === 'trade_evidence' || r.kind === 'trade_evidence_job') && r.trace_id === traceId) { if (r.object_ref) await this.service.privacy.remove(r.owner_id, r.object_ref); if (r.kind === 'trade_evidence') { r.revoked = true; r.object_ref = null; await tx.update('thot_records', r.id, r); } else { r.status = 'revoked'; delete r.ticket; await tx.update('thot_records', r.id, r); } } }

  async assertListingCurrent(tx: Transaction, listing: Document) { if (!listing.trade_evidence_id) return; const row = await tx.get('thot_records', listing.trade_evidence_id, listing.owner_id); ensure(row.kind === 'trade_evidence' && row.trace_id === listing.trace_id && (!listing.release_content_hash || row.content_hash === ('0x' + String(listing.release_content_hash).replace(/^0x/, ''))) && !row.revoked && Date.parse(row.expires_at) > Date.parse(this.service.now()), 'TRADE_EVIDENCE_UNAVAILABLE'); const source = await this.current(tx, { id: row.owner_id, role: 'user' }, row.trace_id); ensure(source.contentHash === row.content_hash, 'TRACE_CHANGED', 409); }
}
