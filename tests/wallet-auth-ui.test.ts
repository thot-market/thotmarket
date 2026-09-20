import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Production browser module intentionally uses JavaScript.
import { createWalletAuth } from '../apps/dashboard/wallet-auth-ui.js';
const origin = 'https://thot.example.test', alice = '0x1111111111111111111111111111111111111111', bob = '0x2222222222222222222222222222222222222222';
const response = (value: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const tick = () => new Promise(resolve => setImmediate(resolve));
function provider(flags: any = { isMetaMask: true }) {
  const state: any = { address: alice, chain: '0xb626', calls: [], sign: async () => '0x' + '12'.repeat(65), switch: true, added:null };
  const listeners = new Map<string, Set<Function>>();
  const p: any = { ...flags, on(event: string, callback: Function) { const set = listeners.get(event) ?? new Set(); set.add(callback); listeners.set(event, set); }, removeListener(event: string, callback: Function) { listeners.get(event)?.delete(callback); }, emit(event: string) { for (const listener of listeners.get(event) ?? []) listener(); },
    async request(input: any) { state.calls.push(input); switch (input.method) {
      case 'eth_accounts': case 'eth_requestAccounts': return [state.address];
      case 'eth_chainId': return state.chain;
      case 'personal_sign': return state.sign();
      case 'wallet_switchEthereumChain': if (!state.switch) throw new Error('switch rejected'); if(state.switch==='missing'){state.switch=true;throw Object.assign(new Error('missing'),{code:4902});} state.chain = input.params[0].chainId; return null;
      case 'wallet_addEthereumChain': state.added=input.params[0];return null;
      default: throw new Error('unexpected method ' + input.method);
    } } };
  return { p, state };
}
function challenge(wallet = alice, chainId = 46630) {
  const id = 'a'.repeat(32);
  return { id, address: wallet, chain_id: chainId, expires_at: '2026-09-15T01:05:00Z', message: `${origin} wants you to sign in with your Ethereum account:\n${wallet}\n\nSign in to thot market and link this wallet for payouts. This does not authorize token transfers or trace sales.\n\nURI: ${origin}/app\nVersion: 1\nChain ID: ${chainId}\nNonce: ${'b'.repeat(32)}\nIssued At: 2026-09-15T01:00:00.000Z\nExpiration Time: 2026-09-15T01:05:00.000Z\nRequest ID: ${id}` };
}
function fixture(overrides: any = {}) {
  const { p, state } = provider(), calls: any[] = [], sessions: any[] = [], changes: any[] = [], signedOut: any[] = [], errors: Error[] = [];
  const window: any = { ethereum: p, location: { origin }, crypto: { randomUUID: () => crypto.randomUUID() }, ...overrides.window };
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(window, key, { get() { throw new Error('browser storage must not be accessed'); } });
  const fetch = async (path: string, init: any) => {
    calls.push({ path, init });
    if (overrides.fetch) { const result = await overrides.fetch(path, init); if (result) return result; }
    if (path.endsWith('/revoke')) return response({ revoked: true });
    if (path.endsWith('/challenge')) return response(challenge(JSON.parse(init.body).address, overrides.chainId ?? 46630));
    return response({ actor: { id: 'alice', role: 'user' }, wallet_address: state.address, chain_id: overrides.chainId ?? 46630, permissions: { contributor: true } });
  };
  const ui = createWalletAuth({ window, fetch, chainId:overrides.chainId, rpcUrl:overrides.rpcUrl, additionalProviders:overrides.additionalProviders, requestTimeoutMs:overrides.requestTimeoutMs, providerTimeoutMs:overrides.providerTimeoutMs, additionalProvidersTimeoutMs:overrides.additionalProvidersTimeoutMs, onSession(value: any) { sessions.push(value); }, onIdentityChanging() { changes.push(true); }, onSignedOut() { signedOut.push(true); }, onError(error: Error) { errors.push(error); } });
  return { ui, window, p, state, calls, sessions, changes, signedOut, errors };
}

test('wallet UI signs a domain-bound message without transactions or exposing a token to JavaScript storage', async () => {
  const a = fixture(); assert.equal(await a.ui.signIn('metamask'), true);
  assert.equal(a.sessions.length, 1); assert.equal(a.sessions[0].actor.id, 'alice'); assert.equal(a.sessions[0].token, null); assert.equal(a.sessions[0].authMode, 'wallet_siwe');
  assert.equal(a.ui.getProvider(), a.p);
  for (const call of a.calls) { assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers.Authorization, undefined); }
  const signature = a.state.calls.find((call: any) => call.method === 'personal_sign');
  assert.equal(signature.params[1], alice); assert.equal(Buffer.from(signature.params[0].slice(2), 'hex').toString(), challenge().message);
  assert.ok(!a.state.calls.some((call: any) => /sendTransaction|signTransaction|signTypedData/.test(call.method)));
  const verified = a.calls.find(call => call.path.endsWith('/verify')); assert.deepEqual(Object.keys(JSON.parse(verified.init.body)).sort(), ['id', 'message', 'signature']);
  a.ui.destroy();
});

