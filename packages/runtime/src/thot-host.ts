import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { FetchRequest, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { ROBINHOOD_TESTNET_CHAIN_ID, ROBINHOOD_TESTNET_RPC, type ThotChainConfig } from '../../chain/thot.ts';
import { strictJson, type AuthProvider, type MembershipInput } from '../../auth/src/index.ts';
import { validateActor } from '../../auth/src/access.ts';
import { canonicalHash, canonicalJson } from '../../protocol/src/index.ts';
import type { Database } from '../../storage/src/index.ts';

export type ThotHostConfiguration = {
  thot?: ThotChainConfig;
  bind: string;
  publicOrigin?: string;
  authConfigured: boolean;
  masterKeySource?: string;
  operatorKeyFile?: string;
  operatorKeyEnvPresent?: boolean;
  readOnly?: boolean;
  privateAnvil?: boolean;
  walletAuthConfigured?: boolean;
};

const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);

/** A public testnet UI must never expose the development role selector or local vault key. */
function validateProductionTarget(config: ThotChainConfig) {
  if (config.mode !== 'production') return;
  if (config.chainId !== 4663 || config.rpcUrl !== 'https://rpc.mainnet.chain.robinhood.com' ||
      !config.percentageFees || !config.sharedTreasury || config.governanceKind !== 'safe' ||
      !config.governor || !config.feeDiscounts || !config.staking || config.confirmations < 2 || config.localDeliverySigner)
    throw Error('THOT_PRODUCTION_CONFIGURATION_REQUIRED');
}

export function validateThotHost(config: ThotHostConfiguration): { hosted: boolean } {
  let origin: URL | undefined;
  if (config.publicOrigin !== undefined) {
    try { origin = new URL(config.publicOrigin); } catch { throw Error('INVALID_PUBLIC_ORIGIN'); }
    if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== config.publicOrigin || origin.username || origin.password) throw Error('INVALID_PUBLIC_ORIGIN');
  }
  const hosted = !loopback(config.bind) || !!(origin && !loopback(origin.hostname));
  if(config.readOnly) {
    if(!hosted||!config.thot||config.thot.mode!=='robinhood-testnet'||config.privateAnvil||config.operatorKeyFile!==undefined||config.operatorKeyEnvPresent)throw Error('THOT_READ_ONLY_CONFIGURATION_REQUIRED');
  }
  // Network exposure, not the presence of a chain manifest, defines this boundary.
  if (!config.thot) {
    if (config.privateAnvil) throw Error('PRIVATE_ANVIL_CONFIGURATION_REQUIRED');
    if (config.operatorKeyFile !== undefined) throw Error('THOT_SIGNER_WITHOUT_CONFIG');
    if (hosted) throw Error('HOSTED_THOT_CONFIGURATION_REQUIRED');
    return { hosted: false };
  }
  if (config.privateAnvil) {
    if (config.thot.mode !== 'local-anvil' || config.thot.chainId !== 31337 || config.thot.rpcUrl !== 'http://127.0.0.1:8545' || !loopback(config.bind) || config.operatorKeyFile !== undefined || !config.thot.localDeliverySigner) throw Error('PRIVATE_ANVIL_CONFIGURATION_REQUIRED');
    if (!config.walletAuthConfigured || !config.authConfigured) throw Error('PRIVATE_ANVIL_WALLET_AUTH_REQUIRED');
    if (config.masterKeySource !== 'dstack') throw Error('HOSTED_THOT_DSTACK_REQUIRED');
    if (!origin || origin.protocol !== 'https:' || loopback(origin.hostname)) throw Error('HOSTED_THOT_HTTPS_ORIGIN_REQUIRED');
  } else if (hosted || config.operatorKeyFile !== undefined) {
    validateProductionTarget(config.thot);
    if (config.thot.mode !== 'production' && (config.thot.mode !== 'robinhood-testnet' || config.thot.chainId !== ROBINHOOD_TESTNET_CHAIN_ID || config.thot.rpcUrl !== ROBINHOOD_TESTNET_RPC)) throw Error('ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED');
    if (!config.readOnly && (!config.operatorKeyFile || !isAbsolute(config.operatorKeyFile))) throw Error('TESTNET_OPERATOR_KEY_FILE_REQUIRED');
  }
  if (hosted) {
    if (!config.authConfigured) throw Error('HOSTED_THOT_AUTH_REQUIRED');
    if (config.masterKeySource !== 'dstack') throw Error('HOSTED_THOT_DSTACK_REQUIRED');
    if (!origin || origin.protocol !== 'https:' || loopback(origin.hostname)) throw Error('HOSTED_THOT_HTTPS_ORIGIN_REQUIRED');
  }
  return { hosted };
}

/** Read only the explicitly configured regular private file. Never return a key in an error. */
export async function loadTestnetOperatorWallet(path: string): Promise<Wallet> {
  let handle;
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) throw Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 64 || stat.size > 256 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw Error();
    const key = (await handle.readFile('utf8')).trim();
    if (!/^0x[0-9a-f]{64}$/i.test(key)) throw Error();
    return new Wallet(key);
  } catch { throw Error('TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE'); }
  finally { await handle?.close(); }
}

function publicTestnetProvider(rpcUrl: string) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = 20_000;
  request.setThrottleParams({ maxAttempts: 3, slotInterval: 1000 });
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 5000;
  return provider;
}

