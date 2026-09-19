import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AbiCoder, Contract, ContractFactory, Interface, JsonRpcProvider, getAddress, getCreateAddress, keccak256, parseEther, toQuantity } from 'ethers';
import solc from 'solc';
import { compileThot } from './thot-local-fixture.mjs';

const DAY = 86400;
const CAMPAIGN_DURATION = 360 * DAY;
const SUPPLY = parseEther('1000000000');
const RESERVE = parseEther('500000000');
const TOKEN_ABI = ['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)'];
const asAddress = (value, name) => { const address = getAddress(value); if (/^0x0{40}$/i.test(address)) throw Error(name + ' must not be zero'); return address; };
const fail = (condition, message) => { if (!condition) throw Error(message); };

/** Match every reviewed runtime byte and decode the sole immutable, THRESHOLD. */
export function verifyThotGovernorRuntime(artifact, code) {
  const bytecode = artifact.evm.deployedBytecode;
  const groups = Object.values(bytecode.immutableReferences ?? {});
  fail(groups.length === 1 && groups[0].length > 0, 'GOVERNOR_IMMUTABLE_LAYOUT_UNSUPPORTED');
  fail(/^0x(?:[a-fA-F0-9]{2})+$/.test(code), 'GOVERNOR_UNSUPPORTED_RUNTIME');
  const expected = Buffer.from(bytecode.object, 'hex');
  const actual = Buffer.from(code.slice(2), 'hex');
  fail(expected.length === actual.length, 'GOVERNOR_UNSUPPORTED_RUNTIME');
  const references = [...groups[0]].sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const { start, length } of references) {
    fail(Number.isSafeInteger(start) && start >= previousEnd && length === 32 && start + length <= expected.length,
      'GOVERNOR_IMMUTABLE_LAYOUT_UNSUPPORTED');
    fail(expected.subarray(start, start + length).every(byte => byte === 0), 'GOVERNOR_IMMUTABLE_LAYOUT_UNSUPPORTED');
    fail(BigInt('0x' + actual.subarray(start, start + length).toString('hex')) === 1n, 'GOVERNOR_IMMUTABLE_THRESHOLD_MISMATCH');
    actual.fill(0, start, start + length);
    previousEnd = start + length;
  }
  fail(expected.equals(actual), 'GOVERNOR_UNSUPPORTED_RUNTIME: only the reviewed ThotGovernor 1-of-3 controller is supported');
  return { runtimeCodeHash: keccak256(code), reviewedRuntimeHash: keccak256(expected), immutableThreshold: 1,
    immutableReferenceCount: references.length };
}

/** One listed owner submits, approves and executes atomically; no signer is requested. */
function governorFlow({ chainId, governor, owners, nextNonce, target, data, governorInterface }) {
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'address', 'bytes32'],
    [chainId, governor, nextNonce, target, keccak256(data)],
  ));
  const transaction = (from, functionName, args) => ({ from, to: governor, chainId: toQuantity(chainId), value: '0x0', data: governorInterface.encodeFunctionData(functionName, args) });
  return {
    expectedGovernorNonce: nextNonce.toString(), expectedOperationId: operationId,
    expectedNonceIsAdvisory: true, target, targetCalldata: data, requiredApprovals: 1, eligibleSigners: owners,
    transactions: [
      { action: 'submit-and-execute', approvalNumber: 1, transaction: transaction(owners[0], 'submitAndExecute', [target, data]) },
    ],
    nonceRecovery: {
      submitCalldataIsNonceIndependent: true,
      rule: 'An intervening proposal changes the predicted id, not this submitAndExecute calldata. Recheck target preconditions, then verify the actual Submitted and Executed events from this governor and operation(actualId). No confirmation or relay using a predicted id is needed. If a transaction outcome is unknown, recover its receipt before retrying; do not submit a duplicate operation.',
      submissionFunction: 'submitAndExecute(address,bytes)', operationIdSource: 'Submitted(bytes32,uint256,address,bytes) receipt event from this governor',
    },
    preconditions: [
      'Before signing, verify the target runtime and bindings, the current listed owner and threshold=1, and the target action preconditions. Read nextNonce for diagnostics; its prediction is advisory because it is not encoded in this transaction.',
      'Any one listed owner may send submitAndExecute. The first owner is only the unsigned plan default; no signature is included or fabricated. An outsider cannot submit it.',
      'After confirmation, verify Submitted and Executed receipt events from this governor, the exact target/calldata, and operation(actualId).executed=true. A failed target call reverts the whole submission.',
      'Choose fresh wallet transaction nonces and estimate fees at each signature. Governor proposal nonces and owner wallet transaction nonces are different counters.',
    ],
  };
}

