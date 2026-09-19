import test from 'node:test';
import assert from 'node:assert/strict';
import { Contract, keccak256, parseEther, toBeHex, zeroPadValue } from 'ethers';
import { deployThotFixture } from '../scripts/thot-local-fixture.mjs';
import { prepareThotDeployment, verifyThotGovernorRuntime } from '../scripts/prepare-thot-deployment.mjs';

const DAY = 86400;
const confirmed = async transaction => (await transaction).wait();

async function setup(f) {
  const addresses = await Promise.all(f.signers.map(signer => signer.getAddress()));
  const owners = [addresses[0], addresses[1], addresses[6]];
  const governor = await f.deploy('ThotGovernor', [owners]);
  const token = await f.deploy('ThotTestToken', [addresses[0], parseEther('1000000000')]);
  const options = { rpcUrl: f.config.rpcUrl, expectedChainId: f.config.chainId, token: await token.getAddress(),
    deployer: addresses[0], governor: await governor.getAddress(), governorCreationTransaction: governor.deploymentTransaction().hash,
    operator: addresses[5], protocolRecipient: addresses[4] };
  return { addresses, owners, governor, token, options };
}

test('unsigned 1-of-3 plan executes atomically despite proposal nonce drift and starts the curve at activation', async () => {
  const f = await deployThotFixture({ activate: false });
  try {
    const { addresses, owners, governor, token, options } = await setup(f);
    const beforeNonce = await f.provider.getTransactionCount(addresses[0], 'pending');
    const beforeBlock = await f.provider.getBlockNumber();
    const plan = await prepareThotDeployment(options);
    assert.equal(plan.governance.creationTransaction, governor.deploymentTransaction().hash);
    await assert.rejects(prepareThotDeployment({...options, governorCreationTransaction: undefined}), /GOVERNOR_CREATION_TRANSACTION_REQUIRED/);
    await assert.rejects(prepareThotDeployment({...options, governorCreationTransaction: token.deploymentTransaction().hash}), /GOVERNOR_CREATION_MISMATCH/);
    assert.equal(await f.provider.getBlockNumber(), beforeBlock, 'preparation never mines or broadcasts');
    assert.equal(await f.provider.getTransactionCount(addresses[0], 'pending'), beforeNonce);
    assert.equal(await governor.nextNonce(), 0n);
    assert.equal(plan.schema, 'thot.unsigned-deployment-plan/3');
    assert.equal(plan.unsignedOnly, true);
    assert.ok(plan.blockers.some(message => message.includes('470M acquisition / 30M staking')), 'legacy planner must not be mistaken for the finalized launch funding plan');
    assert.equal(plan.broadcast, false);
    assert.equal(plan.governance.mode, 'thot-governor-1-of-3');
    assert.deepEqual(plan.governance.owners, owners);
    assert.equal(plan.governance.threshold, 1);
    assert.equal(plan.governance.immutableThreshold, 1);
    assert.ok(plan.governance.immutableReferenceCount > 0);
    assert.equal(plan.governance.runtimeCodeHash, keccak256(await f.provider.getCode(options.governor)));
    assert.notEqual(plan.governance.runtimeCodeHash, plan.governance.reviewedRuntimeHash, 'runtime hash includes the actual immutable value');
    assert.equal(plan.governance.queue, undefined, 'never suggests a transaction signed by a contract');
    assert.equal(plan.governance.execute, undefined);
    assert.equal(plan.waitWindowsSeconds.reserveGovernance, 0);
    assert.equal(plan.waitWindowsSeconds.marketGovernance, 0);
    assert.equal(plan.waitWindowsSeconds.disputeAfterDelivery, 12 * 3600);
    assert.equal(plan.governance.campaignStartMode, 'activation-time');
    assert.equal(plan.governance.proposedCampaignStart, 0);
    assert.equal(plan.governance.proposedCampaignStartISO, null);
    assert.equal(plan.governance.queueBefore, null);
    assert.equal(plan.governance.campaignEndsAt, null);
    assert.equal(plan.governance.campaignDurationSeconds, 360 * DAY);
    assert.ok(plan.sourceSha256['ThotGovernor.sol']);
    assert.equal(JSON.stringify(plan).includes(f.config.rpcUrl), false);

    for (const step of plan.deploymentTransactions) {
      const receipt = await confirmed(f.admin.sendTransaction(step.transaction));
      if (step.action === 'deploy') assert.equal(receipt.contractAddress.toLowerCase(), step.predictedAddress.toLowerCase());
    }
    const reserve = new Contract(plan.predictedAddresses.reserve, f.artifacts.ThotReserveVault.abi, f.provider);
    const market = new Contract(plan.predictedAddresses.market, f.artifacts.ThotMarket.abi, f.provider);
    assert.equal(await reserve.GOVERNANCE_DELAY(), 0n);
    assert.equal(await market.GOVERNANCE_DELAY(), 0n);
    assert.equal(await market.DISPUTE_WINDOW(), 43200n);
    assert.equal(await token.balanceOf(await reserve.getAddress()), parseEther('500000000'));
    for (const owner of owners) assert.equal(await reserve.authorizedBuyers(owner), true);
    assert.equal(await reserve.authorizedBuyers(addresses[5]), false, 'the operator cannot spend the reserve');

    const runFlow = async (flow, signer) => {
      assert.equal(flow.requiredApprovals, 1);
      assert.equal(flow.transactions.length, 1);
      assert.equal(flow.expectedNonceIsAdvisory, true);
      assert.deepEqual(flow.eligibleSigners, owners);
      const [step] = flow.transactions;
      assert.equal(step.action, 'submit-and-execute');
      assert.equal(step.transaction.to, options.governor);
      for (const key of ['nonce', 'gasLimit', 'gasPrice', 'maxFeePerGas', 'signature']) assert.equal(step.transaction[key], undefined);
      const decoded = governor.interface.parseTransaction({ data: step.transaction.data });
      assert.equal(decoded.name, 'submitAndExecute');
      assert.equal(decoded.args.target, flow.target);
      assert.equal(decoded.args.data, flow.targetCalldata);
      const nonce = await governor.nextNonce();
      await assert.rejects(f.attacker.call({ ...step.transaction, from: addresses[5] }), 'an outsider cannot submit and execute');
      assert.equal(await governor.nextNonce(), nonce, 'rejected outsider cannot consume a proposal nonce');
      const receipt = await confirmed(signer.sendTransaction({ ...step.transaction, from: await signer.getAddress() }));
      const events = receipt.logs.filter(log => log.address.toLowerCase() === options.governor.toLowerCase())
        .map(log => governor.interface.parseLog(log));
      const submitted = events.find(log => log.name === 'Submitted');
      assert.equal(submitted.args.nonce, nonce);
      assert.equal(submitted.args.id, await governor.operationId(nonce, flow.target, flow.targetCalldata));
      assert.notEqual(submitted.args.id, flow.expectedOperationId, 'intervening proposals change only the advisory id');
      assert.equal(submitted.args.target, flow.target);
      assert.equal(submitted.args.data, flow.targetCalldata);
      assert.equal(events.find(log => log.name === 'Executed').args.id, submitted.args.id);
      const operation = await governor.operation(submitted.args.id);
      assert.equal(operation.confirmations, 1n);
      assert.equal(operation.executed, true);
      await assert.rejects(governor.execute.staticCall(submitted.args.id), 'executed governance operation cannot replay');
      return receipt;
    };

    const activation = plan.governance.activationFlow.transactions[0].transaction;
    await assert.rejects(f.admin.call(activation), 'activation cannot skip the target queue');
    assert.equal(await governor.nextNonce(), 0n, 'failed target call rolls back the whole submission');
    const unrelated = token.interface.encodeFunctionData('balanceOf', [addresses[0]]);
    await confirmed(governor.connect(f.other).submit(options.token, unrelated));
    await runFlow(plan.governance.queueFlow, f.other);
    assert.ok(await reserve.queued(plan.governance.queueOperation) > 0n);
    assert.equal(await reserve.startAt(), 0n, 'queueing does not activate');
    await confirmed(governor.connect(f.other).submit(options.token, unrelated));
    await f.advance(2 * DAY);
    const receipt = await runFlow(plan.governance.activationFlow, f.buyer);
    const activationBlock = await f.provider.getBlock(receipt.blockNumber);
    assert.equal(await reserve.startAt(), BigInt(activationBlock.timestamp));
    assert.equal(await reserve.currentDay(), 0n, 'pre-activation waiting never consumes campaign days');
    assert.ok(activationBlock.timestamp > plan.observedBlock.timestamp + DAY);
    await assert.rejects(f.admin.call(activation), 'a second activation cannot restart the campaign');
  } finally { await f.close(); }
});

