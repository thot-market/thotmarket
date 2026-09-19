import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The production browser module intentionally ships as plain JavaScript.
import { createClerkAuthUI } from '../apps/dashboard/clerk-auth-ui.js';

const response = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(fetchImpl: any) {
  const listeners: any[] = [], mounts: any[] = [], sessions: any[] = [], signedOut: any[] = [], errors: Error[] = [];
  const clerk: any = {
    session: null, async load() {},
    addListener(callback: any) { listeners.push(callback); return () => {}; },
    mountSignIn(target: any) { mounts.push(target); }, async signOut() { clerk.session = null; },
  };
  const document: any = {};
  const changes: any[] = [];
  const auth = createClerkAuthUI({ document, window: {}, fetch: fetchImpl, onIdentityChanging() { changes.push(true); },
    onSession(value: any) { sessions.push(value); }, onSignedOut() { signedOut.push(true); }, onError(error: Error) { errors.push(error); } });
  const config = { publishable_key: 'pk_test_abcdefghijklmnopqrstuvwxyz', frontend_api_url: 'https://example.clerk.accounts.dev' };
  return { auth, clerk, config, listeners, mounts, sessions, signedOut, errors, changes };
}

test('Clerk UI verifies an SDK session and obtains fresh tokens without storing a custom credential', async () => {
  const calls: any[] = [];
  const a = fixture(async (url: string, init: any) => { calls.push({ url, init }); return response({ actor: { id: 'user-1', role: 'user' } }); });
  let tokenNumber = 0;
  a.clerk.session = { id: 'session-1', getToken: async () => `token-${++tokenNumber}` };
  await a.auth.initialize(a.config, { clerk: a.clerk });
  await tick();
  assert.equal(a.sessions.length, 1); assert.equal(a.sessions[0].actor.id, 'user-1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-1');
  assert.equal(await a.auth.getToken(), 'token-2');
});

test('an initially signed-out Clerk SDK enters the provider sign-in state', async () => {
  const a = fixture(async () => { throw new Error('signed-out initialization must not call THOT session verification'); });
  await a.auth.initialize(a.config, { clerk: a.clerk }); await tick();
  assert.equal(a.signedOut.length, 1);
  assert.equal(a.sessions.length, 0);
});

test('Clerk account changes invalidate an older verification response', async () => {
  let releaseOld!: (value: any) => void;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const a = fixture(async (_url: string, init: any) => init.headers.Authorization === 'Bearer old-token' ? oldResponse : response({ actor: { id: 'new-user', role: 'user' } }));
  await a.auth.initialize(a.config, { clerk: a.clerk });
  a.listeners[0]({ session: { id: 'old', getToken: async () => 'old-token' }, user: { id: 'old-user' } });
  await tick();
  a.listeners[0]({ session: { id: 'new', getToken: async () => 'new-token' }, user: { id: 'new-user' } });
  await tick();
  releaseOld(response({ actor: { id: 'old-user', role: 'user' } })); await tick();
  assert.deepEqual(a.sessions.map(value => value.actor.id), ['new-user']);
});

test('same-session listener updates do not reset or reverify the workspace', async () => {
  const a = fixture(async () => response({ actor: { id: 'user-1', role: 'user' } }));
  a.clerk.session = { id: 'stable-session', getToken: async () => 'first-token' };
  a.clerk.user = { id: 'stable-user' };
  await a.auth.initialize(a.config, { clerk: a.clerk }); await tick();
  a.listeners[0]({ session: { id: 'stable-session', getToken: async () => 'rotated-token' }, user: { id: 'stable-user' } });
  await tick();
  assert.equal(a.sessions.length, 1); assert.equal(a.changes.length, 1);
});

test('provider sign-out invalidates a verification already in flight', async () => {
  let release!: (value: any) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const a = fixture(async () => pending);
  await a.auth.initialize(a.config, { clerk: a.clerk });
  a.listeners[0]({ session: { id: 'ending-session', getToken: async () => 'ending-token' }, user: { id: 'ending-user' } });
  await tick(); await a.auth.signOut();
  release(response({ actor: { id: 'should-not-return', role: 'user' } })); await tick();
  assert.equal(a.sessions.length, 0);
});

test('Clerk presents an invite-specific denial and mounts the provider sign-in UI', async () => {
  const a = fixture(async () => response({ error: 'FORBIDDEN' }, 403));
  await a.auth.initialize(a.config, { clerk: a.clerk });
  const target = {}; a.auth.mountSignIn(target);
  a.listeners[0]({ session: { getToken: async () => 'uninvited-token' } }); await tick();
  assert.equal(a.mounts[0], target);
  assert.match(a.errors[0]?.message ?? '', /not invited/i);
});
