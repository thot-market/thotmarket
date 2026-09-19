import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther as u, id, MaxUint256, keccak256 } from 'ethers';
import { deployThotFixture } from '../scripts/thot-local-fixture.mjs';
import { ThotChain } from '../../packages/chain/thot.ts';
import { stakingWorkspace } from '../../packages/chain/thot-staking.ts';
import { ThotGovernance } from '../../packages/market/src/thot-governance.ts';
const DAY = 86400, tx = async p => (await p).wait();
let f, treasury, pool, token, gov, market, addresses, snapshot, locks, discounts;
before(async () => {
  f = await deployThotFixture({ activate: false });
  addresses = await Promise.all(f.signers.map(s => s.getAddress()));
  token = await f.deploy('ThotTestToken', [addresses[0], u('1000000000')]);
  gov = await f.deploy('ThotGovernor', [addresses.slice(0, 3)]);
  treasury = await f.deploy('ThotTreasury', [await token.getAddress(), await gov.getAddress(), addresses[5]]);
  pool = await f.deploy('ThotStakingPool', [await token.getAddress(), await treasury.getAddress()]);
  locks = await f.deploy('ThotLockVault', [await token.getAddress()]);
  market = await f.deploy('ThotMarket', [await token.getAddress(), await locks.getAddress(), await treasury.getAddress(), await gov.getAddress(), addresses[5], addresses[4]]);
  await govern('bindMarket', [await market.getAddress()]);
  await govern('bindStakingPool', [await pool.getAddress()]);
  discounts = await f.deploy('ThotFeeDiscounts', [await token.getAddress(), await pool.getAddress(), await gov.getAddress()]);
  await tx(gov.submitAndExecute(await discounts.getAddress(), discounts.interface.encodeFunctionData('setPolicy', [u('10000'), u('100000'), 1000, 2500])));
  await tx(gov.submitAndExecute(await market.getAddress(), market.interface.encodeFunctionData('bindFeeDiscounts', [await discounts.getAddress()])));
  await tx(token.transfer(await treasury.getAddress(), u('500000000')));
});
after(async () => { await f?.close(); });
beforeEach(async () => { snapshot = await f.provider.send('evm_snapshot', []); });
afterEach(async () => { await f.provider.send('evm_revert', [snapshot]); });
async function govern(method, args = []) {
  return tx(gov.submitAndExecute(await treasury.getAddress(), treasury.interface.encodeFunctionData(method, args)));
}
async function stakeCampaign(budget = u('30000000'), cap = u('100000000'), rate = 3000) {
  const start = await f.now() + 10;
  await govern('createStakingCampaign', [start, start + DAY, cap, budget, [[90 * DAY, rate]]]);
  return start;
}
async function acquire(budget, label = 'acquisition') {
  await govern('createCampaign', [id(label), budget, 0, 90 * DAY, budget]);
}
test('one 500M deposit backs both budgets without double allocation', async () => {
  assert.equal(await treasury.reserveVersion(), 3n);
  assert.equal(await pool.governor(), await treasury.getAddress());
  await acquire(u('470000000'));
  await stakeCampaign();
  assert.equal(await treasury.unallocatedBalance(), 0n);
  assert.equal(await token.balanceOf(await treasury.getAddress()), u('470000000'));
  assert.equal(await pool.protectedBalance(), u('30000000'));
  await assert.rejects(stakeCampaign(1n, 1n));
  await assert.rejects(acquire(1n, 'overpromise'));
  assert.ok(f.artifacts.ThotTreasury.evm.deployedBytecode.object.length / 2 < 24576);
});
test('closing unused acquisitions immediately permits larger staking budgets and vice versa', async () => {
  await acquire(u('470000000'));
  await stakeCampaign();
  await govern('cancelCampaign', [1]);
  await stakeCampaign(u('60000000'), u('200000000'));
  assert.equal(await treasury.unallocatedBalance(), u('410000000'));
  await govern('closeStakingCampaign', [2]);
  assert.equal(await treasury.unallocatedBalance(), u('470000000'));
  await govern('closeStakingCampaign', [1]);
  await acquire(u('500000000'), 'entire returned budget');
  assert.equal(await treasury.totalAllocated(), u('500000000'));
});
test('reallocation and new reward rates cannot seize principal or alter existing claims', async () => {
  const start = await stakeCampaign();
  await tx(token.transfer(addresses[2], u('100')));
  await tx(token.connect(f.seller).approve(await pool.getAddress(), MaxUint256));
  await f.warp(start);
  await tx(pool.connect(f.seller).stake(1, 0, u('100')));
  const position = await pool.positions(1);
  assert.equal(position.reward, u('30'));
  await govern('closeStakingCampaign', [1]);
  assert.equal(await pool.protectedBalance(), u('130'));
  assert.equal(await treasury.unallocatedBalance(), u('499999970'));
  await assert.rejects(pool.recoverFreeTokens.staticCall(addresses[0], u('1')));
  await govern('collectFreeStakingBudget');
  assert.equal(await token.balanceOf(await pool.getAddress()), u('130'));
  await stakeCampaign(u('200'), u('1000'), 2000);
  assert.deepEqual(Array.from(await pool.positions(1)), Array.from(position));
  await assert.rejects(pool.connect(f.seller).claim.staticCall(1));
  await f.warp(position.unlockAt);
  await tx(pool.connect(f.seller).claim(1));
  assert.equal(await token.balanceOf(addresses[2]), u('130'));
  await assert.rejects(pool.connect(f.seller).claim.staticCall(1));
});
test('failed campaign creation rolls back transfer and outsiders cannot change budgets', async () => {
  const before = await token.balanceOf(await treasury.getAddress());
  await assert.rejects(stakeCampaign(u('1'), u('100')));
  assert.equal(await token.balanceOf(await treasury.getAddress()), before);
  assert.equal(await token.balanceOf(await pool.getAddress()), 0n);
  await assert.rejects(treasury.connect(f.attacker).closeStakingCampaign.staticCall(1));
  await assert.rejects(treasury.connect(f.attacker).collectFreeStakingBudget.staticCall());
  await assert.rejects(govern('bindStakingPool', [await pool.getAddress()]));
});
test('funded escrow stays outside reallocation and a purchase does not spend staking backing', async () => {
  await stakeCampaign();
  await acquire(u('100'));
  const nonce = id('treasury purchase');
  const offer = { id: await market.offerId(await treasury.getAddress(), nonce), nonce,
    seller: addresses[2], gross: u('1'), licenseHash: id('license'), evidenceHash: id('trace') };
  assert.equal(await treasury.authorizedBuyers(addresses[0]), false);
  await assert.rejects(treasury.purchase.staticCall(1, offer, id('review')));
  await govern('setBuyer', [addresses[0], true]);
  await tx(treasury.purchase(1, offer, id('review')));
  assert.equal(await token.balanceOf(await market.getAddress()), u('1'));
  assert.equal(await token.balanceOf(await pool.getAddress()), u('30000000'));
  await govern('cancelCampaign', [1]);
  await govern('closeStakingCampaign', [1]);
  assert.equal(await treasury.unallocatedBalance(), u('499999999'));
  assert.equal(await token.balanceOf(await market.getAddress()), u('1'));
});

