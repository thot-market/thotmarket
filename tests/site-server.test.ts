import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createSiteServer, reviewerOrigin, workspaceUrl, startSiteServer, type SiteServerOptions } from '../apps/site/server.ts';

const invalidReviewers = [
  undefined, '', 'http://review.example', 'https://review.example/',
  'https://review.example/app', 'https://review.example?invite=private',
  'https://review.example#capability', 'https://user:password@review.example',
  'https://localhost', 'https://localhost.', 'https://vault.localhost',
  'https://127.0.0.1', 'https://127.2.3.4', 'https://0.0.0.0',
  'https://[::1]', 'https://[::ffff:7f00:1]', '//review.example',
  'javascript:alert(1)', 'https://review.example\n',
];

async function fixture(t: TestContext, options: SiteServerOptions = {}) {
  const server = createSiteServer(options);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return (path: string, method = 'GET', headers: Record<string, string> = {}) => new Promise<{ status: number; body: Buffer; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers: { Host: 'site.example', ...headers }, setHost: false }, res => {
      const parts: Buffer[] = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(parts), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{"role":"operator_security"}' : undefined);
  });
}

test('reviewer configuration accepts only an exact nonlocal HTTPS origin', () => {
  for (const value of invalidReviewers) assert.equal(reviewerOrigin(value), null, String(value));
  assert.equal(reviewerOrigin('https://review.example'), 'https://review.example');
  assert.equal(reviewerOrigin('https://review.example:4322'), 'https://review.example:4322');
  assert.throws(() => createSiteServer({ publicOrigin: 'https://site.example/path' }), /INVALID_SITE_PUBLIC_ORIGIN/);
  assert.throws(() => createSiteServer({ publicOrigin: 'http://site.example' }), /INVALID_SITE_PUBLIC_ORIGIN/);
});

test('standalone website serves public assets and access page but no application or development APIs', async t => {
  const call = await fixture(t, { publicOrigin: 'https://site.example', reviewerUrl: 'https://review.example' });
  for (const path of ['/', '/index.html', '/read', '/tutorial', '/whitepaper', '/affiliates', '/affiliates.html', '/referrals.css', '/referrals.js', '/app', '/app/', '/site.css', '/site.js', '/access.js', '/assets/robinhood-trade-proof-flow.svg', '/assets/fonts/dm-sans-latin.woff2']) {
    const result = await call(path);
    assert.equal(result.status, 200, path);
    const csp = result.headers['content-security-policy'];
    assert.ok(typeof csp === 'string');
    assert.match(csp, /font-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
  }
  const access = await call('/app');
  assert.match(access.body.toString(), /Put your thoughts/);
  assert.match(access.body.toString(), /id="reviewer-link"[^>]*hidden/);
  assert.doesNotMatch(access.body.toString(), /https:\/\/review\.example|clerk-auth-ui|\/app\.js/);
  assert.equal(access.headers['cache-control'], 'no-store');
  const config = await call('/v1/public/site-config?reviewerUrl=https://outside.invalid');
  assert.deepEqual(JSON.parse(config.body.toString()), { reviewerUrl: 'https://review.example', access: 'invited-reviewers', privateAppHosted: false });
  assert.equal(config.headers['cache-control'], 'no-store');
  const affiliatesRedirect = await call('/affiliates/?next=https://outside.invalid');
  assert.equal(affiliatesRedirect.status, 301);
  assert.equal(affiliatesRedirect.headers.location, '/affiliates');
  for (const path of ['/v1/dev/session', '/v1/auth/session', '/v1/auth/capabilities', '/v1/earnings', '/v1/contributor/portfolio', '/v1/buyer/mandates', '/v1/agent-captures/example/authorize', '/app.js', '/apps/api/server.ts', '/server.ts', '/config/clerk.example.json', '/WHITEPAPER.md', '/launch-prep/WHITEPAPER.md', '/.env']) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.toString(), '{"error":"NOT_FOUND"}');
  }
  for (const path of ['/', '/app', '/healthz', '/v1/public/site-config', '/v1/dev/session', '/v1/contributor/portfolio']) {
    const response = await call(path, 'POST');
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.allow, 'GET, HEAD');
    assert.equal(response.body.toString(), '{"error":"METHOD_NOT_ALLOWED"}');
  }
  assert.equal((await call('/', 'GET', { Host: 'wrong.example' })).status, 403);
  assert.equal((await call('/v1/public/site-config', 'GET', { Host: 'wrong.example' })).status, 403);
});

