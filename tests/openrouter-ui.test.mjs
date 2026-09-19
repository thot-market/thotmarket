import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../apps/dashboard/openrouter-ui.js', import.meta.url), 'utf8');
function fixture(overrides = {}) {
  const calls = [], dialogs = [], messages = [], clipboard = [];
  const state = { actor: { id: 'alice' }, role: 'user', generation: 1 };
  let status = { enabled: true, connected: false, notice_version: 'notice-1', notice: 'Recording includes request and response content. Provider bills your key.', requests: [] };
  let policies = structuredClone(overrides.policies ?? []);
  const fields = new Map(), listeners = new Map();
  const dialog = { open: false, querySelector: id => fields.get(id) ?? null, addEventListener(event, fn) { const callbacks = listeners.get(event) ?? []; callbacks.push(fn); listeners.set(event, callbacks); }, close() { dialog.open = false; for (const fn of listeners.get('close') ?? []) fn(); const form = fields.get('#openrouter-connect-form'); if (form) form.isConnected = false; } };
  function openDialog(title, subtitle, html) {
    const old = fields.get('#openrouter-connect-form'); if (old) old.isConnected = false;
    fields.clear(); dialogs.push({ title, subtitle, html }); dialog.open = true;
    if (html.includes('id="openrouter-connect-form"')) {
      const key = { value: '', isConnected: true }, price = {value:'100'}, consent = { checked: false }, treasury = {checked:false}, button = { disabled: false }, formListeners = new Map();
      const form = { isConnected: true, querySelector(id) { return id === '#openrouter-sale-price' ? price : id === '#openrouter-api-key' ? key : id === '#openrouter-recording-consent' ? consent : id === '#openrouter-treasury-consent' ? treasury : id === 'button[type="submit"]' ? button : null; }, reportValidity() { return !!key.value && consent.checked; }, addEventListener(event, callback) { formListeners.set(event, callback); }, submit() { return formListeners.get('submit')?.({ preventDefault() {}, currentTarget: form }); } };
      fields.set('#openrouter-connect-form', form); fields.set('#openrouter-api-key', key); fields.set('#openrouter-recording-consent', consent); fields.set('#openrouter-treasury-consent',treasury);
    }
    if (html.includes('id="openrouter-proxy"')) { fields.set('#openrouter-proxy', { value: '' }); fields.set('#openrouter-base', { value: '' }); }
  }
  const api = async (path, options = {}) => {
    calls.push({ path, options, actor: state.actor?.id });
    if (path==='/v1/thot/streams') return {policies};
    if (path==='/v1/thot/streams/revoke') {
      if(overrides.revoke) return overrides.revoke(path,options);
      const policy=policies.find(p=>p.id===options.body.id);if(policy)policy.offchain_revoked=true;
      return {revoked:true,transactions:[{to:overrides.market??'0x'+'2'.repeat(40),data:'0x27a69ad5'+'a'.repeat(64),value:'0x0',chainId:'0x7a69'}]};
    }
    if (path==='/v1/thot/streams/prepare'&&overrides.prepare)return overrides.prepare(path,options);
    if (path.endsWith('/connect')) { if (overrides.connect) return overrides.connect(path, options); status.connected = true; return { token: 'thot_or_private_proxy_fixture', shown_once: true }; }
    if (path.endsWith('/disconnect')) { if (overrides.disconnect) return overrides.disconnect(path, options); status.connected = false; return { connected: false }; }
    if (overrides.status) return overrides.status(path, options); return structuredClone(status);
  };
  const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const context = { location: { origin: 'https://thot.example.test' }, navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } }, Date, Error, console: { log() { throw Error('credentials must never be logged'); } }, globalThis: {} };
  for (const storage of ['localStorage', 'sessionStorage']) Object.defineProperty(context, storage, { get() { throw Error('credentials must never enter browser persistence'); } });
  runInNewContext(source.replace('export function createOpenRouterUI', 'function createOpenRouterUI') + '\nglobalThis.factory = createOpenRouterUI;', context);
  const ui = context.globalThis.factory({ state, api, openDialog, dialog, escape, toast: value => messages.push(value), refresh: async () => {}, getProvider:()=>overrides.provider });
  const form = () => fields.get('#openrouter-connect-form');
  const fill = () => { fields.get('#openrouter-api-key').value = 'sk-or-provider_private_fixture'; fields.get('#openrouter-recording-consent').checked = true; return form(); };
  return { ui, state, dialog, fields, calls, dialogs, messages, clipboard, form, fill, status, policies, replaceDialog: () => openDialog('Another view', 'Current view', '<p>Other private task</p>') };
}
const next = () => new Promise(resolve => setImmediate(resolve));