test('planner verifies every threshold immutable, all remaining runtime bytes and coherent owner/nonce state', async () => {
  const f = await deployThotFixture({ activate: false });
  try {
    const { addresses, governor, options } = await setup(f);
    const artifact = f.artifacts.ThotGovernor;
    const code = await f.provider.getCode(options.governor);
    const bytes = Buffer.from(code.slice(2), 'hex');
    const references = Object.values(artifact.evm.deployedBytecode.immutableReferences).flat();
    assert.ok(references.length > 0);
    for (const { start, length } of references) {
      const forged = Buffer.from(bytes);
      forged.fill(0, start, start + length); forged[start + length - 1] = 2;
      assert.throws(() => verifyThotGovernorRuntime(artifact, '0x' + forged.toString('hex')), /GOVERNOR_IMMUTABLE_THRESHOLD_MISMATCH/);
    }
    const forged = Buffer.from(bytes); forged[0] ^= 1;
    assert.throws(() => verifyThotGovernorRuntime(artifact, code + '00'), /GOVERNOR_UNSUPPORTED_RUNTIME/);
    await f.provider.send('anvil_setCode', [options.governor, '0x' + forged.toString('hex')]);
    await assert.rejects(prepareThotDeployment(options), /GOVERNOR_UNSUPPORTED_RUNTIME/);
    await f.provider.send('anvil_setCode', [options.governor, code]);

    // The reviewed governor stores its fixed owner array in slots 0..2. Forging
    // one entry must not pass just because getOwners still returns three values.
    const ownerSlot = toBeHex(0, 32), originalOwner = await f.provider.getStorage(options.governor, ownerSlot);
    await f.provider.send('anvil_setStorageAt', [options.governor, ownerSlot, zeroPadValue(addresses[5], 32)]);
    await assert.rejects(prepareThotDeployment(options), /GOVERNOR_OWNER_MEMBERSHIP_MISMATCH/);
    await f.provider.send('anvil_setStorageAt', [options.governor, ownerSlot, zeroPadValue(addresses[1], 32)]);
    await assert.rejects(prepareThotDeployment(options), /GOVERNOR_REQUIRES_1_OF_3/);
    await f.provider.send('anvil_setStorageAt', [options.governor, ownerSlot, originalOwner]);

    // Slot 4 is nextNonce after the fixed owners and isOwner mapping.
    const nonceSlot = toBeHex(4, 32), originalNonce = await f.provider.getStorage(options.governor, nonceSlot);
    await f.provider.send('anvil_setStorageAt', [options.governor, nonceSlot, toBeHex(9, 32)]);
    assert.equal(await governor.nextNonce(), 9n);
    await assert.rejects(prepareThotDeployment(options), /GOVERNOR_NONCE_STATE_MISMATCH/);
    await f.provider.send('anvil_setStorageAt', [options.governor, nonceSlot, originalNonce]);
    assert.equal((await prepareThotDeployment(options)).governance.threshold, 1);
  } finally { await f.close(); }
});