test('wallet UI ignores a duplicate sign-in click while a wallet prompt is pending', async () => {
  const a = fixture(); let resolve!: (value: string) => void; a.state.sign = () => new Promise(r => { resolve = r; });
  const pending = a.ui.signIn(); await tick(); assert.equal(await a.ui.signIn(), false);
  assert.equal(a.state.calls.filter((call: any) => call.method === 'personal_sign').length, 1);
  resolve('0x' + '12'.repeat(65)); assert.equal(await pending, true); assert.equal(a.sessions.length, 1); a.ui.destroy();
});

test('wallet UI rejects a chain switch refusal before requesting a signature', async () => {
  const a = fixture(); a.state.chain = '0x1'; a.state.switch = false;
  assert.equal(await a.ui.signIn(), false); assert.equal(a.sessions.length, 0); assert.ok(a.errors.length > 0);
  assert.equal(a.state.calls.filter((call: any) => call.method === 'personal_sign').length, 0);
});

test('wallet UI switches to the exact Robinhood testnet before creating a challenge', async () => {
  const a = fixture(); a.state.chain = '0x1'; assert.equal(await a.ui.signIn(), true);
  assert.deepEqual(a.state.calls.find((call: any) => call.method === 'wallet_switchEthereumChain').params, [{ chainId: '0xb626' }]); a.ui.destroy();
});

test('wallet UI uses the reviewed local Anvil chain from server capabilities', async () => {
  const rpcUrl=origin+'/rpc/'+'r'.repeat(43),a = fixture({chainId:31337,rpcUrl}); a.state.chain = '0x1';a.state.switch='missing';assert.equal(await a.ui.signIn(), true);
  assert.deepEqual(a.state.calls.find((call: any) => call.method === 'wallet_switchEthereumChain').params, [{chainId:'0x7a69'}]);
  assert.deepEqual(a.state.added.rpcUrls,[rpcUrl]);assert.ok(!JSON.stringify(a.state.added).includes('127.0.0.1'));
  const body=JSON.parse(a.calls.find(call=>call.path.endsWith('/challenge')).init.body);assert.equal(body.chain_id,31337);assert.equal(a.sessions[0].chain_id,31337);a.ui.destroy();
});

test('wallet UI does not sign a server challenge for another origin, account or chain', async () => {
  for (const changed of [{ message: challenge().message.replaceAll(origin, 'https://evil.example') }, { address: bob }, { chain_id: 1 }]) {
    const a = fixture({ fetch: (path: string) => path.endsWith('/challenge') ? response({ ...challenge(), ...changed }) : null });
    assert.equal(await a.ui.signIn(), false); assert.equal(a.sessions.length, 0);
    assert.ok(!a.state.calls.some((call: any) => call.method === 'personal_sign')); a.ui.destroy();
  }
});

test('provider account change during a signature clears private UI and prevents verification', async () => {
  const a = fixture(); let resolve!: (value: string) => void; a.state.sign = () => new Promise(r => { resolve = r; });
  const pending = a.ui.signIn(); await tick(); a.state.address = bob; a.p.emit('accountsChanged');
  assert.equal(a.changes.length, 2); resolve('0x' + '12'.repeat(65)); assert.equal(await pending, false);
  assert.equal(a.sessions.length, 0); assert.ok(!a.calls.some(call => call.path.endsWith('/verify'))); a.ui.destroy();
});

test('provider chain change without an event after signing is rechecked before verification', async () => {
  const a = fixture(); a.state.sign = async () => { a.state.chain = '0x1'; return '0x' + '12'.repeat(65); };
  assert.equal(await a.ui.signIn(), false); assert.equal(a.sessions.length, 0); assert.ok(!a.calls.some(call => call.path.endsWith('/verify'))); a.ui.destroy();
});

