import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, Wallet } from 'ethers';
import { createTestnetOperatorRuntime, loadHostedAuthMemberships, loadTestnetOperatorWallet, seedHostedAuthMemberships, validateThotHost, type HostedAuthMemberships, type ThotHostConfiguration } from '../packages/runtime/src/thot-host.ts';
import { startServer } from '../apps/api/server.ts';
import { ROBINHOOD_TESTNET_RPC, type ThotChainConfig } from '../packages/chain/thot.ts';
import { AuthAccessStore, type AuthProvider } from '../packages/auth/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoBuyer, demoOperator } from '../packages/market/src/fixtures.ts';

function chain(): ThotChainConfig {
  return { mode: 'robinhood-testnet', chainId: 46630, rpcUrl: ROBINHOOD_TESTNET_RPC,
    token: '0x1111111111111111111111111111111111111111', market: '0x2222222222222222222222222222222222222222',
    locks: '0x3333333333333333333333333333333333333333', reserve: '0x4444444444444444444444444444444444444444',
    operatorAddress: '0x5555555555555555555555555555555555555555', confirmations: 2, deploymentBlock: 1,
    deploymentBlockHash: '0x' + 'a'.repeat(64), codeHashes: { token: '0x'+'b'.repeat(64), market: '0x'+'c'.repeat(64), locks: '0x'+'d'.repeat(64), reserve: '0x'+'e'.repeat(64) } };
}
const hosted = (): ThotHostConfiguration => ({ thot: chain(), bind: '0.0.0.0', publicOrigin: 'https://trial.example',
  authConfigured: true, masterKeySource: 'dstack', operatorKeyFile: '/run/thot/operator.key' });

test('hosted THOT requires authenticated HTTPS, dstack custody and an explicit official-testnet signer', () => {
  assert.deepEqual(validateThotHost(hosted()), { hosted: true });
  for (const [override, expected] of [
    [{ authConfigured: false }, 'HOSTED_THOT_AUTH_REQUIRED'],
    [{ masterKeySource: undefined }, 'HOSTED_THOT_DSTACK_REQUIRED'],
    [{ masterKeySource: 'local-file' }, 'HOSTED_THOT_DSTACK_REQUIRED'],
    [{ publicOrigin: undefined }, 'HOSTED_THOT_HTTPS_ORIGIN_REQUIRED'],
    [{ publicOrigin: 'http://trial.example' }, 'HOSTED_THOT_HTTPS_ORIGIN_REQUIRED'],
    [{ publicOrigin: 'https://localhost' }, 'HOSTED_THOT_HTTPS_ORIGIN_REQUIRED'],
    [{ operatorKeyFile: undefined }, 'TESTNET_OPERATOR_KEY_FILE_REQUIRED'],
    [{ operatorKeyFile: './operator.key' }, 'TESTNET_OPERATOR_KEY_FILE_REQUIRED'],
    [{ thot: { ...chain(), chainId: 4663 } }, 'ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED'],
    [{ thot: { ...chain(), rpcUrl: 'https://other.example' } }, 'ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED'],
    [{ thot: { ...chain(), mode: 'local-anvil', chainId: 31337 } }, 'ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED'],
  ] as const) assert.throws(() => validateThotHost({ ...hosted(), ...override } as ThotHostConfiguration), new RegExp(expected));
});

test('hosted Robinhood read-only mode alone permits a missing operator key', () => {
  const signless={...hosted(),operatorKeyFile:undefined,readOnly:true};
  assert.deepEqual(validateThotHost(signless),{hosted:true});
  for(const override of [
    {readOnly:false},{operatorKeyFile:'/run/thot/operator.key'},
    {operatorKeyEnvPresent:true},
    {bind:'127.0.0.1',publicOrigin:undefined},
    {privateAnvil:true},
    {thot:{...chain(),mode:'local-anvil',chainId:31337,rpcUrl:'http://127.0.0.1:8545'}},
    {thot:undefined},
  ])assert.throws(()=>validateThotHost({...signless,...override} as ThotHostConfiguration));
  assert.throws(()=>validateThotHost({...signless,authConfigured:false}),/HOSTED_THOT_AUTH_REQUIRED/);
  assert.throws(()=>validateThotHost({...signless,masterKeySource:undefined}),/HOSTED_THOT_DSTACK_REQUIRED/);
});

