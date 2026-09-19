import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinnedJwtVerifier, ExternalAuth, AuthAccessStore, strictJson, loadAuthConfig, type ExternalAuthConfig } from '../packages/auth/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { demoUser, demoBuyer } from '../packages/market/src/fixtures.ts';
import type { Actor } from '../packages/market/src/service.ts';
import type { Document } from '../packages/storage/src/index.ts';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'operator-pinned-1', alg: 'RS256', use: 'sig' };
const issuer = 'https://issuer.example.invalid', audience = 'thot-local-access';
const initial = Date.parse('2026-09-06T12:00:00Z');
const policy = { issuer, audience, max_token_age_seconds: 300, jwks: { keys: [jwk] } };
const claims = (fields: Document = {}) => ({ iss: issuer, aud: audience, sub: 'subject-user', iat: initial / 1000 - 10, exp: initial / 1000 + 290, jti: randomUUID(), ...fields });
function token(fields: Document = {}, header: Document = {}, rawBody?: string) {
  const unsigned = [JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid, ...header }), rawBody ?? JSON.stringify(claims(fields))].map(value => Buffer.from(value).toString('base64url')).join('.');
  return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url');
}
const operator: Actor = { id: 'auth-operator', role: 'operator_security' };
async function setup(t: any, external = true, limits?: { requests_per_minute: number; mutations_per_minute: number }) {
  const clock = { now: initial }, dir = await mkdtemp(join(tmpdir(), 'thot-auth-'));
  const app = await createApplication({ memory: true, dataDir: dir, config: { clock: () => new Date(clock.now) } });
  await app.db.transaction(async tx => {
    await tx.insert('users', operator.id, operator.id, { role: operator.role });
    await tx.insert('users', demoBuyer.id, demoBuyer.id, { role: demoBuyer.role, buyer_id: demoBuyer.buyer_id });
  });
  const config: ExternalAuthConfig = { schema_version: 'thot.external-auth/1', jwt: policy, initial_memberships: [{ subject: 'subject-user', actor: demoUser, enabled: true }, { subject: 'subject-buyer', actor: demoBuyer, enabled: true }, { subject: 'subject-operator', actor: operator, enabled: true }], ...(limits ? { rate_limits: limits } : {}) };
  const auth = external ? await ExternalAuth.create(app.db, config, () => clock.now) : undefined;
  let stop = async () => {};
  t.after(async () => { await stop(); await app.close(); });
  const http = async () => {
    const logs: Document[] = [], server = createHttpServer(app, { externalAuth: auth, clock: () => clock.now, log: value => logs.push(value) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    stop = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const call = async (path: string, credential?: string, body?: Document, key = randomUUID()) => {
      const response = await fetch(`http://127.0.0.1:${address.port}` + path, { method: body ? 'POST' : 'GET', headers: { ...(credential ? { Authorization: 'Bearer ' + credential } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    return { call, logs };
  };
  return { app, auth: auth!, config, clock, http };
}

test('pinned JWT uses verified issuer/subject only, never embedded role, scope or buyer authority', () => {
  const verifier = new PinnedJwtVerifier(policy), result = verifier.verify(token({ role: 'operator_security', roles: ['service_settlement'], scope: 'admin:*', buyer_id: 'other-buyer' }), initial);
  assert.equal(result.subject, 'subject-user'); assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'issuedAt', 'issuer', 'jti', 'subject']);
  assert.throws(() => verifier.verify(token({}, { typ: 'JWT' }), initial), /UNAUTHENTICATED/);
});

test('JWT strict encodings reject duplicate names, malformed UTF8 and nested/unknown authority schemas', () => {
  assert.throws(() => strictJson('{"sub":"one","s\\u0075b":"two"}'), /DUPLICATE_AUTH_FIELD/);
  assert.throws(() => strictJson(Uint8Array.from([0xc3, 0x28])), /INVALID_AUTH_JSON/);
  for (const invalid of ['{"a":1,}', '[1,]', '{"a":01}', '{"a":true} trailing', '['.repeat(15) + '0' + ']'.repeat(15)]) assert.throws(() => strictJson(invalid));
  const verifier = new PinnedJwtVerifier(policy), raw = JSON.stringify(claims()).replace('"sub":"subject-user"', '"sub":"subject-user","sub":"subject-operator"');
  assert.throws(() => verifier.verify(token({}, {}, raw), initial), /DUPLICATE_AUTH_FIELD/);
  for (const fields of [{ unknown: true }, { roles: [{ admin: true }] }, { role: 3 }, { scope: 'x'.repeat(1000) }]) assert.throws(() => verifier.verify(token(fields), initial));
  assert.throws(() => verifier.verify(token() + '=', initial));
});

test('JWT rejects unsigned, HMAC-confusion, altered, unpinned and URL/key-injection headers without network', () => {
  const verifier = new PinnedJwtVerifier(policy);
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }, { kid: '../key' }, { jku: 'http://127.0.0.1/private' }, { x5u: 'https://attacker.invalid' }, { jwk }, { crit: ['b64'], b64: false }, { zip: 'DEF' }]) assert.throws(() => verifier.verify(token({}, header), initial));
  const valid = token(), parts = valid.split('.');
  parts[1] = Buffer.from(JSON.stringify(claims({ sub: 'subject-operator' }))).toString('base64url');
  assert.throws(() => verifier.verify(parts.join('.'), initial), /UNAUTHENTICATED/);
  const unsigned = valid.slice(0, valid.lastIndexOf('.'));
  const hmac = createHmac('sha256', pair.publicKey.export({ format: 'pem', type: 'spki' })).update(unsigned).digest('base64url');
  assert.throws(() => verifier.verify(unsigned + '.' + hmac, initial), /UNAUTHENTICATED/);
});

test('JWT enforces exact issuer/audience, integral timestamps, lifetime, not-before and exclusive expiry', () => {
  const verifier = new PinnedJwtVerifier(policy), now = initial / 1000;
  for (const fields of [{ iss: issuer + '/' }, { aud: [audience] }, { aud: 'other-app' }, { sub: '' }, { jti: '' }, { iat: now + 1 }, { iat: now - 301 }, { exp: now }, { exp: now + 301 }, { exp: 1.5 }, { iat: '123' }, { nbf: now + 1 }, { nbf: now - 11 }, { exp: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => verifier.verify(token(fields), initial));
  const short = token({ iat: now, exp: now + 30, nbf: now });
  verifier.verify(short, initial + 29999); assert.throws(() => verifier.verify(short, initial + 30000), /UNAUTHENTICATED/);
});

test('JWT pinning rejects duplicate kids, weak/private keys, mismatched algorithms and excessive policy', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  for (const key of [{ ...jwk, d: 'private' }, { ...jwk, kty: 'oct' }, { ...jwk, alg: 'HS256' }, { ...jwk, use: 'enc' }, { ...jwk, key_ops: ['sign'] }, { ...jwk, x5u: issuer }, { ...jwk, ...weak.publicKey.export({ format: 'jwk' }) }, { ...jwk, e: 'Aw' }]) assert.throws(() => new PinnedJwtVerifier({ ...policy, jwks: { keys: [key] } }));
  assert.throws(() => new PinnedJwtVerifier({ ...policy, jwks: { keys: [jwk, jwk] } }));
  assert.throws(() => new PinnedJwtVerifier({ ...policy, issuer: 'http://issuer.invalid' }));
  assert.throws(() => new PinnedJwtVerifier({ ...policy, max_token_age_seconds: 3601 }));
});

test('explicit auth config loader is bounded, rejects symlinks/writable files and sanitizes missing paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'thot-auth-config-')), path = join(dir, 'pinned.json'), alias = join(dir, 'alias.json');
  const config = { schema_version: 'thot.external-auth/1', jwt: policy, initial_memberships: [] };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); assert.deepEqual(await loadAuthConfig(path), config);
  await symlink(path, alias); await assert.rejects(loadAuthConfig(alias), /AUTH_CONFIGURATION_UNAVAILABLE/);
  await chmod(path, 0o622); await assert.rejects(loadAuthConfig(path), /INSECURE_AUTH_CONFIGURATION/);
  await chmod(path, 0o600); await writeFile(path, 'x'.repeat(262145)); await assert.rejects(loadAuthConfig(path), /INSECURE_AUTH_CONFIGURATION/);
  await assert.rejects(loadAuthConfig(join(dir, 'PRIVATE_CONFIG_PATH')), error => error instanceof Error && error.message === 'AUTH_CONFIGURATION_UNAVAILABLE');
});

test('persisted authorization rejects unknown subjects/actors, disabled actors and revoked buyer approval', async t => {
  const { app, auth } = await setup(t);
  assert.deepEqual((await auth.authenticate(token({ role: 'operator_security' }))).actor, demoUser);
  await assert.rejects(auth.authenticate(token({ sub: 'unprovisioned' })), /UNAUTHENTICATED/);
  await assert.rejects(auth.access.provision(operator, 'unknown-actor-map', { subject: 'new-subject', actor: { id: 'missing-user', role: 'user' }, enabled: true, expected_version: 0 }), /AUTH_ACTOR_UNAVAILABLE/);
  await assert.rejects(auth.access.provision(demoUser, 'self-escalation-map', { subject: 'subject-user', actor: operator, enabled: true, expected_version: 1 }), /FORBIDDEN/);
  await app.db.transaction(async tx => { const row = await tx.get('users', demoUser.id); await tx.update('users', row.id, { ...row, disabled: true }); });
  await assert.rejects(auth.authenticate(token()), /AUTH_ACTOR_UNAVAILABLE/);
  assert.deepEqual((await auth.authenticate(token({ sub: 'subject-buyer' }))).actor, demoBuyer);
  await app.db.transaction(async tx => { const buyer = await tx.get('buyers', demoBuyer.buyer_id!); await tx.update('buyers', buyer.id, { ...buyer, approved: false }); });
  await assert.rejects(auth.authenticate(token({ sub: 'subject-buyer' })), /BUYER_NOT_APPROVED/);
});

test('membership changes invalidate older tokens, require revisions and survive configuration reseeding', async t => {
  const { app, auth, config, clock } = await setup(t), old = token();
  const disabled = { subject: 'subject-user', actor: demoUser, enabled: false, expected_version: 1 };
  const changed = await auth.access.provision(operator, 'disable-membership', disabled); assert.equal(changed.version, 2);
  assert.deepEqual(await auth.access.provision(operator, 'disable-membership', disabled), changed);
  await assert.rejects(auth.access.provision(operator, 'stale-membership', disabled), /AUTH_REVISION_CONFLICT/);
  await assert.rejects(auth.authenticate(old), /UNAUTHENTICATED/);
  const restarted = await ExternalAuth.create(app.db, config, () => clock.now);
  await assert.rejects(restarted.authenticate(old), /UNAUTHENTICATED/);
  await restarted.access.provision(operator, 'reenable-membership', { ...disabled, enabled: true, expected_version: 2 });
  await assert.rejects(restarted.authenticate(old), /UNAUTHENTICATED/);
  clock.now += 1000;
  assert.deepEqual((await restarted.authenticate(token({ iat: clock.now / 1000, exp: clock.now / 1000 + 30 }))).actor, demoUser);
});

test('JWT self-revocation is durable, hashes token identity and never stores raw credential/subject', async t => {
  const { app, auth, config, clock } = await setup(t), raw = token({ jti: 'a-sensitive-token-id' }), verified = await auth.authenticate(raw);
  await auth.access.revoke(verified.identity, verified.actor, 'revoke-current-jwt');
  await assert.rejects(auth.authenticate(raw), /UNAUTHENTICATED/);
  const restarted = await ExternalAuth.create(app.db, config, () => clock.now);
  await assert.rejects(restarted.authenticate(raw), /UNAUTHENTICATED/);
  const stored = JSON.stringify((await app.db.query('SELECT id,document FROM auth_access')).rows) + JSON.stringify((await app.db.query('SELECT payload FROM audit_events')).rows);
  for (const secret of [raw, 'a-sensitive-token-id', 'subject-user']) assert.ok(!stored.includes(secret));
});

test('per-actor limits aggregate sessions, persist across instances, separate actors and reset bounded windows', async t => {
  const { app, clock } = await setup(t), limits = { requests_per_minute: 3, mutations_per_minute: 1 };
  const access = new AuthAccessStore(app.db, issuer, () => clock.now, limits);
  await access.consume(demoUser, true); await assert.rejects(access.consume(demoUser, true), /ACTOR_RATE_LIMIT/);
  await access.consume(demoUser, false);
  const restarted = new AuthAccessStore(app.db, issuer, () => clock.now, limits);
  await restarted.consume(demoUser, false); await assert.rejects(restarted.consume(demoUser, false), /ACTOR_RATE_LIMIT/);
  await restarted.consume(demoBuyer, true);
  clock.now += 60000; await restarted.consume(demoUser, true);
});

test('external HTTP auth disables demo fallbacks, exposes safe capabilities and supports current-credential revoke', async t => {
  const { http } = await setup(t), { call, logs } = await http(), raw = token({ roles: ['operator_security'] });
  const capabilities = await call('/v1/auth/capabilities'); assert.equal(capabilities.body.mode, 'external_jwt'); assert.equal(capabilities.body.development_session_available, false); assert.equal(capabilities.body.external_login_available, false);
  assert.equal((await call('/v1/dev/session', undefined, { role: 'user' })).status, 403);
  assert.equal((await call('/v1/dev/trace', raw, { scenario: 'coding' })).status, 403);
  assert.equal((await call('/v1/traces')).status, 401);
  assert.equal((await call('/v1/operator/reconciliation', raw)).status, 403);
  const session = await call('/v1/auth/session', raw); assert.equal(session.status, 200); assert.deepEqual(session.body.actor, demoUser);
  assert.equal((await call('/v1/auth/session/revoke', raw, {})).body.revoked, true);
  assert.equal((await call('/v1/auth/session', raw)).status, 401);
  for (const secret of [raw, 'subject-user', 'RS256', 'Authorization']) assert.ok(!JSON.stringify(logs).includes(secret));
});

test('external HTTP membership administration and actor quotas cannot be bypassed with another valid token', async t => {
  const { http } = await setup(t, true, { requests_per_minute: 4, mutations_per_minute: 2 }), { call } = await http();
  const user = token(), admin = token({ sub: 'subject-operator' });
  const change = { subject: 'subject-user', actor: demoUser, enabled: false, expected_version: 1 };
  assert.equal((await call('/v1/operator/auth/membership', user, change)).status, 403);
  assert.equal((await call('/v1/auth/session', user)).status, 200);
  assert.equal((await call('/v1/auth/session', token())).status, 200);
  assert.equal((await call('/v1/auth/session', token())).status, 200);
  assert.equal((await call('/v1/auth/session', token())).status, 429);
  assert.equal((await call('/v1/operator/auth/membership', admin, change)).status, 200);
  assert.equal((await call('/v1/auth/session', user)).status, 401);
});

test('development selector remains backward compatible and revoked local sessions do not revive', async t => {
  const { http } = await setup(t, false), { call } = await http();
  assert.equal((await call('/v1/auth/capabilities')).body.development_session_available, true);
  const session = await call('/v1/dev/session', undefined, { role: 'user' }), raw = session.body.token;
  assert.equal((await call('/v1/auth/session', raw)).status, 200);
  assert.equal((await call('/v1/auth/session/revoke', raw, {})).body.revoked, true);
  assert.equal((await call('/v1/traces', raw)).status, 401);
  const renewed = await call('/v1/dev/session', undefined, { role: 'user' }); assert.notEqual(renewed.body.token, raw);
  assert.equal((await call('/v1/traces', renewed.body.token)).status, 200);
});
