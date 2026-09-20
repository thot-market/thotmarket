import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { WalletAuth, walletAuthOrigins, loadWalletAuthConfig, WALLET_SESSION_COOKIE, type WalletAuthConfig } from '../packages/auth/src/index.ts';
import { Database } from '../packages/storage/src/index.ts';
import { canonicalHash } from '../packages/protocol/src/index.ts';

const origin = 'https://thot.example.test', start = Date.parse('2026-09-15T01:00:00Z');
const config: WalletAuthConfig = { schema_version: 'thot.wallet-auth/1', origin, chain_id: 46630, allow_public_signup: true };
async function setup(t: any, overrides: Partial<WalletAuthConfig> = {}) {
  const db = await Database.open(), clock = { now: start }, auth = await WalletAuth.create(db, { ...config, ...overrides }, () => clock.now);
  t.after(() => db.close()); return { db, auth, clock };
}
async function proof(auth: WalletAuth, wallet = Wallet.createRandom()) {
  const challenge = await auth.challenge({ address: wallet.address, chain_id: auth.chainId }, origin);
  return { wallet, challenge, input: { id: challenge.body.id, message: challenge.body.message, signature: await wallet.signMessage(challenge.body.message) }, cookies: challenge.set_cookie.split(';')[0]! };
}
async function login(auth: WalletAuth, wallet = Wallet.createRandom()) {
  const signed = await proof(auth, wallet), result = await auth.verify(signed.input, origin, signed.cookies);
  const token = auth.tokenFromCookie(result.set_cookies[0]!.split(';')[0]);
  return { ...signed, result, token, session: await auth.authenticate(token) };
}

test('wallet sign-in proves address, creates only contributor role, binds payout ownership and sets protected cookies', async t => {
  const { db, auth } = await setup(t), a = await login(auth);
  assert.equal(a.result.body.actor.role, 'user'); assert.equal(a.session.actor.id, a.result.body.actor.id);
  assert.equal(a.session.wallet_address, a.wallet.address); assert.equal(a.session.chain_id, 46630);
  assert.match(a.challenge.body.message, /^https:\/\/thot\.example\.test wants you to sign in with your Ethereum account:/);
  assert.match(a.challenge.body.message, /\nVersion: 1\nChain ID: 46630\nNonce: [0-9a-f]{32}\n/);
  for (const cookie of [a.challenge.set_cookie, ...a.result.set_cookies]) { assert.match(cookie, /; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/); assert.doesNotMatch(cookie, /Domain=/); }
  assert.match(a.result.set_cookies[0]!, /^__Host-thot_session=/); assert.match(a.result.set_cookies[1]!, /Max-Age=0/);
  const bound = await db.transaction(tx => tx.get('thot_records', 'wallet:' + a.session.actor.id, a.session.actor.id));
  assert.equal(bound.address, a.wallet.address);
  const stored = JSON.stringify((await db.query('SELECT document FROM auth_access')).rows);
  assert.ok(!stored.includes(a.token)); assert.ok(!stored.includes(a.input.signature)); assert.ok(!stored.includes(a.cookies.split('=')[1]!));
  assert.ok(!JSON.stringify(a.result.body).includes(a.token));
  assert.equal(auth.capabilities.mode, 'wallet_siwe'); assert.equal(auth.capabilities.development_session_available, false);
});

test('reviewed private Anvil configuration pins auth and exposes only its same-origin capability RPC', async t => {
  const rpc_url=origin+'/rpc/'+'r'.repeat(43), { auth } = await setup(t, { chain_id: 31337, rpc_url }), a = await login(auth);
  assert.equal(auth.chainId, 31337); assert.equal(auth.capabilities.wallet?.chain_id, 31337);
  assert.equal(auth.capabilities.wallet?.rpc_url,rpc_url);
  assert.equal(a.challenge.body.chain_id, 31337); assert.match(a.challenge.body.message, /\nChain ID: 31337\n/);
  assert.match(a.session.identity.subject, /^eip155:31337:/); assert.equal(a.session.chain_id, 31337);
  await assert.rejects(auth.challenge({address:a.wallet.address,chain_id:46630},origin),/AUTH_CHAIN_MISMATCH/);
});