test('loopback behind a public reverse proxy gets the same hosted protections', () => {
  assert.throws(() => validateThotHost({ ...hosted(), bind: '127.0.0.1', authConfigured: false }), /HOSTED_THOT_AUTH_REQUIRED/);
  assert.throws(() => validateThotHost({ ...hosted(), bind: '::1', masterKeySource: undefined }), /HOSTED_THOT_DSTACK_REQUIRED/);
  for (const publicOrigin of ['https://trial.example/path', 'https://trial.example/', 'https://trial.example?x=1', 'https://user:pass@trial.example']) {
    assert.throws(() => validateThotHost({ ...hosted(), publicOrigin }), /INVALID_PUBLIC_ORIGIN/);
  }
});

test('hosted private Anvil is explicit, loopback-only, wallet-authenticated and externally keyed', () => {
  const config: ThotHostConfiguration = {...hosted(), bind:'127.0.0.1', operatorKeyFile:undefined,
    privateAnvil:true,walletAuthConfigured:true,
    thot:{...chain(),mode:'local-anvil',chainId:31337,rpcUrl:'http://127.0.0.1:8545',localDeliverySigner:'0x5555555555555555555555555555555555555555'}};
  assert.deepEqual(validateThotHost(config),{hosted:true});
  for(const override of [
    {privateAnvil:false},{bind:'0.0.0.0'},{walletAuthConfigured:false},{authConfigured:false},
    {masterKeySource:undefined},{publicOrigin:'http://trial.example'},
    {operatorKeyFile:'/run/public-testnet.key'},
    {thot:{...config.thot!,chainId:46630}},
    {thot:{...config.thot!,rpcUrl:'https://rpc.example'}},
    {thot:{...config.thot!,localDeliverySigner:undefined}},
  ])assert.throws(()=>validateThotHost({...config,...override}));
});

test('existing loopback development and local Anvil can remain unsigned; key without chain fails', () => {
  for (const bind of ['127.0.0.1', 'localhost', '::1']) {
    assert.deepEqual(validateThotHost({ bind, authConfigured: false }), { hosted: false });
    assert.deepEqual(validateThotHost({ bind, authConfigured: false, thot: { ...chain(), mode: 'local-anvil', chainId: 31337, rpcUrl: 'http://127.0.0.1:8545' } }), { hosted: false });
  }
  assert.throws(() => validateThotHost({ bind: '127.0.0.1', authConfigured: false, operatorKeyFile: '/run/thot/key' }), /THOT_SIGNER_WITHOUT_CONFIG/);
});

test('operator key loader rejects symlink, hardlink, public mode and invalid scalar without disclosing contents', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(), path = join(directory, 'operator.key');
  await writeFile(path, wallet.privateKey + '\n', { mode: 0o600 });
  assert.equal((await loadTestnetOperatorWallet(path)).address, wallet.address);
  const alias = join(directory, 'alias'); await symlink(path, alias);
  await assert.rejects(loadTestnetOperatorWallet(alias), /TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE/);
  await rm(alias); await link(path, alias);
  await assert.rejects(loadTestnetOperatorWallet(path), /TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE/);
  await rm(alias); await chmod(path, 0o644);
  await assert.rejects(loadTestnetOperatorWallet(path), /TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE/);
  await chmod(path, 0o400);
  await assert.rejects(loadTestnetOperatorWallet(path), /TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE/);
  await chmod(path, 0o600);
  await writeFile(path, '0x' + '0'.repeat(64));
  await assert.rejects(loadTestnetOperatorWallet(path), error => {
    assert.equal((error as Error).message, 'TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE');
    return true;
  });
  await assert.rejects(loadTestnetOperatorWallet(directory), /TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE/);
  await assert.rejects(loadTestnetOperatorWallet('relative.key'), /TESTNET_OPERATOR_KEY_FILE_INVALID_OR_NOT_PRIVATE/);
});

