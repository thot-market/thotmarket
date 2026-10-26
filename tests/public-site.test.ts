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
import { canonicalApplicationUrl, publicLaunchConfig, publicWorkspaceLinks, readPublicAsset, sanitizePublicMarketProof, unavailableMarketProof } from '../apps/api/public-site.ts';

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
  for (const hash of ['#thot=encoded', '#thot-robinhood=encoded', '#thot-history=encoded', '#trace=saved-trace', '#trace=https://outside.invalid']) {
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
  const call = (path: string, method = 'GET', headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; type?: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: { Host: 'site.example', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers }, setHost: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', value => { body += value; });
      res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'], headers: res.headers }));
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
  assert.equal(head.headers['cache-control'], 'private, no-cache');
  assert.ok(head.headers.etag);
  const cached = await call('/assets/thot-logo.png', 'GET', { 'If-None-Match': head.headers.etag });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, '');
  assert.equal((await call('/assets/thot-logo.png', 'GET', { Host: 'wrong.example', 'If-None-Match': head.headers.etag })).status, 403);
  assert.equal((await call('/')).headers['cache-control'], 'no-store');
  const configuration = await call(`/v1/public/launch-config?state=launched&tokenAddress=${tokenAddress}&ponsLaunchAddress=${ponsLaunchAddress}`);
  assert.equal(configuration.status, 200);
  assert.deepEqual(JSON.parse(configuration.body), publicLaunchConfig());
  const site = await call('/v1/public/site-config?appUrl=https://outside.invalid');
  assert.equal(site.status, 200);
  assert.deepEqual(JSON.parse(site.body), { appUrl: '/app', reviewerUrl: null, access: 'same-origin', privateAppHosted: true });
  const proof = await call('/v1/public/market-proof?appUrl=https://app.test.thot.market/app');
  assert.equal(proof.status, 200);
  assert.deepEqual(JSON.parse(proof.body), unavailableMarketProof());
  for (const path of ['/', '/read', '/tutorial', '/whitepaper', '/mechanism', '/affiliates']) {
    const html = (await call(path)).body;
    const links = html.match(/<a\b[^>]*\bdata-workspace-link\b[^>]*>/g);
    assert.ok(links?.length, path);
    for (const link of links) assert.match(link, /href="\/app(?:#[a-z-]+)?"/, path);
  }

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
  for (const path of ['/site.js', '/site.css', '/referrals.js', '/referrals.css', '/assets/thot-logo.png', '/v1/public/launch-config', '/v1/public/site-config', '/v1/public/market-proof', '/v1/auth/session', '/v1/contributor/portfolio']) {
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
  // Check distributed pages; the launch-prep Markdown sources are not in this checkout.
  for (const path of ['apps/site/mechanism.html']) {
    const copy = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(copy, /TESTTHOT|test calibration|testnet tariff|0\.0(?:01|04|06|1|2|3|34|4|6)\b|one.hour|10 million THOT/i, path);
    assert.match(copy, /12 hours after recorded delivery to raise an eligible dispute/, path);
    assert.match(copy, /purchase quote shows the applicable tariff before you authorize payment/i, path);
  }
  for (const path of ['apps/site/index.html', 'apps/site/affiliates.html']) {
    const html = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.match(html, /Worked example</);
    assert.match(html, /not customer adoption or real-money earnings/i);
    assert.match(html, /direct costs/);
    assert.doesNotMatch(html, /customers already|guaranteed earnings|data-fake-counter/i);
  }
  for (const path of ['apps/site/article.html', 'apps/site/whitepaper.html']) {
    const html = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.match(html, /percentage policy applies its configured rate to the listed trace price/i, path);
    assert.match(html, /quoted-cost policy uses the disclosed direct cost plus 1\.5 times allocated overhead/i, path);
    assert.match(html, /displayed estimate does not guarantee a sale or payout/i, path);
    assert.match(html, /before holder discounts/i, path);
    assert.doesNotMatch(html, /launch service fee is|base fee = 1%|referral = 20% of base fee/i, path);
  }
});

