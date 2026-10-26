import { canonicalHash, canonicalJson } from '../../protocol/src/index.ts';
import { ensure, type Database, type Document, type Transaction } from '../../storage/src/index.ts';
import type { Actor } from '../../market/src/service.ts';
import type { VerifiedIdentity } from './jwt.ts';

export type MembershipInput = { subject: string; actor: Actor; enabled: boolean; expected_version?: number };
export type AuthRateLimits = { requests_per_minute: number; mutations_per_minute: number };
const defaultLimits: AuthRateLimits = { requests_per_minute: 180, mutations_per_minute: 60 };
const allowedRoles = ['user', 'buyer_admin', 'buyer_member', 'operator_support', 'operator_security', 'operator_maintenance'];
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const membershipId = (issuer: string, subject: string) => 'membership:' + canonicalHash({ issuer, subject });
const revokedId = (identity: VerifiedIdentity) => 'revoked:' + canonicalHash({ issuer: identity.issuer, jti: identity.jti });
// Every request authenticates and counts against its rate limit. Doing both as database transactions
// serialized all traffic behind them on the single embedded connection, so successful checks are reused
// for a few seconds (cleared on any revocation or membership change) and rate windows are counted in
// memory, shared by every store on the same database in this process.
// shortcut: rate windows reset on restart; move them back to storage if several API processes ever share one database.
const AUTH_CACHE_MS = 10_000;
const rateWindows = new WeakMap<Database, Map<string, { window_start_ms: number; requests: number; mutations: number }>>();
export function validateActor(actor: Actor): void {
  canonicalJson(actor);
  ensure(actor && typeof actor === 'object' && !Array.isArray(actor) && Object.keys(actor).every(key => ['id', 'role', 'buyer_id'].includes(key)), 'INVALID_AUTH_ACTOR');
  ensure(identifier(actor.id) && allowedRoles.includes(actor.role), 'INVALID_AUTH_ACTOR');
  const buyer = ['buyer_admin', 'buyer_member'].includes(actor.role);
  ensure(buyer ? identifier(actor.buyer_id) : actor.buyer_id === undefined, 'INVALID_AUTH_ACTOR');
}