test('mainnet wallet auth pins chain 4663 and never accepts a testnet challenge', async t => {
  const {auth}=await setup(t,{chain_id:4663,allowed_origins:['https://app.thot.market']}),a=await login(auth);
  assert.equal(auth.capabilities.wallet?.rpc_url,'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(a.session.chain_id,4663);
  assert.match(a.challenge.body.message,/\nChain ID: 4663\n/);
  assert.match(a.session.identity.subject,/^eip155:4663:/);
  await assert.rejects(auth.challenge({address:a.wallet.address,chain_id:46630},origin),/AUTH_CHAIN_MISMATCH/);
});

test('adding a stable alias preserves existing membership, wallet binding and native sessions', async t => {
  const alias='https://app.test.thot.market', {db,auth,clock}=await setup(t), existing=await login(auth);
  const updated=await WalletAuth.create(db,{...config,allowed_origins:[alias]},()=>clock.now);
  assert.equal(updated.issuer,auth.issuer);
  assert.equal((await updated.authenticate(existing.token)).actor.id,existing.session.actor.id);
  const challenge=await updated.challenge({address:existing.wallet.address,chain_id:46630},alias);
  assert.ok(challenge.body.message.startsWith(alias+' wants you to sign in'));
  assert.ok(challenge.body.message.includes('\nURI: '+alias+'/app\n'));
  const input={id:challenge.body.id,message:challenge.body.message,signature:await existing.wallet.signMessage(challenge.body.message)};
  const cookies=challenge.set_cookie.split(';')[0]!;
  await assert.rejects(updated.verify(input,origin,cookies),/AUTH_CHALLENGE_MISMATCH/);
  const accepted=await updated.verify(input,alias,cookies);
  assert.equal(accepted.body.actor.id,existing.session.actor.id);
  assert.equal((await db.query('SELECT count(*)::text AS count FROM users')).rows[0]!.count,'1');
  assert.equal(updated.capabilitiesForOrigin(alias).wallet.origin,alias);
  assert.equal(updated.capabilitiesForOrigin(origin).wallet.origin,origin);
  assert.equal((await login(updated,existing.wallet)).session.actor.id,existing.session.actor.id);
});

test('wallet aliases are exact HTTPS origins with no wildcard or implicit suffix authorization', async t => {
  const {db}=await setup(t), alias='https://app.test.thot.market';
  assert.deepEqual(walletAuthOrigins(origin,[alias]),[origin,alias]);
  for(const invalid of [null,alias,[origin],[alias,alias],['https://*.thot.market'],['https://user@app.test.thot.market'],[alias+'/'],[alias+'/app'],[alias+'?x=1'],['http://app.test.thot.market'],Array(9).fill(alias)]) {
    await assert.rejects(WalletAuth.create(db,{...config,allowed_origins:invalid} as any),/INVALID_AUTH_CONFIGURATION/);
  }
  const auth=await WalletAuth.create(db,{...config,allowed_origins:[alias]});
  for(const bad of ['https://app.test.thot.market.attacker.example','https://other.app.test.thot.market',alias+':444'])assert.throws(()=>auth.requireOrigin(bad),/AUTH_ORIGIN_MISMATCH/);
});

test('one wallet challenge can be consumed only once including concurrent verification', async t => {
  const { auth } = await setup(t), p = await proof(auth);
  const results = await Promise.allSettled([auth.verify(p.input, origin, p.cookies), auth.verify(p.input, origin, p.cookies)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /AUTH_CHALLENGE_EXPIRED_OR_USED/);
  await assert.rejects(auth.verify(p.input, origin, p.cookies), /AUTH_CHALLENGE_EXPIRED_OR_USED/);
});

test('wallet proofs reject absent or wrong origin, different domain or chain and untrusted extra fields', async t => {
  const { auth } = await setup(t), p = await proof(auth);
  for (const badOrigin of [undefined, 'null', 'https://evil.example.test', origin + '/', 'http://thot.example.test']) {
    await assert.rejects(auth.challenge({ address: p.wallet.address, chain_id: 46630 }, badOrigin), /AUTH_ORIGIN_MISMATCH/);
    await assert.rejects(auth.verify(p.input, badOrigin, p.cookies), /AUTH_ORIGIN_MISMATCH/);
  }
  await assert.rejects(auth.challenge({ address: p.wallet.address, chain_id: 1 }, origin), /AUTH_CHAIN_MISMATCH/);
  await assert.rejects(auth.challenge({ address: p.wallet.address, chain_id: 46630, role: 'operator_security' } as any, origin), /INVALID_WALLET_CHALLENGE/);
  await assert.rejects(auth.verify({ ...p.input, role: 'operator_security' } as any, origin, p.cookies), /INVALID_WALLET_PROOF/);
  for (const message of [p.input.message.replace('Chain ID: 46630', 'Chain ID: 1'), p.input.message.replaceAll(origin, 'https://evil.example.test'), p.input.message.replace('URI: ' + origin + '/app', 'URI: ' + origin + '/operator')]) {
    await assert.rejects(auth.verify({ ...p.input, message, signature: await p.wallet.signMessage(message) }, origin, p.cookies), /AUTH_CHALLENGE_MISMATCH/);
  }
});

test('wallet proofs require browser-bound cookie and exact signer; copied challenge and arbitrary signatures fail', async t => {
  const { auth } = await setup(t), p = await proof(auth), other = await proof(auth);
  await assert.rejects(auth.verify(p.input, origin), /AUTH_CHALLENGE_COOKIE_REQUIRED/);
  await assert.rejects(auth.verify(p.input, origin, other.cookies), /AUTH_CHALLENGE_MISMATCH/);
  await assert.rejects(auth.verify({ ...p.input, signature: await other.wallet.signMessage(p.input.message) }, origin, p.cookies), /INVALID_WALLET_SIGNATURE/);
  await assert.rejects(auth.verify({ ...p.input, signature: '0x' + '00'.repeat(65) }, origin, p.cookies), /INVALID_WALLET_SIGNATURE/);
  await assert.rejects(auth.verify(p.input, origin, p.cookies + '; ' + p.cookies), /INVALID_AUTH_COOKIE/);
  const okay = await auth.verify(p.input, origin, p.cookies); assert.equal(okay.body.wallet_address, p.wallet.address);
});

test('wallet challenge expires exactly at five minutes and cannot create an account afterward', async t => {
  const { db, auth, clock } = await setup(t), p = await proof(auth); clock.now += 300_000;
  await assert.rejects(auth.verify(p.input, origin, p.cookies), /AUTH_CHALLENGE_EXPIRED_OR_USED/);
  assert.equal((await db.query('SELECT count(*)::text AS count FROM users')).rows[0]!.count, '0');
});

test('distinct wallets have distinct workspaces and no supplied address can switch an authenticated session', async t => {
  const { auth } = await setup(t), a = await login(auth), b = await login(auth);
  assert.notEqual(a.session.actor.id, b.session.actor.id);
  assert.equal((await auth.authenticate(a.token)).wallet_address, a.wallet.address);
  assert.equal((await auth.authenticate(b.token)).wallet_address, b.wallet.address);
  for (const token of [a.wallet.address, a.input.signature, a.token + b.token, 'operator_security', 'Bearer ' + a.token]) await assert.rejects(auth.authenticate(token), /UNAUTHENTICATED/);
  assert.throws(() => auth.tokenFromCookie(`${WALLET_SESSION_COOKIE}=${a.token}; ${WALLET_SESSION_COOKIE}=${b.token}`), /INVALID_AUTH_COOKIE/);
});

test('a signature cannot adopt a wallet already linked to another account or acquire that account traces', async t => {
  const { db, auth } = await setup(t), p = await proof(auth);
  await db.transaction(tx => tx.insert('thot_records', 'wallet:existing-clerk-user', 'existing-clerk-user', { kind: 'wallet', address: p.wallet.address }));
  await assert.rejects(auth.verify(p.input, origin, p.cookies), /WALLET_ALREADY_BOUND/);
  assert.equal((await db.query('SELECT count(*)::text AS count FROM users')).rows[0]!.count, '0');
});

test('wallet login never resets disabled membership or changes contributor into operator from new configuration', async t => {
  const { db, auth, clock } = await setup(t), a = await login(auth);
  const configured = await WalletAuth.create(db, { ...config, operator_addresses: [a.wallet.address] }, () => clock.now);
  assert.equal((await login(configured, a.wallet)).session.actor.role, 'user');
  await db.transaction(async tx => {
    const id = 'membership:' + canonicalHash({ issuer: auth.issuer, subject: a.session.identity.subject }), row = await tx.get('auth_access', id);
    await tx.update('auth_access', id, { ...row, enabled: false });
  });
  await assert.rejects(auth.authenticate(a.token), /UNAUTHENTICATED/);
  const p = await proof(configured, a.wallet); await assert.rejects(configured.verify(p.input, origin, p.cookies), /UNAUTHENTICATED/);
});

test('operator access requires an explicit address and disappears if that configuration is removed', async t => {
  const wallet = Wallet.createRandom(), { db, auth, clock } = await setup(t, { allow_public_signup: false, operator_addresses: [wallet.address] });
  const operator = await login(auth, wallet); assert.equal(operator.session.actor.role, 'operator_security');
  const bound=await db.transaction(tx=>tx.get('thot_records','wallet:'+operator.session.actor.id,operator.session.actor.id));
  assert.equal(bound.address,wallet.address);
  assert.equal((await login(auth,wallet)).session.actor.id,operator.session.actor.id);
  const denied = await proof(auth); await assert.rejects(auth.verify(denied.input, origin, denied.cookies), /AUTH_SIGNUP_DISABLED/);
  const noOperators = await WalletAuth.create(db, { ...config, allow_public_signup: false }, () => clock.now);
  await assert.rejects(noOperators.authenticate(operator.token), /AUTH_OPERATOR_NOT_CONFIGURED/);
  const p = await proof(noOperators, wallet); await assert.rejects(noOperators.verify(p.input, origin, p.cookies), /AUTH_OPERATOR_NOT_CONFIGURED/);
});

test('wallet session expires exactly at its TTL and logout is durable across auth instances', async t => {
  const { db, auth, clock } = await setup(t, { session_ttl_seconds: 300 }), a = await login(auth);
  clock.now += 299_000; assert.equal((await auth.authenticate(a.token)).actor.id, a.session.actor.id);
  clock.now += 1_000; await assert.rejects(auth.authenticate(a.token), /UNAUTHENTICATED/);
  const b = await login(auth); await auth.revoke(b.session.identity, b.session.actor, 'logout-wallet-session');
  const again = await WalletAuth.create(db, { ...config, session_ttl_seconds: 300 }, () => clock.now);
  await assert.rejects(again.authenticate(b.token), /UNAUTHENTICATED/);
  assert.match(again.clearSessionCookie(), /^__Host-thot_session=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Strict$/);
});

test('consumed wallet challenges and revoked sessions remain rejected after a database restart', async t => {
  const path = await mkdtemp(join(tmpdir(), 'thot-wallet-durable-')); let db = await Database.open({ dataDir: path });
  t.after(async () => { await db.close(); await rm(path, { recursive: true, force: true }); });
  const auth = await WalletAuth.create(db, config, () => start), a = await login(auth);
  await auth.revoke(a.session.identity, a.session.actor, 'durable-wallet-logout'); await db.close();
  db = await Database.open({ dataDir: path }); const restored = await WalletAuth.create(db, config, () => start + 1000);
  await assert.rejects(restored.verify(a.input, origin, a.cookies), /AUTH_CHALLENGE_EXPIRED_OR_USED/);
  await assert.rejects(restored.authenticate(a.token), /UNAUTHENTICATED/);
  assert.equal((await login(restored, a.wallet)).session.actor.id, a.session.actor.id);
});

test('wallet challenge quotas persist across instances and reset after their time window', async t => {
  const { db, auth, clock } = await setup(t), wallet = Wallet.createRandom();
  for (let i = 0; i < 10; i++) await auth.challenge({ address: wallet.address, chain_id: 46630 }, origin);
  const again = await WalletAuth.create(db, config, () => clock.now);
  await assert.rejects(again.challenge({ address: wallet.address, chain_id: 46630 }, origin), /AUTH_CHALLENGE_RATE_LIMIT/);
  clock.now += 60_000; await again.challenge({ address: wallet.address, chain_id: 46630 }, origin);
});

test('wallet config fails closed for HTTP, unreviewed chains, accidental privilege flags and insecure explicit files', async t => {
  const { db } = await setup(t);
  for (const bad of [{ origin: 'http://localhost:4325' }, { origin: origin + '/' }, { chain_id: 1 }, { chain_id: 31338 }, {chain_id:31337},{chain_id:31337,rpc_url:'https://rpc.example.test/'},{chain_id:31337,rpc_url:origin+'/rpc/short'},{chain_id:4663,rpc_url:'https://rpc.testnet.chain.robinhood.com'},{rpc_url:origin+'/rpc/'+'r'.repeat(43)}, { auto_admin: true }, { operator_addresses: ['not-an-address'] }, { session_ttl_seconds: 86400 }, { allow_public_signup: undefined }]) await assert.rejects(WalletAuth.create(db, { ...config, ...bad } as any), /INVALID_AUTH_CONFIGURATION/);
  const dir = await mkdtemp(join(tmpdir(), 'thot-wallet-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json'), link = join(dir, 'auth-link.json'); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadWalletAuthConfig(file), config); await symlink(file, link);
  await assert.rejects(loadWalletAuthConfig(link), /AUTH_CONFIGURATION_UNAVAILABLE/);
  await chmod(file, 0o666); await assert.rejects(loadWalletAuthConfig(file), /INSECURE_AUTH_CONFIGURATION/);
});
