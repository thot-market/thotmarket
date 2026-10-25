import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { createFormGate, hashFormGatePassword, loadFormGateConfig } from '../apps/api/form-gate.ts';

// The form/cookie gate replaces the staging Basic Auth prompt (#93). These
// tests drive the real HTTP surface: a fresh browser gets an HTML login page, a
// valid tester credential opens the site, an invalid one gets an on-page error,
// and revoking one tester stops only that tester's next request.

async function setup(t: any, credentials: Record<string,string> = {tester: hashFormGatePassword('synthetic-tester-passphrase'), second: hashFormGatePassword('synthetic-second-passphrase')}) {
  const app = await createApplication({memory: true, dataDir: await mkdtemp(join(tmpdir(), 'thot-gate-'))});
  const config = {cookieName: 'thot_gate', sessionHours: 12, credentials};
  const clock = {now: Date.parse('2026-10-25T12:00:00Z')};
  const gate = createFormGate(config, {clock: () => clock.now});
  const server = createHttpServer(app, {formGate: gate, clock: () => clock.now});
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await app.close();});
  const call = (path: string, {method = 'GET', headers = {}, body}: {method?: string; headers?: Record<string, string>; body?: string} = {}) =>
    new Promise<any>((resolve, reject) => {
      const req = fetch(base + path, {method, headers, redirect: 'manual', ...(body !== undefined ? {body} : {})});
      req.then(async response => resolve({status: response.status, headers: response.headers, location: response.headers.get('location') ?? '', setCookie: response.headers.get('set-cookie') ?? '', text: await response.text()}), reject);
    });
  return {app, call, config, credentials, clock};
}

test('a fresh browser gets an HTML login page and never a Basic Auth challenge', async t => {
  const {call} = await setup(t);
  const landing = await call('/', {headers: {Accept: 'text/html,application/xhtml+xml'}});
  assert.equal(landing.status, 303); assert.equal(landing.location, '/gate?next=%2F');
  const page = await call('/gate');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type')!, /text\/html/);
  assert.match(page.text, /<form class="gate" method="post" action="\/gate">/);
  assert.match(page.text, /name="username"/); assert.match(page.text, /type="password"/);
  assert.ok(!/Basic|WWW-Authenticate/i.test(JSON.stringify([...page.headers.entries()])));
  assert.ok(!/<script/i.test(page.text));
  assert.match(page.headers.get('content-security-policy')!, /form-action 'self'/);
});

test('a valid tester credential opens the site; an invalid one shows an on-page error', async t => {
  const {call} = await setup(t);
  const bad = await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=tester&password=wrong&next=/'});
  assert.equal(bad.status, 401); assert.match(bad.text, /not valid/); assert.equal(bad.setCookie, '');
  const good = await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=tester&password=synthetic-tester-passphrase&next=%2F'});
  assert.equal(good.status, 303); assert.equal(good.location, '/');
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(good.setCookie.includes(attribute), attribute);
  const cookie = good.setCookie.split(';')[0];
  const site = await call('/', {headers: {Accept: 'text/html', Cookie: cookie}});
  assert.equal(site.status, 200); assert.ok(!site.location.includes('gate'));
  const capabilities = await call('/v1/auth/capabilities', {headers: {Cookie: cookie}});
  assert.equal(capabilities.status, 200);
});

test('API requests without a session get a JSON status, and self-authenticated device routes stay reachable', async t => {
  const {call} = await setup(t);
  const api = await call('/v1/auth/capabilities');
  assert.equal(api.status, 401); assert.deepEqual(JSON.parse(api.text), {error: 'GATE_AUTH_REQUIRED'});
  // These routes carry their own device tokens: the gate must not front them.
  const pairing = await call('/v1/device-pairing/sessions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert.notEqual(pairing.status, 401); assert.notEqual(JSON.parse(pairing.text).error, 'GATE_AUTH_REQUIRED');
  const upload = await call('/v1/history-devices/some-device/imports', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert.notEqual(JSON.parse(upload.text).error, 'GATE_AUTH_REQUIRED');
  const health = await call('/healthz', {headers: {Accept: 'application/json'}});
  assert.equal(health.status, 200);
});

test('revoking one tester stops their next request without rotating the other tester', async t => {
  const {call, credentials} = await setup(t);
  const login = async (username: string, password: string) => (await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: `username=${username}&password=${password}&next=%2F`})).setCookie.split(';')[0];
  const testerCookie = await login('tester', 'synthetic-tester-passphrase'), secondCookie = await login('second', 'synthetic-second-passphrase');
  assert.equal((await call('/v1/auth/capabilities', {headers: {Cookie: testerCookie}})).status, 200);
  delete credentials.tester;
  const revoked = await call('/v1/auth/capabilities', {headers: {Cookie: testerCookie}});
  assert.equal(revoked.status, 401); assert.deepEqual(JSON.parse(revoked.text), {error: 'GATE_AUTH_REQUIRED'});
  assert.equal((await call('/v1/auth/capabilities', {headers: {Cookie: secondCookie}})).status, 200, 'the other tester keeps working');
  assert.equal((await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=tester&password=synthetic-tester-passphrase&next=%2F'})).status, 401, 'the revoked credential cannot sign in again');
});

test('repeated failures are throttled, sessions expire, and open redirects are refused', async t => {
  const {call, clock} = await setup(t);
  for (let attempt = 0; attempt < 10; attempt++) await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=tester&password=wrong&next=/'});
  const throttled = await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=tester&password=synthetic-tester-passphrase&next=/'});
  assert.equal(throttled.status, 429); assert.match(throttled.text, /Too many attempts/);
  const escape = await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=x&password=y&next=https://attacker.example.test'});
  assert.notEqual(escape.location, 'https://attacker.example.test');
  const good = await call('/gate', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'username=second&password=synthetic-second-passphrase&next=%2F'});
  const cookie = good.setCookie.split(';')[0];
  clock.now += 13 * 3600_000;
  const expired = await call('/v1/auth/capabilities', {headers: {Cookie: cookie}});
  assert.equal(expired.status, 401);
});

test('gate configuration is validated before the server accepts it', () => {
  const env = {...process.env, THOT_FORM_GATE: 'true', THOT_FORM_GATE_USERS: JSON.stringify({tester: hashFormGatePassword('x'.repeat(16))})};
  assert.equal(loadFormGateConfig(env)?.credentials.tester, JSON.parse(env.THOT_FORM_GATE_USERS).tester);
  assert.equal(loadFormGateConfig({...process.env, THOT_FORM_GATE: 'false'}), undefined);
  for (const users of ['{}', '{"a":"not-a-hash"}', '{invalid', '{"tester":"scrypt$AAAA$BBBB"}'])
    assert.throws(() => loadFormGateConfig({...process.env, THOT_FORM_GATE: 'true', THOT_FORM_GATE_USERS: users}), /INVALID_FORM_GATE_USERS|FORM_GATE_CONFIGURATION_REQUIRED/);
  assert.throws(() => loadFormGateConfig({...env, THOT_FORM_GATE_SESSION_HOURS: '0'}), /INVALID_FORM_GATE_SESSION_HOURS/);
});

test('the login form submits even when the browser sends an opaque null origin (#93)',async t=>{
  const {call}=await setup(t);
  const good=await call('/gate',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:'null','Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'},body:'username=tester&password=synthetic-tester-passphrase&next=%2F'});
  assert.equal(good.status,303);assert.ok(good.setCookie.includes('HttpOnly'),'session cookie set');
});