test('OpenRouter UI needs explicit recording consent and sends only its displayed notice version', async () => {
  const a = fixture(); await a.ui.handle('openrouter-open');
  assert.match(a.dialogs[0].html, /id="openrouter-recording-consent"[^>]*required/);
  a.fields.get('#openrouter-api-key').value = 'sk-or-provider_private_fixture';
  await a.form().submit(); assert.equal(a.calls.filter(call => call.path.endsWith('/connect')).length, 0);
  a.fields.get('#openrouter-recording-consent').checked = true; await a.form().submit();
  const sent = a.calls.find(call => call.path.endsWith('/connect'));
  assert.equal(sent.options.body.api_key, 'sk-or-provider_private_fixture'); assert.equal(sent.options.body.recording_consent, true); assert.equal(sent.options.body.notice_version, 'notice-1');
  assert.match(a.dialogs[0].html, /does not authorize a sale/);
});

test('OpenRouter secrets are assigned as password input values and scrubbed on dialog close', async () => {
  const a = fixture(); await a.ui.handle('openrouter-open'); const form = a.fill(), oldKey = form.querySelector('#openrouter-api-key');
  await form.submit(); assert.equal(oldKey.value, '');
  assert.equal(a.fields.get('#openrouter-proxy').value, 'thot_or_private_proxy_fixture');
  assert.equal(a.fields.get('#openrouter-base').value, 'https://thot.example.test/v1/openrouter');
  const markup = JSON.stringify(a.dialogs); for (const secret of ['sk-or-provider_private_fixture', 'thot_or_private_proxy_fixture']) { assert.ok(!markup.includes(secret)); assert.ok(!JSON.stringify(a.messages).includes(secret)); }
  assert.match(a.dialogs.at(-1).html, /id="openrouter-proxy" type="password" readonly autocomplete="off"/);
  await a.ui.handle('openrouter-copy'); assert.deepEqual(a.clipboard, ['thot_or_private_proxy_fixture']);
  a.dialog.close(); assert.equal(a.fields.get('#openrouter-proxy').value, '');
  await assert.rejects(a.ui.handle('openrouter-copy'), /Reconnect/);
});

test('OpenRouter connected state offers revocation without exposing previously issued proxy credentials', async () => {
  const a = fixture(); a.status.connected = true; await a.ui.handle('openrouter-open');
  assert.match(a.dialogs[0].html, /Disconnect provider & proxy key/); assert.match(a.dialogs[0].html, /shown once/); assert.equal(a.fields.get('#openrouter-proxy'), undefined);
  await a.ui.handle('openrouter-disconnect'); assert.ok(a.calls.some(call => call.path.endsWith('/disconnect'))); assert.ok(a.form());
  assert.match(a.messages.at(-1), /Signed sale policies remain/);
});

test('OpenRouter successful uppercase relay status is shown as a vault trace and untrusted model text is escaped', async () => {
  const a = fixture(); a.status.requests = [{ model: '<img src=x onerror=evil()>', status: 'COMPLETED', created_at: '2026-09-15T01:00:00Z', content_deleted: false }];
  await a.ui.handle('openrouter-open'); assert.match(a.dialogs[0].html, /In your vault/); assert.doesNotMatch(a.dialogs[0].html, /<img src=x/); assert.match(a.dialogs[0].html, /&lt;img/);
});