test('testnet runtime binds only the configured operator and closes its provider exactly once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(), path = join(directory, 'operator.key');
  await writeFile(path, wallet.privateKey, { mode: 0o600 });
  let created = 0, destroyed = 0;
  const provider = { getNetwork: async () => ({ chainId: 46630n }), destroy: () => { destroyed++; } } as unknown as JsonRpcProvider;
  const factory = (rpc: string) => { assert.equal(rpc, ROBINHOOD_TESTNET_RPC); created++; return provider; };
  await assert.rejects(createTestnetOperatorRuntime(chain(), path, factory), /TESTNET_OPERATOR_ADDRESS_MISMATCH/);
  assert.equal(created, 0);
  const runtime = await createTestnetOperatorRuntime({ ...chain(), operatorAddress: wallet.address }, path, factory);
  assert.equal(runtime.signer?.address, wallet.address);
  assert.equal(runtime.signer?.provider, provider);
  assert.equal(created, 1);
  await runtime.close(); await runtime.close();
  assert.equal(destroyed, 1);
});

test('wrong network and connection failures close the provider; mainnet and alternate RPC never connect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-network-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(), path = join(directory, 'operator.key');
  await writeFile(path, wallet.privateKey, { mode: 0o600 });
  const config = { ...chain(), operatorAddress: wallet.address };
  let calls = 0, destroyed = 0, shouldThrow = false;
  const factory = () => { calls++; return { getNetwork: async () => { if (shouldThrow) throw Error('sensitive provider detail'); return { chainId: 4663n }; }, destroy: () => { destroyed++; } } as unknown as JsonRpcProvider; };
  await assert.rejects(createTestnetOperatorRuntime({ ...config, chainId: 4663 }, path, factory), /ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED/);
  await assert.rejects(createTestnetOperatorRuntime({ ...config, rpcUrl: 'https://other.example' }, path, factory), /ROBINHOOD_TESTNET_CONFIGURATION_REQUIRED/);
  assert.equal(calls, 0);
  await assert.rejects(createTestnetOperatorRuntime(config, path, factory), /ROBINHOOD_TESTNET_CHAIN_MISMATCH/);
  assert.equal(destroyed, 1);
  shouldThrow = true;
  await assert.rejects(createTestnetOperatorRuntime(config, path, factory), error => (error as Error).message === 'TESTNET_OPERATOR_CONNECTION_FAILED');
  assert.equal(destroyed, 2);
});

async function withEnvironment(values: Record<string, string | undefined>, operation: () => Promise<void>) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await operation(); }
  finally { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('actual server startup rejects unauthenticated hosted testnet before creating storage or contacting KMS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-denied-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'chain.json'), dataDir = join(directory, 'vault');
  await writeFile(path, JSON.stringify(chain()));
  await withEnvironment({ THOT_CHAIN_CONFIG_FILE: path, THOT_TESTNET_OPERATOR_KEY_FILE: join(directory, 'not-present.key'),
    THOT_AUTH_MEMBERSHIPS_FILE: undefined,
    THOT_BIND: '0.0.0.0', THOT_PUBLIC_ORIGIN: 'https://trial.example', THOT_MASTER_KEY_SOURCE: 'dstack', DSTACK_SOCKET: join(directory, 'not-present.sock'),
    THOT_ENABLE_CLERK_AUTH: undefined, THOT_ENABLE_EXTERNAL_AUTH: undefined }, async () => {
    await assert.rejects(startServer({ port: 0, dataDir }), /HOSTED_THOT_AUTH_REQUIRED/);
    await assert.rejects(stat(dataDir), { code: 'ENOENT' });
  });
});