test('planner retains legacy EOA delays, validates explicit starts and refuses unsupported chains', async () => {
  await assert.rejects(prepareThotDeployment({ expectedChainId: 1 }), /DEPLOYMENT_CHAIN_NOT_ENABLED/);
  const f = await deployThotFixture({ activate: false });
  try {
    const { addresses, token, options } = await setup(f);
    const legacy = { ...options, governor: addresses[6] };
    const plan = await prepareThotDeployment(legacy);
    assert.equal(plan.governance.mode, 'legacy-eoa');
    assert.match(plan.governance.warning, /not the selected 1-of-3/);
    assert.equal(plan.governance.queue.from, addresses[6]);
    assert.equal(plan.governance.execute.from, addresses[6]);
    assert.equal(plan.governance.queueFlow, undefined);
    assert.equal(plan.waitWindowsSeconds.reserveGovernance, DAY);
    assert.equal(plan.waitWindowsSeconds.marketGovernance, 7 * DAY);
    assert.equal(plan.governance.proposedCampaignStart, plan.observedBlock.timestamp + 2 * DAY);
    assert.equal(plan.governance.queueBefore, plan.governance.proposedCampaignStart - DAY);
    assert.equal(plan.governance.campaignEndsAt, plan.governance.proposedCampaignStart + 360 * DAY);
    assert.match(plan.governance.executePrecondition, /late activation does not reset/);
    const sameSigner = await prepareThotDeployment({ ...legacy, governor: addresses[0] });
    assert.equal(Number(sameSigner.governance.queue.nonce), sameSigner.deployerNonce + sameSigner.deploymentTransactions.length);
    const scheduled = await prepareThotDeployment({ ...options, campaignStart: plan.governance.proposedCampaignStart });
    assert.equal(scheduled.governance.campaignStartMode, 'scheduled');
    assert.equal(scheduled.governance.queueBefore, scheduled.governance.proposedCampaignStart);
    assert.equal(scheduled.governance.campaignEndsAt, scheduled.governance.proposedCampaignStart + 360 * DAY);
    await assert.rejects(prepareThotDeployment({ ...options, governor: await token.getAddress() }), /GOVERNOR_UNSUPPORTED_RUNTIME/);
    await assert.rejects(prepareThotDeployment({ ...options, campaignStart: await f.now() - 1 }), /CAMPAIGN_START_TOO_EARLY/);
    await assert.rejects(prepareThotDeployment({ ...legacy, campaignStart: 0 }), /CAMPAIGN_START_TOO_EARLY/);
    await assert.rejects(prepareThotDeployment({ ...legacy, campaignStart: await f.now() + DAY - 1 }), /CAMPAIGN_START_TOO_EARLY/);
  } finally { await f.close(); }
});

test('pending deployer transactions block address prediction; confirmed unrelated sends require a fresh plan', async () => {
  const f = await deployThotFixture({ activate: false });
  try {
    const { addresses, options } = await setup(f);
    const before = await prepareThotDeployment(options);
    await f.provider.send('evm_setAutomine', [false]);
    await f.admin.sendTransaction({ to: addresses[5], value: 1n, gasLimit: 21000n });
    await assert.rejects(prepareThotDeployment(options), /DEPLOYER_HAS_PENDING_TRANSACTIONS/);
    await f.provider.send('evm_setAutomine', [true]);
    await f.provider.send('evm_mine', []);
    const after = await prepareThotDeployment(options);
    assert.equal(after.deployerNonce, before.deployerNonce + 1);
    assert.notDeepEqual(after.predictedAddresses, before.predictedAddresses);
    assert.equal(Number(after.deploymentTransactions[0].transaction.nonce), after.deployerNonce);
  } finally { await f.close(); }
});
