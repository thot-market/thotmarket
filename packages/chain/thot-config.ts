import { readFile } from 'node:fs/promises';
import type { ThotChainConfig } from './thot.ts';
import { ensure } from '../storage/src/index.ts';

/** Same public chain file as the API. Invalid configured files never silently disable THOT. */
export async function loadThotChainConfig(path: string | undefined): Promise<ThotChainConfig | undefined> {
  if (path === undefined) return undefined;
  try {
    ensure(path.length > 0, 'INVALID_THOT_CHAIN_CONFIG');
    const raw = await readFile(path, 'utf8');
    ensure(Buffer.byteLength(raw) <= 32_000, 'INVALID_THOT_CHAIN_CONFIG');
    const value = JSON.parse(raw);
    ensure(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_THOT_CHAIN_CONFIG');
    // Signers belong to the runtime, never to a shareable deployment manifest.
    ensure(!Object.keys(value).some(key => /private.?key|secret|mnemonic|operatorSigner/i.test(key)), 'INVALID_THOT_CHAIN_CONFIG');
    ensure(value.mode === undefined || value.mode === 'local-anvil' || value.mode === 'robinhood-testnet' || value.mode === 'production', 'INVALID_THOT_CHAIN_CONFIG');
    for (const key of ['rpcUrl', 'token', 'market', 'locks', 'reserve']) ensure(typeof value[key] === 'string' && value[key].length > 0, 'INVALID_THOT_CHAIN_CONFIG');
    for (const key of ['chainId', 'confirmations', 'deploymentBlock']) ensure(Number.isSafeInteger(value[key]), 'INVALID_THOT_CHAIN_CONFIG');
    ensure(value.codeHashes && typeof value.codeHashes === 'object' && !Array.isArray(value.codeHashes), 'INVALID_THOT_CHAIN_CONFIG');
    for (const key of ['token', 'market', 'locks', 'reserve']) ensure(typeof value.codeHashes[key] === 'string' && /^0x[\da-f]{64}$/i.test(value.codeHashes[key]), 'INVALID_THOT_CHAIN_CONFIG');
    // createApplication -> ThotChain.guard validates network, addresses, bytecode and bindings.
    return value as ThotChainConfig;
  } catch { throw new Error('INVALID_THOT_CHAIN_CONFIG'); }
}