test('OpenRouter contributor actions reject buyer/operator roles before network or clipboard activity', async () => {
  for (const role of ['operator_security', 'buyer_admin']) {
    const a = fixture(); a.state.role = role;
    for (const action of ['openrouter-open', 'openrouter-disconnect', 'openrouter-copy']) await assert.rejects(a.ui.handle(action), /contributor|account/i);
    assert.equal(a.calls.length, 0); assert.equal(a.clipboard.length, 0);
  }
});

test('a stale OpenRouter form cannot send its provider key under a replacement account', async () => {
  const a = fixture(); await a.ui.handle('openrouter-open'); const form = a.fill();
  a.state.actor = { id: 'bob' }; a.state.generation++;
  await assert.doesNotReject(form.submit());
  assert.ok(!a.calls.some(call => call.path.endsWith('/connect'))); assert.equal(a.dialogs.length, 1);
});

test('a replaced or closed OpenRouter form cannot submit or reveal a delayed proxy credential', async () => {
  const a = fixture(); await a.ui.handle('openrouter-open'); const oldForm = a.fill();
  await a.ui.handle('openrouter-open'); await assert.doesNotReject(oldForm.submit());
  assert.ok(!a.calls.some(call => call.path.endsWith('/connect')));
  let release; const b = fixture({ connect: () => new Promise(resolve => { release = resolve; }) });
  await b.ui.handle('openrouter-open'); const pending = b.fill().submit(); await next(); b.dialog.close();
  release({ token: 'thot_or_late_private_token', shown_once: true }); await assert.doesNotReject(pending);
  assert.equal(b.dialogs.length, 1); assert.ok(!JSON.stringify(b.messages).includes('late_private_token'));
});

test('OpenRouter one-time-key creation is single-flight even if a second submit event is dispatched', async () => {
  let release; const a = fixture({ connect: () => new Promise(resolve => { release = resolve; }) });
  await a.ui.handle('openrouter-open'); const form = a.fill(), pending = form.submit(); await next();
  a.fields.get('#openrouter-api-key').value = 'sk-or-provider_private_fixture'; await form.submit();
  assert.equal(a.calls.filter(call => call.path.endsWith('/connect')).length, 1);
  release({ token: 'thot_or_one_time_token', shown_once: true }); await pending;
});

test('OpenRouter disabled deployment shows status and never requests provider credentials', async () => {
  const a = fixture(); a.status.enabled = false; await a.ui.handle('openrouter-open');
  assert.match(a.dialogs[0].html, /not enabled/); assert.equal(a.form(), undefined);
  assert.equal(await a.ui.handle('unrelated-action'), false);
});

test('a late OpenRouter connection cannot replace an unrelated dialog opened while it was pending', async () => {
  let release; const a = fixture({ connect: () => new Promise(resolve => { release = resolve; }) });
  await a.ui.handle('openrouter-open'); const pending = a.fill().submit(); await next();
  a.replaceDialog(); release({ token: 'thot_or_late_private_token', shown_once: true }); await pending;
  assert.equal(a.dialogs.length, 2); assert.equal(a.dialogs.at(-1).title, 'Another view'); assert.equal(a.fields.get('#openrouter-proxy'), undefined);
});

test('a newer OpenRouter status view invalidates an older response from the same account', async () => {
  let release, count = 0;
  const fresh = { enabled: true, connected: true, notice_version: 'notice-1', notice: 'Current notice', requests: [] };
  const a = fixture({ status: () => ++count === 1 ? new Promise(resolve => { release = resolve; }) : structuredClone(fresh) });
  const old = a.ui.handle('openrouter-open'); await next(); await a.ui.handle('openrouter-open');
  release({ ...fresh, connected: false }); await old.catch(() => {});
  assert.equal(a.dialogs.length, 1); assert.match(a.dialogs[0].html, /Disconnect provider & proxy key/);
});

test('logout clears OpenRouter credentials before a stale copy action can reach the clipboard', async () => {
  const a = fixture(); await a.ui.handle('openrouter-open'); await a.fill().submit();
  a.ui.reset(); a.state.actor = null; a.state.generation++;
  await assert.rejects(a.ui.handle('openrouter-copy'), /contributor/); assert.equal(a.clipboard.length, 0); assert.equal(a.fields.get('#openrouter-proxy').value, '');
});