/** Public RPC reads and unsigned calldata only. Never requests a signer or broadcasts. */
export async function prepareThotDeployment(options) {
  const expectedChainId = Number(options.expectedChainId);
  fail(Number.isSafeInteger(expectedChainId) && expectedChainId > 0, 'expectedChainId must be a positive safe integer');
  fail([31337, 46630].includes(expectedChainId), 'DEPLOYMENT_CHAIN_NOT_ENABLED: the current market is testnet-only; production parameters and deployment are not enabled');
  const endpoint = new URL(options.rpcUrl);
  fail(['http:', 'https:'].includes(endpoint.protocol), 'RPC must use HTTP(S)');
  const tokenAddress = asAddress(options.token, 'token');
  const deployer = asAddress(options.deployer, 'deployer');
  const governor = asAddress(options.governor, 'governor');
  const operator = asAddress(options.operator, 'operator');
  const protocolRecipient = asAddress(options.protocolRecipient, 'protocolRecipient');
  const provider = new JsonRpcProvider(options.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  try {
    const network = await provider.getNetwork();
    fail(network.chainId === BigInt(expectedChainId), 'CHAIN_ID_MISMATCH');
    const block = await provider.getBlock('latest'); fail(block, 'LATEST_BLOCK_UNAVAILABLE');
    const at = { blockTag: block.number };
    const tokenCode = await provider.getCode(tokenAddress, block.number);
    fail(tokenCode !== '0x', 'TOKEN_NOT_DEPLOYED');
    fail(await provider.getCode(deployer, block.number) === '0x', 'DEPLOYER_MUST_BE_EOA: contract-wallet deployments require a separate CREATE execution plan');
    const token = new Contract(tokenAddress, TOKEN_ABI, provider);
    const [decimals, totalSupply, reserveBalance, pendingNonce, latestNonce, governorCode] = await Promise.all([
      token.decimals(at), token.totalSupply(at), token.balanceOf(deployer, at),
      provider.getTransactionCount(deployer, 'pending'), provider.getTransactionCount(deployer, block.number), provider.getCode(governor, block.number),
    ]);
    fail(decimals === 18n, 'THOT_REQUIRES_18_DECIMALS');
    fail(totalSupply === SUPPLY, 'THOT_REQUIRES_EXACT_1_BILLION_SUPPLY');
    fail(pendingNonce === latestNonce, 'DEPLOYER_HAS_PENDING_TRANSACTIONS: wait for confirmation before predicting contract addresses');
    const predicted = {
      locks: getCreateAddress({ from: deployer, nonce: pendingNonce }),
      reserve: getCreateAddress({ from: deployer, nonce: pendingNonce + 1 }),
      market: getCreateAddress({ from: deployer, nonce: pendingNonce + 2 }),
    };
    for (const address of Object.values(predicted)) fail(await provider.getCode(address, block.number) === '0x', 'PREDICTED_ADDRESS_ALREADY_DEPLOYED');
    const artifacts = await compileThot();
    let governorDetails;
    if (governorCode !== '0x') {
      const runtime = verifyThotGovernorRuntime(artifacts.ThotGovernor, governorCode);
      const governorContract = new Contract(governor, artifacts.ThotGovernor.abi, provider);
      const [rawOwners, threshold, immutableThreshold, nextNonce, operationCount] = await Promise.all([
        governorContract.getOwners(at), governorContract.getThreshold(at), governorContract.THRESHOLD(at), governorContract.nextNonce(at), governorContract.operationCount(at),
      ]);
      const owners = Array.from(rawOwners, value => asAddress(value, 'governor owner'));
      fail(owners.length === 3 && new Set(owners).size === 3 && threshold === 1n && immutableThreshold === 1n, 'GOVERNOR_REQUIRES_1_OF_3');
      fail((await Promise.all(owners.map((_owner, index) => governorContract.owners(index, at)))).every((owner, index) => getAddress(owner) === owners[index]), 'GOVERNOR_OWNER_ARRAY_MISMATCH');
      fail((await Promise.all(owners.map(owner => governorContract.isOwner(owner, at)))).every(Boolean), 'GOVERNOR_OWNER_MEMBERSHIP_MISMATCH');
      fail((await Promise.all(owners.map(owner => provider.getCode(owner, block.number)))).every(code => code === '0x'), 'GOVERNOR_OWNERS_MUST_BE_EOA: contract owners require their own nested execution plan');
      fail(nextNonce === operationCount, 'GOVERNOR_NONCE_STATE_MISMATCH');
      // Runtime and the three enumerated owners alone cannot establish that the
      // membership mapping was initialized by the reviewed constructor.
      const creationHash = options.governorCreationTransaction;
      fail(typeof creationHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(creationHash), 'GOVERNOR_CREATION_TRANSACTION_REQUIRED');
      const [creation, receipt] = await Promise.all([
        provider.getTransaction(creationHash), provider.getTransactionReceipt(creationHash),
      ]);
      fail(creation && receipt?.status === 1 && receipt.contractAddress && receipt.blockNumber <= block.number &&
        getAddress(receipt.contractAddress) === governor && creation.to === null && creation.chainId === BigInt(expectedChainId) &&
        getCreateAddress({from: creation.from, nonce: creation.nonce}) === governor, 'GOVERNOR_CREATION_MISMATCH');
      const constructorData = (await new ContractFactory(artifacts.ThotGovernor.abi, artifacts.ThotGovernor.evm.bytecode.object).getDeployTransaction(owners)).data;
      fail(creation.data.toLowerCase() === constructorData.toLowerCase(), 'GOVERNOR_CONSTRUCTOR_MISMATCH');
      fail((await provider.getBlock(receipt.blockNumber))?.hash === receipt.blockHash, 'GOVERNOR_CREATION_REORG');
      governorDetails = { mode: 'thot-governor-1-of-3', owners, threshold: 1, nextNonce: nextNonce.toString(),
        creationTransaction: creationHash, creationBlock: receipt.blockNumber, ...runtime };
    } else {
      const [governorPendingNonce, governorLatestNonce] = await Promise.all([
        provider.getTransactionCount(governor, 'pending'), provider.getTransactionCount(governor, block.number),
      ]);
      fail(governorPendingNonce === governorLatestNonce, 'GOVERNOR_HAS_PENDING_TRANSACTIONS: wait before preparing governor calldata');
      governorDetails = { mode: 'legacy-eoa', signer: governor, pendingNonce: governorPendingNonce, threshold: 1,
        warning: 'Single-wallet legacy governance. This has no three-owner controller and is not the selected 1-of-3 shared-governance configuration; legacy target delays remain.' };
    }
    const steps = [];
    const deploy = async (name, nonce, args, address) => {
      const artifact = artifacts[name];
      const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object);
      const data = (await factory.getDeployTransaction(...args)).data;
      steps.push({ action: 'deploy', contract: name, predictedAddress: address, constructorArguments: args,
        transaction: { from: deployer, chainId: toQuantity(expectedChainId), nonce: toQuantity(nonce), value: '0x0', data } });
    };
    await deploy('ThotLockVault', pendingNonce, [tokenAddress], predicted.locks);
    await deploy('ThotReserveVault', pendingNonce + 1, [tokenAddress, governor, operator], predicted.reserve);
    await deploy('ThotMarket', pendingNonce + 2, [tokenAddress, predicted.locks, predicted.reserve, governor, operator, protocolRecipient], predicted.market);
    steps.push({ action: 'fund-reserve', amountAtoms: RESERVE.toString(), transaction: {
      from: deployer, to: tokenAddress, chainId: toQuantity(expectedChainId), nonce: toQuantity(pendingNonce + 3), value: '0x0',
      data: new Interface(TOKEN_ABI).encodeFunctionData('transfer', [predicted.reserve, RESERVE]),
    } });
    const sharedGovernance = governorDetails.mode === 'thot-governor-1-of-3';
    const reserveGovernanceDelay = sharedGovernance ? 0 : DAY;
    const marketGovernanceDelay = sharedGovernance ? 0 : 7 * DAY;
    // Zero starts the selected controller's curve at actual activation. Legacy
    // EOA governance keeps a day for deployment plus its 24-hour reserve delay.
    const campaignStart = Number(options.campaignStart ?? (sharedGovernance ? 0 : block.timestamp + 2 * DAY));
    const activationTimeStart = sharedGovernance && campaignStart === 0;
    fail(Number.isSafeInteger(campaignStart) && (activationTimeStart || campaignStart >= block.timestamp + reserveGovernanceDelay), 'CAMPAIGN_START_TOO_EARLY');
    fail(campaignStart + CAMPAIGN_DURATION <= 8_640_000_000_000, 'CAMPAIGN_START_OUT_OF_RANGE');
    const reserveInterface = new Interface(artifacts.ThotReserveVault.abi);
    const operation = keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'address', 'uint64'], ['campaign', predicted.market, campaignStart]));
    const governance = {
      ...governorDetails, controller: governor, separateSigner: governor !== deployer, queueOperation: operation,
      campaignStartMode: activationTimeStart ? 'activation-time' : 'scheduled',
      proposedCampaignStart: campaignStart, proposedCampaignStartISO: activationTimeStart ? null : new Date(campaignStart * 1000).toISOString(),
      queueBefore: activationTimeStart ? null : campaignStart - reserveGovernanceDelay,
      campaignEndsAt: activationTimeStart ? null : campaignStart + CAMPAIGN_DURATION,
      campaignDurationSeconds: CAMPAIGN_DURATION,
      queuePrecondition: activationTimeStart
        ? 'After deployments and reserve funding confirm, queueCampaign(market,0) may execute immediately. Verify reserve.startAt()=0 and the exact market/token/governor bindings. Queuing alone does not activate the campaign.'
        : 'The reserve queueCampaign call must execute by queueBefore; merely submitting a governor proposal does not queue the reserve action. If missed before queueing, prepare a new start timestamp.',
      executePrecondition: activationTimeStart
        ? 'After the reserve queue call confirms, verify reserve.queued(queueOperation) is nonzero and reached. executeCampaign(market,0) may run immediately; read CampaignStarted and reserve.startAt() for the actual activation timestamp. The campaign ends that timestamp plus campaignDurationSeconds; no absolute start or end is known before activation.'
        : 'After the reserve queue call confirms, read reserve.queued(queueOperation). Activate no earlier than that timestamp and strictly before campaignEndsAt. Activation after proposedCampaignStart is allowed; startAt remains the original proposedCampaignStart, so late activation does not reset or extend the declining curve.',
    };
    const queueData = reserveInterface.encodeFunctionData('queueCampaign', [predicted.market, campaignStart]);
    const executeData = reserveInterface.encodeFunctionData('executeCampaign', [predicted.market, campaignStart]);
    if (sharedGovernance) {
      const common = { chainId: expectedChainId, governor, owners: governorDetails.owners, target: predicted.reserve, governorInterface: new Interface(artifacts.ThotGovernor.abi) };
      governance.queueFlow = governorFlow({ ...common, nextNonce: BigInt(governorDetails.nextNonce), data: queueData });
      governance.activationFlow = governorFlow({ ...common, nextNonce: BigInt(governorDetails.nextNonce) + 1n, data: executeData });
      governance.operationOrdering = 'Confirm queueFlow before activationFlow. Each flow uses one listed owner and submitAndExecute, with no governance delay. Expected proposal nonces and ids are advisory; intervening proposals do not change either calldata. Recheck target state and use actual receipt ids. Reserve spending, custody and dispute limits still apply.';
    } else {
      const governorNonce = governor === deployer ? pendingNonce + steps.length : governorDetails.pendingNonce;
      governance.queue = { from: governor, to: predicted.reserve, chainId: toQuantity(expectedChainId), nonce: toQuantity(governorNonce), value: '0x0', data: queueData };
      governance.execute = { from: governor, to: predicted.reserve, chainId: toQuantity(expectedChainId), value: '0x0', data: executeData };
    }
    const sources = {};
    for (const name of ['ThotLockVault.sol', 'ThotMarket.sol', 'ThotReserveVault.sol', 'ThotGovernor.sol', 'ThotBudgetSchedule.sol', 'TokenInterfaces.sol']) {
      sources[name] = createHash('sha256').update(await readFile(new URL('../src/' + name, import.meta.url))).digest('hex');
    }
    const blockers = ['Legacy testnet rehearsal only: this planner funds the old 500M acquisition vault and omits staking. It cannot implement the finalized 470M acquisition / 30M staking allocation; prepare and verify a fresh combined launch plan before production funding.'];
    if (reserveBalance < RESERVE) blockers.push('Deployer does not currently own the 500,000,000 THOT required for reserve funding. Acquiring tokens may consume the predicted deployer nonce: regenerate this plan afterward.');
    return {
      schema: 'thot.unsigned-deployment-plan/3', mechanism: '0.9', unsignedOnly: true, broadcast: false,
      chainId: expectedChainId, rpcHost: endpoint.hostname, observedBlock: { number: block.number, hash: block.hash, timestamp: block.timestamp },
      token: { address: tokenAddress, decimals: Number(decimals), totalSupplyAtoms: totalSupply.toString(), runtimeCodeHash: keccak256(tokenCode), deployerBalanceAtoms: reserveBalance.toString() },
      parties: { deployer, governor, operator, protocolRecipient }, predictedAddresses: predicted, deployerNonce: pendingNonce,
      compiler: solc.version(), optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'shanghai', sourceSha256: sources,
      deploymentTransactions: steps, governance, blockers,
      waitWindowsSeconds: { governance: reserveGovernanceDelay, reserveGovernance: reserveGovernanceDelay, marketGovernance: marketGovernanceDelay, campaignDuration: CAMPAIGN_DURATION, lockSeasoning: 7 * DAY, lockPrincipalMinimum: 90 * DAY, disputeAfterDelivery: 12 * 3600 },
      preconditions: [
        'This is calldata preparation, not a production security audit or proof the supplied token is the official Pons token. Independently verify token provenance and the chosen administrators.',
        'Confirm token, chain, unchanged deployer nonce and compiled sources immediately before signing. Execute deployments sequentially in the stated order; an unrelated deployer transaction invalidates later address predictions.',
        'Wallet must estimate gas/fees before each signature. No gas cost, gas limit or profitable token-price assumption is fabricated here.',
        'After deployment verify all runtime code hashes, constructor bindings, reserve balance and operator/governor recipients; publish those observations before enabling the app.',
        'The current application accepts isolated local chain 31337 and guarded Robinhood testnet chain 46630 only. This plan does not remove the public-payment activation gate or configure TEE signing custody.',
      ],
    };
  } finally { provider.destroy(); }
}