test('mainnet wallet sign-in adds the exact Robinhood chain and rejects a testnet challenge', async () => {
  const a=fixture({chainId:4663,rpcUrl:'https://rpc.mainnet.chain.robinhood.com'});
  a.state.switch='missing';
  assert.equal(await a.ui.signIn(),true);
  assert.equal(a.state.added.chainId,'0x1237');
  assert.deepEqual(a.state.added.rpcUrls,['https://rpc.mainnet.chain.robinhood.com/']);
  assert.equal(a.sessions[0].chain_id,4663);
  a.ui.destroy();
  const b=fixture({chainId:4663,rpcUrl:'https://rpc.mainnet.chain.robinhood.com',fetch:(path:string)=>path.endsWith('/challenge')?response(challenge(alice,46630)):null});
  b.state.chain='0x1237';
  assert.equal(await b.ui.signIn(),false);
  assert.equal(b.sessions.length,0);
  b.ui.destroy();
  assert.throws(()=>fixture({chainId:4663,rpcUrl:'https://rpc.testnet.chain.robinhood.com'}),/not configured/);
});

test('a verification arriving after wallet change is discarded and its late session cookie revoked', async () => {
  let release!: (value: any) => void;
  const a = fixture({ fetch: (path: string) => path.endsWith('/verify') ? new Promise(resolve => { release = resolve; }) : null });
  const pending = a.ui.signIn(); await tick(); assert.equal(typeof release, 'function');
  a.state.address = bob; a.p.emit('accountsChanged'); await tick();
  const beforeLateResult = a.calls.filter(call => call.path.endsWith('/revoke')).length;
  release(response({ actor: { id: 'alice', role: 'user' }, wallet_address: alice, chain_id: 46630 }));
  assert.equal(await pending, false); assert.equal(a.sessions.length, 0);
  assert.ok(a.calls.filter(call => call.path.endsWith('/revoke')).length > beforeLateResult); a.ui.destroy();
});

test('wallet restore never displays another selected wallet account from an old cookie', async () => {
  const a = fixture({ fetch: (path: string) => path === '/v1/auth/session' ? response({ actor: { id: 'bob', role: 'user' }, wallet_address: bob, chain_id: 46630 }) : null });
  assert.equal(await a.ui.restore(), false); assert.equal(a.sessions.length, 0); assert.ok(a.calls.some(call => call.path.endsWith('/revoke'))); a.ui.destroy();
});

test('wallet restore binds its session to a matching current provider and logout detaches listeners', async () => {
  const a = fixture(); assert.equal(await a.ui.restore(), true); assert.equal(a.sessions.length, 1); assert.equal(a.ui.getProvider(), a.p);
  await a.ui.signOut(); const count = a.changes.length; a.p.emit('accountsChanged'); await tick(); assert.equal(a.changes.length, count);
  assert.equal(a.signedOut.length, 1); assert.equal(a.ui.getProvider(), null); a.ui.destroy();
});

test('Phantom sign-in accepts its EVM provider and never uses a Solana-only wallet', async () => {
  const phantom = provider({ isPhantom: true });
  const a = fixture({ window: { ethereum: undefined, phantom: { ethereum: phantom.p, solana: { signMessage() { throw new Error('Solana must not be used'); } } } } });
  assert.equal(await a.ui.signIn('phantom'), true); assert.equal(a.ui.getProvider(), phantom.p); a.ui.destroy();
  const b = fixture({ window: { ethereum: undefined, phantom: { solana: {} } } });
  assert.equal(await b.ui.signIn('phantom'), false); assert.match(b.errors[0]!.message, /Solana-only/); assert.equal(b.sessions.length, 0);
});

test('wallet UI fails closed if logout cannot revoke the previous session', async () => {
  const a = fixture({ fetch: (path: string) => path.endsWith('/revoke') ? response({}, 503) : null });
  assert.equal(await a.ui.signIn(), false); assert.equal(a.sessions.length, 0); assert.equal(a.state.calls.length, 0);
});

test('a Privy EVM provider uses the same SIWE proof and expected address checks', async () => {
  const a=fixture({window:{ethereum:undefined}}), embedded=provider();
  assert.equal(await a.ui.signInProvider(embedded.p,alice),true);
  assert.equal(a.ui.getProvider(),embedded.p);assert.equal(a.sessions[0].authMode,'wallet_siwe');
  a.ui.destroy();
  const b=fixture({window:{ethereum:undefined}});
  assert.equal(await b.ui.signInProvider(embedded.p,bob),false);
  assert.equal(b.sessions.length,0);assert.ok(!b.calls.some(call=>call.path.endsWith('/challenge')));b.ui.destroy();
});

test('a returning embedded wallet restores only the same server-bound wallet without requesting a new signature', async () => {
  const embedded=provider(),requested:any[]=[];
  const a=fixture({window:{ethereum:undefined},additionalProviders:async(address:string)=>{requested.push(address);return [embedded.p];}});
  assert.equal(await a.ui.restore(),true);assert.deepEqual(requested,[alice]);assert.equal(a.ui.getProvider(),embedded.p);
  assert.ok(!embedded.state.calls.some((call:any)=>call.method==='personal_sign'));
  await a.ui.signOut();assert.equal(a.ui.getProvider(),null);a.ui.destroy();
});