test('synthetic proof fixtures remain explicitly testnet and reject claims from another environment', () => {
  const hash = '0x' + '1'.repeat(64);
  const fixture = {
    schema_version: 'thot.public-market-proof/1', environment: 'dev', network: 'Robinhood testnet',
    chain_id: 46630, test_assets: true, scope: 'testnet-verification', as_of: '2026-01-01T00:00:00.000Z',
    block_number: 10, block_hash: hash, confirmations: 1, amount_basis: 'finalized seller proceeds',
    purchase_amount_basis: 'gross purchase price', private_note: 'must not reach the response',
    scan: { from_block: 1, through_block: 10, complete_since_deployment: true },
    tariff: { service_fee_thot: '0.04', direct_cost_thot: '0.01', allocated_overhead_thot: '0',
      net_contribution_thot: '0.03', referral_bps: 2000, dispute_seconds: 43200, activation_seconds: 0, term_seconds: 0 },
    receipts: [], purchases: [{ tx_hash: hash, block_number: 10, amount_thot: '1', source: 'unknown',
      explorer_url: 'https://explorer.testnet.chain.robinhood.com/tx/' + hash, status: 'finalized' }],
  };
  const proof = sanitizePublicMarketProof(fixture, 'dev');
  assert.equal(proof.status, 'available');
  assert.equal(proof.test_assets, true);
  assert.equal(proof.scope, 'testnet-verification');
  assert.match(proof.notice, /do not establish organic traction/);
  assert.ok(!('private_note' in proof));
  assert.throws(() => sanitizePublicMarketProof(fixture, 'staging'), /INVALID_PUBLIC_MARKET_PROOF/);
  for (const replacement of [{ environment: 'production' }, { test_assets: false }, { scope: 'production' }, { chain_id: 4663 }]) {
    assert.throws(() => sanitizePublicMarketProof({ ...fixture, ...replacement }, 'dev'), /INVALID_PUBLIC_MARKET_PROOF/);
  }
});

test('ordinary production entry links target the canonical application and preserve their intended view', async () => {
  for (const name of ['index', 'article', 'tutorial', 'mechanism', 'whitepaper', 'affiliates']) {
    const html = await readFile(new URL(`../apps/site/${name}.html`, import.meta.url), 'utf8');
    const links = html.match(/<a\b[^>]*\bdata-workspace-link\b[^>]*>/g);
    assert.ok(links?.length, name);
    for (const link of links) assert.match(link, /href="https:\/\/app\.thot\.market\/app(?:#[a-z-]+)?"/, name);
    assert.doesNotMatch(html, /href="\/app"|>Open the test app<|>test workspace</);
  }
  const html = '<a href="https://app.thot.market/app#referrals" data-workspace-link>Referrals</a><a href="/app#thot=secret">Capability</a>';
  assert.equal(publicWorkspaceLinks(html, '/app'), '<a href="/app#referrals" data-workspace-link>Referrals</a><a href="/app#thot=secret">Capability</a>');
  assert.equal(publicWorkspaceLinks(html, canonicalApplicationUrl), html);
  for (const value of ['javascript:alert(1)', 'https://user:secret@app.example/app', 'https://app.example/app?token=secret', 'https://app.example/app#secret']) {
    assert.throws(() => publicWorkspaceLinks(html, value), /INVALID_PUBLIC_APP_URL/);
  }
});


