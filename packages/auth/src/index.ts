import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ensure, type Database } from '../../storage/src/index.ts';
import { PinnedJwtVerifier, type JwtPolicy } from './jwt.ts';
import { AuthAccessStore, type MembershipInput, type AuthRateLimits } from './access.ts';
import { strictJson } from './json.ts';
import type { Actor } from '../../market/src/service.ts';
import type { VerifiedIdentity } from './jwt.ts';
export { PinnedJwtVerifier } from './jwt.ts';
export { AuthAccessStore } from './access.ts';
export { strictJson } from './json.ts';
export type { VerifiedIdentity, JwtPolicy } from './jwt.ts';
export type { MembershipInput, AuthRateLimits } from './access.ts';
export { ClerkAuth } from './clerk.ts';
export type { ClerkAuthConfig, ClerkProviderApi, ClerkTokenClaims, ClerkSessionRecord, ClerkUserRecord } from './clerk.ts';
export { WalletAuth, walletAuthOrigins, loadWalletAuthConfig, WALLET_CHAIN_ID, WALLET_CHAIN_IDS, WALLET_CHALLENGE_SECONDS, WALLET_SESSION_COOKIE, WALLET_CHALLENGE_COOKIE } from './wallet.ts';
export type { WalletAuthConfig, WalletChainId } from './wallet.ts';
export type AuthCapabilities = { mode: 'external_jwt'|'clerk'|'wallet_siwe'; development_session_available: false; external_login_available: boolean; algorithm?: string; token_type?: string; maximum_token_age_seconds?: number; clerk?: { publishable_key: string; frontend_api_url: string }; wallet?: { origin: string; chain_id: number; rpc_url: string; session_ttl_seconds: number; signature_type: 'eip191'; wallet_type: 'evm-eoa' } };
export type AuthenticatedSession = { actor: Actor; identity: VerifiedIdentity; expires_at: string };
export interface AuthProvider { readonly access: AuthAccessStore; readonly capabilities: AuthCapabilities; authenticate(token: string): Promise<AuthenticatedSession>; revoke?(identity: VerifiedIdentity, actor: Actor, key: string): Promise<{ revoked: true }> }
export type ExternalAuthConfig = { schema_version: 'thot.external-auth/1'; jwt: JwtPolicy; initial_memberships: MembershipInput[]; rate_limits?: AuthRateLimits };

export class ExternalAuth implements AuthProvider {
  readonly verifier: PinnedJwtVerifier; readonly access: AuthAccessStore;
  readonly capabilities: AuthCapabilities;
  private readonly clock: () => number;
  private constructor(db: Database, config: ExternalAuthConfig, clock: () => number) {
    ensure(config && typeof config === 'object' && Object.keys(config).every(key => ['schema_version', 'jwt', 'initial_memberships', 'rate_limits'].includes(key)) && config.schema_version === 'thot.external-auth/1', 'INVALID_AUTH_CONFIGURATION');
    this.clock = clock; this.verifier = new PinnedJwtVerifier(config.jwt); this.access = new AuthAccessStore(db, this.verifier.issuer, clock, config.rate_limits);
    this.capabilities = { mode: 'external_jwt', development_session_available: false, external_login_available: false, algorithm: 'RS256', token_type: 'at+jwt', maximum_token_age_seconds: this.verifier.maxAge };
  }
  static async create(db: Database, config: ExternalAuthConfig, clock: () => number = Date.now) {
    const auth = new ExternalAuth(db, config, clock); await auth.access.seed(config.initial_memberships); return auth;
  }
  async authenticate(token: string) {
    const identity = this.verifier.verify(token, this.clock()), actor = await this.access.authenticate(identity);
    return { actor, identity, expires_at: new Date(identity.expiresAt * 1000).toISOString() };
  }
}

/** Read exactly one explicit operator path. No discovery, network fetch, credential scan or symlink. */
export async function loadAuthConfig(path: string): Promise<ExternalAuthConfig> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { ensure(false, 'AUTH_CONFIGURATION_UNAVAILABLE'); }
  try {
    const stat = await handle.stat(); ensure(stat.isFile() && stat.size <= 262144 && (stat.mode & 0o022) === 0, 'INSECURE_AUTH_CONFIGURATION');
    return strictJson(await handle.readFile(), 262144);
  } finally { await handle.close(); }
}
