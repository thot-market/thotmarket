const NETWORKS = {
  31337: {chainId: '0x7a69', chainName: 'Private Anvil', nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18}},
  46630: {chainId: '0xb626', chainName: 'Robinhood Chain Testnet', nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18}, rpcUrls: ['https://rpc.testnet.chain.robinhood.com'], blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com']},
  4663: {chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18}, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com']}
};

/** Cookie-based EVM sign-in: never persists a bearer token in browser storage. */
export function createWalletAuth({ window, fetch, chainId = 46630, rpcUrl = 'https://rpc.testnet.chain.robinhood.com', onSession, onSignedIn, onSignedOut = () => {}, onIdentityChanging, onSessionChanging, onError = () => {}, additionalProviders = async () => [], requestTimeoutMs = 15000, providerTimeoutMs = 5000, additionalProvidersTimeoutMs = 30000 }) {
  let rpc; try {rpc=new URL(rpcUrl);} catch {}
  const definition = NETWORKS[chainId];
  if (!definition || rpc?.protocol !== 'https:' || chainId === 4663 && rpc.href !== 'https://rpc.mainnet.chain.robinhood.com/') throw new Error('Wallet login is not configured for this network.');
  const network={...definition,rpcUrls:[rpc.href]};
  const sessionReady = onSession ?? onSignedIn ?? (() => {}), changing = onIdentityChanging ?? onSessionChanging ?? (() => {});
  let provider = null, listeners = [], epoch = 0, busy = false, destroyed = false, busyEpoch = null, busyKind = null;
  const current = expected => { if (destroyed || expected !== epoch) throw new Error('The wallet changed during sign-in. Please try again.'); };

  function availableProviders() {
    return [...new Set([...(window.ethereum?.providers ?? []), window.ethereum, window.phantom?.ethereum].filter(p => typeof p?.request === 'function'))];
  }
  function select(kind) {
    const providers = availableProviders();
    const found = kind === 'phantom' ? window.phantom?.ethereum ?? providers.find(p => p.isPhantom)
      : kind === 'metamask' ? providers.find(p => p.isMetaMask && !p.isPhantom)
      : kind === 'injected' ? window.ethereum ?? providers[0] : null;
    if (typeof found?.request !== 'function') throw new Error(kind === 'phantom' ? 'Enable an EVM account in Phantom. A Solana-only wallet cannot sign in here.' : 'Open an EVM wallet such as MetaMask and try again.');
    return found;
  }
  async function bounded(promise, milliseconds, message, abort = () => {}) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => {abort(); reject(new Error(message));}, milliseconds);})]); }
    finally {clearTimeout(timer);}
  }
  async function api(path, body) {
    const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (path.endsWith('/revoke')) init.headers['Idempotency-Key'] = window.crypto.randomUUID();
    const controller = new AbortController(); init.signal = controller.signal;
    return bounded((async () => {const response = await fetch(path, init), result = await response.json().catch(() => ({})); return {response, result};})(), requestTimeoutMs,
      'Wallet authentication took too long. Retry sign-in; no session has been accepted here.', () => controller.abort());
  }
  async function revokeRemote() {
    const { response } = await api('/v1/auth/session/revoke', {});
    if (!response.ok && response.status !== 401) throw new Error('The previous session could not be signed out. Please retry before switching wallets.');
  }
  function detach() { for (const [event, callback] of listeners) provider?.removeListener?.(event, callback); listeners = []; provider = null; }
  function attach(next) {
    detach(); provider = next;
    const invalidate = () => { ++epoch; changing(); void revokeRemote().then(() => onSignedOut()).catch(onError); };
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) { provider.on?.(event, invalidate); listeners.push([event, invalidate]); }
  }
  async function context(p, expected, wallet) {
    current(expected);
    const accounts = await p.request({ method: 'eth_accounts' }); current(expected);
    if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== wallet.toLowerCase()) throw new Error('The selected wallet account changed. Please sign in again.');
    const chain = await p.request({ method: 'eth_chainId' }); current(expected);
    if (Number(chain) !== chainId) throw new Error(`Select ${network.chainName} to sign in.`);
  }
  async function ensureChain(p, expected) {
    const chain = await p.request({ method: 'eth_chainId' }); current(expected);
    if (Number(chain) === chainId) return;
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] }); }
    catch (error) { current(expected); if (Number(error?.code) !== 4902) throw error; await p.request({ method: 'wallet_addEthereumChain', params: [network] }); await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] }); }
    current(expected);
    if (Number(await p.request({ method: 'eth_chainId' })) !== chainId) throw new Error(`Select ${network.chainName} to sign in.`);
    current(expected);
  }
  function validateChallenge(value, wallet) {
    const origin = window.location.origin;
    if (!origin.startsWith('https://') || typeof value.message !== 'string' || value.message.length > 2048 || !/^[0-9a-f]{32}$/.test(value.id ?? '') || value.address?.toLowerCase() !== wallet.toLowerCase() || value.chain_id !== chainId
      || !value.message.startsWith(`${origin} wants you to sign in with your Ethereum account:\n${value.address}\n\n`)
      || !value.message.includes(`\nURI: ${origin}/app\nVersion: 1\nChain ID: ${chainId}\nNonce: `) || !value.message.endsWith(`\nRequest ID: ${value.id}`)) throw new Error('The sign-in challenge does not match this site, wallet, or network.');
  }
  const sessionValue = result => ({ actor: result.actor, permissions: result.permissions ?? {}, token: null, authMode: 'wallet_siwe', wallet_address: result.wallet_address, chain_id: chainId });
  function validateSession(result, wallet) {
    if (!result.actor?.id || !result.actor?.role || result.chain_id !== chainId || result.wallet_address?.toLowerCase() !== wallet.toLowerCase()) throw new Error('The signed-in account does not match the selected wallet.');
  }
  async function signIn(kind = 'injected', suppliedProvider = null, expectedAddress = null) {
    if (busy || destroyed) return false;
    busy = true; const expected = ++epoch; busyEpoch = expected; busyKind = 'sign-in'; changing(); detach();
    try {
      await revokeRemote(); current(expected);
      const next = suppliedProvider ?? select(kind);
      if (typeof next?.request !== 'function') throw new Error('The wallet provider is unavailable.');
      const accounts = await next.request({ method: 'eth_requestAccounts' }); current(expected);
      const wallet = accounts?.[0]; if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Choose an EVM wallet account.');
      if (expectedAddress && wallet.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('The wallet provider returned a different account. Please choose your wallet again.');
      await ensureChain(next, expected); attach(next); await context(next, expected, wallet);
      const challenge = await api('/v1/auth/wallet/challenge', { address: wallet, chain_id: chainId }); current(expected);
      if (!challenge.response.ok) throw new Error(challenge.result.error === 'AUTH_CHALLENGE_RATE_LIMIT' ? 'Too many sign-in attempts. Wait a minute and try again.' : 'A sign-in challenge could not be created.');
      validateChallenge(challenge.result, wallet); await context(next, expected, wallet);
      const bytes = new TextEncoder().encode(challenge.result.message), hex = '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      const signature = await next.request({ method: 'personal_sign', params: [hex, wallet] });
      await context(next, expected, wallet);
      const verified = await api('/v1/auth/wallet/verify', { id: challenge.result.id, message: challenge.result.message, signature }); current(expected);
      if (!verified.response.ok) throw new Error(verified.result.error === 'WALLET_ALREADY_BOUND' ? 'This wallet belongs to an existing thot market account. Use that account to sign in; wallet sign-in will not copy its private traces.' : 'Wallet verification failed. Please try signing in again.');
      validateSession(verified.result, wallet); await context(next, expected, wallet);
      await sessionReady(sessionValue(verified.result)); return true;
    } catch (error) {
      // A verification can finish after a provider change/logout. Clear that late cookie too.
      try { await revokeRemote(); } catch (cleanupError) { onError(cleanupError); }
      if (!destroyed) { await onSignedOut(); onError(error); } return false;
    } finally { if (busyEpoch === expected) {busy = false; busyEpoch = null; busyKind = null;} }
  }
  async function restore() {
    if (busy || destroyed) return false;
    busy = true; const expected = ++epoch; busyEpoch = expected; busyKind = 'restore'; changing({restoring: true});
    try {
      const { response, result } = await api('/v1/auth/session'); current(expected);
      if (response.status === 401) { await onSignedOut(); return false; }
      if (!response.ok) throw new Error('The wallet session could not be restored.');
      let selected = null;
      const match = async candidates => {
        for (const candidate of [...new Set(candidates)]) {
          try {
            const accounts = await bounded(candidate.request({method: 'eth_accounts'}), providerTimeoutMs, 'Wallet provider did not respond.'); current(expected);
            const chain = await bounded(candidate.request({method: 'eth_chainId'}), providerTimeoutMs, 'Wallet provider did not respond.'); current(expected);
            if (accounts?.[0]?.toLowerCase() === result.wallet_address?.toLowerCase() && Number(chain) === chainId) return candidate;
          } catch (error) {current(expected);}
        }
        return null;
      };
      // Anonymous and injected-wallet restores never download the optional SDK.
      selected = await match(availableProviders()); current(expected);
      if (!selected) {
        const extra = await bounded(additionalProviders(result.wallet_address), additionalProvidersTimeoutMs, 'Email wallet restoration took too long. Retry sign-in.'); current(expected);
        selected = await match(extra); current(expected);
      }
      if (!selected) { await revokeRemote(); current(expected); await onSignedOut(); return false; }
      validateSession(result, result.wallet_address); attach(selected); await bounded(context(selected, expected, result.wallet_address), providerTimeoutMs, 'Wallet provider did not respond. Retry sign-in.'); current(expected);
      await sessionReady(sessionValue(result)); return true;
    } catch (error) { if (!destroyed && expected === epoch) { await onSignedOut(); onError(error); } return false; }
    finally { if (busyEpoch === expected) {busy = false; busyEpoch = null; busyKind = null;} }
  }
  async function signOut() { ++epoch; if (busyKind === 'restore') {busy = false; busyEpoch = null; busyKind = null;} changing(); detach(); try { await revokeRemote(); } finally { if (!destroyed) await onSignedOut(); } }
  function destroy() { ++epoch; destroyed = true; detach(); }
  return { signIn, signInProvider: (next, address) => signIn('provided', next, address), restore, signOut, destroy, getProvider: () => provider, providers: () => ({ metamask: availableProviders().some(p => p.isMetaMask && !p.isPhantom), phantom: availableProviders().some(p => p.isPhantom) || typeof window.phantom?.ethereum?.request === 'function', injected: availableProviders().length > 0 }) };
}
