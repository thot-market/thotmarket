import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, id, ZeroAddress, MaxUint256 } from 'ethers';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const sources = Object.fromEntries(readdirSync(sourceDir).filter(name => name.endsWith('.sol'))
  .map(name => [name, { content: readFileSync(`${sourceDir}/${name}`, 'utf8') }]));
const compilation = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
assert.deepEqual((compilation.errors ?? []).filter(error => error.severity === 'error'), [], 'Solidity compilation failed');

async function fixture() {
  const engine = ganache.provider({ chain: { chainId: 1337, hardfork: 'shanghai' },
    wallet: { deterministic: true, totalAccounts: 7 }, logging: { quiet: true } });
  const provider = new BrowserProvider(engine); provider.pollingInterval = 10;
  const signers = await Promise.all(Array.from({ length: 7 }, (_, index) => provider.getSigner(index)));
  const [admin, buyer, attacker, user, treasury, reserve, sink] = signers;
  async function deploy(name, args, signer = admin) {
    const artifact = compilation.contracts[`${name}.sol`][name];
    const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(...args);
    await contract.waitForDeployment(); return contract;
  }
  const payment = await deploy('ThotToken', [await buyer.getAddress(), 1_000_000n]);
  const thot = await deploy('ThotToken', [await admin.getAddress(), 1_000_000n]);
  const registry = await deploy('SettlementRegistry', [await admin.getAddress()]);
  const escrow = await deploy('MandateEscrow', [await payment.getAddress(), await registry.getAddress(),
    await admin.getAddress(), await admin.getAddress(), await treasury.getAddress(), await reserve.getAddress()]);
  await (await registry.bindRecorder(await escrow.getAddress())).wait();
  await (await payment.connect(buyer).approve(await escrow.getAddress(), MaxUint256)).wait();
  return { engine, provider, deploy, signers, admin, buyer, attacker, user, treasury, reserve, sink, payment, thot, registry, escrow };
}

test('contract bytecode compiles with a fixed, explicit compiler and target EVM', () => {
  assert.match(solc.version(), /^0\.8\.30\+/);
  for (const name of ['ThotToken', 'MandateEscrow', 'SettlementRegistry', 'MockBurnExecutor']) {
    assert.ok(compilation.contracts[`${name}.sol`][name].evm.bytecode.object.length > 0);
  }
});

test('fixed genesis ERC20 has no mint/owner, respects allowances, and burns actual circulating supply', async () => {
  const f = await fixture();
  try {
    const functions = f.thot.interface.fragments.filter(fragment => fragment.type === 'function').map(fragment => fragment.name);
    assert.equal(functions.includes('mint'), false); assert.equal(functions.includes('owner'), false);
    assert.equal(await f.thot.name(), 'THOT token'); assert.equal(await f.thot.symbol(), 'THOT');
    assert.equal(await f.thot.totalSupply(), 1_000_000n);
    await assert.rejects(f.thot.connect(f.attacker).transferFrom.staticCall(await f.admin.getAddress(), await f.user.getAddress(), 1n));
    await assert.rejects(f.thot.transfer.staticCall(ZeroAddress, 1n));
    await (await f.thot.approve(await f.buyer.getAddress(), 200n)).wait();
    await (await f.thot.connect(f.buyer).transferFrom(await f.admin.getAddress(), await f.user.getAddress(), 125n)).wait();
    assert.equal(await f.thot.allowance(await f.admin.getAddress(), await f.buyer.getAddress()), 75n);
    assert.equal(await f.thot.totalSupply(), 1_000_000n);
    await (await f.thot.connect(f.user).burn(25n)).wait();
    assert.equal(await f.thot.totalSupply(), 999_975n); assert.equal(await f.thot.balanceOf(await f.user.getAddress()), 100n);
    await (await f.thot.connect(f.buyer).burnFrom(await f.admin.getAddress(), 75n)).wait();
    assert.equal(await f.thot.totalSupply(), 999_900n);
    await assert.rejects(f.thot.connect(f.buyer).burnFrom.staticCall(await f.admin.getAddress(), 1n));
  } finally { await f.engine.disconnect(); }
});