test('fee policy binds through the treasury to the financial governor, not an unbound pool', async () => {
  assert.equal(await discounts.governor(), await gov.getAddress());
  assert.equal(await discounts.staking(), await pool.getAddress());
  assert.equal(await market.feeDiscounts(), await discounts.getAddress());
  await assert.rejects(discounts.connect(f.attacker).setPolicy.staticCall(u('10000'), u('100000'), 1000, 2500), /GOVERNOR/);
  await tx(gov.submitAndExecute(await discounts.getAddress(), discounts.interface.encodeFunctionData('setPolicy', [u('10000'), u('100000'), 1000, 2500])));
  assert.equal(await discounts.version(), 2n);
  const unbound = await f.deploy('ThotStakingPool', [await token.getAddress(), await treasury.getAddress()]);
  await assert.rejects(f.deploy('ThotFeeDiscounts', [await token.getAddress(), await unbound.getAddress(), await gov.getAddress()]));
});

test('runtime pins and governance API support a single treasury with unsigned budget changes', async () => {
  const block = await f.provider.getBlock('latest');
  const config = { ...f.config, codeHashes: {}, feeDiscounts: await discounts.getAddress(), governor: await gov.getAddress(), staking: await pool.getAddress(),
    token: await token.getAddress(), locks: await locks.getAddress(), market: await market.getAddress(), reserve: await treasury.getAddress(),
    deploymentBlock: block.number, deploymentBlockHash: block.hash, localDeliverySigner: addresses[5],
    manualReserve: true, reserveCampaigns: true, sharedTreasury: true };
  for (const name of ['governor','staking','token','locks','market','reserve','feeDiscounts']) config.codeHashes[name] = keccak256(await f.provider.getCode(config[name]));
  const chain = new ThotChain(config);
  try {
    await chain.guard();
    const holderQuote = await chain.purchaseQuote(addresses[0], u('1'), addresses[2]);
    assert.equal(holderQuote.total, u('.99').toString());
    const api = new ThotGovernance(chain);
    const input = {action:'create_staking_campaign',params:{budget_thot:'30000000',principal_cap_thot:'100000000',enrollment_days:90,terms:[{duration_days:30,reward_bps:500},{duration_days:60,reward_bps:1200},{duration_days:90,reward_bps:3000}]}};
    await assert.rejects(api.prepare(addresses[5], input), /GOVERNANCE_OWNER_REQUIRED/);
    const prepared = await api.prepare(addresses[0], input);
    assert.equal(await pool.campaignCount(), 0n, 'preparation does not broadcast');
    assert.equal(prepared.review.contract_action, 'createStakingCampaign');
    await tx(f.admin.sendTransaction(prepared.transactions[0]));
    const state = await stakingWorkspace(chain, addresses[0]);
    assert.equal(state.campaigns[0].reward_budget, u('30000000').toString());
    assert.equal(state.campaigns[0].terms[2].reward_bps, 3000);
    const close = await api.prepare(addresses[0], {action:'close_staking_campaign',params:{campaign_id:'1'}});
    await tx(f.admin.sendTransaction(close.transactions[0]));
    assert.equal(await treasury.unallocatedBalance(), u('500000000'));
    const invalid = {...input,params:{...input.params,budget_thot:'1'}};
    await assert.rejects(api.prepare(addresses[0],invalid), /STAKING_BUDGET_BELOW_CAPACITY/);
    const legacyConfig = {...config,sharedTreasury:false};
    const legacy = new ThotChain(legacyConfig);
    try { await assert.rejects(legacy.guard(), /CAMPAIGN_RESERVE_REQUIRED/); } finally { legacy.close(); }
  } finally { chain.close(); }
});