test('HEAD returns matching content metadata without a body and traversal never selects server files', async t => {
  const call = await fixture(t);
  for (const path of ['/app', '/read', '/tutorial', '/whitepaper', '/affiliates', '/affiliates/', '/assets/robinhood-trade-proof-flow.svg', '/assets/thot-logo.png', '/site.css', '/v1/public/site-config', '/v1/public/market-proof', '/v1/public/market-proof.json', '/healthz', '/missing']) {
    const get = await call(path);
    const head = await call(path, 'HEAD');
    assert.equal(head.status, get.status, path);
    assert.equal(head.headers['content-type'], get.headers['content-type'], path);
    assert.equal(head.headers['content-length'], String(get.body.length), path);
    assert.equal(head.body.length, 0, path);
  }
  const image = await call('/assets/thot-logo.png');
  assert.equal(image.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.headers['cache-control'], 'public, max-age=3600');
  const proofFlow = await call('/assets/robinhood-trade-proof-flow.svg');
  assert.equal(proofFlow.headers['content-type'], 'image/svg+xml');
  assert.match(proofFlow.body.toString(), /<svg[^>]+aria-labelledby="title desc"/);
  for (const path of ['/assets/../server.ts', '/assets/%2e%2e/server.ts', '/assets/../../api/public-site.ts', '/%2e%2e/package.json', '/assets/thot-logo.png/../../../server.ts']) {
    assert.equal((await call(path)).status, 404, path);
  }
  assert.equal((await call('//outside.invalid/')).status, 400);
  assert.equal((await call('/#private')).status, 400);
});

test('public proof selection uses only configured stable app URLs and does not expose snapshot sources', async t => {
  for (const appUrl of [undefined, 'https://app.thot.market/app', 'https://app.test.thot.market/app', 'https://app.staging.thot.market/app']) {
    const call = await fixture(t, { appUrl });
    const response = await call('/v1/public/market-proof?appUrl=https://app.test.thot.market/app&file=../../.env');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    const proof = JSON.parse(response.body.toString());
    const environment = appUrl === 'https://app.test.thot.market/app' ? 'dev' : appUrl === 'https://app.staging.thot.market/app' ? 'staging' : undefined;
    assert.equal(proof.status, environment ? 'available' : 'unavailable');
    assert.equal(proof.environment, environment);
    assert.deepEqual(JSON.parse((await call('/v1/public/market-proof.json')).body.toString()), proof);
    for (const source of ['/assets/market-proof-dev.json', '/assets/market-proof-staging.json', '/v1/public/market-proof/../../.env']) assert.equal((await call(source)).status, 404);
    assert.equal((await call('/v1/public/market-proof', 'POST')).status, 405);
  }
});

test('absent or invalid reviewer settings expose unavailable without reflecting configuration or query data', async t => {
  for (const reviewerUrl of [undefined, 'https://review.example/?private=value']) {
    const call = await fixture(t, { reviewerUrl });
    const response = await call('/v1/public/site-config?reviewerUrl=https://outside.invalid#never-forwarded'.split('#')[0]!);
    assert.deepEqual(JSON.parse(response.body.toString()), { reviewerUrl: null, access: 'unavailable', privateAppHosted: false });
  }
  const call = await fixture(t);
  const launch = JSON.parse((await call('/v1/public/launch-config?state=launched')).body.toString());
  assert.equal(launch.state, 'preview');
  assert.equal(launch.tokenAddress, null);
  assert.equal(launch.holdingIncome, false);
});