/** Operator-provisioned authorization, revocation and quotas in serialized SQL transactions. */
export class AuthAccessStore {
  readonly limits: AuthRateLimits;
  private readonly db: Database; readonly issuer: string; private readonly clock: () => number;
  constructor(db: Database, issuer: string, clock: () => number = Date.now, limits: AuthRateLimits = defaultLimits) {
    ensure(Object.keys(limits).length === 2 && Number.isSafeInteger(limits.requests_per_minute) && limits.requests_per_minute >= 1 && limits.requests_per_minute <= 600 && Number.isSafeInteger(limits.mutations_per_minute) && limits.mutations_per_minute >= 1 && limits.mutations_per_minute <= limits.requests_per_minute, 'INVALID_AUTH_RATE_LIMITS');
    this.db = db; this.issuer = issuer; this.clock = clock; this.limits = { ...limits };
  }
  private authenticated = new Map<string, { actor: Actor; until: number }>();
  private now() { const now = this.clock(); ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_AUTH_CLOCK'); return now; }
  private async knownActor(tx: Transaction, actor: Actor) {
    validateActor(actor);
    const row = await tx.maybe('users', actor.id);
    ensure(row && row.owner_id === actor.id && row.disabled !== true && row.role === actor.role, 'AUTH_ACTOR_UNAVAILABLE', 403);
    if (actor.buyer_id) {
      ensure(row.buyer_id === actor.buyer_id, 'AUTH_MEMBERSHIP_UNAVAILABLE', 403);
      const buyer = await tx.maybe('buyers', actor.buyer_id);
      ensure(buyer && buyer.owner_id === actor.buyer_id && buyer.approved === true, 'BUYER_NOT_APPROVED', 403);
    }
  }
  private validateMembership(input: MembershipInput) {
    canonicalJson(input);
    ensure(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['subject', 'actor', 'enabled', 'expected_version'].includes(key)), 'INVALID_AUTH_MEMBERSHIP');
    ensure(identifier(input.subject) && typeof input.enabled === 'boolean', 'INVALID_AUTH_MEMBERSHIP'); validateActor(input.actor);
    ensure(input.expected_version === undefined || Number.isSafeInteger(input.expected_version) && input.expected_version >= 0, 'INVALID_AUTH_REVISION');
  }
  private async save(tx: Transaction, input: MembershipInput, initial: boolean) {
    this.authenticated.clear();
    this.validateMembership(input);
    const id = membershipId(this.issuer, input.subject), prior = await tx.maybe('auth_access', id);
    if (initial && prior) return prior; // Restart never undoes a persisted revocation or membership change.
    ensure(initial || input.expected_version === (prior?.version ?? 0), 'AUTH_REVISION_CONFLICT', 409);
    await this.knownActor(tx, input.actor);
    if (!prior) ensure(Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='membership'")).rows[0]!.count) < 10000, 'AUTH_MEMBERSHIP_LIMIT', 429);
    const record = { kind: 'membership', issuer: this.issuer, subject_hash: canonicalHash(input.subject), actor: structuredClone(input.actor), enabled: input.enabled, version: (prior?.version ?? 0) + 1, valid_after: initial ? 0 : Math.floor(this.now() / 1000) };
    if (prior) await tx.update('auth_access', id, record); else await tx.insert('auth_access', id, 'network', record);
    await tx.audit('network', 'AuthMembershipProvisioned', { membership_id: id, version: record.version, enabled: record.enabled });
    return { membership_id: id, version: record.version, enabled: record.enabled, actor: record.actor, valid_after: record.valid_after };
  }
  async seed(inputs: MembershipInput[]) {
    ensure(Array.isArray(inputs) && inputs.length <= 1000, 'INVALID_AUTH_INITIAL_MEMBERSHIPS');
    const ids = inputs.map(input => membershipId(this.issuer, input.subject)); ensure(new Set(ids).size === ids.length, 'DUPLICATE_AUTH_MEMBERSHIP');
    await this.db.transaction(async tx => { for (const input of inputs) { ensure(input.expected_version === undefined, 'INVALID_AUTH_INITIAL_MEMBERSHIPS'); await this.save(tx, input, true); } });
  }
  async provision(operator: Actor, key: string, input: MembershipInput) {
    ensure(operator.role === 'operator_security', 'FORBIDDEN', 403);
    return this.db.command(operator.id, key, { action: 'authProvision', issuer: this.issuer, input }, async tx => {
      await this.knownActor(tx, operator); return this.save(tx, input, false);
    });
  }
  async authenticate(identity: VerifiedIdentity): Promise<Actor> {
    ensure(identity.issuer === this.issuer, 'UNAUTHENTICATED', 401);
    const key = revokedId(identity) + membershipId(identity.issuer, identity.subject), cached = this.authenticated.get(key), nowMs = this.now();
    if (cached && cached.until > nowMs) return structuredClone(cached.actor);
    const actor = await this.db.transaction(async tx => {
      const now = Math.floor(this.now() / 1000), membership = await tx.maybe('auth_access', membershipId(identity.issuer, identity.subject));
      ensure(membership?.kind === 'membership' && membership.issuer === this.issuer && membership.enabled === true && Number.isSafeInteger(membership.version) && membership.version >= 1 && Number.isSafeInteger(membership.valid_after) && membership.valid_after >= 0 && identity.issuedAt > membership.valid_after && identity.expiresAt > now, 'UNAUTHENTICATED', 401);
      const revoked = await tx.maybe('auth_access', revokedId(identity));
      ensure(!revoked || revoked.expires_at <= now, 'UNAUTHENTICATED', 401);
      await this.knownActor(tx, membership.actor); return structuredClone(membership.actor);
    });
    if (this.authenticated.size > 10_000) this.authenticated.clear();
    this.authenticated.set(key, { actor: structuredClone(actor), until: Math.min(nowMs + AUTH_CACHE_MS, identity.expiresAt * 1000) });
    return actor;
  }
  async revoke(identity: VerifiedIdentity, actor: Actor, key: string) {
    ensure(identity.issuer === this.issuer, 'UNAUTHENTICATED', 401);
    this.authenticated.clear();
    return this.db.command(actor.id, key, { action: 'authRevoke', token_id: revokedId(identity) }, async tx => {
      const membership = await tx.maybe('auth_access', membershipId(identity.issuer, identity.subject));
      ensure(membership?.actor?.id === actor.id, 'FORBIDDEN', 403);
      const id = revokedId(identity), prior = await tx.maybe('auth_access', id);
      if (!prior) {
        // Only expired denylist entries are removed; active revocations survive restart.
        await tx.sql.query("DELETE FROM auth_access WHERE document->>'kind'='jwt_revocation' AND (document->>'expires_at')::numeric <= $1", [Math.floor(this.now() / 1000)]);
        ensure(Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='jwt_revocation'")).rows[0]!.count) < 10000, 'AUTH_REVOCATION_LIMIT', 429);
        await tx.insert('auth_access', id, 'network', { kind: 'jwt_revocation', expires_at: identity.expiresAt });
        await tx.audit('network', 'AuthCredentialRevoked', { token_id: id });
      }
      return { revoked: true };
    });
  }
  async consume(actor: Actor, mutation: boolean) {
    let windows = rateWindows.get(this.db); if (!windows) rateWindows.set(this.db, windows = new Map());
    const id = 'rate:' + canonicalHash(actor.id), now = this.now(), prior = windows.get(id);
    const record = prior && now >= prior.window_start_ms && now - prior.window_start_ms < 60000 ? prior : { window_start_ms: now, requests: 0, mutations: 0 };
    ensure(record.requests < this.limits.requests_per_minute && (!mutation || record.mutations < this.limits.mutations_per_minute), 'ACTOR_RATE_LIMIT', 429);
    record.requests++; if (mutation) record.mutations++;
    if (windows.size > 50_000) for (const [key, value] of windows) if (now - value.window_start_ms >= 60000) windows.delete(key);
    windows.set(id, record);
  }

}
