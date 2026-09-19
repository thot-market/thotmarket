import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { WalletAuth, type WalletAuthConfig } from '../packages/auth/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { importDemo } from '../packages/market/src/fixtures.ts';

const origin = 'https://thot.example.test', host = 'thot.example.test';
const config: WalletAuthConfig = { schema_version: 'thot.wallet-auth/1', origin, chain_id: 46630, allow_public_signup: true, session_ttl_seconds: 300 };
async function setup(t: any, privy?: {app_id:string;client_id?:string}, aliases: string[] = [], readOnly=false) {
  const dir = await mkdtemp(join(tmpdir(), 'thot-wallet-http-')), clock = { now: Date.parse('2026-09-15T02:00:00Z') };
  const app = await createApplication({ memory: true, dataDir: dir, readOnly, config: { clock: () => new Date(clock.now) } });
  const auth = await WalletAuth.create(app.db, {...config,allowed_origins:aliases}, () => clock.now), logs: any[] = [];
  // Loopback transport, explicit HTTPS logical origin: these tests do not weaken production cookie policy.
  const server = createHttpServer(app, { externalAuth: auth, publicOrigin: origin, privy, readOnly, clock: () => clock.now, log: entry => logs.push(entry) });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const call = (path: string, options: { body?: any; cookies?: string; origin?: string | null; host?: string; method?: string; headers?: Record<string, string> } = {}) => new Promise<any>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body), headers: Record<string, string> = { Host: options.host ?? host, ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}), ...(options.cookies ? { Cookie: options.cookies } : {}), ...(options.origin === null ? {} : { Origin: options.origin ?? origin }), ...options.headers };
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('error', reject); res.on('end', () => { const raw = Buffer.concat(chunks).toString(); let result; try { result = JSON.parse(raw); } catch { result = raw; } resolve({ status: res.statusCode, headers: res.headers, body: result }); });
    }); req.on('error', reject); req.end(body);
  });
  const login = async (wallet = Wallet.createRandom(), requestOrigin = origin) => {
    const originHeaders={origin:requestOrigin,host:new URL(requestOrigin).host};
    const challenge = await call('/v1/auth/wallet/challenge', { ...originHeaders, body: { address: wallet.address, chain_id: 46630 } }); assert.equal(challenge.status, 200);
    const challengeCookie = challenge.headers['set-cookie'][0].split(';')[0];
    const input = { id: challenge.body.id, message: challenge.body.message, signature: await wallet.signMessage(challenge.body.message) };
    const result = await call('/v1/auth/wallet/verify', { ...originHeaders, body: input, cookies: challengeCookie }); assert.equal(result.status, 200);
    return { wallet, challenge, challengeCookie, input, result, cookies: result.headers['set-cookie'][0].split(';')[0] };
  };
  return { app, auth, call, login, clock, logs };
}

test('signless old-candidate mode retains wallet login and workspace but rejects financial writes and future routes', async t => {
  const {call,login}=await setup(t,undefined,[],true),account=await login();
  assert.equal((await call('/v1/auth/session',{cookies:account.cookies})).status,200);
  assert.equal((await call('/v1/thot/workspace',{cookies:account.cookies})).status,200);
  for(const path of ['/v1/thot/offers/prepare','/v1/thot/listings','/v1/thot/disputes/finalize','/v1/openrouter/chat/completions','/v1/unknown-future-route']){
    const denied=await call(path,{cookies:account.cookies,body:{}});
    assert.equal(denied.status,403,path);assert.equal(denied.body.error,'THOT_READ_ONLY',path);
  }
  assert.equal((await call('/v1/traces',{cookies:account.cookies})).status,403);
  const delivery=await call('/v1/thot/offers/delivery',{cookies:account.cookies,body:{id:'0x'+'0'.repeat(64)}});
  assert.notEqual(delivery.body.error,'THOT_READ_ONLY','only delivery passes the route guard');
});

test('Privy public onboarding config preserves SIWE ownership and enables only the required CSP origins', async t => {
  const {call, login} = await setup(t, {app_id:'cmu2kc1sv03370dla944rfnb7', client_id:'client-public-fixture'});
  const capabilities = await call('/v1/auth/capabilities');
  assert.deepEqual(capabilities.body.privy, {app_id:'cmu2kc1sv03370dla944rfnb7',client_id:'client-public-fixture',chain_id:46630,rpc_url:'https://rpc.testnet.chain.robinhood.com'});
  assert.equal(capabilities.body.mode, 'wallet_siwe'); assert.equal(capabilities.body.bearer_required, false);
  const policy = capabilities.headers['content-security-policy'];
  assert.match(policy, /connect-src[^;]+https:\/\/auth\.privy\.io/); assert.match(policy, /frame-src[^;]+https:\/\/auth\.privy\.io/);
  assert.ok(!policy.includes("'unsafe-eval'")); assert.ok(!policy.includes("script-src 'self' 'unsafe-inline'"));
  const wallet = Wallet.createRandom(), first = await login(wallet), again = await login(wallet);
  assert.equal(first.result.body.actor.id, again.result.body.actor.id);
  assert.equal((await call('/v1/contributor/portfolio',{headers:{Authorization:'Bearer did:privy:someone'}})).status,401);
});