test('standalone server starts in production on loopback without the private application runtime', async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const server = await startSiteServer({ port: 0 });
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('access UI requires an explicit reviewer click and never forwards helper fragments or OAuth queries', async () => {
  const source = await readFile(new URL('../apps/site/access.js', import.meta.url), 'utf8');
  for (const reviewerUrl of ['https://review.example', ...invalidReviewers]) {
    const nodes: Record<string, { hidden: boolean; textContent: string; href?: string }> = {
      'reviewer-link': { hidden: true, textContent: '' }, 'access-status': { hidden: false, textContent: '' }, 'helper-note': { hidden: true, textContent: '' },
    };
    const historyChanges: string[] = [];
    const redirects: string[] = [];
    runInNewContext(source, {
      document: { getElementById: (id: string) => nodes[id] },
      window: { location: { hash: '#thot=private-capability', search: '?oauth_state_id=private-state', pathname: '/app', replace: (url: string) => redirects.push(url), assign: (url: string) => redirects.push(url) } },
      history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => historyChanges.push(url) },
      fetch: async (url: string) => { assert.equal(url, '/v1/public/site-config'); return { ok: true, json: async () => ({ access: 'invited-reviewers', reviewerUrl }) }; },
      URL, AbortSignal,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(redirects, []);
    assert.deepEqual(historyChanges, ['/app']);
    assert.equal(nodes['helper-note']!.hidden, false);
    if (reviewerUrl === 'https://review.example') {
      assert.equal(nodes['reviewer-link']!.href, reviewerUrl);
      assert.equal(nodes['reviewer-link']!.hidden, false);
    } else {
      assert.equal(nodes['reviewer-link']!.href, undefined);
      assert.equal(nodes['reviewer-link']!.hidden, true);
      assert.match(nodes['access-status']!.textContent, /unavailable/);
    }
  }
});

test('wallet workspace configuration accepts only the exact HTTPS origin or app path and cannot fall back to an old reviewer', async t => {
  for (const value of ['https://workspace.example', 'https://workspace.example/app']) assert.equal(workspaceUrl(value), 'https://workspace.example/app');
  for (const value of ['https://workspace.example/', 'https://workspace.example/app/', 'https://workspace.example/app?token=private', 'https://workspace.example/app#capability', 'https://user:pass@workspace.example/app', 'https://localhost/app', 'http://workspace.example/app', 'https://workspace.example/other', 'https://workspace.example/app\n']) assert.equal(workspaceUrl(value), null);
  const call = await fixture(t, { appUrl: 'https://workspace.example/app', reviewerUrl: 'https://review.example' });
  assert.deepEqual(JSON.parse((await call('/v1/public/site-config?appUrl=https://outside.invalid/app')).body.toString()), { appUrl: 'https://workspace.example/app', reviewerUrl: null, access: 'wallet', privateAppHosted: false });
  const invalid = await fixture(t, { appUrl: 'https://workspace.example/app?token=private', reviewerUrl: 'https://review.example' });
  assert.deepEqual(JSON.parse((await invalid('/v1/public/site-config')).body.toString()), { appUrl: null, reviewerUrl: null, access: 'unavailable', privateAppHosted: false });
});

test('wallet access UI opens only its configured workspace, keeps helper secrets local, and states the testnet scope', async () => {
  const source = await readFile(new URL('../apps/site/access.js', import.meta.url), 'utf8');
  for (const appUrl of ['https://workspace.example/app', 'https://workspace.example/app?token=private', 'https://workspace.example/app#secret', 'https://localhost/app', 'https://workspace.example/other']) {
    const nodes: Record<string, { hidden: boolean; textContent: string; href?: string }> = Object.fromEntries(['reviewer-link', 'access-status', 'helper-note', 'access-intro', 'access-title', 'access-description', 'access-link-label'].map(id => [id, { hidden: id === 'reviewer-link' || id === 'helper-note', textContent: '' }]));
    const replaced: string[] = [], navigation: string[] = [];
    runInNewContext(source, {
      document: { getElementById: (id: string) => nodes[id] },
      window: { location: { hash: '#thot=private-capability', search: '?invite=private-query', pathname: '/app', assign: (url: string) => navigation.push(url), replace: (url: string) => navigation.push(url) } },
      history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
      fetch: async (_url: string, options: any) => { assert.equal(options.credentials, 'omit'); return { ok: true, json: async () => ({ access: 'wallet', appUrl, reviewerUrl: 'https://old-review.example' }) }; }, URL, AbortSignal,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(replaced, ['/app']); assert.deepEqual(navigation, []); assert.equal(nodes['helper-note']!.hidden, false);
    if (appUrl === 'https://workspace.example/app') {
      assert.equal(nodes['reviewer-link']!.href, appUrl); assert.equal(nodes['reviewer-link']!.hidden, false);
      assert.match(nodes['access-description']!.textContent, /EVM wallet/); assert.match(nodes['access-status']!.textContent, /testnet/);
      assert.doesNotMatch(nodes['access-status']!.textContent, /invited|email/);
    } else {
      assert.equal(nodes['reviewer-link']!.href, undefined); assert.equal(nodes['reviewer-link']!.hidden, true);
    }
  }
});
