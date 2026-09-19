/** Selection is explicit: never turn an unrelated connected wallet into a private account. */
export function eligiblePrivyWallets(user, wallets) {
  const linked = new Set((user?.linkedAccounts ?? []).filter(a => a.type === 'wallet' && a.chainType === 'ethereum').map(a => a.address?.toLowerCase()));
  const seen = new Set();
  return (wallets ?? []).filter(wallet => {
    const address = wallet?.address?.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address ?? '') || !linked.has(address) || seen.has(address) || typeof wallet.getEthereumProvider !== 'function') return false;
    seen.add(address); return true;
  });
}

export function selectPrivyWallet(user, wallets, address = null) {
  const eligible = eligiblePrivyWallets(user, wallets);
  if (address) {
    const selected = eligible.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (!selected) throw new Error('That wallet is not connected to this Privy account.');
    return selected;
  }
  if (eligible.length !== 1) return null;
  return eligible[0];
}

export function validatePrivyConfig(config) {
  let rpc; try {rpc = new URL(config?.rpc_url);} catch {}
  if (!config || !/^[a-z0-9]{20,64}$/.test(config.app_id ?? '') || config.client_id && !/^[a-z0-9_-]{10,100}$/i.test(config.client_id) || ![31337, 46630].includes(config.chain_id) || rpc?.protocol !== 'https:') throw new Error('Privy login is not configured for this application.');
  return {appId: config.app_id, ...(config.client_id ? {clientId: config.client_id} : {}), chainId: config.chain_id, rpcUrl: rpc.href};
}
