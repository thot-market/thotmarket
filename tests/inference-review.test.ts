import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { InferenceGateway } from '../packages/market/src/inference-gateway.ts';
import { OpenAIResponsesProvider, maximumReservation, type InferenceRateCard } from '../packages/inference/src/index.ts';
import { canonicalHash } from '../packages/protocol/src/index.ts';
import { postJournal, accountBalance } from '../packages/ledger/src/index.ts';
import { demoUser, demoSettlement } from '../packages/market/src/fixtures.ts';
import type { Document } from '../packages/storage/src/index.ts';
import { createHttpServer } from '../apps/api/server.ts';

const instant = '2026-09-06T00:00:00.000Z';
// Fictional offline rates and model. Every transport is intercepted; these tests cannot call the network.
const card: InferenceRateCard = { version: 'offline-review/1', model: 'offline-review-model', service_tier: 'default', currency: 'USD',
  input_micro_usd_per_million: '4000000', cached_micro_usd_per_million: '2000000', cache_write_micro_usd_per_million: null,
  output_micro_usd_per_million: '20000000', max_input_tokens: 1000, max_output_tokens: 250,
  verified_at: instant, expires_at: '2026-09-07T00:00:00.000Z', verified: true, example_only: false };
function wireResponse(patch: Document = {}) {
  return { id: 'resp_review_fixture', model: card.model, service_tier: 'default', status: 'completed',
    usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200, input_tokens_details: { cached_tokens: 0 } },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Private output fixture' }] }], ...patch };
}
function provider(options: { card?: InferenceRateCard; clock?: () => Date; generate?: () => Promise<Response>; count?: () => Promise<Response> } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const transport = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/input_tokens')) return options.count ? options.count() : json({ object: 'response.input_tokens', input_tokens: 100 });
    return options.generate ? options.generate() : json(wireResponse());
  };
  return { adapter: new OpenAIResponsesProvider({ apiKey: 'offline-only-review-key', rateCard: options.card ?? card, clock: options.clock ?? (() => new Date(instant)) }, transport as typeof fetch), calls };
}
async function setup(t: any, options: { durable?: boolean; provider?: ReturnType<typeof provider>; clock?: () => Date } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'thot-inference-review-')); const p = options.provider ?? provider();
  let app = await createApplication({ dataDir, memory: !options.durable, config: { clock: options.clock ?? (() => new Date(instant)) }, inference: { provider: p.adapter, dailyBudgetMinor: '100' } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.db.transaction(async tx => {
    await tx.insert('contributor_entitlements', 'review-credit', demoUser.id, { entitlement_id: 'review-credit', settlement_id: 'review-sale',
      currency: 'USD', disposition: 'inference_credit', status: 'AVAILABLE', available_minor: '100' });
    await postJournal(tx, 'review-funding', 'USD', [{ owner: 'network', account: 'ASSET:cash', amount: 100n },
      { owner: 'review-credit', account: 'LIABILITY:contributor_inference_credit', amount: -100n }]);
  });
  const input = { entitlement_id: 'review-credit', prompt: 'Private prompt fixture', provider: 'openai',
    rate_card_hash: canonicalHash(card), max_cost_minor: maximumReservation(card), consent_external_processing: true };
  return { get app() { return app; }, input, ...p, async restart() {
    assert.equal(options.durable, true); await app.close();
    app = await createApplication({ dataDir, config: { clock: options.clock ?? (() => new Date(instant)) }, inference: { provider: p.adapter, dailyBudgetMinor: '100' } }); return app;
  } };
}

test('queued request cannot transmit after operator disables the inference budget', async t => {
  const a = await setup(t); const queued = await a.app.inference.create(demoUser, 'review-disabled-queue', a.input);
  const disabled = new InferenceGateway(a.app.service, a.adapter, '0'); assert.equal(disabled.capabilities().enabled, false);
  await assert.rejects(disabled.execute(demoUser, queued.request_id), /INFERENCE_DISABLED|INFERENCE_BUDGET/);
  assert.equal(a.calls.length, 0); assert.equal((await disabled.get(demoUser, queued.request_id)).status, 'QUEUED');
  await disabled.cancel(demoUser, 'review-disabled-cancel', queued.request_id);
  assert.equal((await a.app.service.earnings(demoUser)).entitlements[0]!.available_minor, '100');
});

test('queued consent does not transfer to a replacement provider with the same price card', async t => {
  const a = await setup(t); const queued = await a.app.inference.create(demoUser, 'review-provider-queue', a.input);
  let calls = 0;
  const replacement = { provider: 'different-provider', rateCard: card, validate() {}, async count() { calls++; return 100; },
    async generate() { calls++; return { provider_response_id: 'resp_other', status: 'COMPLETED' as const, text: 'other', actual_minor: '1',
      usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200, cached_tokens: 0, cache_write_tokens: 0 } }; } };
  const changed = new InferenceGateway(a.app.service, replacement, '100');
  await assert.rejects(changed.execute(demoUser, queued.request_id), /INFERENCE_PROVIDER_CHANGED|INFERENCE_CONSENT/);
  assert.equal(calls, 0); assert.equal((await changed.get(demoUser, queued.request_id)).status, 'QUEUED');
});

