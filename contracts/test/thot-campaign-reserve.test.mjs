import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, ZeroAddress, ZeroHash, parseEther, id } from 'ethers';
import { deployThotFixture } from '../scripts/thot-local-fixture.mjs';

const DAY = 86400, units = parseEther;
const tx = async pending => (await pending).wait();
let f, token, gov, reserve, market, addresses, artifact;

before(async () => {
  f = await deployThotFixture({ activate: false });
  artifact = f.artifacts.ThotCampaignReserve;
  addresses = await Promise.all(f.signers.map(signer => signer.getAddress()));
  gov = await f.deploy('ThotGovernor', [[addresses[0], addresses[1], addresses[6]]]);
  token = await f.deploy('ThotTestToken', [addresses[0], units('1000000000')]);
  const locks = await f.deploy('ThotLockVault', [await token.getAddress()]);
  reserve = await deployReserve();
  market = await f.deploy('ThotMarket', [await token.getAddress(), await locks.getAddress(), await reserve.getAddress(), await gov.getAddress(), addresses[5], addresses[4]]);
  await tx(token.transfer(await reserve.getAddress(), units('470000000')));
  await govern('bindMarket', [await market.getAddress()]);
});
after(async () => { await f?.close(); });

async function deployReserve(governor = gov, asset = token) {
  const result = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, f.admin)
    .deploy(await asset.getAddress(), await governor.getAddress(), addresses[5]);
  await result.waitForDeployment(); return result;
}
async function isolated(fn) {
  const snapshot = await f.provider.send('evm_snapshot', []);
  try { await fn(); } finally { await f.provider.send('evm_revert', [snapshot]); }
}
async function govern(method, args = [], signer = f.admin, target = reserve) {
  return tx(gov.connect(signer).submitAndExecute(await target.getAddress(), target.interface.encodeFunctionData(method, args)));
}
async function campaign(label, { budget = units('50000000'), start = 0, duration = 90 * DAY, upfront = budget / 90n } = {}) {
  const receipt = await govern('createCampaign', [id(label), budget, start, duration, upfront]);
  return { campaignId: await reserve.campaignCount(), receipt };
}
async function input(label, gross = units('1')) {
  const nonce = id(label);
  return { id: await market.offerId(await reserve.getAddress(), nonce), nonce, seller: addresses[2], gross,
    licenseHash: id('licence:' + label), evidenceHash: id('material:' + label) };
}
const authorizationTypes = { SaleAuthorization: [
  { name: 'seller', type: 'address' }, { name: 'buyer', type: 'address' },
  { name: 'evidenceHash', type: 'bytes32' }, { name: 'licenseHash', type: 'bytes32' },
  { name: 'gross', type: 'uint256' }, { name: 'minSellerBps', type: 'uint16' },
  { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'bytes32' }, { name: 'maxUses', type: 'uint32' },
] };
async function authorize(offer, signer = f.seller) {
  const authorization = { seller: offer.seller, buyer: await reserve.getAddress(), evidenceHash: offer.evidenceHash,
    licenseHash: offer.licenseHash, gross: offer.gross, minSellerBps: 3000,
    validUntil: (await f.now()) + DAY, nonce: id('authorization:' + offer.id), maxUses: 1 };
  const signature = await signer.signTypedData({ name: 'thot market', version: '0.9', chainId: 31337,
    verifyingContract: await market.getAddress() }, authorizationTypes, authorization);
  return { authorization, signature };
}