test('logout invalidates a pending embedded-provider restoration before private data can appear',async()=>{
  let release!:(value:any)=>void;
  const a=fixture({window:{ethereum:undefined},additionalProviders:()=>new Promise(resolve=>{release=resolve;})});
  const pending=a.ui.restore();await tick();await a.ui.signOut();release([provider().p]);
  assert.equal(await pending,false);assert.equal(a.sessions.length,0);assert.equal(a.ui.getProvider(),null);a.ui.destroy();
});


test('anonymous restoration does not fetch optional wallet providers',async()=>{
  let extra=0;
  const a=fixture({fetch:(path:string)=>path==='/v1/auth/session'?response({},401):null,additionalProviders:async()=>{extra++;throw Error('Optional SDK must stay unloaded');}});
  assert.equal(await a.ui.restore(),false);assert.equal(extra,0);assert.equal(a.sessions.length,0);assert.equal(a.errors.length,0);a.ui.destroy();
});

test('an existing injected wallet restores without waiting for the optional SDK',async()=>{
  let extra=0;
  const a=fixture({additionalProviders:async()=>{extra++;return new Promise(()=>{});}});
  assert.equal(await a.ui.restore(),true);assert.equal(extra,0);assert.equal(a.sessions.length,1);a.ui.destroy();
});

test('a stalled anonymous-session request is aborted and leaves a visible retry without accepting a session',async()=>{
  let release!:(value:any)=>void;
  const a=fixture({requestTimeoutMs:10,fetch:(path:string)=>path==='/v1/auth/session'?new Promise(resolve=>{release=resolve;}):null});
  assert.equal(await a.ui.restore(),false);assert.equal(a.calls[0].init.signal.aborted,true);assert.equal(a.sessions.length,0);assert.match(a.errors[0].message,/took too long/);assert.equal(a.signedOut.length,1);
  release(response({actor:{id:'alice',role:'user'},wallet_address:alice,chain_id:46630}));await tick();assert.equal(a.sessions.length,0);
  assert.equal(await a.ui.signIn(),true,'a fresh manual sign-in can retry after timeout');a.ui.destroy();
});

test('a session response with a stalled body is bounded too',async()=>{
  const a=fixture({requestTimeoutMs:10,fetch:(path:string)=>path==='/v1/auth/session'?{...response({}),json:()=>new Promise(()=>{})}:null});
  assert.equal(await a.ui.restore(),false);assert.equal(a.calls[0].init.signal.aborted,true);assert.equal(a.sessions.length,0);assert.match(a.errors[0].message,/took too long/);a.ui.destroy();
});

test('a stalled noninteractive injected provider cannot block a matching embedded wallet',async()=>{
  const embedded=provider(),a=fixture({providerTimeoutMs:10,additionalProviders:async()=>[embedded.p]});
  a.p.request=()=>new Promise(()=>{});
  assert.equal(await a.ui.restore(),true);assert.equal(a.ui.getProvider(),embedded.p);assert.equal(a.sessions.length,1);a.ui.destroy();
});

test('optional provider restoration has a deadline and never accepts a late provider',async()=>{
  let release!:(value:any)=>void;
  const a=fixture({window:{ethereum:undefined},additionalProvidersTimeoutMs:10,additionalProviders:()=>new Promise(resolve=>{release=resolve;})});
  assert.equal(await a.ui.restore(),false);assert.match(a.errors[0].message,/restoration took too long/);assert.equal(a.sessions.length,0);
  release([provider().p]);await tick();assert.equal(a.sessions.length,0);assert.equal(a.ui.getProvider(),null);a.ui.destroy();
});


test('sign-out cancels a restore without letting an unresolved signature overlap a fresh login',async()=>{
  const a=fixture();let release!:(signature:string)=>void;
  a.state.sign=()=>new Promise(resolve=>{release=resolve;});
  const first=a.ui.signIn();await tick();await a.ui.signOut();
  assert.equal(await a.ui.signIn(),false,'the unresolved wallet signature retains the sign-in lock');
  release('0x'+'12'.repeat(65));assert.equal(await first,false);assert.equal(a.sessions.length,0);
  a.state.sign=async()=>'0x'+'12'.repeat(65);assert.equal(await a.ui.signIn(),true);assert.equal(a.sessions.length,1);a.ui.destroy();
});
