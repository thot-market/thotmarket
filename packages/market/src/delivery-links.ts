import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../../storage/src/index.ts';
import { releaseHash, type Actor, type ThotService } from './service.ts';
import { assertOperationEnabled } from './operational-controls.ts';

const maximumLifetimeMs = 60_000;
type DeliveryScope = {
  schema_version: 'thot.delivery-link/1';
  actor_id: string;
  buyer_id: string;
  license_id: string;
  release_artifact_hash: string;
  issued_at_ms: number;
  expires_at_ms: number;
  nonce: string;
};
export interface DeliveryLinkOptions { clock?: () => number; signingKey?: Uint8Array }

/** Authenticated, scope-limited reads, not public object-store URLs or transferable licenses. */
export class DeliveryLinks {
  private service: ThotService;
  private key: Buffer;
  private clock: () => number;
  constructor(service: ThotService, options: DeliveryLinkOptions = {}) {
    this.service = service;
    this.key = options.signingKey ? Buffer.from(options.signingKey) : randomBytes(32);
    ensure(this.key.length >= 32, 'DELIVERY_SIGNING_KEY_TOO_SHORT');
    this.clock = options.clock ?? (() => Date.parse(service.now()));
  }
  private now(): number {
    const now = this.clock();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_DELIVERY_CLOCK');
    return now;
  }
  private requireBuyer(actor: Actor): string {
    ensure(['buyer_admin', 'buyer_member'].includes(actor.role) && actor.buyer_id, 'FORBIDDEN', 403);
    return actor.buyer_id;
  }
  private signature(encoded: string): Buffer { return createHmac('sha256', this.key).update('thot.delivery-link/1\0').update(encoded).digest(); }
  private async access(tx: Transaction, actor: Actor, id: string, now: number) {
    await assertOperationEnabled(tx,'deliveries');
    const buyer = this.requireBuyer(actor);
    ensure((await tx.get('buyers', buyer, buyer)).approved, 'BUYER_NOT_APPROVED', 403);
    const delivery = await tx.get('deliveries', id, buyer), license = await tx.get('licenses', id);
    if(this.service.moneyPath)await this.service.moneyPath.assertPaid(tx,id);
    ensure(license.buyer_id === buyer, 'NOT_FOUND', 404);
    const retention = Date.parse(license.retention_expires_at);
    ensure(Number.isFinite(retention) && retention > now, 'DELIVERY_EXPIRED', 410);
    ensure(['AVAILABLE', 'DELIVERED'].includes(delivery.status), 'DELIVERY_UNAVAILABLE', 410);
    const artifact = await tx.get('release_artifacts', id, license.owner_user_id);
    ensure(artifact.release_hash === license.release_artifact_hash && /^[a-f0-9]{64}$/.test(license.release_artifact_hash), 'RELEASE_TAMPERED');
    return { buyer, delivery, license, artifact, retention };
  }
  async issue(actor: Actor, key: string, id: string, input: Document = {}) {
    const buyer = this.requireBuyer(actor);
    if(this.service.moneyPath)await this.service.moneyPath.verifyDelivery(actor,id);
    ensure(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(field => field === 'ttl_seconds'), 'INVALID_DELIVERY_LINK_REQUEST');
    const ttl = Object.hasOwn(input, 'ttl_seconds') ? input.ttl_seconds : 60;
    ensure(Number.isSafeInteger(ttl) && ttl >= 1 && ttl <= 60, 'INVALID_DELIVERY_LINK_TTL');
    return this.service.db.command(actor.id, key, { action: 'deliveryLink', license_id: id, input }, async tx => {
      const now = this.now(), { license, retention } = await this.access(tx, actor, id, now);
      const scope: DeliveryScope = { schema_version: 'thot.delivery-link/1', actor_id: actor.id, buyer_id: buyer, license_id: id, release_artifact_hash: license.release_artifact_hash, issued_at_ms: now, expires_at_ms: Math.min(now + ttl * 1000, retention), nonce: randomBytes(24).toString('base64url') };
      const encoded = Buffer.from(canonicalJson(scope)).toString('base64url'), capability = `${encoded}.${this.signature(encoded).toString('base64url')}`;
      const expires = new Date(scope.expires_at_ms).toISOString();
      await tx.audit(buyer, 'DeliveryLinkIssued', { license_id: id, release_hash: scope.release_artifact_hash, expires_at: expires });
      return { schema_version: 'thot.delivery-link-response/1', license_id: id, release_artifact_hash: scope.release_artifact_hash, download_url: `/v1/buyer/deliveries/${encodeURIComponent(id)}/download?capability=${capability}`, expires_at: expires, authentication: 'same_actor_and_buyer_bearer_required', replay_policy: 'repeatable_read_until_expiry', maximum_ttl_seconds: 60 };
    });
  }
  private verify(actor: Actor, id: string, capability: unknown): DeliveryScope {
    const buyer = this.requireBuyer(actor);
    ensure(typeof capability === 'string' && capability.length <= 4096, 'INVALID_DELIVERY_LINK', 403);
    const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(capability);
    ensure(parts, 'INVALID_DELIVERY_LINK', 403);
    const encoded = parts[1]!, signature = Buffer.from(parts[2]!, 'base64url'), expected = this.signature(encoded);
    ensure(signature.length === expected.length && signature.toString('base64url') === parts[2] && timingSafeEqual(signature, expected), 'INVALID_DELIVERY_LINK', 403);
    const bytes = Buffer.from(encoded, 'base64url');
    ensure(bytes.toString('base64url') === encoded, 'INVALID_DELIVERY_LINK', 403);
    let scope: DeliveryScope;
    try { scope = JSON.parse(bytes.toString('utf8')); } catch { ensure(false, 'INVALID_DELIVERY_LINK', 403); }
    ensure(scope && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).sort().join(',') === ['schema_version', 'actor_id', 'buyer_id', 'license_id', 'release_artifact_hash', 'issued_at_ms', 'expires_at_ms', 'nonce'].sort().join(','), 'INVALID_DELIVERY_LINK', 403);
    ensure(canonicalJson(scope) === bytes.toString('utf8') && scope.schema_version === 'thot.delivery-link/1' && /^[a-f0-9]{64}$/.test(scope.release_artifact_hash) && /^[A-Za-z0-9_-]{32}$/.test(scope.nonce), 'INVALID_DELIVERY_LINK', 403);
    ensure(scope.actor_id === actor.id && scope.buyer_id === buyer && scope.license_id === id, 'DELIVERY_LINK_SCOPE_MISMATCH', 403);
    ensure(Number.isSafeInteger(scope.issued_at_ms) && Number.isSafeInteger(scope.expires_at_ms) && scope.issued_at_ms >= 0 && scope.expires_at_ms > scope.issued_at_ms && scope.expires_at_ms - scope.issued_at_ms <= maximumLifetimeMs, 'INVALID_DELIVERY_LINK', 403);
    const now = this.now();
    ensure(scope.issued_at_ms <= now && scope.expires_at_ms > now, 'DELIVERY_LINK_EXPIRED', 410);
    return scope;
  }
  async redeem(actor: Actor, id: string, capability: unknown) {
    const scope = this.verify(actor, id, capability);
    if(this.service.moneyPath)await this.service.moneyPath.verifyDelivery(actor,id);
    return this.service.db.transaction(async tx => {
      // Recheck after taking the service lock: waiting must not extend link or license life.
      const now = this.now();
      ensure(scope.issued_at_ms <= now && scope.expires_at_ms > now, 'DELIVERY_LINK_EXPIRED', 410);
      const { buyer, delivery, license, artifact } = await this.access(tx, actor, id, now);
      ensure(license.release_artifact_hash === scope.release_artifact_hash, 'DELIVERY_LINK_SCOPE_MISMATCH', 403);
      const bundle = await this.service.privacy.open(license.owner_user_id, artifact.object_ref);
      ensure(releaseHash(bundle) === scope.release_artifact_hash && bundle.delivery.bundle_hash === scope.release_artifact_hash, 'RELEASE_TAMPERED');
      ensure(scope.expires_at_ms > this.now(), 'DELIVERY_LINK_EXPIRED', 410);
      delivery.retrieval_count++; delivery.status = 'DELIVERED';
      await tx.update('deliveries', id, delivery);
      await tx.audit(buyer, 'DeliveryCompleted', { license_id: id, release_hash: scope.release_artifact_hash, access: 'authenticated_signed_link' });
      return bundle;
    });
  }
}
