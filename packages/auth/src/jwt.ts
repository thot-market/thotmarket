import { constants, createPublicKey, verify, type KeyObject, type webcrypto } from 'node:crypto';
import { ensure } from '../../storage/src/index.ts';
import { strictJson } from './json.ts';

export type AuthJwk = webcrypto.JsonWebKey & { kid?: string };
export type JwtPolicy = { issuer: string; audience: string; max_token_age_seconds: number; jwks: { keys: AuthJwk[] } };
export type VerifiedIdentity = { issuer: string; subject: string; jti: string; issuedAt: number; expiresAt: number };
const object = (value: any, keys: string[]) => ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)), 'INVALID_AUTH_SCHEMA', 401);
const identifier = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const kidValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value);
const base64 = (value: unknown, max: number): Buffer => {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_AUTH_ENCODING', 401);
  const result = Buffer.from(value, 'base64url'); ensure(result.toString('base64url') === value, 'INVALID_AUTH_ENCODING', 401); return result;
};

/** Fixed RS256 access-token profile. Key selection never follows token-supplied URLs or keys. */
export class PinnedJwtVerifier {
  readonly issuer: string; readonly audience: string; readonly maxAge: number;
  private keys = new Map<string, KeyObject>();
  constructor(input: JwtPolicy) {
    object(input, ['issuer', 'audience', 'max_token_age_seconds', 'jwks']);
    ensure(identifier(input.issuer, 1024) && identifier(input.audience, 256), 'INVALID_AUTH_POLICY');
    let issuer: URL;
    try { issuer = new URL(input.issuer); } catch { ensure(false, 'INVALID_AUTH_ISSUER'); }
    ensure(issuer.protocol === 'https:' && !issuer.username && !issuer.password && !issuer.search && !issuer.hash, 'INVALID_AUTH_ISSUER');
    ensure(Number.isSafeInteger(input.max_token_age_seconds) && input.max_token_age_seconds >= 30 && input.max_token_age_seconds <= 3600, 'INVALID_AUTH_MAX_AGE');
    object(input.jwks, ['keys']); ensure(Array.isArray(input.jwks.keys) && input.jwks.keys.length >= 1 && input.jwks.keys.length <= 8, 'INVALID_AUTH_KEYS');
    for (const jwk of input.jwks.keys) {
      object(jwk, ['kty', 'kid', 'alg', 'use', 'key_ops', 'n', 'e']);
      ensure(jwk.kty === 'RSA' && jwk.alg === 'RS256' && jwk.use === 'sig' && kidValid(jwk.kid) && !this.keys.has(jwk.kid), 'INVALID_AUTH_KEY');
      ensure(jwk.key_ops === undefined || Array.isArray(jwk.key_ops) && jwk.key_ops.length === 1 && jwk.key_ops[0] === 'verify', 'INVALID_AUTH_KEY');
      const modulus = base64(jwk.n, 700), exponent = base64(jwk.e, 12);
      ensure(modulus.length >= 256 && modulus.length <= 512 && modulus[0] !== 0 && exponent.toString('base64url') === 'AQAB', 'INVALID_AUTH_KEY');
      let key: KeyObject;
      try { key = createPublicKey({ key: jwk, format: 'jwk' }); } catch { ensure(false, 'INVALID_AUTH_KEY'); }
      ensure(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength! >= 2048 && key.asymmetricKeyDetails?.modulusLength! <= 4096, 'INVALID_AUTH_KEY');
      this.keys.set(jwk.kid, key);
    }
    this.issuer = input.issuer; this.audience = input.audience; this.maxAge = input.max_token_age_seconds;
  }
  verify(token: string, nowMs = Date.now()): VerifiedIdentity {
    ensure(typeof token === 'string' && token.length <= 16384, 'UNAUTHENTICATED', 401);
    const parts = token.split('.'); ensure(parts.length === 3, 'UNAUTHENTICATED', 401);
    const header = strictJson(base64(parts[0], 2048), 1024);
    object(header, ['alg', 'kid', 'typ']);
    ensure(header.alg === 'RS256' && header.typ === 'at+jwt' && kidValid(header.kid), 'UNAUTHENTICATED', 401);
    const key = this.keys.get(header.kid); ensure(key, 'UNAUTHENTICATED', 401);
    const signature = base64(parts[2], 700); ensure(signature.length === key.asymmetricKeyDetails!.modulusLength! / 8, 'UNAUTHENTICATED', 401);
    ensure(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), { key, padding: constants.RSA_PKCS1_PADDING }, signature), 'UNAUTHENTICATED', 401);
    const claims = strictJson(base64(parts[1], 12000), 8192);
    object(claims, ['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti', 'scope', 'client_id', 'roles', 'role', 'buyer_id']);
    ensure(claims.iss === this.issuer && claims.aud === this.audience && identifier(claims.sub) && identifier(claims.jti), 'UNAUTHENTICATED', 401);
    ensure(Number.isSafeInteger(nowMs) && nowMs >= 0, 'INVALID_AUTH_CLOCK');
    const now = Math.floor(nowMs / 1000);
    ensure(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) && claims.iat >= 0 && claims.iat <= now && claims.exp > now && claims.exp > claims.iat && claims.exp - claims.iat <= this.maxAge && now - claims.iat < this.maxAge, 'UNAUTHENTICATED', 401);
    if (claims.nbf !== undefined) ensure(Number.isSafeInteger(claims.nbf) && claims.nbf >= claims.iat && claims.nbf <= now && claims.nbf < claims.exp, 'UNAUTHENTICATED', 401);
    for (const field of ['scope', 'client_id', 'role', 'buyer_id']) if (claims[field] !== undefined) ensure(identifier(claims[field]), 'INVALID_AUTH_SCHEMA', 401);
    if (claims.roles !== undefined) ensure(Array.isArray(claims.roles) && claims.roles.length <= 16 && claims.roles.every((role: unknown) => identifier(role, 80)), 'INVALID_AUTH_SCHEMA', 401);
    // Role/scope/buyer claims above are bounded but never used as authorization.
    return { issuer: claims.iss, subject: claims.sub, jti: claims.jti, issuedAt: claims.iat, expiresAt: claims.exp };
  }
}
