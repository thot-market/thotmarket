import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {getBytes, parseEther} from 'ethers';
import {chromium} from 'playwright-core';
import {deployBrowserFixture} from './thot-browser-fixture.mjs';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {startWorkerLoop} from '../apps/worker/main.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/record-thot-purchase.mjs [--economics quoted-cost|percentage] [--output DIRECTORY]\nCreates disposable local Anvil and browser actors; no hosted RPC supported. Videos, screenshots and accounting evidence are written to a fresh run directory. Local dispute/refund time is explicitly accelerated.');
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert(['--economics', '--output'].includes(args[i]) && args[i+1], 'Invalid arguments; use --help');
  assert(!options[args[i]], 'Duplicate argument'); options[args[i]] = args[i+1];
}
const economics = options['--economics'] ?? 'quoted-cost';
assert(['quoted-cost', 'percentage'].includes(economics));
const outputRoot = resolve(options['--output'] ?? 'work/thot-browser');
await mkdir(outputRoot, {recursive: true, mode: 0o700});
const output = await mkdtemp(join(outputRoot, `${economics}-`));
const dataDir = await mkdtemp(join(tmpdir(), 'thot-purchase-vault-'));
const git = args => {try {return execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();} catch {return null;}};
const digest = value => '0x' + canonicalHash(value).replace(/^sha256:/, '').replace(/^0x/, '');
const evidence = {schema: 'thot.local-purchase-demo/1', status: 'RUNNING', economics,
  source_commit: git(['rev-parse', 'HEAD']),
  source_dirty: git(['status', '--porcelain']) === null ? null : Boolean(git(['status', '--porcelain'])),
  scope: 'Synthetic local browser actors and disposable Anvil. Test assets only. Local time accelerated.',
  assumptions: ['Wallet transport is injected; all signing, transactions, API responses and content delivery are real local operations.', 'Local development role authentication; hosted SIWE/Privy and Safe governance are separate acceptance gates.', 'In-memory database: browser reload and delayed worker pickup, not application/database process recovery.', 'Ordinary zero-referral sale; positive referral payout is not exercised.', 'Refund order uses real API preparation and direct local signer funding; refund status is shown in browser.'],
  checks: [], screenshots: [], transactions: [], skips: []};
