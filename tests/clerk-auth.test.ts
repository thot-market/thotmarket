import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClerkAuth, type ClerkAuthConfig, type ClerkProviderApi, type ClerkTokenClaims, type ClerkUserRecord } from '../packages/auth/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import {DomainError} from '../packages/storage/src/index.ts';

const now = Date.parse('2026-09-08T12:00:00Z'), issuer = 'https://clerk.example.test';
const config: ClerkAuthConfig = { schema_version: 'thot.clerk-auth/1', issuer, publishable_key: 'pk_test_public_fixture', secret_key: 'sk_test_private_fixture', authorized_parties: ['https://demo.example.test'], invited_emails: ['alice@example.test'] };
const claims = (patch: Partial<ClerkTokenClaims> = {}): ClerkTokenClaims => ({ iss: issuer, sub: 'user_alice', sid: 'sess_alice', azp: 'https://demo.example.test', iat: now / 1000 - 10, exp: now / 1000 + 300, ...patch });
const verifiedEmail = (address = 'alice@example.test'): ClerkUserRecord => ({ id: 'user_alice', banned: false, locked: false, primaryEmailAddressId: 'email_primary', emailAddresses: [{ id: 'email_primary', emailAddress: address, verification: { status: 'verified' } }] });

function fixtureApi() {
  const state = { claims: claims(), session: { id: 'sess_alice', userId: 'user_alice', status: 'active', expireAt: now + 3_600_000 }, user: verifiedEmail(), revoked: [] as string[], options: undefined as any };
  const api: ClerkProviderApi = {
    async verifyToken(_token, options) { state.options = options; return state.claims; },
    async getSession() { return state.session; }, async getUser() { return state.user; },
    async revokeSession(id) { state.revoked.push(id); state.session = { ...state.session, status: 'revoked' }; }
  };
  return { state, api };
}

async function setup(t: any, override: Partial<ClerkAuthConfig> = {}) {
  const clock = { value: now }, dir = await mkdtemp(join(tmpdir(), 'thot-clerk-auth-')), app = await createApplication({ memory: true, dataDir: dir, config: { clock: () => new Date(clock.value) } }), fixture = fixtureApi();
  t.after(() => app.close());
  const auth = await ClerkAuth.create(app.db, { ...config, ...override }, fixture.api, () => clock.value);
  return { app, auth, clock, ...fixture };
}

test('Clerk first login provisions exactly one stable contributor for a verified invitation', async t => {
  const { app, auth, state } = await setup(t);
  const [first, concurrent] = await Promise.all([auth.authenticate('session-token-one'), auth.authenticate('session-token-two')]);
  assert.deepEqual(first.actor, concurrent.actor); assert.equal(first.actor.role, 'user');
  assert.deepEqual(auth.capabilities, { mode: 'clerk', development_session_available: false, external_login_available: true, clerk: { publishable_key: config.publishable_key, frontend_api_url: issuer } });
  assert.deepEqual(state.options, { secretKey: config.secret_key, authorizedParties: config.authorized_parties });
  const users = (await app.db.query("SELECT id FROM users WHERE id LIKE 'clerk-user-%'")).rows;
  const memberships = (await app.db.query("SELECT id FROM auth_access WHERE document->>'kind'='membership'")).rows;
  assert.equal(users.length, 1); assert.equal(memberships.length, 1);
});

test('Clerk rejects uninvited or unverified first login and grants no workspace', async t => {
  for (const user of [verifiedEmail('mallory@example.test'), { ...verifiedEmail(), emailAddresses: [{ id: 'email_primary', emailAddress: 'alice@example.test', verification: { status: 'unverified' } }] }]) {
    const { app, auth, state } = await setup(t); state.user = user;
    await assert.rejects(auth.authenticate('session-token'), /AUTH_INVITATION_REQUIRED/);
    assert.equal((await app.db.query("SELECT count(*)::text AS count FROM users WHERE id LIKE 'clerk-user-%'")).rows[0]!.count, '0');
  }
});