test('immediate governance binds a funded market once and enables only the three owners as buyers', () => isolated(async () => {
  assert.equal(await reserve.reserveVersion(), 2n);
  assert.equal(await reserve.RESERVE(), units('470000000'));
  assert.equal(await reserve.GOVERNANCE_DELAY(), 0n);
  assert.equal(await market.GOVERNANCE_DELAY(), 0n);
  assert.equal(await market.acquisitionVault(), await reserve.getAddress());
  for (const index of [0, 1, 6]) assert.equal(await reserve.authorizedBuyers(addresses[index]), true);
  assert.equal(await reserve.authorizedBuyers(addresses[5]), false, 'maintenance operator has no implicit spending power');
  await assert.rejects(reserve.bindMarket.staticCall(await market.getAddress()), /GOVERNOR/);
  await assert.rejects(govern('bindMarket', [await market.getAddress()]));
  await assert.rejects(new ContractFactory(artifact.abi, artifact.evm.bytecode.object, f.admin)
    .deploy(await token.getAddress(), addresses[0], addresses[5]), 'an EOA cannot impersonate the three-owner controller');
  const unbound = await deployReserve();
  await assert.rejects(govern('bindMarket', [await market.getAddress()], f.admin, unbound), 'market must name this vault');
  const locks = await f.deploy('ThotLockVault', [await token.getAddress()]);
  const candidate = await f.deploy('ThotMarket', [await token.getAddress(), await locks.getAddress(), await unbound.getAddress(), await gov.getAddress(), addresses[5], addresses[4]]);
  await assert.rejects(govern('bindMarket', [await candidate.getAddress()], f.admin, unbound), 'binding requires 470M actually received');
  await assert.rejects(govern('createCampaign', [id('unfunded'), units('1'), 0, DAY, 0], f.admin, unbound));
  const { campaignId, receipt } = await campaign('immediate first campaign');
  const current = await reserve.campaign(campaignId);
  assert.equal(current.startAt, BigInt((await f.provider.getBlock(receipt.blockNumber)).timestamp));
  assert.equal(current.endAt - current.startAt, BigInt(90 * DAY));
  assert.equal(await reserve.remainingAllowance(campaignId), units('50000000') / 90n);
  assert.equal(await reserve.unallocatedBalance(), units('420000000'));
}));

test('campaign inputs cannot backdate, exceed allocation, or mutate an existing campaign', () => isolated(async () => {
  const valid = [id('valid'), units('1'), 0, DAY, 0];
  await assert.rejects(reserve.createCampaign.staticCall(...valid), /GOVERNOR/);
  await assert.rejects(govern('createCampaign', [ZeroHash, units('1'), 0, DAY, 0]));
  await assert.rejects(govern('createCampaign', [id('zero'), 0, 0, DAY, 0]));
  await assert.rejects(govern('createCampaign', [id('upfront'), units('1'), 0, DAY, units('2')]));
  await assert.rejects(govern('createCampaign', [id('duration0'), units('1'), 0, 0, 0]));
  await assert.rejects(govern('createCampaign', [id('durationlong'), units('1'), 0, 366 * DAY, 0]));
  await assert.rejects(govern('createCampaign', [id('past'), units('1'), (await f.now()) - 1, DAY, 0]));
  await assert.rejects(govern('createCampaign', [id('overflow'), units('1'), 2n ** 64n - 1n, DAY, 0]));
  await assert.rejects(reserve.campaign(0));
  await assert.rejects(reserve.remainingAllowance(1));
  const { campaignId } = await campaign('first allocation', { budget: units('300000000') });
  await assert.rejects(campaign('overpromise', { budget: units('170000001') }));
  assert.equal(await reserve.campaignCount(), 1n);
  assert.equal((await reserve.campaign(campaignId)).budget, units('300000000'));
  assert.equal(await reserve.totalAllocated(), units('300000000'));
  await campaign('second allocation', { budget: units('170000000') });
  assert.equal(await reserve.unallocatedBalance(), 0n);
  await tx(token.transfer(await reserve.getAddress(), units('100000000')));
  assert.equal(await reserve.unallocatedBalance(), 0n, 'donations do not expand the lifetime 470M ceiling');
  await assert.rejects(campaign('donation authority', { budget: 1n, upfront: 0 }));
}));