test('published token UI shows the exact configured contract and supports copy without implying mechanism activation',async()=>{
 const source=await readFile(new URL('../apps/site/site.js',import.meta.url),'utf8');
 for(const scenario of ['launched','preview','failed']){
  let copy:undefined|(()=>Promise<void>),copied='';
  const nodes:Record<string,any>={'token-state':{textContent:''},'token-contract':{hidden:true},'thot-contract-address':{textContent:''},'token-copy-status':{textContent:''},'copy-token-address':{addEventListener:(_name:string,handler:()=>Promise<void>)=>{copy=handler;}}},link:any={hidden:true};
  const config=publicLaunchConfig(scenario==='launched'?{state:'launched',tokenAddress,ponsLaunchAddress}:{});
  runInNewContext(source,{window:{location:{hash:'',search:''}},document:{getElementById:(id:string)=>nodes[id]??null,querySelectorAll:()=>[link]},fetch:async()=>({ok:scenario!=='failed',json:async()=>config}),navigator:{clipboard:{writeText:async(value:string)=>{copied=value;}}},AbortSignal,URLSearchParams,URL});
  await new Promise(resolve=>setImmediate(resolve));
  if(scenario==='launched'){assert.equal(link.hidden,false);assert.equal(nodes['token-contract'].hidden,false);assert.equal(nodes['thot-contract-address'].textContent,tokenAddress);assert.match(nodes['token-state'].textContent,/is live/);assert.ok(copy);await copy();assert.equal(copied,tokenAddress);assert.match(nodes['token-copy-status'].textContent,/copied/);}
  else {assert.equal(link.hidden,true);assert.equal(nodes['token-contract'].hidden,true);assert.equal(nodes['thot-contract-address'].textContent,'');assert.doesNotMatch(nodes['token-state'].textContent,/will appear|is live/);}
 }
 const html=(await readPublicAsset('/'))!.body.toString();assert.match(html,/Token availability is separate/);assert.match(html,/id="copy-token-address"/);
});

test('production entry bundles require explicit published token inputs while test bundles remain preview',async()=>{
 const {buildCloudflarePages}=await import('../scripts/build-cloudflare-pages.ts');
 const dir=await mkdtemp(join(tmpdir(),'token-entry-build-'));
 try{
  await assert.rejects(buildCloudflarePages({outputParent:dir,zip:false}),/PRODUCTION_TOKEN_CONFIGURATION_REQUIRED/);
  await assert.rejects(buildCloudflarePages({outputParent:dir,appUrl:'https://app.thot.market',zip:false}),/PRODUCTION_TOKEN_CONFIGURATION_REQUIRED/);
  await assert.rejects(buildCloudflarePages({outputParent:dir,appUrl:'https://app.thot.market',launch:{state:'launched'},zip:false}),/INCOMPLETE_LAUNCH_CONFIGURATION/);
  const built=await buildCloudflarePages({outputParent:dir,appUrl:'https://app.thot.market',launch:{state:'launched',tokenAddress,ponsLaunchAddress},zip:false});
  assert.equal(JSON.parse(await readFile(join(built.directory,'v1/public/launch-config.json'),'utf8')).tokenAddress,tokenAddress);
 }finally{await rm(dir,{recursive:true,force:true});}
});

// Minimal DOM double for referrals.js: one shared node per selector, created elements tracked.
function referralsSandbox(proof: unknown) {
 const element = () => ({
  children: [] as any[], textContent: '', hidden: false, className: '', value: '', href: '', rel: '', target: '',
  dataset: {} as Record<string, string>,
  append(...nodes: any[]) { this.children.push(...nodes); },
  replaceChildren(...nodes: any[]) { this.children = [...nodes]; },
  addEventListener() {},
  getAttribute() { return ''; },
  setAttribute(name: string, value: string) { (this as any)['attr_' + name] = value; },
 });
 const registry = new Map<string, any[]>();
 const nodes = (selector: string) => { if (!registry.has(selector)) registry.set(selector, [element()]); return registry.get(selector)!; };
 const created: any[] = [];
 const sandbox = {
  document: {
   querySelectorAll: (selector: string) => selector.split(',').flatMap(part => nodes(part.trim())),
   querySelector: (selector: string) => nodes(selector)[0],
   createElement: () => { const node = element(); created.push(node); return node; },
  },
  fetch: async () => ({ ok: true, json: async () => proof }),
  AbortSignal,
 };
 const text = (node: any): string => node.textContent + node.children.map(text).join('');
 const rendered = () => [...registry.values()].flat().map(text).concat(created.map(text)).join('\n');
 return { sandbox, nodes, rendered, text };
}

