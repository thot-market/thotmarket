import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { AuthAccessStore, type AuthProvider } from '../packages/auth/src/index.ts';
import { createHttpServer } from '../apps/api/server.ts';
import { publicLaunchConfig, readPublicAsset } from '../apps/api/public-site.ts';

const tokenAddress = '0x1111111111111111111111111111111111111111';
const ponsLaunchAddress = '0x2222222222222222222222222222222222222222';

test('trading stays unavailable until the operator selects launched and both nonzero addresses', () => {
  for (const config of [
    {}, { state: 'launched' }, { state: 'preview', tokenAddress, ponsLaunchAddress },
    { state: 'launched', tokenAddress }, { state: 'launched', ponsLaunchAddress },
    { state: 'launched', tokenAddress: '0x' + '0'.repeat(40), ponsLaunchAddress },
    { state: 'launched', tokenAddress, ponsLaunchAddress: '0x' + '0'.repeat(40) },
    { state: 'launched', tokenAddress: tokenAddress + '?redirect=https://other.invalid', ponsLaunchAddress },
    { state: 'launched', tokenAddress, ponsLaunchAddress: 'javascript:alert(1)' },
  ]) {
    const result = publicLaunchConfig(config);
    assert.equal(result.state, 'preview');
    assert.equal(result.tokenAddress, null);
    assert.equal(result.tokenUrl, null);
    assert.equal(result.holdingIncome, false);
    assert.equal(result.mechanismStatus, 'selected-not-live');
  }
  const result = publicLaunchConfig({ state: 'launched', tokenAddress, ponsLaunchAddress });
  assert.equal(result.state, 'launched');
  assert.equal(result.tokenAddress, tokenAddress);
  assert.equal(result.tokenUrl, `https://www.ponsfamily.com/launchpad/${ponsLaunchAddress}`);
  assert.equal(result.holdingIncome, false);
  assert.equal(result.mechanismStatus, 'selected-not-live');
});

test('public files use an explicit asset list rather than request-selected filesystem paths', async () => {
  const page = await readPublicAsset('/');
  assert.ok(page);
  assert.match(page.contentType, /^text\/html/);
  const logo = await readPublicAsset('/assets/thot-logo.png');
  assert.ok(logo);
  assert.equal(logo.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const tutorial = await readPublicAsset('/tutorial');
  assert.ok(tutorial);
  assert.match(tutorial.contentType, /^text\/html/);
  const proofFlow = await readPublicAsset('/assets/robinhood-trade-proof-flow.svg');
  assert.ok(proofFlow);
  assert.equal(proofFlow.contentType, 'image/svg+xml');
  assert.match(proofFlow.body.toString(), /^<svg/);
  for (const path of [
    '/apps/api/server.ts', '/config/clerk.example.json', '/.env',
    '/assets/../../api/server.ts', '/assets/%2e%2e/%2e%2e/api/server.ts',
    '/assets/thot-logo.png/../server.ts', '/site.css?file=../../config/clerk.example.json',
  ]) assert.equal(await readPublicAsset(path), undefined, path);
});

test('legacy capture, brokerage and saved-trace links forward only to the same-origin app', async () => {
  const source = await readFile(new URL('../apps/site/site.js', import.meta.url), 'utf8');
  for (const hash of ['#thot=encoded', '#thot-robinhood=encoded', '#trace=saved-trace', '#trace=https://outside.invalid']) {
    const destinations: string[] = [];
    runInNewContext(source, {
      window: { location: { hash, search: '?__clerk_handshake=synthetic', replace: (value: string) => destinations.push(value) } },
      document: { getElementById: () => null, querySelectorAll: () => [] },
      fetch: async () => ({ ok: false }), AbortSignal, URLSearchParams,
    });
    assert.deepEqual(destinations, ['/app?__clerk_handshake=synthetic' + hash]);
  }
  for (const hash of ['', '#how-it-works', '#redirect=https://outside.invalid', '#thot-unknown=encoded']) {
    const destinations: string[] = [];
    runInNewContext(source, {
      window: { location: { hash, search: '?redirect=https://outside.invalid', replace: (value: string) => destinations.push(value) } },
      document: { getElementById: () => null, querySelectorAll: () => [] },
      fetch: async () => ({ ok: false }), AbortSignal, URLSearchParams,
    });
    assert.deepEqual(destinations, []);
  }
  const destinations: string[] = [];
  runInNewContext(source, {
    window: { location: { hash: '', search: '?oauth_state_id=synthetic', replace: (value: string) => destinations.push(value) } },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    fetch: async () => ({ ok: false }), AbortSignal, URLSearchParams,
  });
  assert.deepEqual(destinations, ['/app?oauth_state_id=synthetic']);
});

test('public documents and launch config preserve private API, development-auth, and Host/Origin protections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'thot-public-site-'));
  const app = await createApplication({ memory: true, dataDir: dir });
  let authenticationAttempts = 0;
  const auth: AuthProvider = {
    access: new AuthAccessStore(app.db, 'https://auth.example.invalid'),
    capabilities: {
      mode: 'clerk', development_session_available: false, external_login_available: true,
      clerk: { publishable_key: 'pk_test_public', frontend_api_url: 'https://auth.example.invalid' },
    },
    async authenticate() { authenticationAttempts++; throw Error('Unexpected provider call in unauthenticated public-route test'); },
    async revoke() { throw Error('Unexpected revocation'); },
  };
  const server = createHttpServer(app, { publicOrigin: 'https://site.example', externalAuth: auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path: string, method = 'GET', headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; type?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: { Host: 'site.example', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers }, setHost: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', value => { body += value; });
      res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });

  for (const path of ['/', '/read', '/tutorial', '/whitepaper', '/affiliates', '/affiliates.html', '/referrals.js', '/referrals.css', '/app', '/app/', '/site.js', '/assets/robinhood-trade-proof-flow.svg', '/assets/thot-logo.png']) {
    assert.equal((await call(path)).status, 200, path);
    assert.equal((await call(path, 'GET', { Host: 'wrong.example' })).status, 403, path);
  }
  const head = await call('/assets/thot-logo.png', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.type, 'image/png');
  assert.equal(head.body, '');
  const configuration = await call(`/v1/public/launch-config?state=launched&tokenAddress=${tokenAddress}&ponsLaunchAddress=${ponsLaunchAddress}`);
  assert.equal(configuration.status, 200);
  assert.deepEqual(JSON.parse(configuration.body), publicLaunchConfig());

  for (const path of ['/v1/contributor/portfolio', '/v1/earnings', '/v1/buyer/mandates', '/config/clerk.example.json', '/apps/api/server.ts']) {
    assert.equal((await call(path)).status, 401, path);
  }
  const development = await call('/v1/dev/session', 'POST');
  assert.equal(development.status, 403);
  assert.equal(JSON.parse(development.body).error, 'DEVELOPMENT_AUTH_DISABLED');

  const navigation = { Origin: 'https://login.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const path of ['/', '/read', '/tutorial', '/whitepaper', '/affiliates', '/affiliates.html', '/app', '/app/', '/getting-started']) {
    assert.equal((await call(path, 'GET', navigation)).status, 200, path);
    assert.equal((await call(path, 'POST', navigation)).status, 403, path);
    assert.equal((await call(path, 'GET', { ...navigation, 'Sec-Fetch-Dest': 'iframe' })).status, 403, path);
    assert.equal((await call(path, 'GET', { ...navigation, Host: 'wrong.example' })).status, 403, path);
  }
  for (const path of ['/site.js', '/site.css', '/referrals.js', '/referrals.css', '/assets/thot-logo.png', '/v1/public/launch-config', '/v1/public/market-proof', '/v1/auth/session', '/v1/contributor/portfolio']) {
    assert.equal((await call(path, 'GET', navigation)).status, 403, path);
  }
  assert.equal(authenticationAttempts, 0);
});