test('stable-host sign-in opens the existing vault while native callbacks keep the same capture owner', async t => {
  const alias='https://app.test.thot.market', stable={origin:alias,host:new URL(alias).host};
  const {app,call,login}=await setup(t,undefined,[alias]), existing=await login();
  await importDemo(app.service,existing.result.body.actor,'coding','native-vault-before-alias');
  const next=await login(existing.wallet,alias);
  assert.equal(next.result.body.actor.id,existing.result.body.actor.id);
  assert.ok(next.challenge.body.message.startsWith(alias+' wants you to sign in'));
  assert.equal((await call('/v1/auth/capabilities',stable)).body.wallet.origin,alias);
  assert.equal((await call('/v1/auth/capabilities')).body.wallet.origin,origin);
  const stableTraces=await call('/v1/traces',{...stable,cookies:next.cookies});
  const nativeTraces=await call('/v1/traces',{cookies:existing.cookies});
  assert.equal(stableTraces.status,200);assert.deepEqual(stableTraces.body,nativeTraces.body);assert.equal(stableTraces.body.length,1);
  for(const cookie of next.result.headers['set-cookie'])assert.ok(!cookie.includes('Domain='));
  const device=await call('/v1/contributor/capture-devices',{...stable,cookies:next.cookies,body:{client:'codex',device_name:'stable domain fixture',save_privately:true}});
  assert.equal(device.status,200);
  const capture=await call('/v1/capture-devices/'+device.body.device_id+'/captures',{origin:null,headers:{Authorization:'Bearer '+device.body.device_token},body:{client:'codex',project:'native callback fixture'}});
  assert.equal(capture.status,200);
  const saved=await app.agentCapture.authenticate(capture.body.capture_id,capture.body.upload_token);
  assert.equal(saved.owner_id,existing.result.body.actor.id);
});

test('known aliases cannot cross the Host/Origin boundary or smuggle forwarded origins', async t => {
  const alias='https://app.test.thot.market', stable={origin:alias,host:new URL(alias).host};
  const {call,login}=await setup(t,undefined,[alias]), account=await login();
  const rejected:Array<{host:string;origin:string;headers?:Record<string,string>}>=[
    {host:new URL(alias).host,origin}, {host,origin:alias},
    {host:'attacker.example',origin:alias,headers:{'X-Forwarded-Host':new URL(alias).host}},
    {...stable,origin:'https://attacker.example','headers':{'X-Forwarded-Host':new URL(alias).host,'X-Forwarded-Proto':'https'}},
  ];
  for(const request of rejected)assert.equal((await call('/v1/auth/session/revoke',{...request,cookies:account.cookies,body:{}})).status,403);
  const forwarded=await call('/v1/auth/capabilities',{headers:{'X-Forwarded-Host':new URL(alias).host,'X-Forwarded-Proto':'https'}});
  assert.equal(forwarded.body.wallet.origin,origin);
  assert.equal((await call('/v1/auth/session',{cookies:account.cookies})).status,200);
});