test('production build renders no Unavailable receipts panel while live sales render with their transactions',async()=>{
 const {buildCloudflarePages}=await import('../scripts/build-cloudflare-pages.ts');
 const dir=await mkdtemp(join(tmpdir(),'public-entry-proof-'));
 try{
  // The real production bundle: its baked proof is unavailable for this app URL.
  const built=await buildCloudflarePages({outputParent:dir,appUrl:'https://app.thot.market/app',launch:{state:'launched',tokenAddress,ponsLaunchAddress},zip:false});
  const proof=JSON.parse(await readFile(join(built.directory,'v1/public/market-proof.json'),'utf8'));
  assert.equal(proof.status,'unavailable');
  const script=(await readFile(join(built.directory,'referrals.js'),'utf8')).replace(/^export /gm,'');
  const unavailable=referralsSandbox(proof);
  runInNewContext(script,unavailable.sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(unavailable.rendered(),/unavailable/i);
  assert.equal(unavailable.nodes('[data-proof-environment]')[0].hidden,true);
  assert.equal(unavailable.nodes('[data-proof-time]')[0].hidden,true);
  assert.match(unavailable.nodes('[data-proof-rows]')[0].children[0].textContent,/receipts appear here when this environment publishes a verified snapshot/i);
  // Live stats from the app render the chain badge, totals and linked recent sales.
  const hash='0x'+'1'.repeat(64);
  const live=referralsSandbox({as_of:'2026-01-01T00:00:00.000Z',chain:{name:'Robinhood Chain',explorer_url:'https://explorer.example/'},listings_active:3,
   independent:{purchases:2,finalized:1,gross_atoms:'2000000000000000000',paid_to_sellers_atoms:'990000000000000000',sellers:1,buyers:2},treasury:{purchases:0},
   recent:[{title:'Synthetic dataset',gross_atoms:'1000000000000000000',status:'paid',block:10,treasury:false,transaction_hash:hash,transaction_url:'https://explorer.example/tx/'+hash}],basis:'Independent purchases only.'});
  runInNewContext(script,{...live.sandbox,location:{origin:'https://thot.market'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(live.nodes('[data-proof-environment]')[0].textContent,'Robinhood Chain');
  assert.match(live.nodes('[data-proof-time]')[0].textContent,/2 purchases · 0\.99 THOT paid to sellers/);
  assert.match(live.nodes('[data-proof-heading]')[0].textContent,/Recent sales/);
  assert.match(live.text(live.nodes('[data-proof-rows]')[0].children[0]),/Synthetic dataset.*Purchase · paid.*1 THOT.*View transaction/s);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('2026-10-24 QA copy fixes: plain language, no dead references, no font-glyph arrows', async () => {
  const pages = ['index.html','article.html','tutorial.html','mechanism.html','whitepaper.html','affiliates.html','access.html'] as const;
  const html = Object.fromEntries(await Promise.all(pages.map(async name => [name, await readFile(new URL('../apps/site/'+name, import.meta.url), 'utf8')] as const)));
  // #86: CTA arrows are inline SVG icons that render on every platform.
  for (const [name, page] of Object.entries(html)) {
    assert.ok(!page.includes('↗'), `${name} still contains a raw arrow glyph`);
    assert.ok(!page.includes('↓'), `${name} still contains a raw down-arrow glyph`);
  }
  assert.match(html['index.html']!, /<svg class="arrow-icon"/);
  assert.match(html['whitepaper.html']!, /Read the launch post <svg class="arrow-icon"/);
  // #88: plain-language and corrected copy.
  assert.match(html['index.html']!, /The base service fee is 1% of the price/);
  assert.doesNotMatch(html['index.html']!, /At the current tiers, The base service fee/);
  assert.doesNotMatch(html['index.html']!, /Joined local acceptance/);
  assert.doesNotMatch(Object.values(html).join(' '), /assayer/i);
  assert.match(html['affiliates.html']!, /<h3>Share your wallet address\.<\/h3>/);
  assert.doesNotMatch(html['affiliates.html']!, /<h3>Share your wallet\.<\/h3>/);
  // #85: no dead Pons repository link remains.
  assert.doesNotMatch(html['whitepaper.html']!, /github\.com/);
  assert.match(html['whitepaper.html']!, /configuration inspected for this whitepaper/);
  // The idea page no longer promises buyers a proof package they do not receive.
  assert.doesNotMatch(html['article.html']!, /a property a buyer can verify/);
  assert.match(html['article.html']!, /bounded trade claim the marketplace checks for buyers/);
});