test('concurrent campaigns isolate commitments, retain unused allowance, and pause without stopping time', () => isolated(async () => {
  const start = (await f.now()) + 100;
  const { campaignId: first } = await campaign('first', { budget: units('9000'), start, duration: 90 * DAY, upfront: units('900') });
  const { campaignId: second } = await campaign('second', { budget: units('100'), start, duration: 90 * DAY, upfront: units('10') });
  assert.equal(await reserve.remainingAllowance(first), 0n);
  await f.warp(start);
  assert.equal(await reserve.unlockedBudget(first), units('900'));
  await tx(reserve.purchase(first, await input('first buy', units('900')), id('review')));
  await tx(reserve.connect(f.buyer).purchase(second, await input('second buy', units('10')), id('review')));
  assert.equal((await reserve.campaign(first)).committed, units('900'));
  assert.equal((await reserve.campaign(second)).committed, units('10'));
  await f.warp(start + 30 * DAY);
  assert.equal(await reserve.remainingAllowance(first), units('2700'), 'unused allowance accumulates across days');
  await govern('setCampaignPaused', [first, true], f.other);
  assert.equal(await reserve.remainingAllowance(first), 0n);
  assert.equal(await reserve.remainingAllowance(second), units('30'));
  await f.warp(start + 45 * DAY);
  await govern('setCampaignPaused', [first, false], f.buyer);
  assert.equal(await reserve.remainingAllowance(first), units('4050'), 'pause never stops the release clock');
  await govern('pause', [], f.other);
  assert.equal(await reserve.remainingAllowance(first), 0n);
  assert.equal(await reserve.remainingAllowance(second), 0n);
  await govern('unpause');
  await f.warp(start + 90 * DAY - 1);
  const expected = units('900') + units('8100') * BigInt(90 * DAY - 1) / BigInt(90 * DAY) - units('900');
  assert.equal(await reserve.remainingAllowance(first), expected, 'linear rounding is downward at the last valid second');
  await f.warp(start + 90 * DAY);
  assert.equal(await reserve.unlockedBudget(first), units('9000'));
  assert.equal(await reserve.remainingAllowance(first), 0n, 'campaign end is exclusive for purchases');
  await assert.rejects(reserve.purchase.staticCall(first, await input('late'), id('review')));
}));

test('cancellation and permissionless expiry release unspent allocation without releasing tokens to callers', () => isolated(async () => {
  const start = (await f.now()) + 100;
  const { campaignId: first } = await campaign('cancel', { budget: units('50000000'), start, upfront: units('100') });
  const { campaignId: second } = await campaign('expire', { budget: units('420000000'), start, duration: DAY, upfront: units('100') });
  await assert.rejects(reserve.connect(f.attacker).cancelCampaign.staticCall(first));
  await assert.rejects(reserve.connect(f.attacker).expireCampaign.staticCall(second));
  await f.warp(start);
  await tx(reserve.purchase(first, await input('committed before cancellation', units('100')), id('review')));
  await govern('cancelCampaign', [first], f.buyer);
  assert.equal(await reserve.remainingAllowance(first), 0n);
  assert.equal(await reserve.totalAllocated(), units('420000000'));
  assert.equal(await reserve.unallocatedBalance(), units('49999900'));
  await assert.rejects(govern('cancelCampaign', [first]));
  await assert.rejects(govern('setCampaignPaused', [first, false]));
  const beforeCaller = await token.balanceOf(addresses[5]);
  await f.warp(start + DAY);
  await tx(reserve.connect(f.attacker).expireCampaign(second));
  assert.equal(await reserve.totalAllocated(), 0n);
  assert.equal(await reserve.unallocatedBalance(), units('469999900'));
  assert.equal(await token.balanceOf(addresses[5]), beforeCaller);
  await assert.rejects(reserve.expireCampaign.staticCall(second));
  const { campaignId: third } = await campaign('reallocated', { budget: units('469999900'), upfront: 0 });
  assert.equal(third, 3n);
  await assert.rejects(campaign('above remaining lifetime authority', { budget: 1n, upfront: 0 }));
}));