test('changed or expired tariffs reject queued execution before prompt decryption or transmission', async t => {
  const a = await setup(t); const queued = await a.app.inference.create(demoUser, 'review-tariff-queue', a.input);
  const changed = provider({ card: { ...card, version: 'offline-review/2', output_micro_usd_per_million: '30000000' } });
  await assert.rejects(new InferenceGateway(a.app.service, changed.adapter, '100').execute(demoUser, queued.request_id), /RATE_CARD_CHANGED/);
  assert.equal(changed.calls.length, 0);
  let time = instant; const expires = provider({ clock: () => new Date(time) });
  time = '2026-09-07T00:00:00.000Z';
  await assert.rejects(new InferenceGateway(a.app.service, expires.adapter, '100').execute(demoUser, queued.request_id), /RATE_CARD_EXPIRED/);
  assert.equal(expires.calls.length, 0);
});

test('service settlement cannot spoof managed request identity to release an unknown provider charge', async t => {
  const p = provider({ generate: async () => { throw new Error('private unknown provider charge'); } });
  const a = await setup(t, { provider: p }); const queued = await a.app.inference.create(demoUser, 'review-managed-queue', a.input);
  const result = await a.app.inference.execute(demoUser, queued.request_id); assert.equal(result.status, 'UNCERTAIN');
  await assert.rejects(a.app.service.settleInference(demoSettlement, 'review-spoofed-refund', result.reservation_id,
    { request_id: queued.request_id, actual_minor: '0', provider_metered: true }), /MANAGED_INFERENCE_RESERVATION/);
  const reservation = await a.app.db.transaction(tx => tx.get('inference_credit_reservations', result.reservation_id));
  assert.equal(reservation.status, 'RESERVED'); assert.equal((await a.app.service.earnings(demoUser)).entitlements[0]!.available_minor, '99');
});

test('duplicate provider response identity is not metered twice across distinct authorized requests', async t => {
  const a = await setup(t);
  const first = await a.app.inference.create(demoUser, 'review-response-first', a.input);
  assert.equal((await a.app.inference.execute(demoUser, first.request_id)).status, 'COMPLETED');
  const second = await a.app.inference.create(demoUser, 'review-response-second', { ...a.input, prompt: 'Different private prompt' });
  const result = await a.app.inference.execute(demoUser, second.request_id);
  assert.equal(result.status, 'UNCERTAIN'); assert.equal(result.output, undefined);
  const payable = await a.app.db.transaction(tx => accountBalance(tx, 'USD', 'network', 'LIABILITY:inference_provider_payable'));
  assert.equal(payable, -1n); assert.equal(a.calls.length, 4);
});

test('durable restart never resubmits completed work and deleted prompt/output stay absent', async t => {
  const a = await setup(t, { durable: true }); const queued = await a.app.inference.create(demoUser, 'review-restart-queue', a.input);
  await a.restart(); const result = await a.app.inference.execute(demoUser, queued.request_id); assert.equal(result.status, 'COMPLETED');
  await a.restart(); assert.deepEqual(await a.app.inference.execute(demoUser, queued.request_id), result); assert.equal(a.calls.length, 2);
  await a.app.inference.deleteContent(demoUser, 'review-delete-private-content', queued.request_id); await a.restart();
  const deleted = await a.app.inference.get(demoUser, queued.request_id); assert.equal(deleted.content_deleted, true); assert.equal(deleted.output, undefined);
  assert.equal((await a.app.inference.execute(demoUser, queued.request_id)).content_deleted, true); assert.equal(a.calls.length, 2);
  const rows = JSON.stringify((await a.app.db.query('SELECT document FROM inference_requests')).rows);
  for (const secret of ['Private prompt fixture', 'Private output fixture', 'prompt_ref', 'output_ref', 'offline-only-review-key']) assert.ok(!rows.includes(secret));
});

test('transport errors, wrong MIME, malformed JSON and oversized output fail closed without persisting payloads', async t => {
  for (const kind of ['http', 'mime', 'json', 'oversize'] as const) {
    const p = provider({ generate: async () => kind === 'http' ? new Response('PRIVATE-RESPONSE', { status: 503 })
      : kind === 'mime' ? new Response('PRIVATE-RESPONSE', { headers: { 'content-type': 'text/html' } })
      : kind === 'json' ? new Response('PRIVATE-INVALID-JSON', { headers: { 'content-type': 'application/json' } })
      : new Response('PRIVATE-' + 'x'.repeat(1_000_001), { headers: { 'content-type': 'application/json' } }) });
    const a = await setup(t, { provider: p }); const queued = await a.app.inference.create(demoUser, 'review-transport-' + kind, a.input);
    const result = await a.app.inference.execute(demoUser, queued.request_id); assert.equal(result.status, 'UNCERTAIN', kind);
    const persisted = JSON.stringify((await a.app.db.query('SELECT payload FROM audit_events')).rows) + JSON.stringify(result);
    assert.ok(!persisted.includes('PRIVATE-')); assert.equal(result.actual_minor, undefined); assert.equal(p.calls.length, 2);
  }
});