test('a supported connection signs one scoped policy before sending the provider key',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),walletCalls=[];
 const provider={async request(input){walletCalls.push(input);if(input.method==='eth_accounts')return [wallet];if(input.method==='eth_chainId')return '0x7a69';if(input.method==='eth_signTypedData_v4')return '0x'+'3'.repeat(130);throw Error('Unexpected wallet method');}};
 const a=fixture({provider,prepare:async()=>({id:'stream:one',typed_data:{domain:{chainId:31337,verifyingContract:market},message:{seller:wallet}}})});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};await a.ui.handle('openrouter-open');
 assert.match(a.dialogs[0].html,/subsequent traces only/);assert.match(a.dialogs[0].html,/including model outputs/);assert.match(a.dialogs[0].html,/asking price, not an assay estimate/);assert.match(a.dialogs[0].html,/one complete approved release from each stable group of 20/);
 await a.fill().submit();const connect=a.calls.find(call=>call.path.endsWith('/connect'));
 const prepared=a.calls.find(call=>call.path==='/v1/thot/streams/prepare').options.body;assert.equal(prepared.price_thot,'100');assert.equal(prepared.treasury_sampling_opt_in,false);
 assert.equal(walletCalls.filter(c=>c.method==='eth_signTypedData_v4').length,1);assert.equal(connect.options.body.sale_policy_id,'stream:one');assert.equal(connect.options.body.rights_confirmed,true);assert.equal(connect.options.body.model_output_licensed,true);
 assert.match(a.dialogs.at(-1).html,/No per-trace signing/);
});

test('OpenRouter reserve sampling is separately optional and sent only when checked',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40);
 const provider={async request(input){if(input.method==='eth_accounts')return [wallet];if(input.method==='eth_chainId')return '0x7a69';if(input.method==='eth_signTypedData_v4')return '0x'+'3'.repeat(130);throw Error('Unexpected wallet method');}};
 const a=fixture({provider,prepare:async()=>({id:'stream:one',typed_data:{domain:{chainId:31337,verifyingContract:market},message:{seller:wallet}}})});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};await a.ui.handle('openrouter-open');a.fields.get('#openrouter-treasury-consent').checked=true;await a.fill().submit();
 const prepared=a.calls.find(call=>call.path==='/v1/thot/streams/prepare').options.body;assert.equal(prepared.price_thot,'100');assert.equal(prepared.treasury_sampling_opt_in,true);
});

test('connection signer/domain mismatch cannot send a provider key or signed sale policy',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),calls=[];
 const provider={async request(input){calls.push(input);return input.method==='eth_accounts'?[wallet]:'0x7a69';}};
 const a=fixture({provider,prepare:async()=>({id:'stream:wrong',typed_data:{domain:{chainId:1,verifyingContract:market},message:{seller:wallet}}})});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};await a.ui.handle('openrouter-open');await a.fill().submit();
 assert.equal(a.calls.filter(c=>c.path.endsWith('/connect')).length,0);assert.equal(calls.filter(c=>c.method==='eth_signTypedData_v4').length,0);assert.match(a.messages.at(-1),/does not match/);
});