async function main() {
  const argv = process.argv.slice(2), values = {};
  if (argv.includes('--help')) {
    console.log('Unsigned only: node contracts/scripts/prepare-thot-deployment.mjs --rpc-env THOT_RPC_URL --expected-chain-id 31337 --token 0x... --deployer 0x... --governor 0x... --operator 0x... --protocol-recipient 0x... --output work/thot-deployment-plan.json');
    console.log('Alternatively --rpc URL. No private key argument is supported; RPC URLs are excluded from the output.');
    console.log('Deploy the selected 1-of-3 ThotGovernor first and pass its address as --governor and direct creation receipt hash as --governor-creation-transaction. Any one listed owner can submitAndExecute queue and activation. The default campaign-start 0 uses actual activation time. An EOA retains legacy governance delays. Only local/testnet chain IDs 31337 and 46630 are supported.'); return;
  }
  const known = new Set(['rpc', 'rpc-env', 'expected-chain-id', 'token', 'deployer', 'governor', 'governor-creation-transaction', 'operator', 'protocol-recipient', 'campaign-start', 'output']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    fail(argv[i]?.startsWith('--') && known.has(key) && argv[i+1] && !argv[i+1].startsWith('--'), 'Unknown or incomplete argument; use --help');
    fail(values[key] === undefined, 'Duplicate argument: ' + key); values[key] = argv[i+1];
  }
  fail(!(values.rpc && values['rpc-env']), 'Choose --rpc or --rpc-env');
  const rpcUrl = values.rpc ?? (values['rpc-env'] ? process.env[values['rpc-env']] : undefined);
  fail(rpcUrl, 'RPC missing: prefer --rpc-env to keep credentials out of shell arguments');
  fail(values.output, '--output is required');
  const plan = await prepareThotDeployment({ rpcUrl, expectedChainId: values['expected-chain-id'], token: values.token, deployer: values.deployer, governor: values.governor, governorCreationTransaction: values['governor-creation-transaction'], operator: values.operator, protocolRecipient: values['protocol-recipient'], campaignStart: values['campaign-start'] });
  await mkdir(dirname(values.output), { recursive: true }); await writeFile(values.output, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ unsignedOnly: true, broadcast: false, chainId: plan.chainId, predictedAddresses: plan.predictedAddresses, transactions: plan.deploymentTransactions.length, governorMode: plan.governance.mode, separateGovernor: plan.governance.separateSigner, reserveDelaySeconds: plan.waitWindowsSeconds.reserveGovernance, blockers: plan.blockers, output: values.output }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => {
  // Ethers errors can embed RPC credentials. Print known validation messages only.
  const message = String(error?.message ?? '');
  if (/^(CHAIN_ID_|TOKEN_NOT_|DEPLOYER_|DEPLOYMENT_|GOVERNOR_|THOT_REQUIRES_|PREDICTED_|CAMPAIGN_|RPC missing|Choose --rpc|Unknown or incomplete|Duplicate argument|--output)/.test(message)) console.error(message);
  else console.error('Unable to prepare deployment. Check the RPC connection and all required addresses/arguments. No transaction was sent.');
  process.exitCode = 1;
});