test('two invited Clerk subjects receive distinct empty contributor workspaces', async t => {
  const { app, auth, state } = await setup(t, { invited_emails: ['alice@example.test', 'bob@example.test'] });
  const alice = await auth.authenticate('alice-token');
  state.claims = claims({ sub: 'user_bob', sid: 'sess_bob' });
  state.session = { ...state.session, id: 'sess_bob', userId: 'user_bob' };
  state.user = { ...verifiedEmail('bob@example.test'), id: 'user_bob' };
  const bob = await auth.authenticate('bob-token');
  assert.notEqual(alice.actor.id, bob.actor.id);
  assert.deepEqual(await app.portfolio.list(alice.actor), await app.portfolio.list(bob.actor));
  assert.deepEqual((await app.portfolio.list(alice.actor)).items, []); assert.deepEqual((await app.portfolio.list(bob.actor)).items, []);
});

test('Clerk identity mapping survives email changes and disabled accounts cannot reprovision', async t => {
  const { app, auth, state } = await setup(t), first = await auth.authenticate('session-token');
  state.user = verifiedEmail('changed@example.test');
  assert.deepEqual((await auth.authenticate('refreshed-token')).actor, first.actor);
  await app.db.transaction(async tx => { const user = await tx.get('users', first.actor.id); await tx.update('users', user.id, { ...user, disabled: true }); });
  await assert.rejects(auth.authenticate('another-token'), /AUTH_ACTOR_UNAVAILABLE/);
  assert.equal((await app.db.query("SELECT count(*)::text AS count FROM auth_access WHERE document->>'kind'='membership'")).rows[0]!.count, '1');
});

test('Clerk checks exact instance, authorized party, active session and current user status', async t => {
  const { auth, state } = await setup(t);
  for (const altered of [{ iss: 'https://other.example.test/' }, { azp: 'https://attacker.example.test' }, { sid: 'sess_other' }]) { state.claims = claims(altered); await assert.rejects(auth.authenticate('bad-token'), /UNAUTHENTICATED/); }
  state.claims = claims(); state.session = { ...state.session, status: 'revoked' }; await assert.rejects(auth.authenticate('revoked-token'), /UNAUTHENTICATED/);
  state.session = { ...state.session, status: 'active' }; state.user = { ...state.user, banned: true }; await assert.rejects(auth.authenticate('banned-token'), /UNAUTHENTICATED/);
});

test('Clerk distinguishes missing sessions from provider failures without expiring valid login state',async t=>{
  for(const [providerStatus,expectedCode,expectedStatus]of [[404,'UNAUTHENTICATED',401],[401,'AUTH_PROVIDER_UNAVAILABLE',503],[429,'AUTH_PROVIDER_UNAVAILABLE',503],[500,'AUTH_PROVIDER_UNAVAILABLE',503]] as const){
    const{auth,api}=await setup(t);api.getSession=async()=>{throw Object.assign(new Error('provider request failed'),{status:providerStatus});};
    await assert.rejects(auth.authenticate('session-token'),error=>error instanceof DomainError&&error.code===expectedCode&&error.status===expectedStatus);
  }
});

test('Clerk logout revokes the provider session and THOT blocks refreshed tokens for the full session lifetime', async t => {
  const { app, auth, state, clock } = await setup(t), authenticated = await auth.authenticate('session-token');
  assert.deepEqual(await auth.revoke(authenticated.identity, authenticated.actor, 'revoke-clerk-session'), { revoked: true });
  assert.deepEqual(state.revoked, ['sess_alice']);
  clock.value += 301_000;
  state.claims = claims({ iat: clock.value / 1000 - 1, exp: clock.value / 1000 + 300 });
  state.session = { ...state.session, status: 'active' };
  await assert.rejects(auth.authenticate('new-token-same-session'), /UNAUTHENTICATED/);
  const stored = JSON.stringify((await app.db.query('SELECT id,document FROM auth_access')).rows);
  for (const secret of ['session-token', config.secret_key, 'alice@example.test', 'user_alice', 'sess_alice']) assert.ok(!stored.includes(secret));
});

test('Clerk configuration rejects unsafe origins, duplicate invitations and missing runtime secret', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'thot-clerk-config-')), app = await createApplication({ memory: true, dataDir: dir }); t.after(() => app.close());
  const api = fixtureApi().api;
  for (const invalid of [
    { authorized_parties: ['http://demo.example.test'] }, { authorized_parties: ['https://demo.example.test/path'] },
    { invited_emails: ['Alice@example.test', 'alice@example.test'] }, { secret_key: '' }
  ]) await assert.rejects(ClerkAuth.create(app.db, { ...config, ...invalid } as ClerkAuthConfig, api), /INVALID_AUTH_CONFIGURATION/);
});
