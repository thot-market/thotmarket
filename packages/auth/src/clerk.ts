import { createClerkClient, verifyToken } from '@clerk/backend';
import { canonicalHash } from '../../protocol/src/index.ts';
import { DomainError, ensure, type Database, type Document } from '../../storage/src/index.ts';
import type { Actor } from '../../market/src/service.ts';
import { AuthAccessStore, type AuthRateLimits } from './access.ts';
import type { AuthenticatedSession, AuthCapabilities, AuthProvider } from './index.ts';
import type { VerifiedIdentity } from './jwt.ts';

export type ClerkAuthConfig = {
  schema_version: 'thot.clerk-auth/1';
  issuer: string;
  publishable_key: string;
  secret_key: string;
  authorized_parties: string[];
  invited_emails: string[];
  rate_limits?: AuthRateLimits;
};

export type ClerkTokenClaims = { iss?: unknown; sub?: unknown; sid?: unknown; iat?: unknown; exp?: unknown; azp?: unknown };
export type ClerkSessionRecord = { id: string; userId: string; status: string; expireAt: number };
export type ClerkEmailRecord = { id: string; emailAddress: string; verification?: { status?: string } | null };
export type ClerkUserRecord = { id: string; banned: boolean; locked: boolean; primaryEmailAddressId: string | null; emailAddresses: ClerkEmailRecord[] };
export interface ClerkProviderApi {
  verifyToken(token: string, options: { secretKey: string; authorizedParties: string[] }): Promise<ClerkTokenClaims>;
  getSession(id: string): Promise<ClerkSessionRecord>;
  getUser(id: string): Promise<ClerkUserRecord>;
  revokeSession(id: string): Promise<unknown>;
}

const identifier = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const email = (value: unknown): value is string => typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const membershipId = (issuer: string, subject: string) => 'membership:' + canonicalHash({ issuer, subject });

function validateConfig(config: ClerkAuthConfig) {
  ensure(config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).every(key => ['schema_version','issuer','publishable_key','secret_key','authorized_parties','invited_emails','rate_limits'].includes(key)) && config.schema_version === 'thot.clerk-auth/1', 'INVALID_AUTH_CONFIGURATION');
  let issuer: URL;
  try { issuer = new URL(config.issuer); } catch { ensure(false, 'INVALID_AUTH_ISSUER'); }
  ensure(issuer.protocol === 'https:' && issuer.origin === config.issuer && !issuer.username && !issuer.password && !issuer.search && !issuer.hash, 'INVALID_AUTH_ISSUER');
  ensure(identifier(config.publishable_key, 1024) && identifier(config.secret_key, 1024), 'INVALID_AUTH_CONFIGURATION');
  ensure(Array.isArray(config.authorized_parties) && config.authorized_parties.length >= 1 && config.authorized_parties.length <= 8, 'INVALID_AUTH_CONFIGURATION');
  for (const party of config.authorized_parties) { let value: URL; try { value = new URL(party); } catch { ensure(false, 'INVALID_AUTH_CONFIGURATION'); } const local = value.protocol === 'http:' && (value.hostname === 'localhost' || value.hostname === '127.0.0.1'); ensure((value.protocol === 'https:' || local) && value.origin === party && !value.username && !value.password, 'INVALID_AUTH_CONFIGURATION'); }
  ensure(new Set(config.authorized_parties).size === config.authorized_parties.length, 'INVALID_AUTH_CONFIGURATION');
  ensure(Array.isArray(config.invited_emails) && config.invited_emails.length <= 1000 && config.invited_emails.every(email), 'INVALID_AUTH_CONFIGURATION');
  ensure(new Set(config.invited_emails.map(value => value.toLowerCase())).size === config.invited_emails.length, 'INVALID_AUTH_CONFIGURATION');
}

function sdkApi(config: ClerkAuthConfig): ClerkProviderApi {
  const client = createClerkClient({ secretKey: config.secret_key, publishableKey: config.publishable_key });
  return {
    verifyToken: (token, options) => verifyToken(token, options),
    getSession: id => client.sessions.getSession(id),
    getUser: id => client.users.getUser(id),
    revokeSession: id => client.sessions.revokeSession(id)
  };
}

