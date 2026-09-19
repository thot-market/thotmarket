/** Read-only chain telemetry; never sends a transaction or returns RPC credentials. */
export function createChainObserver(fetcher: typeof fetch = fetch) {
  let key: string | undefined, expires = 0;
  let pending: Promise<ChainObservation> | undefined;
  return (capabilities: Record<string, unknown>): Promise<ChainObservation> => {
    const base = { id: 'chain' as const, observed_at: new Date().toISOString(), source: 'configured-chain-rpc' as const };
    if (capabilities.mode === 'unconfigured') return Promise.resolve({ ...base, status: 'unconfigured', reason: 'Chain is not configured.' });
    let url: URL;
    try {
      if (typeof capabilities.rpc_url !== 'string') throw Error();
      url = new URL(capabilities.rpc_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !Number.isSafeInteger(capabilities.chain_id)) throw Error();
    } catch { return Promise.resolve({ ...base, status: 'unavailable', reason: 'Chain observation configuration is unavailable.' }); }
    const currentKey = url.href + ':' + capabilities.chain_id;
    if (pending && key === currentKey && Date.now() < expires) return pending;
    key = currentKey; expires = Date.now() + 10_000;
    pending = (async (): Promise<ChainObservation> => {
      try {
        const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] }]) });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(); }
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 4096) throw Error(); chunks.push(chunk); }
        const results = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(results) || results.length !== 2 || new Set(results.map(row => row?.id)).size !== 2) throw Error();
        const get = (id: number) => {
          const row = results.find(row => row?.id === id);
          if (row?.jsonrpc !== '2.0' || row.error !== undefined || typeof row.result !== 'string' || !/^0x[0-9a-fA-F]{1,32}$/.test(row.result)) throw Error();
          return BigInt(row.result);
        };
        const chainId = get(1), blockNumber = get(2);
        if (chainId !== BigInt(capabilities.chain_id as number)) return { ...base, status: 'unavailable', reason: 'Observed chain ID differs from configured chain ID.' };
        return { ...base, status: 'observed', metrics: { chain_id: chainId.toString(), block_number: blockNumber.toString() } };
      } catch { return { ...base, status: 'unavailable', reason: 'Chain RPC timed out or returned invalid telemetry.' }; }
    })();
    return pending;
  };
}
export interface ChainObservation {
  id: 'chain'; status: 'observed' | 'unconfigured' | 'unavailable'; observed_at: string;
  source: 'configured-chain-rpc'; reason?: string; metrics?: { chain_id: string; block_number: string };
}
export const observeChain = createChainObserver();