/** The runtime signer is separate from the chain manifest and owned by this process. */
export async function createTestnetOperatorRuntime(config: ThotChainConfig | undefined, keyFile: string | undefined,
  providerFactory: (rpcUrl: string) => JsonRpcProvider = publicTestnetProvider): Promise<{ signer?: Wallet; close(): Promise<void> }> {
  if (keyFile === undefined) return { close: async () => {} };
  if (!config || (config.mode !== 'production' && (config.mode !== 'robinhood-testnet' || config.chainId !== ROBINHOOD_TESTNET_CHAIN_ID || config.rpcUrl !== ROBINHOOD_TESTNET_RPC)) || config.localDeliverySigner) throw Error('ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED');
  validateProductionTarget(config);
  const wallet = await loadTestnetOperatorWallet(keyFile);
  try { if (wallet.address !== getAddress(config.operatorAddress!)) throw Error(); }
  catch { throw Error('TESTNET_OPERATOR_ADDRESS_MISMATCH'); }
  let provider: JsonRpcProvider | undefined, closed = false;
  const close = async () => { if (!closed) { closed = true; await provider?.destroy(); } };
  try {
    provider = providerFactory(config.rpcUrl);
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw Error('ROBINHOOD_TESTNET_CHAIN_MISMATCH');
    return { signer: wallet.connect(provider), close };
  } catch (error) {
    await close();
    if (error instanceof Error && error.message === 'ROBINHOOD_TESTNET_CHAIN_MISMATCH') throw error;
    throw Error('TESTNET_OPERATOR_CONNECTION_FAILED');
  }
}

export type HostedAuthMemberships = {
  schema_version: 'thot.auth-memberships/1';
  issuer: string;
  memberships: (MembershipInput & { create_actor?: true })[];
};

/** Optional deployment-owned role mapping. It never infers authority from an email or JWT role claim. */
export async function loadHostedAuthMemberships(path: string): Promise<HostedAuthMemberships> {
  let handle;
  try {
    if (!isAbsolute(path)) throw Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw Error();
    const value = strictJson(await handle.readFile(), 65_536);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || !Object.keys(value).every(key => ['schema_version', 'issuer', 'memberships'].includes(key)) || value.schema_version !== 'thot.auth-memberships/1') throw Error();
    const issuer = new URL(value.issuer);
    if (issuer.protocol !== 'https:' || issuer.origin !== value.issuer || issuer.username || issuer.password) throw Error();
    if (!Array.isArray(value.memberships) || value.memberships.length > 20) throw Error();
    for (const entry of value.memberships) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['subject', 'actor', 'enabled'].every(key => Object.hasOwn(entry,key)) || !Object.keys(entry).every(key => ['subject', 'actor', 'enabled', 'create_actor'].includes(key)) || (Object.hasOwn(entry,'create_actor') && entry.create_actor !== true) || typeof entry.subject !== 'string' || !entry.subject || entry.subject.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.subject) || typeof entry.enabled !== 'boolean') throw Error();
      validateActor(entry.actor);
    }
    if (new Set(value.memberships.map((entry: MembershipInput) => entry.subject)).size !== value.memberships.length) throw Error();
    return value as HostedAuthMemberships;
  } catch { throw Error('HOSTED_AUTH_MEMBERSHIPS_INVALID_OR_NOT_PRIVATE'); }
  finally { await handle?.close(); }
}

/** Seed new identities only. A startup file cannot reactivate or silently change existing authority. */
export async function seedHostedAuthMemberships(db: Database, auth: AuthProvider | undefined, config: HostedAuthMemberships) {
  if (!auth || config.issuer !== auth.access.issuer) throw Error('HOSTED_AUTH_MEMBERSHIPS_ISSUER_MISMATCH');
  if (auth.capabilities.mode === 'clerk' && config.memberships.some(entry => !/^user_[A-Za-z0-9_]{1,240}$/.test(entry.subject))) throw Error('HOSTED_CLERK_SUBJECT_REQUIRED');
  await db.transaction(async tx => {
    for (const entry of config.memberships) {
      const prior = await tx.maybe('auth_access', 'membership:' + canonicalHash({ issuer: config.issuer, subject: entry.subject }));
      if (prior && (canonicalJson(prior.actor) !== canonicalJson(entry.actor) || (prior.enabled === true && entry.enabled === false))) throw Error('HOSTED_AUTH_MEMBERSHIP_CONFLICT');
      if(entry.create_actor){
        const actor=entry.actor,existing=await tx.maybe('users',actor.id);
        if(existing){
          if(existing.owner_id!==actor.id||existing.role!==actor.role||existing.buyer_id!==actor.buyer_id)throw Error('HOSTED_AUTH_ACTOR_CONFLICT');
          if(existing.disabled===true)throw Error('AUTH_ACTOR_UNAVAILABLE');
        }else{
          // A missing actor behind an existing membership is an inconsistency,
          // never permission to resurrect a deleted/disabled identity.
          if(prior)throw Error('AUTH_ACTOR_UNAVAILABLE');
          if(actor.buyer_id){const buyer=await tx.maybe('buyers',actor.buyer_id);if(!buyer||buyer.owner_id!==actor.buyer_id||buyer.approved!==true)throw Error('BUYER_NOT_APPROVED');}
          await tx.insert('users',actor.id,actor.id,{role:actor.role,...(actor.buyer_id?{buyer_id:actor.buyer_id}:{}),revoked_receipts:[],hosted_bootstrap:true});
          await tx.audit('network','HostedAuthActorProvisioned',{actor_id:actor.id,role:actor.role,...(actor.buyer_id?{buyer_id:actor.buyer_id}:{})});
        }
      }
    }
  });
  // AuthAccessStore.seed checks the actor and buyer already exist, and leaves a
  // persisted disabled mapping, revision and revocation boundary unchanged.
  await auth.access.seed(config.memberships.map(({create_actor,...entry})=>entry));
}