/** Clerk establishes an active session; THOT owns durable identity mapping and authorization. */
export class ClerkAuth implements AuthProvider {
  readonly access: AuthAccessStore;
  readonly capabilities: AuthCapabilities;
  private readonly db: Database; private readonly config: ClerkAuthConfig; private readonly provider: ClerkProviderApi; private readonly clock: () => number;
  private constructor(db: Database, config: ClerkAuthConfig, provider: ClerkProviderApi, clock: () => number) {
    validateConfig(config); this.db = db; this.config = structuredClone(config); this.provider = provider; this.clock = clock;
    this.access = new AuthAccessStore(db, config.issuer, clock, config.rate_limits);
    this.capabilities = { mode: 'clerk', development_session_available: false, external_login_available: true, clerk: { publishable_key: config.publishable_key, frontend_api_url: config.issuer } };
  }
  static async create(db: Database, config: ClerkAuthConfig, provider?: ClerkProviderApi, clock: () => number = Date.now) {
    return new ClerkAuth(db, config, provider ?? sdkApi(config), clock);
  }
  private now() { const value = this.clock(); ensure(Number.isSafeInteger(value) && value >= 0, 'INVALID_AUTH_CLOCK'); return Math.floor(value / 1000); }
  private identity(claims: ClerkTokenClaims): VerifiedIdentity {
    const now = this.now();
    ensure(claims.iss === this.config.issuer && identifier(claims.sub) && identifier(claims.sid) && Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && (claims.iat as number) >= 0 && (claims.iat as number) <= now && (claims.exp as number) > (claims.iat as number) && (claims.exp as number) > now, 'UNAUTHENTICATED', 401);
    ensure(typeof claims.azp === 'string' && this.config.authorized_parties.includes(claims.azp), 'UNAUTHENTICATED', 401);
    return { issuer: claims.iss, subject: claims.sub, jti: claims.sid, issuedAt: claims.iat as number, expiresAt: claims.exp as number };
  }
  private primaryVerifiedEmail(user: ClerkUserRecord): string | undefined {
    const item = user.emailAddresses.find(value => value.id === user.primaryEmailAddressId);
    return item && email(item.emailAddress) && item.verification?.status === 'verified' ? item.emailAddress.toLowerCase() : undefined;
  }
  private async provision(identity: VerifiedIdentity, user: ClerkUserRecord): Promise<void> {
    const id = membershipId(identity.issuer, identity.subject), subjectHash = canonicalHash(identity.subject), invited = this.primaryVerifiedEmail(user);
    await this.db.transaction(async tx => {
      const prior = await tx.maybe('auth_access', id);
      if (prior) return; // Disabled mappings stay disabled and are rejected by AuthAccessStore.
      ensure(invited !== undefined && this.config.invited_emails.map(value => value.toLowerCase()).includes(invited), 'AUTH_INVITATION_REQUIRED', 403);
      const actorId = 'clerk-user-' + canonicalHash({ issuer: identity.issuer, subject: identity.subject }).slice(0, 32), actor: Actor = { id: actorId, role: 'user' };
      const existing = await tx.maybe('users', actorId);
      ensure(!existing, 'AUTH_IDENTITY_CONFLICT', 409);
      ensure(Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='membership'")).rows[0]!.count) < 10000, 'AUTH_MEMBERSHIP_LIMIT', 429);
      await tx.insert('users', actorId, actorId, { role: 'user', revoked_receipts: [], auth_identity_hash: canonicalHash({ issuer: identity.issuer, subject: identity.subject }) });
      await tx.insert('auth_access', id, 'network', { kind: 'membership', issuer: identity.issuer, subject_hash: subjectHash, actor, enabled: true, version: 1, valid_after: 0 });
      await tx.audit('network', 'AuthContributorProvisioned', { membership_id: id, actor_id: actorId, version: 1 });
    });
  }
  async authenticate(token: string): Promise<AuthenticatedSession> {
    ensure(typeof token === 'string' && token.length > 0 && token.length <= 16384, 'UNAUTHENTICATED', 401);
    let claims: ClerkTokenClaims, session: ClerkSessionRecord, user: ClerkUserRecord;
    try {
      claims = await this.provider.verifyToken(token, { secretKey: this.config.secret_key, authorizedParties: [...this.config.authorized_parties] });
      const identity = this.identity(claims);
      try {[session, user] = await Promise.all([this.provider.getSession(identity.jti), this.provider.getUser(identity.subject)]);}
      catch(error){const value=error as {status?:unknown;statusCode?:unknown},status=Number(value?.status??value?.statusCode);throw new DomainError(status===404?'UNAUTHENTICATED':'AUTH_PROVIDER_UNAVAILABLE',status===404?401:503);}
      ensure(session.id === identity.jti && session.userId === identity.subject && session.status === 'active' && session.expireAt > this.clock() && user.id === identity.subject && !user.banned && !user.locked, 'UNAUTHENTICATED', 401);
      await this.provision(identity, user);
      const actor = await this.access.authenticate(identity);
      return { actor, identity, expires_at: new Date(identity.expiresAt * 1000).toISOString() };
    } catch (error) {
      if (error instanceof Error && ['AUTH_INVITATION_REQUIRED','AUTH_IDENTITY_CONFLICT','AUTH_ACTOR_UNAVAILABLE','UNAUTHENTICATED','AUTH_PROVIDER_UNAVAILABLE'].includes(error.message)) throw error;
      ensure(false, 'UNAUTHENTICATED', 401);
    }
  }
  async revoke(identity: VerifiedIdentity, actor: Actor, key: string): Promise<{ revoked: true }> {
    ensure(identity.issuer === this.config.issuer, 'UNAUTHENTICATED', 401);
    let session: ClerkSessionRecord;
    try { session = await this.provider.getSession(identity.jti); await this.provider.revokeSession(identity.jti); } catch { ensure(false, 'AUTH_PROVIDER_UNAVAILABLE', 503); }
    ensure(session.id === identity.jti && session.userId === identity.subject && Number.isSafeInteger(session.expireAt) && session.expireAt > this.clock(), 'UNAUTHENTICATED', 401);
    const revoked = await this.access.revoke({ ...identity, expiresAt: Math.max(identity.expiresAt, Math.ceil(session.expireAt / 1000)) }, actor, key);
    return { revoked: revoked.revoked as true };
  }
}