test('escrow release checks permission, funding, license replay, source split, costs, and exact balances', async () => {
  const f = await fixture();
  try {
    const mandate = id('mandate'); const license = id('license'); const commitment = id('private settlement commitment');
    await (await f.escrow.connect(f.buyer).createMandate(mandate, await f.payment.getAddress(), 20_000n)).wait();
    await assert.rejects(f.escrow.connect(f.attacker).deposit.staticCall(mandate, 10n));
    await assert.rejects(f.escrow.connect(f.attacker).release.staticCall(license, mandate, await f.user.getAddress(), 10_000n, 0n, commitment));
    await assert.rejects(f.escrow.release.staticCall(license, mandate, await f.user.getAddress(), 20_001n, 0n, commitment));
    await assert.rejects(f.escrow.release.staticCall(license, mandate, await f.user.getAddress(), 10_000n, 10_001n, commitment));
    const tx = await f.escrow.release(license, mandate, await f.user.getAddress(), 10_100n, 100n, commitment);
    const receipt = await tx.wait();
    assert.equal(await f.payment.balanceOf(await f.user.getAddress()), 6500n);
    assert.equal(await f.payment.balanceOf(await f.reserve.getAddress()), 2000n);
    assert.equal(await f.payment.balanceOf(await f.treasury.getAddress()), 1600n);
    assert.equal(await f.escrow.available(mandate), 9900n);
    await assert.rejects(f.escrow.release.staticCall(license, mandate, await f.user.getAddress(), 1n, 0n, commitment));
    const release = receipt.logs.map(log => { try { return f.escrow.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === 'Released');
    assert.equal(release.args.burnAmount, 2000n); assert.equal(release.args.operatorAmount, 1500n);
    assert.equal(release.args.contributorAmount + release.args.burnAmount + release.args.operatorAmount + release.args.directCosts, release.args.gross);
    assert.notEqual(await f.registry.settlementHashes(license), id('different'));
  } finally { await f.engine.disconnect(); }
});

test('refunds stay buyer-bound and mandate-isolated through pause; unauthorized control is rejected', async () => {
  const f = await fixture();
  try {
    const a = id('a'); const b = id('b');
    await (await f.escrow.connect(f.buyer).deposit(a, 200n)).wait();
    await (await f.escrow.connect(f.buyer).deposit(b, 300n)).wait();
    await assert.rejects(f.escrow.connect(f.attacker).refund.staticCall(a, 1n));
    await assert.rejects(f.escrow.connect(f.buyer).refund.staticCall(a, 201n));
    await assert.rejects(f.escrow.connect(f.buyer).setPaused.staticCall(true));
    await (await f.escrow.setPaused(true)).wait();
    await assert.rejects(f.escrow.connect(f.buyer).fundMandate.staticCall(a, 1n));
    await assert.rejects(f.escrow.release.staticCall(id('l'), a, await f.user.getAddress(), 1n, 0n, id('c')));
    await (await f.escrow.connect(f.buyer).refund(a, 200n)).wait();
    assert.equal(await f.escrow.available(a), 0n); assert.equal(await f.escrow.available(b), 300n);
  } finally { await f.engine.disconnect(); }
});

test('registry pins one recorder, rounds without uint256 overflow, and anchors exact batch roots', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.registry.bindRecorder.staticCall(await f.escrow.getAddress()));
    await assert.rejects(f.registry.connect(f.attacker).record.staticCall(id('s'), id('m'), id('c'), 100n, 0n, 65n, 20n, 15n));
    for (const value of [0n, 1n, 3n, 99n, 100n, 101n, MaxUint256]) {
      const [contributor, burn, operator] = await f.registry.split(value);
      assert.equal(contributor, value * 65n / 100n); assert.equal(burn, value * 20n / 100n);
      assert.equal(contributor + burn + operator, value);
    }
    const batchId = id('batch'); const root = id('exact reconciliation Merkle root');
    await assert.rejects(f.escrow.anchorBatch.staticCall(batchId, root, 100n, 0n, 65n, 20n, 16n));
    await (await f.escrow.anchorBatch(batchId, root, 100n, 0n, 65n, 20n, 15n)).wait();
    assert.equal(await f.registry.batchRoots(batchId), root);
    await assert.rejects(f.escrow.anchorBatch.staticCall(batchId, id('replacement'), 100n, 0n, 65n, 20n, 15n));
  } finally { await f.engine.disconnect(); }
});

test('mock burn failure and slippage preserve inventory; successful retry burns once and respects deadlines', async () => {
  const f = await fixture();
  try {
    const executor = await f.deploy('MockBurnExecutor', [await f.payment.getAddress(), await f.thot.getAddress(),
      await f.admin.getAddress(), await f.sink.getAddress(), 2n, 1n]);
    await (await f.payment.connect(f.buyer).transfer(await executor.getAddress(), 200n)).wait();
    await (await f.thot.transfer(await executor.getAddress(), 1000n)).wait();
    const burnId = id('burn allocation'); const deadline = BigInt((await f.provider.getBlock('latest')).timestamp) + 600n;
    await assert.rejects(executor.connect(f.attacker).executeBurn.staticCall(burnId, 200n, 400n, deadline));
    await assert.rejects(executor.executeBurn.staticCall(burnId, 200n, 401n, deadline));
    await assert.rejects(executor.executeBurn.staticCall(burnId, 200n, 400n, 1n));
    await (await executor.setFailing(true)).wait();
    await assert.rejects(executor.executeBurn.staticCall(burnId, 200n, 400n, deadline));
    assert.equal(await f.payment.balanceOf(await executor.getAddress()), 200n);
    assert.equal(await f.thot.totalSupply(), 1_000_000n); assert.equal(await executor.executed(burnId), false);
    await (await executor.setFailing(false)).wait();
    await (await executor.executeBurn(burnId, 200n, 400n, deadline)).wait();
    assert.equal(await f.thot.totalSupply(), 999_600n); assert.equal(await f.thot.balanceOf(await executor.getAddress()), 600n);
    assert.equal(await f.payment.balanceOf(await f.sink.getAddress()), 200n);
    await assert.rejects(executor.executeBurn.staticCall(burnId, 200n, 400n, deadline));
  } finally { await f.engine.disconnect(); }
});

test('local EVM rollback removes settlement and event effects; replayed event queries are stable', async () => {
  const f = await fixture();
  try {
    const mandate = id('rollback mandate'); const license = id('rollback license');
    await (await f.escrow.connect(f.buyer).deposit(mandate, 1000n)).wait();
    const snapshot = await f.engine.request({ method: 'evm_snapshot', params: [] });
    const tx = await f.escrow.release(license, mandate, await f.user.getAddress(), 100n, 0n, id('commitment'));
    const receipt = await tx.wait();
    const filter = { address: await f.escrow.getAddress(), fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber };
    const a = await f.provider.getLogs(filter); const b = await f.provider.getLogs(filter);
    assert.deepEqual(a.map(log => [log.transactionHash, log.index]), b.map(log => [log.transactionHash, log.index]));
    assert.equal(await f.engine.request({ method: 'evm_revert', params: [snapshot] }), true);
    assert.equal(await f.escrow.available(mandate), 1000n); assert.equal(await f.escrow.released(license), false);
    assert.equal(await f.payment.balanceOf(await f.user.getAddress()), 0n);
  } finally { await f.engine.disconnect(); }
});
