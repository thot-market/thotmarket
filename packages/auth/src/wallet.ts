import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { canonicalHash } from '../../protocol/src/index.ts';
import { ensure, type Database, type Transaction } from '../../storage/src/index.ts';
import type { Actor } from '../../market/src/service.ts';
import { AuthAccessStore, type AuthRateLimits } from './access.ts';
import type { AuthProvider, AuthCapabilities } from './index.ts';
import type { VerifiedIdentity } from './jwt.ts';
import { strictJson } from './json.ts';

export const WALLET_CHAIN_ID = 46630;
export const WALLET_CHAIN_IDS = [31337, WALLET_CHAIN_ID] as const;
export type WalletChainId = typeof WALLET_CHAIN_IDS[number];
export const WALLET_CHALLENGE_SECONDS = 300;
export const WALLET_SESSION_COOKIE = '__Host-thot_session';
export const WALLET_CHALLENGE_COOKIE = '__Host-thot_wallet_challenge';
export type WalletAuthConfig = {
  schema_version: 'thot.wallet-auth/1'; origin: string; chain_id: WalletChainId;
  allowed_origins?: string[];
  rpc_url?: string;
  allow_public_signup: boolean; operator_addresses?: string[]; maintenance_addresses?: string[];
  session_ttl_seconds?: number; rate_limits?: AuthRateLimits;
};
type ChallengeInput = { address: string; chain_id: number };
type VerificationInput = { id: string; message: string; signature: string };
const opaque = () => randomBytes(32).toString('base64url');
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Strict`;
const keys = (value: unknown, required: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === required.length && Object.keys(value).every(key => required.includes(key));
/** Exact aliases share the existing account namespace; they never replace its issuer. */
export function walletAuthOrigins(origin: string, aliases: unknown = []): readonly string[] {
  ensure(Array.isArray(aliases) && aliases.length <= 8, 'INVALID_AUTH_CONFIGURATION');
  const origins = [origin, ...aliases];
  for (const value of origins) {
    let url: URL; try { url = new URL(value); } catch { ensure(false, 'INVALID_AUTH_CONFIGURATION'); }
    ensure(typeof value === 'string' && value.length <= 2048 && url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.hostname.includes('*'), 'INVALID_AUTH_CONFIGURATION');
  }
  ensure(new Set(origins).size === origins.length, 'INVALID_AUTH_CONFIGURATION');
  return Object.freeze(origins);
}
function address(value: unknown): string {
  ensure(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), 'INVALID_WALLET_ADDRESS');
  try { return getAddress(value); } catch { ensure(false, 'INVALID_WALLET_ADDRESS'); }
}
function cookieValue(header: string | undefined, name: string): string {
  if (!header) return '';
  ensure(typeof header === 'string' && header.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(header), 'INVALID_AUTH_COOKIE', 401);
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  ensure(matches.length <= 1, 'INVALID_AUTH_COOKIE', 401);
  if (!matches.length) return '';
  const value = matches[0]!.slice(name.length + 1);
  ensure(opaquePattern.test(value), 'INVALID_AUTH_COOKIE', 401);
  return value;
}

/** EOA SIWE sign-in. It authorizes a session, never a transaction or a token allowance.
 * The server accepts only its own canonical EIP-4361 challenge, verified with EIP-191.
 * Contract wallets (EIP-1271) and Solana signatures are deliberately unsupported.
 */
export class WalletAuth implements AuthProvider {
  readonly access: AuthAccessStore; readonly capabilities: AuthCapabilities;
  readonly origin: string; readonly issuer: string; readonly chainId: WalletChainId;
  readonly allowedOrigins: readonly string[];
  private readonly db: Database; private readonly clock: () => number;
  private readonly operators: Set<string>; private readonly maintenance: Set<string>; private readonly publicSignup: boolean; private readonly ttl: number;
  private constructor(db: Database, config: WalletAuthConfig, clock: () => number) {
    ensure(config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).every(key => ['schema_version', 'origin', 'allowed_origins', 'chain_id', 'rpc_url', 'allow_public_signup', 'operator_addresses', 'maintenance_addresses', 'session_ttl_seconds', 'rate_limits'].includes(key)) && config.schema_version === 'thot.wallet-auth/1', 'INVALID_AUTH_CONFIGURATION');
    let url: URL; try { url = new URL(config.origin); } catch { ensure(false, 'INVALID_AUTH_CONFIGURATION'); }
    ensure(url.protocol === 'https:' && url.origin === config.origin && !url.username && !url.password && WALLET_CHAIN_IDS.includes(config.chain_id) && typeof config.allow_public_signup === 'boolean', 'INVALID_AUTH_CONFIGURATION');
    this.allowedOrigins = walletAuthOrigins(config.origin, config.allowed_origins);
    ensure(this.allowedOrigins.length === 1 || config.chain_id === WALLET_CHAIN_ID, 'INVALID_AUTH_CONFIGURATION');
    let rpcUrl = 'https://rpc.testnet.chain.robinhood.com';
    if (config.chain_id === 31337) {
      let rpc: URL; try { rpc = new URL(config.rpc_url!); } catch { ensure(false, 'INVALID_AUTH_CONFIGURATION'); }
      ensure(rpc.protocol === 'https:' && rpc.origin === config.origin && /^\/rpc\/[A-Za-z0-9_-]{32,128}$/.test(rpc.pathname) && !rpc.search && !rpc.hash && !rpc.username && !rpc.password, 'INVALID_AUTH_CONFIGURATION');
      rpcUrl = rpc.href;
    } else ensure(config.rpc_url === undefined, 'INVALID_AUTH_CONFIGURATION');
    ensure(config.operator_addresses === undefined || Array.isArray(config.operator_addresses) && config.operator_addresses.length <= 16, 'INVALID_AUTH_CONFIGURATION');
    const operators = (config.operator_addresses ?? []).map(value => { try { return address(value).toLowerCase(); } catch { ensure(false, 'INVALID_AUTH_CONFIGURATION'); } });
    ensure(new Set(operators).size === operators.length, 'INVALID_AUTH_CONFIGURATION');
    ensure(config.maintenance_addresses === undefined || Array.isArray(config.maintenance_addresses) && config.maintenance_addresses.length <= 16, 'INVALID_AUTH_CONFIGURATION');
    const maintenance = (config.maintenance_addresses ?? []).map(value => { try { return address(value).toLowerCase(); } catch { ensure(false, 'INVALID_AUTH_CONFIGURATION'); } });
    ensure(new Set(maintenance).size === maintenance.length && maintenance.every(value => !operators.includes(value)), 'INVALID_AUTH_CONFIGURATION');
    const ttl = config.session_ttl_seconds ?? 8 * 3600;
    ensure(Number.isSafeInteger(ttl) && ttl >= 300 && ttl <= 8 * 3600, 'INVALID_AUTH_CONFIGURATION');
    this.db = db; this.clock = clock; this.origin = config.origin; this.issuer = this.origin + '/auth/wallet'; this.chainId = config.chain_id;
    this.operators = new Set(operators); this.maintenance = new Set(maintenance); this.publicSignup = config.allow_public_signup; this.ttl = ttl;
    this.access = new AuthAccessStore(db, this.issuer, clock, config.rate_limits);
    this.capabilities = { mode: 'wallet_siwe', development_session_available: false, external_login_available: true, wallet: { origin: this.origin, chain_id: this.chainId, rpc_url: rpcUrl, session_ttl_seconds: ttl, signature_type: 'eip191', wallet_type: 'evm-eoa' } };
  }
  static async create(db: Database, config: WalletAuthConfig, clock: () => number = Date.now) { return new WalletAuth(db, config, clock); }
  private now() { const value = this.clock(); ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_AUTH_CLOCK'); return Math.floor(value / 1000); }
  requireOrigin(origin: string | undefined) { ensure(typeof origin === 'string' && this.allowedOrigins.includes(origin), 'AUTH_ORIGIN_MISMATCH', 403); return origin; }
  capabilitiesForOrigin(origin: string) {
    this.requireOrigin(origin);
    return { ...this.capabilities, wallet: { ...this.capabilities.wallet!, origin } };
  }
  tokenFromCookie(header?: string) { return cookieValue(header, WALLET_SESSION_COOKIE); }
  clearSessionCookie() { return cookie(WALLET_SESSION_COOKIE, '', 0); }
  clearChallengeCookie() { return cookie(WALLET_CHALLENGE_COOKIE, '', 0); }
  private configuredRole(role:Actor['role'],wallet:string) {
    return role==='operator_security'&&this.operators.has(wallet.toLowerCase()) || role==='operator_maintenance'&&this.maintenance.has(wallet.toLowerCase());
  }

  private async limitChallenges(tx: Transaction, wallet: string, now: number) {
    await tx.sql.query("DELETE FROM auth_access WHERE document->>'kind' IN ('wallet_challenge','wallet_session') AND (document->>'expires_at')::numeric <= $1", [now]);
    await tx.sql.query("DELETE FROM auth_access WHERE document->>'kind'='wallet_challenge_rate' AND (document->>'window_end')::numeric <= $1", [now]);
    for (const [scope, maximum] of [['global', 120], [wallet.toLowerCase(), 10]] as const) {
      const id = 'wallet-rate:' + canonicalHash({ issuer: this.issuer, scope }), prior = await tx.maybe('auth_access', id);
      ensure(!prior || prior.count < maximum, 'AUTH_CHALLENGE_RATE_LIMIT', 429);
      const value = { kind: 'wallet_challenge_rate', count: (prior?.count ?? 0) + 1, window_end: prior?.window_end ?? now + 60 };
      if (prior) await tx.update('auth_access', id, value); else await tx.insert('auth_access', id, 'network', value);
    }
    ensure(Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='wallet_challenge'")).rows[0]!.count) < 10000, 'AUTH_CHALLENGE_LIMIT', 429);
  }

  async challenge(input: ChallengeInput, origin: string | undefined) {
    const requestOrigin = this.requireOrigin(origin);
    ensure(keys(input, ['address', 'chain_id']), 'INVALID_WALLET_CHALLENGE');
    ensure(input.chain_id === this.chainId, 'AUTH_CHAIN_MISMATCH');
    const wallet = address(input.address), now = this.now(), id = randomBytes(16).toString('hex'), nonce = randomBytes(16).toString('hex'), binding = opaque();
    const expires = now + WALLET_CHALLENGE_SECONDS;
    const message = `${requestOrigin} wants you to sign in with your Ethereum account:\n${wallet}\n\nSign in to thot market and link this wallet for payouts. This does not authorize token transfers or trace sales.\n\nURI: ${requestOrigin}/app\nVersion: 1\nChain ID: ${this.chainId}\nNonce: ${nonce}\nIssued At: ${new Date(now * 1000).toISOString()}\nExpiration Time: ${new Date(expires * 1000).toISOString()}\nRequest ID: ${id}`;
    await this.db.transaction(async tx => {
      await this.limitChallenges(tx, wallet, now);
      await tx.insert('auth_access', 'wallet-challenge:' + id, 'network', { kind: 'wallet_challenge', issuer: this.issuer, origin: requestOrigin, chain_id: this.chainId, address: wallet, message, binding_hash: canonicalHash(binding), used: false, issued_at: now, expires_at: expires });
    });
    return { body: { id, message, address: wallet, chain_id: this.chainId, expires_at: new Date(expires * 1000).toISOString() }, set_cookie: cookie(WALLET_CHALLENGE_COOKIE, binding, WALLET_CHALLENGE_SECONDS) };
  }

  private async provision(tx: Transaction, wallet: string, subject: string): Promise<Actor> {
    const id = 'membership:' + canonicalHash({ issuer: this.issuer, subject }), prior = await tx.maybe('auth_access', id);
    if (prior) {
      // A fresh signature must never undo a stored disablement or grant a new role.
      ensure(prior.kind === 'membership' && prior.issuer === this.issuer && prior.enabled === true, 'UNAUTHENTICATED', 401);
      const user = await tx.maybe('users', prior.actor.id);
      ensure(user && user.disabled !== true && user.role === prior.actor.role, 'AUTH_ACTOR_UNAVAILABLE', 403);
      if (prior.actor.role !== 'user') ensure(this.configuredRole(prior.actor.role,wallet), 'AUTH_OPERATOR_NOT_CONFIGURED', 403);
      await this.bindWallet(tx, prior.actor, wallet);
      return structuredClone(prior.actor);
    }
    const isOperator = this.operators.has(wallet.toLowerCase());
    const isMaintenance = this.maintenance.has(wallet.toLowerCase());
    ensure(isOperator || isMaintenance || this.publicSignup, 'AUTH_SIGNUP_DISABLED', 403);
    ensure(Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='membership'")).rows[0]!.count) < 10000, 'AUTH_MEMBERSHIP_LIMIT', 429);
    const actor: Actor = { id: 'wallet-user-' + canonicalHash({ issuer: this.issuer, subject }).slice(0, 32), role: isOperator ? 'operator_security' : isMaintenance ? 'operator_maintenance' : 'user' };
    ensure(!await tx.maybe('users', actor.id), 'AUTH_ACTOR_CONFLICT', 409);
    await this.bindWallet(tx, actor, wallet);
    await tx.insert('users', actor.id, actor.id, { role: actor.role, revoked_receipts: [], auth_identity_hash: canonicalHash({ issuer: this.issuer, subject }) });
    await tx.insert('auth_access', id, 'network', { kind: 'membership', issuer: this.issuer, subject_hash: canonicalHash(subject), actor, enabled: true, version: 1, valid_after: 0 });
    await tx.audit('network', 'AuthWalletProvisioned', { actor_id: actor.id, role: actor.role, membership_id: id });
    return actor;
  }
  private async bindWallet(tx: Transaction, actor: Actor, wallet: string) {
    const id = 'wallet:' + actor.id, prior = await tx.maybe('thot_records', id);
    ensure(!prior || prior.owner_id === actor.id && prior.kind === 'wallet' && prior.address?.toLowerCase() === wallet.toLowerCase(), 'WALLET_ALREADY_BOUND', 409);
    const others = await tx.sql.query("SELECT owner_id FROM thot_records WHERE document->>'kind'='wallet' AND lower(document->>'address')=$1 AND owner_id<>$2 LIMIT 1", [wallet.toLowerCase(), actor.id]);
    ensure(!others.rows.length, 'WALLET_ALREADY_BOUND', 409);
    if (!prior) await tx.insert('thot_records', id, actor.id, { kind: 'wallet', address: wallet });
  }

  async verify(input: VerificationInput, origin: string | undefined, cookieHeader?: string) {
    this.requireOrigin(origin);
    ensure(keys(input, ['id', 'message', 'signature']) && /^[0-9a-f]{32}$/.test(input.id) && typeof input.message === 'string' && input.message.length <= 2048 && /^0x[0-9a-fA-F]{130}$/.test(input.signature), 'INVALID_WALLET_PROOF');
    const binding = cookieValue(cookieHeader, WALLET_CHALLENGE_COOKIE);
    ensure(binding, 'AUTH_CHALLENGE_COOKIE_REQUIRED', 401);
    let recovered: string; try { recovered = verifyMessage(input.message, input.signature); } catch { ensure(false, 'INVALID_WALLET_SIGNATURE', 401); }
    const token = opaque(), sessionHash = canonicalHash(token);
    const result = await this.db.transaction(async tx => {
      const now = this.now(), challenge = await tx.maybe('auth_access', 'wallet-challenge:' + input.id);
      ensure(challenge?.kind === 'wallet_challenge' && !challenge.used && challenge.expires_at > now && challenge.issued_at <= now, 'AUTH_CHALLENGE_EXPIRED_OR_USED', 401);
      ensure(challenge.origin === origin && challenge.issuer === this.issuer && challenge.chain_id === this.chainId && challenge.message === input.message && challenge.binding_hash === canonicalHash(binding), 'AUTH_CHALLENGE_MISMATCH', 401);
      ensure(recovered.toLowerCase() === challenge.address.toLowerCase(), 'INVALID_WALLET_SIGNATURE', 401);
      const subject = `eip155:${this.chainId}:${recovered.toLowerCase()}`, actor = await this.provision(tx, recovered, subject);
      const membership = await tx.get('auth_access', 'membership:' + canonicalHash({ issuer: this.issuer, subject }));
      ensure(now > membership.valid_after, 'AUTH_SESSION_RETRY', 409);
      await tx.update('auth_access', challenge.id, { ...challenge, used: true });
      await tx.sql.query("DELETE FROM auth_access WHERE document->>'kind'='wallet_session' AND (document->>'expires_at')::numeric <= $1", [now]);
      // Ownership was freshly proved. Retire the oldest sessions above eight per wallet.
      const active = await tx.sql.query("SELECT id FROM auth_access WHERE document->>'kind'='wallet_session' AND document->>'issuer'=$1 AND document->>'subject'=$2 ORDER BY (document->>'issued_at')::numeric,id", [this.issuer, subject]);
      for (const row of active.rows.slice(0, Math.max(0, active.rows.length - 7))) await tx.sql.query('DELETE FROM auth_access WHERE id=$1', [row.id]);
      ensure(Number((await tx.sql.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='wallet_session'")).rows[0]!.count) < 50000, 'AUTH_SESSION_LIMIT', 429);
      await tx.insert('auth_access', 'wallet-session:' + sessionHash, actor.id, { kind: 'wallet_session', issuer: this.issuer, subject, address: recovered, chain_id: this.chainId, issued_at: now, expires_at: now + this.ttl });
      return { actor, wallet_address: recovered, chain_id: this.chainId, expires_at: new Date((now + this.ttl) * 1000).toISOString(), mode: 'wallet_siwe' as const };
    });
    return { body: result, set_cookies: [cookie(WALLET_SESSION_COOKIE, token, this.ttl), this.clearChallengeCookie()] };
  }

  async authenticate(token: string) {
    ensure(typeof token === 'string' && opaquePattern.test(token), 'UNAUTHENTICATED', 401);
    const hash = canonicalHash(token), session = (await this.db.query('SELECT owner_id,document FROM auth_access WHERE id=$1', ['wallet-session:' + hash])).rows[0];
    const stored = session?.document, now = this.now();
    ensure(stored?.kind === 'wallet_session' && stored.issuer === this.issuer && stored.chain_id === this.chainId && stored.expires_at > now && stored.issued_at <= now, 'UNAUTHENTICATED', 401);
    const identity: VerifiedIdentity = { issuer: this.issuer, subject: stored.subject, jti: hash, issuedAt: stored.issued_at, expiresAt: stored.expires_at };
    const actor = await this.access.authenticate(identity);
    ensure(actor.id === session!.owner_id, 'UNAUTHENTICATED', 401);
    if (actor.role !== 'user') ensure(this.configuredRole(actor.role,stored.address), 'AUTH_OPERATOR_NOT_CONFIGURED', 403);
    return { actor, identity, expires_at: new Date(identity.expiresAt * 1000).toISOString(), wallet_address: stored.address as string, chain_id: this.chainId };
  }
  async revoke(identity: VerifiedIdentity, actor: Actor, key: string): Promise<{ revoked: true }> { await this.access.revoke(identity, actor, key); return { revoked: true }; }
}

/** Read one explicit configuration file; do not discover wallet keys or credentials. */
export async function loadWalletAuthConfig(path: string): Promise<WalletAuthConfig> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { ensure(false, 'AUTH_CONFIGURATION_UNAVAILABLE'); }
  try {
    const stat = await handle.stat(); ensure(stat.isFile() && stat.size <= 262144 && (stat.mode & 0o022) === 0, 'INSECURE_AUTH_CONFIGURATION');
    return strictJson(await handle.readFile(), 262144);
  } finally { await handle.close(); }
}