test('provider reasoning is neither returned nor stored; arbitrary tool output cannot be treated as a response', async () => {
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const p = provider({ generate: async () => json(wireResponse({ output: [
    { type: 'reasoning', summary: [{ text: 'PRIVATE-REASONING-SENTINEL' }] }, ...wireResponse().output,
  ] })) });
  const result = await p.adapter.generate('synthetic fixture', 'reasoning-review');
  assert.equal(result.text, 'Private output fixture'); assert.ok(!JSON.stringify(result).includes('PRIVATE-REASONING'));
  const tool = provider({ generate: async () => json(wireResponse({ output: [{ type: 'function_call', name: 'private_action', arguments: 'PRIVATE-TOOL' }] })) });
  await assert.rejects(tool.adapter.generate('synthetic fixture', 'tool-review'), /UNEXPECTED_INFERENCE_TOOL_OUTPUT/);
});

test('HTTP inference: disabled default, bearer and owner gates, explicit consent, metered execution, replay, and private logs', async t => {
  const a = await setup(t); const logs: Document[] = [];
  async function http(gateway: InferenceGateway) {
    const server = createHttpServer({ ...a.app, inference: gateway }, { log: event => logs.push(event) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (path: string, token = '', body?: Document, key = randomUUID()) => {
      const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const session = async (role: string) => (await call('/v1/dev/session', '', { role })).body.token as string;
    return { call, session };
  }
  const disabled = await http(new InferenceGateway(a.app.service)); const disabledUser = await disabled.session('user');
  assert.equal((await disabled.call('/v1/inference/capabilities', disabledUser)).body.enabled, false);
  assert.equal((await disabled.call('/v1/inference/requests', disabledUser, a.input)).status, 503);
  assert.equal(a.calls.length, 0);
  const enabled = await http(a.app.inference); const user = await enabled.session('user'), buyer = await enabled.session('buyer_admin');
  assert.equal((await enabled.call('/v1/inference/requests')).status, 401);
  assert.equal((await enabled.call('/v1/inference/requests', buyer)).status, 403);
  const capabilities = await enabled.call('/v1/inference/capabilities', user);
  assert.equal(capabilities.body.enabled, true); assert.equal(capabilities.body.external_prompt_transfer, true);
  assert.equal((await enabled.call('/v1/inference/requests', user, { ...a.input, consent_external_processing: false })).body.error, 'INFERENCE_CONSENT_REQUIRED');
  const key = randomUUID(); const created = await enabled.call('/v1/inference/requests', user, a.input, key);
  assert.equal(created.status, 200);
  assert.deepEqual((await enabled.call('/v1/inference/requests', user, a.input, key)).body, created.body);
  const path = '/v1/inference/requests/' + created.body.request_id;
  assert.equal((await enabled.call(path, user)).body.status, 'QUEUED');
  const queued = await enabled.call(path, user);
  const spoof = await enabled.call('/v1/dev/inference-settle', user,
    { reservation_id: queued.body.reservation_id, request_id: created.body.request_id, provider_metered: true, actual_minor: '0' });
  assert.equal(spoof.status, 409); assert.equal(spoof.body.error, 'MANAGED_INFERENCE_RESERVATION');
  await a.app.db.transaction(tx => tx.insert('inference_requests', 'other-owner-request', 'other-user',
    { request_id: 'other-owner-request', reservation_id: 'other-owner-reservation', status: 'FAILED', reserved_minor: '1' }));
  assert.equal((await enabled.call('/v1/inference/requests/other-owner-request', user)).status, 404);
  const completed = await enabled.call(path + '/execute', user, {});
  assert.equal(completed.status, 200); assert.equal(completed.body.status, 'COMPLETED'); assert.equal(completed.body.actual_minor, '1');
  assert.equal(completed.body.output.text, 'Private output fixture');
  assert.deepEqual((await enabled.call(path, user)).body, completed.body);
  assert.deepEqual((await enabled.call(path + '/execute', user, {})).body, completed.body); assert.equal(a.calls.length, 2);
  const consent={rights_confirmed:true,model_output_licensed:false};
  assert.equal((await enabled.call(path+'/capture','',consent)).status,401);
  assert.equal((await enabled.call(path+'/capture',buyer,consent)).status,403);
  assert.equal((await enabled.call('/v1/inference/requests/other-owner-request/capture',user,consent)).status,404);
  const capture=await enabled.call(path+'/capture',user,consent);
  assert.equal(capture.status,200);assert.equal(capture.body.capture_receipt.path,'operator_capture');
  assert.equal(capture.body.capture_receipt.confidence_tier,'P0_OPERATOR');
  const again=await enabled.call(path+'/capture',user,consent);
  assert.equal(again.body.trace_id,capture.body.trace_id);assert.equal(again.body.duplicate,true);
  assert.equal(a.calls.length,2,'Saving must not invoke the provider');
  const logText = JSON.stringify(logs);
  for (const secret of [user, buyer, a.input.prompt, 'Private output fixture', 'offline-only-review-key']) assert.ok(!logText.includes(secret));
});