test('read-only startup rejects even an empty retained operator-key environment variable before KMS or storage',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'thot-host-readonly-denied-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'chain.json'),dataDir=join(directory,'vault');
  await writeFile(path,JSON.stringify(chain()));
  await withEnvironment({THOT_CHAIN_CONFIG_FILE:path,THOT_READ_ONLY:'true',THOT_TESTNET_OPERATOR_KEY_FILE:undefined,THOT_TESTNET_OPERATOR_KEY:'',
    THOT_BIND:'0.0.0.0',THOT_PUBLIC_ORIGIN:'https://trial.example',THOT_MASTER_KEY_SOURCE:'dstack',DSTACK_SOCKET:join(directory,'not-present.sock'),THOT_ENABLE_WALLET_AUTH:'true'},async()=>{
    await assert.rejects(startServer({port:0,dataDir}),/THOT_READ_ONLY_CONFIGURATION_REQUIRED/);
    await assert.rejects(stat(dataDir),{code:'ENOENT'});
  });
});

test('default loopback server still starts, serves, drains and closes idempotently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-local-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await withEnvironment({ THOT_CHAIN_CONFIG_FILE: undefined, THOT_TESTNET_OPERATOR_KEY_FILE: undefined, THOT_BIND: '127.0.0.1',
    THOT_AUTH_MEMBERSHIPS_FILE: undefined,
    THOT_PUBLIC_ORIGIN: undefined, THOT_MASTER_KEY_SOURCE: undefined, THOT_ENABLE_CLERK_AUTH: undefined, THOT_ENABLE_EXTERNAL_AUTH: undefined,
    THOT_ENABLE_LIVE_INFERENCE: undefined, THOT_ENABLE_BILLING_RECONCILIATION: undefined, THOT_ROBINHOOD_CONFIG_FILE: undefined,
    THOT_RECORDER_POLICY_FILE: undefined, THOT_TRACE_EXPLORER_VIEWERS: undefined, PLAID_CLIENT_ID: undefined, NODE_ENV: 'test' }, async () => {
    const running = await startServer({ port: 0, dataDir: directory });
    try {
      const response = await fetch(running.url + '/v1/auth/capabilities');
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { development_session_available: boolean }).development_session_available, true);
    } finally { await running.close(); await running.close(); }
    assert.equal(running.server.listening, false);
  });
});

test('hosted membership file is private, bounded, exact-schema and cannot carry claim-derived roles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-memberships-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'memberships.json');
  const config: HostedAuthMemberships = { schema_version: 'thot.auth-memberships/1', issuer: 'https://login.example',
    memberships: [{ subject: 'user_Founder123', actor: demoOperator, enabled: true }] };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadHostedAuthMemberships(path), config);
  await chmod(path, 0o644);
  await assert.rejects(loadHostedAuthMemberships(path), /HOSTED_AUTH_MEMBERSHIPS_INVALID_OR_NOT_PRIVATE/);
  await chmod(path, 0o600);
  const alias = join(directory, 'alias'); await symlink(path, alias);
  await assert.rejects(loadHostedAuthMemberships(alias), /HOSTED_AUTH_MEMBERSHIPS_INVALID_OR_NOT_PRIVATE/);
  for (const bad of [
    { ...config, unknown: true },
    { ...config, memberships: [...config.memberships, ...config.memberships] },
    { ...config, memberships: Array.from({ length: 21 }, (_, i) => ({ ...config.memberships[0], subject: 'user_' + i })) },
    { ...config, memberships: [{ ...config.memberships[0], email: 'someone@example.com' }] },
    { ...config, memberships: [{ ...config.memberships[0], expected_version: 0 }] },
    { ...config, memberships: [{ ...config.memberships[0], create_actor: false }] },
    { ...config, memberships: [{ ...config.memberships[0], actor: { id: 'arbitrary', role: 'superadmin' } }] },
  ]) {
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(loadHostedAuthMemberships(path), /HOSTED_AUTH_MEMBERSHIPS_INVALID_OR_NOT_PRIVATE/);
  }
});