test('public copy distinguishes trade properties, paid buyer access and persistent opt-in DAO sampling', async () => {
  const [home, mechanism, access] = await Promise.all([
    readFile(new URL('../apps/site/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/site/mechanism.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/site/access.html', import.meta.url), 'utf8'),
  ]);
  for (const html of [home, mechanism, access]) assert.match(html, /href="\/tutorial"/);
  assert.match(home, /src="\/assets\/robinhood-trade-proof-flow\.svg"/);
  assert.match(home, /They see no order records and no excerpt from the research/);
  assert.match(mechanism, /with little or no qualifying THOT can still buy/);
  assert.match(mechanism, /There is no membership surcharge/);
  assert.match(mechanism, /20% of net service contribution/);
  assert.match(mechanism, /365-day funding window/);
  assert.match(mechanism, /Nineteen traces produce no selection; 20 produce one; 40 produce two/);
  assert.match(mechanism, /cannot draw again/);
  assert.match(mechanism, /ordinary buyers no access to trace content/);
  assert.doesNotMatch(mechanism, /requires a combined balance|Ineligible purchases cannot complete|free randomly selected preview/i);
});


test('production documents keep calibration out; public examples identify their basis', async () => {
  for (const path of ['apps/site/mechanism.html', 'launch-prep/LAUNCH_POST.md', 'launch-prep/WHITEPAPER.md']) {
    const copy = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(copy, /TESTTHOT|test calibration|testnet tariff|0\.0(?:01|04|06|1|2|3|34|4|6)\b|one.hour|10 million THOT/i, path);
    assert.match(copy, /12 hours after recorded delivery to raise an eligible dispute/, path);
    assert.match(copy, /production (?:policy for lock-based benefits|tariff)/i, path);
  }
  for (const path of ['apps/site/index.html', 'apps/site/affiliates.html']) {
    const html = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.match(html, /Worked example · testnet tariff/);
    assert.match(html, /production tariff/);
    assert.match(html, /not customer adoption or real-money earnings/i);
    assert.match(html, /direct costs/);
    assert.doesNotMatch(html, /customers already|guaranteed earnings|data-fake-counter/i);
  }
});