test('buyer access, reviewed inputs, replay guards and exact allowances protect concurrent spending', () => isolated(async () => {
  const { campaignId: first } = await campaign('access', { budget: units('10'), upfront: units('10') });
  const { campaignId: second } = await campaign('replay second', { budget: units('10'), upfront: units('10') });
  const offer = await input('actual buy', units('10'));
  await assert.rejects(reserve.connect(f.attacker).purchase.staticCall(first, offer, id('review')), /BUYER/);
  await assert.rejects(reserve.purchase.staticCall(first, offer, ZeroHash), /ACQUISITION_REVIEW/);
  await assert.rejects(reserve.purchase.staticCall(first, { ...offer, evidenceHash: ZeroHash }, id('review')));
  await assert.rejects(reserve.purchase.staticCall(first, await input('over cap', units('11')), id('review')));
  await tx(reserve.purchase(first, offer, id('review')));
  assert.equal(await reserve.acquisitionCampaign(offer.id), first);
  assert.equal(await reserve.acquisitionBuyer(offer.id), addresses[0]);
  assert.equal(await token.allowance(await reserve.getAddress(), await market.getAddress()), 0n);
  await assert.rejects(reserve.connect(f.other).purchase.staticCall(second, offer, id('replay')));
  await assert.rejects(reserve.connect(f.other).cancelOffer.staticCall(offer.id));
  await govern('setBuyer', [addresses[0], false], f.buyer);
  await assert.rejects(reserve.purchase.staticCall(second, await input('revoked'), id('review')));
  await tx(reserve.cancelOffer(offer.id));
  assert.equal((await market.offers(offer.id)).status, 6n, 'revoked purchaser can cancel its already funded manual offer');
  await tx(reserve.connect(f.attacker).collectReturns());
  assert.equal(await token.balanceOf(await reserve.getAddress()), units('470000000'));
  assert.equal(await reserve.totalGrossCommitted(), units('10'));
  assert.equal(await reserve.remainingAllowance(first), 0n);
  assert.equal(await reserve.totalAllocated(), units('10'));
  await govern('cancelCampaign', [first]); await govern('cancelCampaign', [second]);
  assert.equal(await reserve.unallocatedBalance(), units('469999990'), 'returned principal cannot recycle lifetime authority');
  await assert.rejects(campaign('refund oversubscription', { budget: units('470000000'), upfront: 0 }));
  await assert.rejects(reserve.collectReturns.staticCall(), 'a refund cannot be claimed twice');
}));

test('authorized purchase failures roll back every ledger, and full delivery preserves seller and reserve accounting', () => isolated(async () => {
  const { campaignId } = await campaign('authorized sale', { budget: units('100'), upfront: units('100') });
  const offer = await input('signed sale', units('100'));
  const wrong = await authorize(offer, f.attacker);
  await assert.rejects(tx(reserve.purchaseAuthorized(campaignId, offer, wrong.authorization, wrong.signature, id('review'), { gasLimit: 2_000_000 })));
  assert.equal(await reserve.totalGrossCommitted(), 0n);
  assert.equal(await reserve.totalAllocated(), units('100'));
  assert.equal(await reserve.acquisitionCampaign(offer.id), 0n);
  assert.equal(await token.allowance(await reserve.getAddress(), await market.getAddress()), 0n);
  assert.equal(await token.balanceOf(await reserve.getAddress()), units('470000000'));
  await tx(market.connect(f.seller).registerReferrer(addresses[3]));
  const signed = await authorize(offer);
  await tx(reserve.connect(f.other).purchaseAuthorized(campaignId, offer, signed.authorization, signed.signature, id('review')));
  const sale = await market.offers(offer.id);
  assert.equal(sale.status, 2n);
  assert.equal(sale.treasury, true);
  assert.equal(sale.independent, false);
  assert.equal(sale.referralAmount, 0n);
  assert.equal(await reserve.totalAllocated(), 0n);
  assert.equal(await reserve.totalGrossCommitted(), units('100'));
  await assert.rejects(reserve.connect(f.other).cancelOffer.staticCall(offer.id), 'funded automatic sale cannot be cancelled as an unaccepted manual offer');
  await assert.rejects(reserve.dispute.staticCall(offer.id, id('complaint')));
  await tx(market.connect(f.attacker).markDelivered(offer.id, id('delivery')));
  const delivered = await market.offers(offer.id);
  await f.warp(Number(delivered.deliveredAt) + 12 * 3600);
  await tx(market.finalize(offer.id));
  const sellerBefore = await token.balanceOf(addresses[2]);
  await tx(market.claimFor(addresses[2]));
  await tx(reserve.collectReturns());
  const fee = offer.gross - sale.sellerAmount;
  assert.equal(await token.balanceOf(addresses[2]), sellerBefore + sale.sellerAmount);
  assert.equal(await token.balanceOf(await reserve.getAddress()), units('470000000') - offer.gross + fee);
  assert.equal(await reserve.totalGrossCommitted(), offer.gross, 'retained treasury fees do not reset gross consumption');
  assert.equal(await reserve.remainingAllowance(campaignId), 0n);
  assert.equal(await reserve.unallocatedBalance(), units('469999900'));
  assert.equal(await market.claimable(addresses[3]), 0n);
  assert.equal(await market.escrowLiability(), 0n);
  assert.equal(await market.claimLiability(), 0n);
}));