test('shared treasury supports holder discounts and rejects unrelated governance or unbound pools', async () => {
  const otherGov = await f.deploy('ThotGovernor', [addresses.slice(0, 3)]);
  await assert.rejects(f.deploy('ThotFeeDiscounts', [await token.getAddress(), await pool.getAddress(), await otherGov.getAddress()]));
  const unboundPool = await f.deploy('ThotStakingPool', [await token.getAddress(), await treasury.getAddress()]);
  await assert.rejects(f.deploy('ThotFeeDiscounts', [await token.getAddress(), await unboundPool.getAddress(), await gov.getAddress()]));
  const start = await stakeCampaign();
  await tx(token.transfer(addresses[2], u('100000')));
  await tx(token.connect(f.seller).approve(await pool.getAddress(), MaxUint256));
  await f.warp(start);
  await tx(pool.connect(f.seller).stake(1, 0, u('100000')));
  assert.equal(await token.balanceOf(addresses[2]), 0n);
  assert.equal(await discounts.qualifyingBalance(addresses[2]), u('100000'));
  assert.equal(await discounts.discount(addresses[2], u('.04'), u('.03')), u('.01'));
  const policyHash = id('thot.introductory-tariff/1:C=0.01;O=0.02;buffer=20%;referral=20%;THOT');
  for (const action of ['queueTariff', 'executeTariff']) {
    await tx(gov.submitAndExecute(await market.getAddress(), market.interface.encodeFunctionData(action, [u('.01'), u('.02'), policyHash])));
  }
  const quote = await market.costQuote(u('1'));
  assert.equal(quote.serviceFee, u('.04'));
  assert.equal(quote.policyHash, policyHash);
});