test('wallet HTTP sign-in returns cookie credentials, safe session fields, private contributor routes and complete logout', async t => {
  const { call, login, logs } = await setup(t), capabilities = await call('/v1/auth/capabilities');
  assert.equal(capabilities.body.mode, 'wallet_siwe'); assert.equal(capabilities.body.bearer_required, false); assert.equal(capabilities.body.development_session_available, false);
  assert.equal(capabilities.body.wallet.chain_id, 46630);
  const a = await login(); assert.equal(a.result.body.actor.role, 'user'); assert.equal(a.result.body.mode, 'wallet_siwe');
  assert.equal(a.result.body.permissions.trace_explorer, false);
  assert.equal(a.result.body.token, undefined); assert.equal(a.result.body.identity, undefined);
  assert.equal(a.result.headers['set-cookie'].length, 2);
  for (const value of a.result.headers['set-cookie']) assert.match(value, /; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
  const session = await call('/v1/auth/session', { cookies: a.cookies });
  assert.equal(session.status, 200); assert.equal(session.body.actor.id, a.result.body.actor.id);
  assert.equal(session.body.wallet_address.toLowerCase(), a.wallet.address.toLowerCase()); assert.equal(session.body.chain_id, 46630);
  assert.equal((await call('/v1/contributor/portfolio', { cookies: a.cookies })).status, 200);
  assert.equal((await call('/v1/contributor/portfolio')).status, 401);
  const logout = await call('/v1/auth/session/revoke', { cookies: a.cookies, body: {} }); assert.equal(logout.status, 200); assert.equal(logout.body.revoked, true);
  assert.ok(logout.headers['set-cookie'].every((value: string) => value.includes('Max-Age=0')));
  assert.equal((await call('/v1/auth/session', { cookies: a.cookies })).status, 401);
  const serialized = JSON.stringify(logs); for (const secret of [a.cookies.split('=')[1], a.input.signature, a.wallet.address]) assert.ok(!serialized.includes(secret));
});

test('wallet HTTP challenge and proof require exact HTTPS origin and configured host', async t => {
  const { call, login } = await setup(t), wallet = Wallet.createRandom();
  for (const bad of [{ origin: null }, { origin: 'null' }, { origin: 'https://evil.example.test' }, { origin: origin + '/' }, { host: 'evil.example.test' }]) assert.equal((await call('/v1/auth/wallet/challenge', { body: { address: wallet.address, chain_id: 46630 }, ...bad })).status, 403);
  const a = await login();
  assert.equal((await call('/v1/auth/wallet/verify', { body: a.input, cookies: a.challengeCookie, origin: null })).status, 403);
  assert.equal((await call('/v1/auth/wallet/verify', { body: a.input, cookies: a.challengeCookie, origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await call('/v1/auth/wallet/verify', { body: a.input, cookies: a.challengeCookie })).body.error, 'AUTH_CHALLENGE_EXPIRED_OR_USED');
});

test('wallet cookie mutations reject missing or foreign Origin without revoking an active session', async t => {
  const { call, login } = await setup(t), a = await login();
  for (const invalid of [null, 'null', 'https://evil.example.test', 'http://thot.example.test']) {
    const response = await call('/v1/auth/session/revoke', { body: {}, cookies: a.cookies, origin: invalid });
    assert.equal(response.status, 403); assert.equal(response.headers['set-cookie'], undefined, 'a rejected origin must not clear a browser session');
    assert.equal((await call('/v1/auth/session', { cookies: a.cookies })).status, 200);
    assert.equal((await call('/v1/contributor/import/preview', { body: {}, cookies: a.cookies, origin: invalid })).status, 403);
  }
  const hostileHost = await call('/v1/auth/session/revoke', { body: {}, cookies: a.cookies, host: 'evil.example.test' });
  assert.equal(hostileHost.status, 403); assert.equal(hostileHost.headers['set-cookie'], undefined);
  assert.equal((await call('/v1/auth/session', { cookies: a.cookies, origin: null })).status, 200, 'read-only cookie session restore is allowed without Origin');
});

test('wallet HTTP sign-in cannot request development, buyer or operator privileges', async t => {
  const { call, login } = await setup(t), a = await login();
  for (const role of ['user', 'buyer_admin', 'operator_security']) assert.equal((await call('/v1/dev/session', { body: { role } })).body.error, 'DEVELOPMENT_AUTH_DISABLED');
  assert.equal((await call('/v1/dev/trace', { body: { scenario: 'coding' }, cookies: a.cookies })).body.error, 'DEVELOPMENT_AUTH_DISABLED');
  assert.equal((await call('/v1/operator/reconciliation', { cookies: a.cookies })).status, 403);
  assert.equal((await call('/v1/operator/auth/membership', { cookies: a.cookies, body: { subject: 'operator', actor: { id: a.result.body.actor.id, role: 'operator_security' }, enabled: true } })).status, 403);
  assert.equal((await call('/v1/auth/wallet/challenge', { body: { address: a.wallet.address, chain_id: 46630, role: 'operator_security' } })).body.error, 'INVALID_WALLET_CHALLENGE');
  assert.equal((await call('/v1/auth/session', { cookies: a.cookies })).body.actor.role, 'user');
});

test('wallet HTTP session identity isolates two contributors and rejects duplicate session cookies', async t => {
  const { app, call, login } = await setup(t), a = await login(), b = await login();
  await importDemo(app.service, a.result.body.actor, 'coding', 'wallet-alice-private-trace');
  const aliceTraces = await call('/v1/traces', { cookies: a.cookies }), bobTraces = await call('/v1/traces', { cookies: b.cookies });
  assert.equal(aliceTraces.status, 200); assert.equal(bobTraces.status, 200); assert.equal(aliceTraces.body.length, 1); assert.equal(bobTraces.body.length, 0);
  assert.notEqual(a.result.body.actor.id, b.result.body.actor.id);
  assert.equal((await call('/v1/auth/session', { cookies: a.cookies + '; ' + b.cookies })).status, 401);
});

test('expired or absent wallet cookies still receive logout clearing headers from the correct origin', async t => {
  const { call, login, clock } = await setup(t), a = await login(); clock.now += 300_000;
  assert.equal((await call('/v1/auth/session', { cookies: a.cookies })).status, 401);
  for (const cookies of [a.cookies, undefined]) {
    const result = await call('/v1/auth/session/revoke', { body: {}, cookies }); assert.equal(result.status, 401);
    assert.equal(result.headers['set-cookie'].length, 2); assert.ok(result.headers['set-cookie'].every((value: string) => value.includes('Max-Age=0')));
  }
});
