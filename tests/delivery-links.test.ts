import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { DeliveryLinks } from '../packages/market/src/delivery-links.ts';
import { demoBuyer, demoUser, createDemoMandate, importDemo, policyInput } from '../packages/market/src/fixtures.ts';
import { createHttpServer } from '../apps/api/server.ts';
import type { Document } from '../packages/storage/src/index.ts';

async function setup(t: any, http = false, sessionTtlMs?: number) {
  const clock = { now: Date.parse('2026-09-06T12:00:00.000Z') };
  const app = await createApplication({ memory: true, dataDir: await mkdtemp(join(tmpdir(), 'thot-delivery-links-')), config: { clock: () => new Date(clock.now) } });
  const links = new DeliveryLinks(app.service), logs: Document[] = [];
  let closeServer = async () => {};
  t.after(async () => { await closeServer(); await app.close(); });
  if (!http) return { app, links, clock, logs, call: undefined, session: undefined };
  const server = createHttpServer(app, { clock: () => clock.now, sessionTtlMs, log: event => logs.push(event) });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  // Stop the server before closing its backing database.
  closeServer = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  const call = async (path: string, { token = '', body, key = randomUUID(), method = body ? 'POST' : 'GET' }: Document = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const session = async (role: string) => (await call('/v1/dev/session', { body: { role } })).body.token;
  return { app, links, clock, logs, call, session };
}
async function sale(app: Awaited<ReturnType<typeof createApplication>>) {
  await app.service.createPolicy(demoUser, 'delivery-link-policy', policyInput(app.service));
  await importDemo(app.service, demoUser, 'coding', 'delivery-link-trace');
  await createDemoMandate(app.service, 'general', 'delivery-link-mandate');
  assert.equal((await app.service.runWorker()).failed, 0);
  const candidate = (await app.service.candidates(demoUser))[0]!;
  const { release, ...preview } = await app.service.preview(demoUser, candidate.candidate_id);
  const result = await app.service.authorize(demoUser, 'delivery-link-authorize', { ...preview, payout_preference: 'inference_credit' });
  return { id: result.license_id, hash: preview.release_artifact_hash };
}
const capability = (url: string) => new URL(url, 'http://localhost').searchParams.get('capability')!;

test('spec 110: signed links bind an exact release, actor and buyer; permitted read replay never repeats a sale', async t => {
  const { app, links, clock } = await setup(t), { id, hash } = await sale(app);
  const link = await links.issue(demoBuyer, 'delivery-link-issue', id, {});
  assert.equal(link.release_artifact_hash, hash); assert.equal(Date.parse(link.expires_at), clock.now + 60000);
  assert.match(link.download_url, /^\/v1\/buyer\/deliveries\/[a-z0-9-]+\/download\?capability=/);
  assert.equal(link.authentication, 'same_actor_and_buyer_bearer_required');
  assert.deepEqual(await links.issue(demoBuyer, 'delivery-link-issue', id, {}), link);
  await assert.rejects(links.issue(demoBuyer, 'delivery-link-issue', id, { ttl_seconds: 5 }), /IDEMPOTENCY_CONFLICT/);
  const token = capability(link.download_url);
  const first = await links.redeem(demoBuyer, id, token), second = await links.redeem(demoBuyer, id, token);
  assert.deepEqual(second, first); assert.equal(first.delivery.bundle_hash, hash);
  assert.equal((await app.db.transaction(tx => tx.get('deliveries', id))).retrieval_count, 2);
  assert.equal((await app.db.query('SELECT count(*)::text AS count FROM licenses')).rows[0].count, '1');
  const audit = JSON.stringify((await app.db.query('SELECT event_type,payload FROM audit_events')).rows);
  assert.ok(!audit.includes(token)); assert.ok(!audit.includes('object_ref')); assert.ok(!audit.includes('download_url'));
});

test('signed delivery links reject tampering, wrong scopes, foreign accounts and unapproved issuance inputs', async t => {
  const { app, links } = await setup(t), { id } = await sale(app);
  const link = await links.issue(demoBuyer, 'scope-link-issue', id), token = capability(link.download_url);
  await assert.rejects(links.issue(demoUser, 'user-link-issue', id), /FORBIDDEN/);
  await assert.rejects(links.redeem(demoUser, id, token), /FORBIDDEN/);
  await assert.rejects(links.redeem({ ...demoBuyer, id: 'another-buyer-admin' }, id, token), /SCOPE_MISMATCH/);
  await assert.rejects(links.redeem({ ...demoBuyer, buyer_id: 'another-buyer' }, id, token), /SCOPE_MISMATCH/);
  await assert.rejects(links.redeem(demoBuyer, 'a-different-license', token), /SCOPE_MISMATCH/);
  const [payload, signature] = token.split('.'), scope = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
  const changed = Buffer.from(JSON.stringify({ ...scope, expires_at_ms: scope.expires_at_ms + 60000 })).toString('base64url') + '.' + signature;
  for (const invalid of [changed, token + '=', token.replace('.', '..'), 'x'.repeat(4097), null, token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')]) await assert.rejects(links.redeem(demoBuyer, id, invalid), /INVALID_DELIVERY_LINK/);
  for (const [index, input] of [{ ttl_seconds: 0 }, { ttl_seconds: 61 }, { ttl_seconds: 1.5 }, { ttl_seconds: '60' }, { ttl_seconds: null }, { redirect: 'https://attacker.invalid' }, { object_ref: 'private-object' }].entries()) await assert.rejects(links.issue(demoBuyer, 'bad-issue-' + index, id, input));
  assert.equal((await app.db.transaction(tx => tx.get('deliveries', id))).retrieval_count, 0);
});

test('signed links expire at the exact deadline and never outlive licensed retention', async t => {
  const { app, links, clock } = await setup(t), { id } = await sale(app);
  const short = await links.issue(demoBuyer, 'short-link-issue', id, { ttl_seconds: 1 });
  clock.now += 999; await links.redeem(demoBuyer, id, capability(short.download_url));
  clock.now++; await assert.rejects(links.redeem(demoBuyer, id, capability(short.download_url)), /DELIVERY_LINK_EXPIRED/);
  const license = await app.db.transaction(tx => tx.get('licenses', id));
  clock.now = Date.parse(license.retention_expires_at) - 35;
  const clipped = await links.issue(demoBuyer, 'clipped-link-issue', id);
  assert.equal(clipped.expires_at, license.retention_expires_at);
  await links.redeem(demoBuyer, id, capability(clipped.download_url));
  clock.now += 35;
  await assert.rejects(links.redeem(demoBuyer, id, capability(clipped.download_url)), /DELIVERY_LINK_EXPIRED/);
  await assert.rejects(links.issue(demoBuyer, 'expired-license-issue', id), /DELIVERY_EXPIRED/);
});

test('buyer approval and delivery availability are rechecked when a previously issued link is redeemed', async t => {
  const { app, links } = await setup(t), { id } = await sale(app);
  const token = capability((await links.issue(demoBuyer, 'revocation-link-issue', id)).download_url);
  await app.db.transaction(async tx => { const buyer = await tx.get('buyers', demoBuyer.buyer_id!); await tx.update('buyers', buyer.id, { ...buyer, approved: false }); });
  await assert.rejects(links.redeem(demoBuyer, id, token), /BUYER_NOT_APPROVED/);
  await assert.rejects(links.issue(demoBuyer, 'revoked-buyer-issue', id), /BUYER_NOT_APPROVED/);
  await app.db.transaction(async tx => {
    const buyer = await tx.get('buyers', demoBuyer.buyer_id!); await tx.update('buyers', buyer.id, { ...buyer, approved: true });
    const delivery = await tx.get('deliveries', id); await tx.update('deliveries', id, { ...delivery, status: 'REVOKED' });
  });
  await assert.rejects(links.redeem(demoBuyer, id, token), /DELIVERY_UNAVAILABLE/);
  assert.equal((await app.db.transaction(tx => tx.get('deliveries', id))).retrieval_count, 0);
});

test('default signing keys are ephemeral: reconstructed instances reject old links without changing licenses', async t => {
  const { app, links } = await setup(t), { id } = await sale(app);
  const issued = await links.issue(demoBuyer, 'ephemeral-link-issue', id), restarted = new DeliveryLinks(app.service);
  await assert.rejects(restarted.redeem(demoBuyer, id, capability(issued.download_url)), /INVALID_DELIVERY_LINK/);
  const fresh = await restarted.issue(demoBuyer, 'fresh-ephemeral-link-issue', id);
  assert.equal((await restarted.redeem(demoBuyer, id, capability(fresh.download_url))).delivery.bundle_hash, issued.release_artifact_hash);
  assert.throws(() => new DeliveryLinks(app.service, { signingKey: new Uint8Array(16) }), /KEY_TOO_SHORT/);
});

test('tampered or too-slow object retrieval cannot pass scope commitments or commit delivery counters', async t => {
  const { app, links, clock } = await setup(t), { id } = await sale(app);
  const token = capability((await links.issue(demoBuyer, 'object-check-link-issue', id)).download_url), open = app.privacy.open.bind(app.privacy);
  app.privacy.open = async (owner, ref) => ({ ...await open(owner, ref), unauthorized_extra: 'tampered content' });
  await assert.rejects(links.redeem(demoBuyer, id, token), /RELEASE_TAMPERED/);
  app.privacy.open = async (owner, ref) => { const result = await open(owner, ref); clock.now += 60000; return result; };
  await assert.rejects(links.redeem(demoBuyer, id, token), /DELIVERY_LINK_EXPIRED/);
  assert.equal((await app.db.transaction(tx => tx.get('deliveries', id))).retrieval_count, 0);
});

test('HTTP signed downloads keep the ordinary authenticated route, reject anonymous/hostile URLs and redact logs', async t => {
  const { app, call, session, logs } = await setup(t, true), { id, hash } = await sale(app);
  const buyer = await session!('buyer_admin'), user = await session!('user'), path = `/v1/buyer/deliveries/${id}`;
  const issued = await call!(path + '/link', { token: buyer, body: {} }); assert.equal(issued.status, 200);
  const url = issued.body.download_url;
  assert.equal((await call!(url)).status, 401);
  assert.equal((await call!(url, { token: user })).status, 403);
  assert.equal((await call!(url + '&redirect=https://attacker.invalid', { token: buyer })).status, 400);
  assert.equal((await call!(url + '&capability=' + capability(url), { token: buyer })).status, 400);
  assert.equal((await call!(path + '/download', { token: buyer })).status, 400);
  const delivered = await call!(url, { token: buyer }); assert.equal(delivered.status, 200); assert.equal(delivered.body.delivery.bundle_hash, hash);
  assert.equal(delivered.headers.get('cache-control'), 'no-store'); assert.equal(delivered.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await call!(path, { token: buyer })).status, 200);
  assert.equal((await call!(path + '/link', { token: buyer, body: {}, key: '' })).status, 400);
  const output = JSON.stringify(logs);
  for (const secret of [buyer, user, capability(url), 'download_url', 'scrubbed_content', 'Authorization']) assert.ok(!output.includes(secret));
});

test('HTTP expired sessions fail reads and mutations exactly at expiry; reconnect retries retain idempotency', async t => {
  const { app, call, session, clock, logs } = await setup(t, true, 1000);
  const oldToken = await session!('user'), key = 'session-expiry-same-import', body = { scenario: 'coding' };
  const first = await call!('/v1/dev/trace', { token: oldToken, body, key }); assert.equal(first.status, 200);
  clock.now += 999; assert.equal((await call!('/v1/traces', { token: oldToken })).status, 200);
  clock.now++;
  assert.equal((await call!('/v1/traces', { token: oldToken })).status, 401);
  assert.equal((await call!('/v1/dev/trace', { token: oldToken, body, key })).status, 401);
  assert.equal((await app.service.traces(demoUser)).length, 1);
  const renewed = await session!('user'); assert.notEqual(renewed, oldToken);
  assert.deepEqual((await call!('/v1/dev/trace', { token: renewed, body, key })).body, first.body);
  assert.equal((await app.service.traces(demoUser)).length, 1);
  assert.equal((await call!('/v1/traces', { token: oldToken })).status, 401, 'issuing a replacement must not revive the old token');
  assert.ok(!JSON.stringify(logs).includes(oldToken)); assert.ok(!JSON.stringify(logs).includes(renewed));
});