test('a signed sale policy remains visible after proxy disconnect and can be stopped and revoked from the seller wallet',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),hash='0x'+'3'.repeat(64),walletCalls=[];
 const provider={async request(input){walletCalls.push(input);if(input.method==='eth_accounts')return [wallet];if(input.method==='eth_chainId')return '0x7a69';if(input.method==='eth_sendTransaction')return hash;if(input.method==='eth_getTransactionReceipt')return {transactionHash:hash,status:'0x1'};throw Error('Unexpected wallet method');}};
 const a=fixture({provider,market,policies:[{id:'stream:one',price_thot:'100',valid_until:Math.floor(Date.now()/1000)+86400,offchain_revoked:false,onchain_revoked:false}]});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};a.status.connected=true;a.status.sale_policy_id='stream:one';
 await a.ui.handle('openrouter-open');assert.match(a.dialogs.at(-1).html,/Stop new offers/);
 await a.ui.handle('openrouter-disconnect');assert.match(a.dialogs.at(-1).html,/Stop new offers/);assert.equal(a.status.connected,false);
 assert.equal(a.calls.filter(c=>c.path==='/v1/thot/streams/revoke').length,0,'disconnect alone does not pretend to revoke sale rights');
 const button={dataset:{id:'stream:one'}};await a.ui.handle('openrouter-stop-policy',button);
 assert.equal(a.policies[0].offchain_revoked,true);assert.match(a.dialogs.at(-1).html,/Confirm wallet revocation/);assert.equal(walletCalls.length,0);
 await a.ui.handle('openrouter-chain-revoke',button);
 const sent=walletCalls.find(c=>c.method==='eth_sendTransaction');assert.equal(sent.params[0].to,market);assert.equal(sent.params[0].from,wallet);
 assert.match(a.messages.at(-1),/Wait for chain finality/);
 a.policies[0].onchain_revoked=true;await a.ui.handle('openrouter-open');assert.match(a.dialogs.at(-1).html,/revoked on chain/);assert.doesNotMatch(a.dialogs.at(-1).html,/Confirm wallet revocation/);
});

test('an unrelated wallet cannot submit a stream-policy revocation, but app-level offers stay stopped',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),walletCalls=[];
 const provider={async request(input){walletCalls.push(input);if(input.method==='eth_accounts')return ['0x'+'4'.repeat(40)];throw Error('Unexpected wallet call');}};
 const a=fixture({provider,market,policies:[{id:'stream:one',price_thot:'100',valid_until:Math.floor(Date.now()/1000)+86400,offchain_revoked:true,onchain_revoked:false}]});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};
 await a.ui.handle('openrouter-open');await assert.rejects(a.ui.handle('openrouter-chain-revoke',{dataset:{id:'stream:one'}}),/linked seller wallet/);
 assert.equal(a.policies[0].offchain_revoked,true);assert.equal(walletCalls.some(c=>c.method==='eth_sendTransaction'),false);
});

test('a delayed revocation receipt checks the submitted hash without sending another transaction',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),hash='0x'+'3'.repeat(64),walletCalls=[];let found=false;
 const provider={async request(input){walletCalls.push(input);if(input.method==='eth_accounts')return [wallet];if(input.method==='eth_chainId')return '0x7a69';if(input.method==='eth_sendTransaction')return hash;if(input.method==='eth_getTransactionReceipt')return found?{transactionHash:hash,status:'0x1'}:null;throw Error('Unexpected wallet method');}};
 const a=fixture({provider,market,policies:[{id:'stream:one',price_thot:'100',valid_until:Math.floor(Date.now()/1000)+86400,offchain_revoked:true,onchain_revoked:false}]});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};
 const button={dataset:{id:'stream:one'}};await a.ui.handle('openrouter-open');
 await assert.rejects(a.ui.handle('openrouter-chain-revoke',button),/not confirmed yet/);
 found=true;await a.ui.handle('openrouter-chain-revoke',button);
 assert.equal(walletCalls.filter(c=>c.method==='eth_sendTransaction').length,1);assert.equal(walletCalls.filter(c=>c.method==='eth_getTransactionReceipt').length,2);
});

test('wallet revocation rejects a transaction targeting any other market operation',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),walletCalls=[];
 const provider={async request(input){walletCalls.push(input);throw Error('No wallet action should be requested');}};
 const a=fixture({provider,policies:[{id:'stream:one',price_thot:'100',valid_until:Math.floor(Date.now()/1000)+86400,offchain_revoked:true,onchain_revoked:false}],revoke:async()=>({revoked:true,transactions:[{to:market,data:'0xdeadbeef'+'a'.repeat(64),value:'0x0',chainId:'0x7a69'}]})});
 a.state.thot={wallet,capabilities:{stream_sales:true,chain_id:31337,market}};
 await a.ui.handle('openrouter-open');await assert.rejects(a.ui.handle('openrouter-chain-revoke',{dataset:{id:'stream:one'}}),/does not match this THOT market/);
 assert.equal(walletCalls.length,0);
});