let fixture, app, server, browser, worker, activePage, phase = 'fixture';
const contexts = [], workerErrors = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const save = () => writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
async function shot(page, name) {
  activePage = page; await page.screenshot({path: join(output, name + '.png'), fullPage: true});
  evidence.screenshots.push(name + '.png'); await pause(500);
}
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 90; attempt++) {const value = await check(); if (value) return value; await pause(500);}
  throw Error('Timed out: ' + label + '; worker errors: ' + workerErrors.join(','));
}
try {
  fixture = await deployBrowserFixture(economics);
  evidence.configuration = {chain_id: 31337, economics_policy: economics, market: fixture.config.market, token: fixture.config.token, code_hashes: fixture.config.codeHashes};
  app = await createApplication({dataDir, memory: true, thot: {...fixture.config, localDeliverySigner: fixture.config.operator}});
  server = createHttpServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless: true, executablePath: process.env.THOT_E2E_BROWSER ?? process.env.THOT_E2E_BROWSER ?? '/usr/bin/chromium'});
  const startWorker = () => {worker = startWorkerLoop(app, {intervalMs: 250, onError: e => workerErrors.push(String(e.message))});};
  async function session(role, signer) {
    const context = await browser.newContext({viewport: {width: 1360, height: 980}, recordVideo: {dir: output, size: {width: 1360, height: 980}}});
    const run = {context, signer, address: await signer.getAddress(), role, rejectNext: false, holdReceipts: false, sent: []};
    contexts.push(run);
    await context.exposeBinding('localFixtureWallet', async (_source, {method, params = []}) => {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [run.address];
      if (method === 'eth_chainId') return '0x7a69';
      if (['wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(method)) return null;
      if (method === 'personal_sign') return signer.signMessage(getBytes(params[0]));
      if (method === 'eth_signTypedData_v4') {const typed = JSON.parse(params[1]); delete typed.types.EIP712Domain; return signer.signTypedData(typed.domain, typed.types, typed.message);}
      if (method === 'eth_sendTransaction') {
        if (run.rejectNext) {run.rejectNext = false; return {rejected: true};}
        assert.equal(params[0].from.toLowerCase(), run.address.toLowerCase());
        assert([fixture.config.token, fixture.config.market, fixture.config.locks].some(a => a.toLowerCase() === params[0].to.toLowerCase()), 'Unexpected transaction target');
        const response = await signer.sendTransaction(params[0]); run.sent.push(response.hash);
        if (run.holdAfterFunding && params[0].to.toLowerCase() === fixture.config.market.toLowerCase()) run.holdReceipts = true;
        evidence.transactions.push({role, hash: response.hash, to: params[0].to}); return response.hash;
      }
      if (['eth_blockNumber', 'eth_getBlockByNumber'].includes(method)) return fixture.provider.send(method, params);
      if (method === 'eth_getTransactionReceipt') return run.holdReceipts ? null : fixture.provider.send(method, params);
      throw Error('Unexpected wallet method ' + method);
    });
    await context.addInitScript(({label}) => {
      window.ethereum = {isMetaMask: true, request: async input => {const value = await window.localFixtureWallet(input); if (value?.rejected) {const error = new Error('Synthetic wallet rejection'); error.code = 4001; throw error;} return value;}, on() {}, removeListener() {}};
      document.addEventListener('DOMContentLoaded', () => {const banner = document.createElement('div'); banner.textContent = `LOCAL TEST · ${label} · synthetic actors/assets · dispute time accelerated in this recording`; banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:8px;background:#172b4d;color:white;z-index:99999;text-align:center;font:14px sans-serif;pointer-events:none'; document.body.append(banner);});
    }, {label: role === 'user' ? 'Seller' : role === 'buyer_admin' ? 'Buyer' : 'Unrelated reader'});
    run.page = await context.newPage(); activePage = run.page; run.page.setDefaultTimeout(30000);
    const response = await context.request.post(origin + '/v1/dev/session', {data: {role}});
    assert.equal(response.status(), 200); run.token = (await response.json()).token;
    run.api = async (path, body, expected = 200, key = randomUUID()) => {
      const response = await context.request.fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: 'Bearer ' + run.token, 'Idempotency-Key': key}, ...(body === undefined ? {} : {data: body})});
      const result = await response.json(); assert.equal(response.status(), expected, path + ': ' + JSON.stringify(result)); return result;
    };
    run.open = async view => {
      await run.page.goto(origin + '/app'); await run.page.locator('#main h1').waitFor();
      if (role !== 'user') { const loaded = run.page.waitForResponse(r => r.url().endsWith('/v1/thot/workspace')); await run.page.locator('#role').selectOption(role); await loaded; await run.page.waitForFunction(role => document.querySelector('#role').value === role, role); }
      await run.page.locator(`nav [data-view="${view}"]`).click(); if (view === 'market') await run.page.locator('[data-action="thot-refresh"]').waitFor();
    };
    await run.open(role === 'operator_security' ? 'operator' : 'market');
    if (role !== 'operator_security' && !(await run.api('/v1/thot/workspace')).wallet) { await run.page.locator('[data-action="thot-link"]').waitFor();
      const linked = run.page.waitForResponse(r => r.url().endsWith('/v1/thot/wallet/link'));
      await run.page.locator('[data-action="thot-link"]').click(); assert.equal((await linked).status(), 200);
      await waitFor(async () => (await run.api('/v1/thot/workspace')).wallet === run.address, 'wallet link');
    }
    return run;
  }
  const seller = await session('user', fixture.seller), buyer = await session('buyer_admin', fixture.buyer);
  const stranger = await session('operator_security', fixture.attacker);
  const actorsReadyAt = Date.now();
  const foreignChallenge = await stranger.api('/v1/thot/wallet/challenge', {address: stranger.address});
  await stranger.api('/v1/thot/wallet/link', {id: foreignChallenge.id, signature: await fixture.attacker.signMessage(foreignChallenge.message)});
  assert.equal((await stranger.api('/v1/thot/workspace')).wallet, stranger.address);
  async function enroll(label) {
    phase = 'synthetic-import'; await seller.open('vault');
    await seller.page.locator('[data-action="import-research"]').first().click();
    const text = [
      {type: 'user', sessionId: randomUUID(), timestamp: '2026-09-22T10:00:00Z', cwd: '/workspace/synthetic-demo', message: {role: 'user', content: `Synthetic ${label}: how should a cache key include a project ID?`}},
      {type: 'assistant', timestamp: '2026-09-22T10:01:00Z', message: {role: 'assistant', content: [{type: 'text', text: 'Synthetic answer: prefix every cache key with the project identifier.'}]}},
    ].map(JSON.stringify).join('\n');
    await seller.page.locator('#research-file').setInputFiles({name: 'synthetic.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(text)});
    await seller.page.locator('#research-preview-form button[type="submit"]').click();
    await seller.page.getByRole('heading', {name: 'Review conversation', exact: true}).waitFor();
    await seller.page.getByText('Prepare for a sale later (optional)', {exact: true}).click();
    await seller.page.locator('#research-rights').check(); await seller.page.locator('#research-license').check();
    await shot(seller.page, label + '-01-import-rights');
    const imported = seller.page.waitForResponse(r => r.url().endsWith('/v1/contributor/import/confirm'));
    await seller.page.locator('[data-action="confirm-research"]').click();
    const response = await imported; assert.equal(response.status(), 200); const trace = await response.json();
    await seller.page.locator('nav [data-view="market"]').click();
    await seller.page.locator('#thot-trace').selectOption(trace.trace_id);
    const metadataResponse = seller.page.waitForResponse(r => r.url().endsWith('/v1/thot/listings/metadata'));
    await seller.page.locator('[data-action="thot-list-configure"]').click();
    const metadata = await (await metadataResponse).json();
    await seller.page.locator('#thot-title').fill('Synthetic ' + label);
    await seller.page.locator('#thot-price').fill('100'); await seller.page.locator('#thot-list-consent').check();
    await shot(seller.page, label + '-02-listing-commitment');
    const activated = seller.page.waitForResponse(r => r.url().endsWith('/v1/thot/listings/activate'));
    await seller.page.locator('[data-action="thot-list-confirm"]').click(); const activation = await activated; assert.equal(activation.status(), 200);
    const listing = await activation.json();
    assert(listing?.automatic_sales); return {trace, listing, metadata};
  }
  const {trace, listing, metadata} = await enroll('purchase');
  phase = 'buyer-review'; await buyer.open('market');
  const prepare = buyer.page.waitForResponse(r => r.url().endsWith('/v1/thot/offers/prepare'));
  await buyer.page.locator(`[data-action="thot-buy"][data-id="${listing.id}"]`).click();
  const preparedResponse = await prepare; assert.equal(preparedResponse.status(), 200); const offer = await preparedResponse.json();
  await shot(buyer.page, 'purchase-03-buyer-quote');
  evidence.trace_id = trace.trace_id; evidence.listing_id = listing.id; evidence.offer_id = offer.id;
  evidence.content_commitment = metadata.content_hash; evidence.release_commitment = listing.evidence_hash;
  evidence.quote = {buyer_total: offer.buyer_total, seller_gross: offer.seller_gross};
  assert.equal((await buyer.api('/v1/thot/offers/delivery', {id: offer.id}, 409)).error, 'OFFER_NOT_CONFIRMED');
  phase = 'wallet-rejection'; buyer.rejectNext = true; const countBefore = buyer.sent.length;
  await buyer.page.locator('[data-action="thot-send"]').click();
  await waitFor(() => !buyer.rejectNext, 'wallet rejection'); await pause(200);
  assert.equal(buyer.sent.length, countBefore); evidence.checks.push('Explicit wallet rejection sends no transaction; same reviewed action can retry.');
  const balancesBefore = {};
  for (const [name, signer] of Object.entries({buyer: fixture.buyer, seller: fixture.seller, protocol: fixture.protocol, referrer: fixture.referrer})) balancesBefore[name] = await fixture.token.balanceOf(await signer.getAddress());
  phase = 'payment'; buyer.holdAfterFunding = true; await buyer.page.locator('[data-action="thot-send"]').click();
  await waitFor(async () => Number((await fixture.market.offers(offer.id)).status) === 2, 'funded authorized offer');
  const funded = await buyer.api('/v1/thot/workspace'); const receipt = funded.orders.find(o => o.id === offer.id).receipt;
  assert.equal(balancesBefore.buyer - await fixture.token.balanceOf(buyer.address), BigInt(offer.buyer_total));
  assert.equal(receipt.buyer_total, offer.buyer_total); assert.equal(receipt.gross, parseEther('100').toString());
  if (economics === 'percentage') {assert.equal(receipt.buyer_total, parseEther('99.7').toString()); assert.equal(receipt.seller_amount, parseEther('99.2').toString());}
  else assert.equal(receipt.seller_amount, parseEther('99.96').toString());
  evidence.receipt_at_funding = receipt;
  // The worker has intentionally not run since upload. Start it to reconcile the existing funded intent; this is not a database restart.
  const sends = buyer.sent.length; await buyer.open('market');
  await buyer.page.locator('[data-action="thot-resume-payment"]').click();
  await shot(buyer.page, 'purchase-04-resume-confirmation');
  buyer.holdReceipts = false; buyer.holdAfterFunding = false;
  await buyer.page.locator('[data-action="thot-send"]').click();
  await waitFor(async () => !(await buyer.page.locator('#detail-dialog').evaluate(el => el.open)), 'same payment reconciled after reload');
  assert.equal(buyer.sent.length, sends); startWorker();
  await waitFor(async () => Number((await fixture.market.offers(offer.id)).status) === 3, 'worker delivery');
  assert.equal(buyer.sent.length, sends);
  await buyer.open('market'); await buyer.page.locator(`[data-action="thot-delivery"][data-id="${offer.id}"]`).click();
  await buyer.page.getByRole('heading', {name: 'Your licensed trace', exact: true}).waitFor();
  await shot(buyer.page, 'purchase-04-licensed-content');
  const licensed = await buyer.api('/v1/thot/offers/delivery', {id: offer.id});
  assert(JSON.stringify(licensed.release.content).includes('prefix every cache key with the project identifier'));
  assert.equal(digest(licensed.release.content), metadata.content_hash);
  assert.equal(digest(licensed.release), listing.evidence_hash);
  assert.equal(licensed.receipt.evidence_hash, listing.evidence_hash);
  assert.equal(licensed.receipt.delivery_hash, listing.evidence_hash);
  assert.equal(digest(licensed.release.license), licensed.receipt.license_hash);
  const reopened = await buyer.api('/v1/thot/offers/delivery', {id: offer.id}); assert.deepEqual(reopened.release, licensed.release);
  await stranger.api('/v1/thot/offers/delivery', {id: offer.id}, 404);
  assert.equal((await buyer.api('/v1/thot/workspace')).orders.filter(o => o.listing_id === listing.id && o.receipt?.status > 0).length, 1);
  evidence.checks.push('Actual buyer token debit matches frozen quote; reload and delayed worker pickup retain one funded purchase.', 'Repeated licensed readback is exact; unfunded and foreign readers denied.');
  await seller.open('earnings'); await shot(seller.page, 'purchase-05-seller-pending');
  await worker.close(); worker = undefined;
  await assert.rejects(fixture.market.finalize(offer.id));
  assert.equal(await fixture.token.balanceOf(seller.address), balancesBefore.seller);
  evidence.dispute_seconds = Number(await fixture.market.DISPUTE_WINDOW());
  phase = 'local-payout'; await fixture.advance(evidence.dispute_seconds + 1); startWorker();
  await waitFor(async () => await fixture.token.balanceOf(seller.address) === balancesBefore.seller + BigInt(receipt.seller_amount), 'actual seller payout');
  await worker.close(); worker = undefined;
  const completed = (await seller.api('/v1/thot/workspace')).orders.find(o => o.id === offer.id);
  assert.equal(completed.receipt.status, 5); assert(completed.payout_transaction);
  assert.equal((await fixture.provider.getTransactionReceipt(completed.payout_transaction)).status, 1);
  const expected = {seller: BigInt(receipt.seller_amount), referrer: BigInt(receipt.referral_amount), protocol: BigInt(receipt.buyer_total) - BigInt(receipt.seller_amount) - BigInt(receipt.referral_amount)};
  evidence.balance_deltas = {};
  // The settlement worker pays the seller; other beneficiaries explicitly claim their allocations.
  for (const signer of [fixture.protocol, fixture.referrer]) {const address = await signer.getAddress(); if (await fixture.market.claimable(address)) {const tx = await fixture.market.claimFor(address); await tx.wait(); evidence.transactions.push({role: 'beneficiary-claim', hash: tx.hash});}}
  for (const [name, signer] of Object.entries({seller: fixture.seller, protocol: fixture.protocol, referrer: fixture.referrer})) {
    const delta = await fixture.token.balanceOf(await signer.getAddress()) - balancesBefore[name]; assert.equal(delta, expected[name]); evidence.balance_deltas[name] = delta.toString();
  }
  await app.thot.processSales(); assert.equal(await fixture.token.balanceOf(seller.address), balancesBefore.seller + expected.seller);
  evidence.payout_transaction = completed.payout_transaction; evidence.checks.push('Early payout denied; local-only accelerated deadline yields mined payout and exact beneficiary balance deltas; repeated worker cycle cannot pay twice.');
  await seller.open('earnings'); await shot(seller.page, 'purchase-06-seller-paid');
  phase = 'refund';
  // Pace the second chapter under the unchanged 180-request/60-mutation actor limits.
  while (Date.now() < actorsReadyAt + 65000) await pause(Math.min(30000, actorsReadyAt + 65000 - Date.now()));
  const refundListing = (await enroll('refund')).listing;
  const refundOffer = await buyer.api('/v1/thot/offers/prepare', {listing_id: refundListing.id});
  const refundBalance = await fixture.token.balanceOf(buyer.address);
  for (const tx of refundOffer.transactions) await (await fixture.buyer.sendTransaction(tx)).wait();
  assert.equal(Number((await fixture.market.offers(refundOffer.id)).status), 2);
  await fixture.advance(48 * 3600 + 1); await app.thot.processSales();
  assert.equal(Number((await fixture.market.offers(refundOffer.id)).status), 6);
  assert.equal(await fixture.token.balanceOf(buyer.address), refundBalance);
  evidence.refund_offer_id = refundOffer.id; evidence.checks.push('Funded order undelivered during worker outage refunds original buyer in full after local-only 48-hour advance.');
  await buyer.open('market');
  await buyer.page.getByText(/Completed & refunded purchases/).click();
  await buyer.page.getByText('Refund paid to buyer wallet', {exact: true}).waitFor();
  await shot(buyer.page, 'refund-03-refunded');
  evidence.skips.push('Wallet transport losing a submitted transaction hash is covered by focused UI tests, not this browser recording. This runner suppresses a known-hash receipt then reloads/resumes without rebroadcast.');
  evidence.status = 'PASS'; evidence.completed_at = new Date().toISOString();
} catch (error) {
  evidence.status = 'FAIL'; evidence.phase = phase; evidence.error = String(error.stack ?? error); evidence.worker_errors = workerErrors;
  if (activePage) await shot(activePage, 'failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await save(); console.log(JSON.stringify({status: evidence.status, phase: evidence.phase, error: evidence.error, output}));
  await worker?.close();
  await Promise.all(contexts.map(async run => {const video = run.page?.video(); await run.context.close(); if (video) await copyFile(await video.path(), join(output, `${run.role}.webm`));}));
  await browser?.close();
  if (server) {server.closeAllConnections(); await new Promise(r => server.close(r));}
  await app?.close(); await fixture?.close(); await rm(dataDir, {recursive: true, force: true});
  await save(); console.log(JSON.stringify({status: evidence.status, phase: evidence.phase, error: evidence.error, output}));
}