test('explicit bootstrap creates operator/buyer actors for exact Clerk identities; restart never reactivates or changes them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-host-role-seed-'));
  const app = await createApplication({ memory: true, dataDir: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const issuer = 'https://login.example';
  const access = new AuthAccessStore(app.db, issuer);
  const auth: AuthProvider = { access, capabilities: { mode: 'clerk', development_session_available: false, external_login_available: true }, authenticate: async () => { throw Error('UNUSED_TEST_PROVIDER'); } };
  const config: HostedAuthMemberships = { schema_version: 'thot.auth-memberships/1', issuer, memberships: [
    { subject: 'user_Founder123', actor: demoOperator, enabled: true, create_actor: true }, { subject: 'user_Buyer123', actor: demoBuyer, enabled: true, create_actor: true },
  ] };
  const identity = { issuer, subject: 'user_Founder123', jti: 'session_fixture', issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 60 };
  await seedHostedAuthMemberships(app.db, auth, config);
  assert.deepEqual(await access.authenticate(identity), demoOperator);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, issuer: 'https://other.example' }), /HOSTED_AUTH_MEMBERSHIPS_ISSUER_MISMATCH/);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, memberships: [{ ...config.memberships[0]!, subject: 'founder@example.com' }] }), /HOSTED_CLERK_SUBJECT_REQUIRED/);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, memberships: [{ ...config.memberships[0]!, actor: demoBuyer }] }), /HOSTED_AUTH_MEMBERSHIP_CONFLICT/);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, memberships: [{ ...config.memberships[0]!, enabled: false }] }), /HOSTED_AUTH_MEMBERSHIP_CONFLICT/);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, memberships: [{ subject: 'user_UnknownBuyer', actor: { id: 'new-buyer', role: 'buyer_admin', buyer_id: 'not-approved' }, enabled: true, create_actor: true }] }), /BUYER_NOT_APPROVED/);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, memberships: [{ subject: 'user_Escalation', actor: { id: 'demo-user', role: 'operator_security' }, enabled: true, create_actor: true }] }), /HOSTED_AUTH_ACTOR_CONFLICT/);
  await access.provision(demoOperator, 'disable-founder', { subject: config.memberships[0]!.subject, actor: demoOperator, enabled: false, expected_version: 1 });
  await seedHostedAuthMemberships(app.db, auth, config);
  await assert.rejects(access.authenticate(identity), /UNAUTHENTICATED/);
  await assert.rejects(seedHostedAuthMemberships(app.db, auth, { ...config, memberships: [{ subject: 'user_Nobody123', actor: { id: 'does-not-exist', role: 'operator_security' }, enabled: true }] }), /AUTH_ACTOR_UNAVAILABLE/);
});


test('production signing rejects incomplete policy or foreign RPC before opening a key', async () => {
  const production: ThotChainConfig={...chain(),mode:'production',chainId:4663,rpcUrl:'https://rpc.mainnet.chain.robinhood.com',percentageFees:true,sharedTreasury:true,governanceKind:'safe',governor:'0x'+'6'.repeat(40),feeDiscounts:'0x'+'7'.repeat(40),staking:'0x'+'8'.repeat(40)};
  assert.deepEqual(validateThotHost({...hosted(),thot:production}),{hosted:true});
  for(const override of [{chainId:8453},{rpcUrl:'https://other.example'},{percentageFees:false},{sharedTreasury:false},{governanceKind:'controller'},{confirmations:1},{governor:undefined},{staking:undefined},{feeDiscounts:undefined}]) {
    const candidate={...production,...override} as ThotChainConfig;
    assert.throws(()=>validateThotHost({...hosted(),thot:candidate}),/THOT_PRODUCTION_CONFIGURATION_REQUIRED/);
    await assert.rejects(createTestnetOperatorRuntime(candidate,'/nonexistent-key'),/THOT_PRODUCTION_CONFIGURATION_REQUIRED/);
  }
});
