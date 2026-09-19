import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseEther, id, ZeroHash, ZeroAddress, MaxUint256, TypedDataEncoder, Signature, concat, toBeHex } from 'ethers';
import { deployThotFixture } from '../scripts/thot-local-fixture.mjs';
import { prepareThotDeployment } from '../scripts/prepare-thot-deployment.mjs';

const DAY = 86400;
const HOUR = 3600;
const DISPUTE_WINDOW = 12 * HOUR;
const units = parseEther;
let f;
before(async () => { f = await deployThotFixture(); });
after(async () => { await f?.close(); });
async function isolated(fn) { const snapshot = await f.provider.send('evm_snapshot', []); try { await fn(); } finally { await f.provider.send('evm_revert', [snapshot]); } }
const addr = signer => signer.getAddress();
const tx = async value => (await value).wait();
async function lock(signer, amount, days = 120) {
  // Pin the deposit block: an exact 90-day term must not become 89d23h59m59s
  // when wall time advances between reading the head and transaction mining.
  const timestamp = (await f.now()) + 1;
  await f.provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await tx(f.locks.connect(signer).deposit(units(String(amount)), timestamp + days * DAY));
}
async function offered(label, { reviewed = false, treasury = false, gross = units('100000'), sellerAddress } = {}) {
  const buyerAddress = treasury ? await f.reserve.getAddress() : await addr(f.buyer);
  const input = await f.input(label, { buyerAddress, gross, ...(sellerAddress ? { sellerAddress } : {}) });
  if (reviewed) await tx(f.market.reviewOffer(buyerAddress, input, id(label + ':independence-reviewed'), true));
  if (treasury) await tx(f.reserve.purchase(input, id(label + ':assay-review')));
  else {
    const quote = await f.market.buyerQuote(buyerAddress, input.gross);
    await tx(f.market.connect(f.buyer).createOffer(input, quote.total));
  }
  return input;
}
async function accept(input, seller = f.seller) { await tx(f.market.connect(seller).acceptOffer(input.id, await f.market.quoteDigest(input.id))); }
async function deliver(input, signer = f.buyer) { await tx(f.market.connect(signer).markDelivered(input.id, id('delivered:' + input.id))); }
async function finish(input, seller = f.seller) { await accept(input, seller); await deliver(input, f.admin); await f.advance(DISPUTE_WINDOW); await tx(f.market.finalize(input.id)); }
async function qualifyForSubjectiveDispute(label = 'prior reviewed spend') {
  const input = await offered(label, { reviewed: true, gross: units('10000000'), sellerAddress: await addr(f.other) });
  await finish(input, f.other);
  assert.equal(await f.market.finalizedIndependentSpend(await addr(f.buyer)), units('10000000'));
  return input;
}
const authorizationTypes = { SaleAuthorization: [
  { name: 'seller', type: 'address' }, { name: 'buyer', type: 'address' },
  { name: 'evidenceHash', type: 'bytes32' }, { name: 'licenseHash', type: 'bytes32' },
  { name: 'gross', type: 'uint256' }, { name: 'minSellerBps', type: 'uint16' },
  { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'bytes32' }, { name: 'maxUses', type: 'uint32' },
] };
const reviewTypes = { ReviewAuthorization: [
  { name: 'inputDigest', type: 'bytes32' }, { name: 'reviewHash', type: 'bytes32' },
  { name: 'validUntil', type: 'uint64' },
] };
async function signedAuthorization(input, overrides = {}, signer = f.seller, domainOverrides = {}) {
  const domain = { name: 'thot market', version: '0.9', chainId: 31337, verifyingContract: await f.market.getAddress(), ...domainOverrides };
  const authorization = { seller: input.seller, buyer: ZeroAddress, evidenceHash: input.evidenceHash,
    licenseHash: input.licenseHash, gross: input.gross, minSellerBps: 3000,
    validUntil: (await f.now()) + 30 * DAY, nonce: id('sale authorization:' + input.id), maxUses: 1, ...overrides };
  return { authorization, signature: await signer.signTypedData(domain, authorizationTypes, authorization), domain };
}
async function signedReview(input, { buyer = f.buyer, signer = f.admin, reviewOverrides = {}, domainOverrides = {} } = {}) {
  const domain = { name: 'thot market', version: '0.9', chainId: 31337, verifyingContract: await f.market.getAddress(), ...domainOverrides };
  const review = { inputDigest: await f.market.inputDigest(await addr(buyer), input),
    reviewHash: id('independent review:' + input.id), validUntil: (await f.now()) + DAY, ...reviewOverrides };
  return { review, signature: await signer.signTypedData(domain, reviewTypes, review), domain };
}
async function reviewLegacyAuthorizedOffer(input) {
  await tx(f.market.reviewOffer(await addr(f.buyer), input, id('legacy authorization review:' + input.id), true));
}
async function nextAuthorizedInput(input, label, buyerAddress) {
  const nonce = id(label);
  return { ...input, nonce, id: await f.market.offerId(buyerAddress ?? await addr(f.buyer), nonce) };
}
async function solvent() {
  const liabilities = await f.market.escrowLiability() + await f.market.claimLiability();
  assert.equal(await f.token.balanceOf(await f.market.getAddress()), liabilities);
  assert.equal(await f.token.balanceOf(await f.locks.getAddress()), await f.locks.totalPrincipal());
}


test('new contracts compile below EIP-170 and use actual isolated Anvil, not mocked settlement', () => isolated(async () => {
  assert.equal(await f.provider.send('eth_chainId', []), '0x7a69');
  assert.match(await f.provider.send('web3_clientVersion', []), /anvil/i);
  assert.equal(await f.market.DISPUTE_WINDOW(), BigInt(DISPUTE_WINDOW));
  assert.equal(await f.market.QUOTE_LIFETIME(), BigInt(DAY));
  for (const [name, artifact] of Object.entries(f.artifacts)) assert.ok(artifact.evm.deployedBytecode.object.length / 2 < 24576, name);
  for (const key of ['token', 'locks', 'market', 'reserve']) assert.notEqual(await f.provider.getCode(f.config[key]), '0x');
}));

test('fixed standard token works without mint, burn, transfer tax, staking hook, or operator token control', () => isolated(async () => {
  const names = f.token.interface.fragments.filter(x => x.type === 'function').map(x => x.name);
  for (const unsupported of ['mint', 'burn', 'owner', 'setTax']) assert.equal(names.includes(unsupported), false);
  const input = await offered('plain token'); await finish(input);
  assert.equal(await f.token.totalSupply(), units('1000000000'));
  await solvent();
}));

test('lock compatibility views are neutral ceilings, never sale or referral tiers', () => isolated(async () => {
  for (const amount of [0n,units('10000'),units('100000'),units('5000000'),MaxUint256]) {
    assert.equal(await f.locks.sellerBpsFor(amount),10000n);
    assert.equal(await f.locks.referralBpsFor(amount),2000n);
  }
}));

test('locks enforce minimum 90 days, full seven-day seasoning, separate top-up age, and ten remaining days', () => isolated(async () => {
  const now = await f.now();
  await assert.rejects(f.locks.connect(f.seller).deposit.staticCall(units('10000'), now + 89 * DAY));
  await lock(f.seller, '10000', 90);
  let lot = await f.locks.lot(await addr(f.seller), 0);
  await f.warp(Number(lot.depositedAt) + 7 * DAY - 1);
  assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), 0n);
  await f.advance(1); assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), units('10000'));
  await lock(f.seller, '90000', 120);
  assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), units('10000'));
  await f.warp(Number(lot.unlockAt) - 10 * DAY);
  assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), units('100000'));
  await f.advance(1); assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), units('90000'));
  await solvent();
}));

test('lot extension preserves age; expired lot cannot be revived; redeposit seasons again', () => isolated(async () => {
  await lock(f.seller, '100000', 90); await f.advance(7 * DAY);
  const first = await f.locks.lot(await addr(f.seller), 0);
  await tx(f.locks.connect(f.seller).extend(0, Number(first.unlockAt) + 20 * DAY));
  assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), units('100000'));
  const extended = await f.locks.lot(await addr(f.seller), 0);
  assert.equal(extended.depositedAt, first.depositedAt);
  await f.warp(Number(extended.unlockAt));
  await assert.rejects(f.locks.connect(f.seller).extend.staticCall(0, Number(extended.unlockAt) + DAY));
  await tx(f.locks.connect(f.seller).withdraw(0));
  await lock(f.seller, '100000', 90);
  assert.equal(await f.locks.qualifiedBalance(await addr(f.seller)), 0n);
  assert.equal(await f.locks.lotCount(await addr(f.seller)), 1n);
}));

test('seller principal cannot be withdrawn early, moved by another wallet, or paused by governance', () => isolated(async () => {
  await lock(f.seller, '100000', 90);
  await assert.rejects(f.locks.connect(f.seller).withdraw.staticCall(0));
  await assert.rejects(f.locks.connect(f.attacker).withdraw.staticCall(0));
  await tx(f.market.pause()); await tx(f.reserve.pause());
  const lot = await f.locks.lot(await addr(f.seller), 0); await f.warp(Number(lot.unlockAt));
  const before = await f.token.balanceOf(await addr(f.seller)); await tx(f.locks.connect(f.seller).withdraw(0));
  assert.equal(await f.token.balanceOf(await addr(f.seller)), before + units('100000'));
  const names = f.locks.interface.fragments.filter(x => x.type === 'function').map(x => x.name);
  for (const absent of ['transfer', 'transferFrom', 'delegate', 'sweep', 'pause']) assert.equal(names.includes(absent), false);
}));

test('explicit no-membership buyer pricing charges zero and never excludes a low-balance buyer', () => isolated(async () => {
  const gross = units('10'), buyer = await addr(f.buyer);
  const balance = await f.token.balanceOf(buyer);
  await tx(f.token.connect(f.buyer).transfer(await addr(f.other), balance - gross));
  const quote = await f.market.buyerQuote(buyer, gross);
  assert.deepEqual([...quote], [0n, gross, 0n, 0n]);
  assert.equal(await f.market.buyerEligible(buyer), true);
  const input = await f.input('ungated low-balance buyer', { gross });
  await assert.rejects(f.market.connect(f.buyer).createOffer.staticCall(input, gross - 1n));
  await tx(f.market.connect(f.buyer).createOffer(input, gross));
  assert.deepEqual([...(await f.market.paymentFor(input.id))].slice(0, 4), [gross, 0n, gross, 0n]);
  assert.equal(await f.token.balanceOf(buyer), 0n);
  await accept(input); // Holdings are never rechecked after the exact payment is escrowed.
  await solvent();
}));

test('governance timelocks a quoted tariff while buyers pay the posted price without surcharge', () => isolated(async () => {
  const policy=id('explicit quoted tariff');
  await assert.rejects(f.market.queueTariff.staticCall(0,0,ZeroHash));
  await tx(f.market.queueTariff(units('.02'),units('.04'),policy));
  await assert.rejects(f.market.executeTariff.staticCall(units('.02'),units('.04'),policy));
  await f.advance(7*DAY);await tx(f.market.executeTariff(units('.02'),units('.04'),policy));
  assert.equal(await f.market.buyerPricingTierCount(),1n);
  const buyer=await addr(f.buyer),gross=units('100000'),input=await f.input('priced buyer',{gross});
  const quote=await f.market.buyerQuote(buyer,gross);assert.deepEqual([...quote].slice(0,3),[0n,gross,0n]);
  await assert.rejects(f.market.connect(f.buyer).createOffer.staticCall(input,gross-1n));
  await tx(f.market.connect(f.buyer).createOffer(input,gross));
  assert.equal((await f.market.offers(input.id)).sellerAmount,gross-units('.08'));await solvent();
}));

test('buyer namespaces offer identifiers; contributor consent binds exact price/material/license/parties', () => isolated(async () => {
  const input = await f.input('exact consent');
  await assert.rejects(f.market.connect(f.attacker).createOffer.staticCall(input, input.gross));
  await tx(f.market.connect(f.buyer).createOffer(input, input.gross));
  await assert.rejects(f.market.connect(f.seller).acceptOffer.staticCall(input.id, id('different license')));
  await assert.rejects(f.market.connect(f.attacker).acceptOffer.staticCall(input.id, await f.market.quoteDigest(input.id)));
  await assert.rejects(f.market.connect(f.buyer).createOffer.staticCall(input, input.gross));
  await accept(input); await assert.rejects(f.market.connect(f.buyer).cancelOffer.staticCall(input.id));
}));

test('signed contribution consent atomically funds and accepts without a later seller transaction', () => isolated(async () => {
  const input = await f.input('automatic sale');
  const { authorization, signature, domain } = await signedAuthorization(input);
  assert.equal(await f.market.saleAuthorizationDigest(authorization), TypedDataEncoder.hash(domain, authorizationTypes, authorization));
  assert.equal(await f.market.hasAcceptedSale(input.seller), false);
  await reviewLegacyAuthorizedOffer(input);
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(input, authorization, signature, input.gross));
  const offer = await f.market.offers(input.id);
  assert.equal(offer.status, 2n); assert.equal(offer.acceptedAt, offer.issuedAt);
  assert.equal(offer.sellerAmount, units('99999.96'));
  assert.equal(await f.market.hasAcceptedSale(input.seller), true);
  assert.equal(await f.market.authorizationUses(input.seller, authorization.nonce), 1n);
  await assert.rejects(f.market.connect(f.seller).acceptOffer.staticCall(input.id, await f.market.quoteDigest(input.id)));
  await assert.rejects(f.market.connect(f.buyer).cancelOffer.staticCall(input.id));
  await assert.rejects(f.market.connect(f.seller).registerReferrer.staticCall(await addr(f.referrer)));
  await solvent();
}));

test('buyer-paid signed review atomically funds an independent sale without operator gas', () => isolated(async () => {
  const input = await f.input('signed independent purchase');
  const seller = await signedAuthorization(input);
  const { review, signature } = await signedReview(input);
  const operatorNonce = await f.provider.getTransactionCount(await addr(f.admin));
  assert.equal(await f.market.reviewedInputs(review.inputDigest), ZeroHash);
  await tx(f.market.connect(f.buyer).createReviewedAuthorizedOffer(input, seller.authorization, seller.signature, input.gross, review, signature));
  const offer = await f.market.offers(input.id);
  assert.equal(offer.status, 2n);
  assert.equal(offer.independent, true);
  assert.equal(offer.treasury, false);
  assert.equal(offer.reviewHash, review.reviewHash);
  assert.equal(offer.acceptedAt, offer.issuedAt);
  assert.equal(await f.market.authorizationUses(input.seller, seller.authorization.nonce), 1n);
  assert.equal(await f.provider.getTransactionCount(await addr(f.admin)), operatorNonce, 'operator only signed data and spent no gas');
  await deliver(input); await f.advance(DISPUTE_WINDOW); await tx(f.market.finalize(input.id));
  assert.equal(await f.market.finalizedIndependentSpend(await addr(f.buyer)), input.gross);
  await solvent();
}));

test('seller referral registration after review makes the prepared purchase revert rather than lose buyer rights', () => isolated(async () => {
  const input = await f.input('review attribution race');
  const seller = await signedAuthorization(input);
  const oldReview = await signedReview(input);
  const beforeBalance = await f.token.balanceOf(await addr(f.buyer));
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  await assert.rejects(f.market.connect(f.buyer).createReviewedAuthorizedOffer.staticCall(
    input, seller.authorization, seller.signature, input.gross, oldReview.review, oldReview.signature), /REVIEW_INPUTS_CHANGED/);
  assert.equal(await f.market.authorizationUses(input.seller, seller.authorization.nonce), 0n);
  assert.equal((await f.market.offers(input.id)).status, 0n);
  assert.equal(await f.token.balanceOf(await addr(f.buyer)), beforeBalance);
  const currentReview = await signedReview(input);
  assert.notEqual(currentReview.review.inputDigest, oldReview.review.inputDigest);
  await tx(f.market.connect(f.buyer).createReviewedAuthorizedOffer(
    input, seller.authorization, seller.signature, input.gross, currentReview.review, currentReview.signature));
  const offer = await f.market.offers(input.id);
  assert.equal(offer.independent, true);
  assert.equal(offer.referrer, await addr(f.referrer));
  assert.equal(offer.referralAmount, units('.006'));
  assert.equal(offer.reviewHash, currentReview.review.reviewHash);
  await solvent();
}));

test('buyer-paid review rejects forged signer, changed buyer or offer, and a different signing domain', () => isolated(async () => {
  const input = await f.input('signed review boundaries');
  const seller = await signedAuthorization(input);
  const valid = await signedReview(input);
  const invalid = [
    await signedReview(input, { signer: f.attacker }),
    await signedReview(input, { buyer: f.attacker }),
    await signedReview(input, { domainOverrides: { chainId: 31338 } }),
    await signedReview(input, { domainOverrides: { verifyingContract: await f.reserve.getAddress() } }),
  ];
  for (const candidate of invalid) await assert.rejects(f.market.connect(f.buyer).createReviewedAuthorizedOffer.staticCall(
    input, seller.authorization, seller.signature, input.gross, candidate.review, candidate.signature));
  for (const mutation of [
    { ...input, gross: input.gross + 1n },
    { ...input, evidenceHash: id('different evidence') },
    { ...input, licenseHash: id('different licence') },
  ]) {
    const matchingSeller = await signedAuthorization(mutation);
    await assert.rejects(f.market.connect(f.buyer).createReviewedAuthorizedOffer.staticCall(
      mutation, matchingSeller.authorization, matchingSeller.signature, mutation.gross, valid.review, valid.signature), /REVIEW_INPUTS_CHANGED/);
  }
  assert.equal(await f.market.authorizationUses(input.seller, seller.authorization.nonce), 0n);
  assert.equal((await f.market.offers(input.id)).status, 0n);
  await solvent();
}));

test('signed review expires and operator rotation invalidates an old review before funds move', () => isolated(async () => {
  const expiredInput = await f.input('expired signed review');
  const expiredSeller = await signedAuthorization(expiredInput);
  const expired = await signedReview(expiredInput, { reviewOverrides: { validUntil: (await f.now()) + 1 } });
  await f.advance(2);
  await assert.rejects(f.market.connect(f.buyer).createReviewedAuthorizedOffer.staticCall(
    expiredInput, expiredSeller.authorization, expiredSeller.signature, expiredInput.gross, expired.review, expired.signature), /REVIEW_INPUTS_CHANGED/);
  assert.equal(await f.market.authorizationUses(expiredInput.seller, expiredSeller.authorization.nonce), 0n);

  const input = await f.input('operator-rotated review');
  const seller = await signedAuthorization(input);
  const oldReview = await signedReview(input, { reviewOverrides: { validUntil: (await f.now()) + 30 * DAY } });
  await tx(f.market.queueOperator(await addr(f.other)));
  await f.advance(7 * DAY);
  await tx(f.market.executeOperator(await addr(f.other)));
  const beforeBalance = await f.token.balanceOf(await addr(f.buyer));
  await assert.rejects(f.market.connect(f.buyer).createReviewedAuthorizedOffer.staticCall(
    input, seller.authorization, seller.signature, input.gross, oldReview.review, oldReview.signature), /OPERATOR_REVIEW_SIGNATURE/);
  assert.equal(await f.market.authorizationUses(input.seller, seller.authorization.nonce), 0n);
  assert.equal((await f.market.offers(input.id)).status, 0n);
  assert.equal(await f.token.balanceOf(await addr(f.buyer)), beforeBalance);
  await solvent();
}));

test('unreviewed legacy ordinary funding fails closed while a reviewed reserve sale stays exempt', () => isolated(async () => {
  const input = await f.input('ordinary review required');
  const seller = await signedAuthorization(input);
  const beforeBalance = await f.token.balanceOf(await addr(f.buyer));
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(
    input, seller.authorization, seller.signature, input.gross), /BUYER_REVIEW_REQUIRED/);
  assert.equal(await f.market.authorizationUses(input.seller, seller.authorization.nonce), 0n);
  assert.equal((await f.market.offers(input.id)).status, 0n);
  assert.equal(await f.token.balanceOf(await addr(f.buyer)), beforeBalance);

  const reserveAddress = await f.reserve.getAddress();
  const sample = await f.input('reserve review exemption', { buyerAddress: reserveAddress });
  const consent = await signedAuthorization(sample, { buyer: reserveAddress });
  await tx(f.reserve.purchaseAuthorized(sample, consent.authorization, consent.signature, id('reserve manual assay')));
  const receipt = await f.market.offers(sample.id);
  assert.equal(receipt.treasury, true);
  assert.equal(receipt.independent, false);
  await solvent();
}));

test('authorization binds exact material, licence, seller, price, minimum retention and every signed limit', () => isolated(async () => {
  const input = await f.input('bound authorization');
  const { authorization, signature } = await signedAuthorization(input);
  for (const mutated of [
    { ...input, seller: await addr(f.other) }, { ...input, evidenceHash: id('other private trace') },
    { ...input, licenseHash: id('broader licence') }, { ...input, gross: input.gross - 1n },
  ]) await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(mutated, authorization, signature, mutated.gross));
  for (const mutated of [
    { ...authorization, seller: await addr(f.other) }, { ...authorization, buyer: await addr(f.buyer) },
    { ...authorization, evidenceHash: id('another trace') }, { ...authorization, licenseHash: id('another licence') },
    { ...authorization, gross: authorization.gross + 1n }, { ...authorization, minSellerBps: 2999 },
    { ...authorization, validUntil: authorization.validUntil + 1 }, { ...authorization, nonce: id('another nonce') },
    { ...authorization, maxUses: 2 },
  ]) await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, mutated, signature, input.gross));
  assert.equal(await f.market.authorizationUses(input.seller, authorization.nonce), 0n);
  assert.equal((await f.market.offers(input.id)).status, 0n); await solvent();
}));

test('wrong signer, chain, market, noncanonical and malformed signatures cannot authorize seller assets', () => isolated(async () => {
  const input = await f.input('domain and signer');
  for (const signed of [
    await signedAuthorization(input, {}, f.attacker),
    await signedAuthorization(input, {}, f.seller, { chainId: 31338 }),
    await signedAuthorization(input, {}, f.seller, { verifyingContract: await f.reserve.getAddress() }),
    await signedAuthorization(input, {}, f.seller, { version: '0.7' }),
  ]) await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, signed.authorization, signed.signature, input.gross));
  const { authorization, signature } = await signedAuthorization(input);
  const parsed = Signature.from(signature);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const malleable = concat([parsed.r, toBeHex(order - BigInt(parsed.s), 32), toBeHex(parsed.v === 27 ? 28 : 27, 1)]);
  for (const invalid of [malleable, '0x', signature.slice(0, -2), concat([parsed.r, parsed.s, '0x00'])]) {
    await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, authorization, invalid, input.gross));
  }
  assert.equal(await f.market.authorizationUses(input.seller, authorization.nonce), 0n);
}));

test('signed buyer, expiry, usage and seller-retention limits are enforced before funds remain committed', () => isolated(async () => {
  const input = await f.input('authorization constraints');
  const wrongBuyer = await signedAuthorization(input, { buyer: await addr(f.other) });
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, wrongBuyer.authorization, wrongBuyer.signature, input.gross));
  const expired = await signedAuthorization(input, { validUntil: await f.now() });
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, expired.authorization, expired.signature, input.gross));
  const noUses = await signedAuthorization(input, { maxUses: 0 });
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, noUses.authorization, noUses.signature, input.gross));
  const min = await signedAuthorization(input, { minSellerBps: 10000 });
  await reviewLegacyAuthorizedOffer(input);
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, min.authorization, min.signature, input.gross), /SELLER_RETENTION/);
  assert.equal(await f.market.authorizationUses(input.seller, min.authorization.nonce), 0n);
  await lock(f.seller, '5000000'); await f.advance(7 * DAY);
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(input, min.authorization, min.signature, input.gross), /SELLER_RETENTION/);
  const valid = await signedAuthorization(input, {minSellerBps:9500});
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(input, valid.authorization, valid.signature, input.gross));
  assert.equal((await f.market.offers(input.id)).sellerAmount, units('99999.96'));
  await solvent();
}));

test('single-use signatures cannot replay and a nonce cannot be reused to enlarge signed sales authority', () => isolated(async () => {
  const input = await f.input('authorization replay');
  const { authorization, signature } = await signedAuthorization(input);
  await reviewLegacyAuthorizedOffer(input);
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(input, authorization, signature, input.gross));
  const replay = await nextAuthorizedInput(input, 'second offer same licence');
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(replay, authorization, signature, replay.gross));
  const expanded = await signedAuthorization(replay, { nonce: authorization.nonce, maxUses: 2, validUntil: authorization.validUntil });
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(replay, expanded.authorization, expanded.signature, replay.gross));
  assert.equal(await f.market.authorizationUses(input.seller, authorization.nonce), 1n);
  const multiInput = await f.input('explicit two sales');
  const multi = await signedAuthorization(multiInput, { maxUses: 2 });
  await reviewLegacyAuthorizedOffer(multiInput);
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(multiInput, multi.authorization, multi.signature, multiInput.gross));
  const second = await nextAuthorizedInput(multiInput, 'explicit second permitted sale');
  await reviewLegacyAuthorizedOffer(second);
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(second, multi.authorization, multi.signature, second.gross));
  const third = await nextAuthorizedInput(multiInput, 'third forbidden sale');
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(third, multi.authorization, multi.signature, third.gross));
  assert.equal(await f.market.authorizationUses(input.seller, multi.authorization.nonce), 2n); await solvent();
}));

test('seller may revoke future authorization, but revocation cannot refuse or refund an already funded sale', () => isolated(async () => {
  const input = await f.input('authorization revocation');
  const { authorization, signature } = await signedAuthorization(input, { maxUses: 2 });
  await reviewLegacyAuthorizedOffer(input);
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(input, authorization, signature, input.gross));
  await tx(f.market.connect(f.attacker).revokeSaleAuthorization(authorization.nonce));
  assert.equal(await f.market.authorizationRevoked(input.seller, authorization.nonce), false);
  await tx(f.market.connect(f.seller).revokeSaleAuthorization(authorization.nonce));
  const next = await nextAuthorizedInput(input, 'revoked next sale');
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(next, authorization, signature, next.gross));
  assert.equal((await f.market.offers(input.id)).status, 2n);
  await assert.rejects(f.market.connect(f.seller).cancelOffer.staticCall(input.id));
  await deliver(input); await f.advance(DISPUTE_WINDOW); await tx(f.market.finalize(input.id));
  assert.equal(await f.market.claimable(input.seller), units('99999.96'));
  const unspent = await f.input('revoke before any funding');
  const unspentAuth = await signedAuthorization(unspent);
  await tx(f.market.connect(f.seller).revokeSaleAuthorization(unspentAuth.authorization.nonce));
  await assert.rejects(f.market.connect(f.buyer).createAuthorizedOffer.staticCall(unspent, unspentAuth.authorization, unspentAuth.signature, unspent.gross));
  assert.equal(await f.market.authorizationUses(input.seller, unspentAuth.authorization.nonce), 0n); await solvent();
}));

test('permissionless automated payout at twelve hours pays only the beneficiary and never unlocks seller principal', () => isolated(async () => {
  await lock(f.seller, '1000000', 90); await f.advance(7 * DAY);
  const input = await f.input('automated direct payout');
  const { authorization, signature } = await signedAuthorization(input);
  await reviewLegacyAuthorizedOffer(input);
  await tx(f.market.connect(f.buyer).createAuthorizedOffer(input, authorization, signature, input.gross));
  assert.equal((await f.market.offers(input.id)).sellerAmount, units('99999.96')); // Locks do not change the quoted service tariff.
  await deliver(input);
  const delivery = await f.market.offers(input.id);
  await f.warp(Number(delivery.deliveredAt) + DISPUTE_WINDOW - 1);
  await assert.rejects(f.market.finalize.staticCall(input.id));
  await assert.rejects(f.market.connect(f.attacker).claimFor.staticCall(input.seller));
  await f.advance(1); await tx(f.market.connect(f.attacker).finalize(input.id));
  const beforeSeller = await f.token.balanceOf(input.seller);
  const beforeCaller = await f.token.balanceOf(await addr(f.attacker));
  await tx(f.market.connect(f.attacker).claimFor(input.seller));
  assert.equal(await f.token.balanceOf(input.seller), beforeSeller + units('99999.96'));
  assert.equal(await f.token.balanceOf(await addr(f.attacker)), beforeCaller);
  assert.equal(await f.market.claimable(input.seller), 0n);
  assert.equal(await f.locks.totalPrincipal(), units('1000000'));
  await assert.rejects(f.locks.connect(f.seller).withdraw.staticCall(0));
  await assert.rejects(f.market.claimFor.staticCall(input.seller));
  await assert.rejects(f.market.claimFor.staticCall(ZeroAddress)); await solvent();
}));

test('reserve automatically purchases authorized samples within unchanged caps and rolls back rejected consent', () => isolated(async () => {
  const reserveAddress = await f.reserve.getAddress();
  const input = await f.input('paid reserve sample', { buyerAddress: reserveAddress });
  const { authorization, signature } = await signedAuthorization(input, { buyer: reserveAddress });
  const reviewHash = id('published sample campaign and selection');
  await assert.rejects(f.reserve.connect(f.attacker).purchaseAuthorized.staticCall(input, authorization, signature, reviewHash));
  await assert.rejects(f.reserve.purchaseAuthorized.staticCall(input, authorization, signature, ZeroHash));
  const wrong = await signedAuthorization(input, {}, f.attacker);
  await assert.rejects(f.reserve.purchaseAuthorized.staticCall(input, wrong.authorization, wrong.signature, reviewHash));
  await assert.rejects(tx(f.reserve.purchaseAuthorized(input, wrong.authorization, wrong.signature, reviewHash, { gasLimit: 2_000_000 })));
  assert.equal(await f.reserve.grossCommitted(), 0n); assert.equal(await f.reserve.dayCommitted(0), 0n);
  assert.equal(await f.token.balanceOf(reserveAddress), units('500000000'));
  assert.equal(await f.token.allowance(reserveAddress, await f.market.getAddress()), 0n);
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  await tx(f.reserve.purchaseAuthorized(input, authorization, signature, reviewHash));
  const offer = await f.market.offers(input.id);
  assert.equal(offer.status, 2n); assert.equal(offer.buyer, reserveAddress); assert.equal(offer.treasury, true);
  assert.equal(offer.referralAmount, 0n); assert.equal(offer.independent, false);
  assert.equal(await f.reserve.grossCommitted(), input.gross);
  assert.equal(await f.reserve.dayCommitted(0), input.gross);
  assert.equal(await f.token.allowance(reserveAddress, await f.market.getAddress()), 0n);
  await assert.rejects(f.reserve.cancelOffer.staticCall(input.id));
  await deliver(input, f.admin); await f.advance(DISPUTE_WINDOW); await tx(f.market.finalize(input.id));
  await tx(f.market.claimFor(input.seller)); await tx(f.reserve.collectReturns());
  assert.equal(await f.token.balanceOf(reserveAddress), units('499900000.04'));
  assert.equal(await f.reserve.grossCommitted(), input.gross); await solvent();
}));

test('twelve-hour hold and finalization route the quoted service tariff to protocol', () => isolated(async () => {
  const input = await offered('settlement'); await accept(input); await deliver(input);
  await assert.rejects(f.market.finalize.staticCall(input.id));
  await assert.rejects(f.market.connect(f.seller).claim.staticCall());
  const delivery = await f.market.offers(input.id);
  await f.warp(Number(delivery.deliveredAt) + DISPUTE_WINDOW - 1);
  await assert.rejects(f.market.finalize.staticCall(input.id));
  await f.advance(1); await tx(f.market.finalize(input.id));
  assert.equal(await f.market.claimable(await addr(f.seller)), units('99999.96'));
  assert.equal(await f.market.claimable(await addr(f.protocol)), units('.04'));
  assert.equal(await f.market.finalizedIndependentSpend(await addr(f.buyer)), 0n); // Unreviewed purchases never create demand credit.
  await assert.rejects(f.market.finalize.staticCall(input.id)); await solvent();
  const before = await f.token.balanceOf(await addr(f.seller)); await tx(f.market.connect(f.seller).claim());
  assert.equal(await f.token.balanceOf(await addr(f.seller)), before + units('99999.96'));
  await assert.rejects(f.market.connect(f.seller).claim.staticCall()); await solvent();
}));

test('the dispute deadline is delivery plus 43200 seconds, with no gap or overlap at the boundary', () => isolated(async () => {
  await qualifyForSubjectiveDispute('deadline prior spend');
  const input = await offered('twelve-hour deadline', { reviewed: true }); await accept(input);
  await f.advance(6 * HOUR); // Paying and consenting do not start the dispute clock.
  await assert.rejects(f.market.finalize.staticCall(input.id));
  await assert.rejects(f.market.connect(f.buyer).dispute.staticCall(input.id, id('not yet delivered')));
  await deliver(input);
  const delivery = await f.market.offers(input.id);
  await f.warp(Number(delivery.deliveredAt) + HOUR);
  await f.market.connect(f.buyer).dispute.staticCall(input.id, id('filing remains open after one hour'));
  await assert.rejects(f.market.finalize.staticCall(input.id));
  await f.warp(Number(delivery.deliveredAt) + DISPUTE_WINDOW - 1);
  await f.market.connect(f.buyer).dispute.staticCall(input.id, id('missing licensed content'));
  await assert.rejects(f.market.finalize.staticCall(input.id));
  assert.equal(await f.market.claimable(input.seller), 0n);
  await f.advance(1);
  await assert.rejects(f.market.connect(f.buyer).dispute.staticCall(input.id, id('too late')));
  await f.market.finalize.staticCall(input.id);
  await tx(f.market.finalize(input.id));
  assert.equal(await f.market.claimable(input.seller), units('99999.96'));
  await solvent();
}));

test('subjective eligibility includes the reviewed purchase being disputed, not refunded or treasury purchases', () => isolated(async () => {
  const buyer = await addr(f.buyer);
  const unreviewed = await offered('unreviewed history', { gross: units('1000000') }); await finish(unreviewed);
  assert.equal(await f.market.finalizedIndependentSpend(buyer), 0n);
  const refunded = await offered('refunded reviewed history', { reviewed: true, gross: units('1000000') });
  await tx(f.market.connect(f.buyer).cancelOffer(refunded.id));
  const treasury = await offered('treasury history', { treasury: true }); await accept(treasury); await deliver(treasury, f.admin); await f.advance(DISPUTE_WINDOW); await tx(f.market.finalize(treasury.id));
  assert.equal(await f.market.finalizedIndependentSpend(buyer), 0n);
  const tooSmall = await offered('below dispute threshold', { reviewed: true, gross: units('9999999') }); await accept(tooSmall); await deliver(tooSmall);
  await assert.rejects(f.market.connect(f.buyer).dispute.staticCall(tooSmall.id, id('below threshold')));
  // This isolated fixture funds the buyer with 20M, while this case deliberately
  // escrows nearly 10M in the smaller offer and another 10M in the qualifying one.
  await tx(f.token.transfer(buyer, units('11000000')));
  const current = await offered('large first purchase qualifies itself', { reviewed: true, gross: units('10000000') }); await accept(current); await deliver(current);
  await f.market.connect(f.buyer).dispute.staticCall(current.id, id('current purchase counts'));
  assert.equal(await f.market.finalizedIndependentSpend(buyer), 0n);
  await f.advance(DISPUTE_WINDOW); await tx(f.market.finalize(current.id));
  assert.equal(await f.market.finalizedIndependentSpend(buyer), units('10000000'));
}));

test('rounding at every tier preserves every base unit without uint256 multiplication overflow', () => isolated(async () => {
  for (const gross of [1n, 3n, 99n, 10001n, MaxUint256]) for (const sellerBps of [3000n,5000n,7000n,9000n,9500n]) {
    const seller = await f.market.mulBps(gross, sellerBps);
    assert.equal(seller, gross * sellerBps / 10000n);
    const fee = gross - seller;
    const referral = await f.market.mulBps(fee, 3000);
    assert.equal(seller + referral + (fee-referral), gross);
  }
  await assert.rejects(f.market.mulBps(1, 10001));
}));

test('24-hour unfunded-consent expiry and cancellation refund the posted price only to buyer', () => isolated(async () => {
  const a = await offered('expire'); const b = await offered('cancel');
  await assert.rejects(f.market.connect(f.attacker).cancelOffer.staticCall(a.id));
  await assert.rejects(f.market.refundExpired.staticCall(a.id));
  await tx(f.market.connect(f.buyer).cancelOffer(b.id));
  await f.advance(DAY + 1);
  await assert.rejects(f.market.connect(f.seller).acceptOffer.staticCall(a.id, await f.market.quoteDigest(a.id)));
  await tx(f.market.connect(f.attacker).refundExpired(a.id));
  assert.equal(await f.market.claimable(await addr(f.buyer)), units('200000'));
  assert.equal(await f.market.claimable(await addr(f.seller)), 0n);
  await assert.rejects(f.market.refundExpired.staticCall(a.id)); await solvent();
}));

test('missing delivery after 48h refunds the full total; unrelated wallets cannot mark delivery', () => isolated(async () => {
  const input = await offered('no delivery'); await accept(input);
  await assert.rejects(f.market.connect(f.attacker).markDelivered.staticCall(input.id, id('fake')));
  await assert.rejects(f.market.connect(f.seller).markDelivered.staticCall(input.id, id('self assert')));
  await assert.rejects(f.market.refundUndelivered.staticCall(input.id));
  await f.advance(2 * DAY + 1);
  await assert.rejects(f.market.markDelivered.staticCall(input.id, id('late')));
  await tx(f.market.refundUndelivered(input.id));
  assert.equal(await f.market.claimable(await addr(f.buyer)), units('100000'));
}));

test('eligible buyer win makes half claimable, sends half to the dead sink, and pays no seller-side allocation', () => isolated(async () => {
  await qualifyForSubjectiveDispute('buyer-win prior spend');
  const baseline = {
    buyer: await f.market.claimable(await addr(f.buyer)), seller: await f.market.claimable(await addr(f.seller)),
    referrer: await f.market.claimable(await addr(f.referrer)), protocol: await f.market.claimable(await addr(f.protocol)),
    dead: await f.token.balanceOf(await f.market.DEAD_SINK()),
  };
  const input = await offered('dispute buyer win', { reviewed: true }); await accept(input); await deliver(input);
  await tx(f.market.connect(f.buyer).dispute(input.id, id('unusable delivery')));
  await tx(f.market.connect(f.seller).respondToDispute(input.id, id('seller private response')));
  assert.equal((await f.market.disputeCases(input.id)).responseHash, id('seller private response'));
  const dispute = await f.market.disputeCases(input.id); await f.warp(Number(dispute.voteStartsAt));
  await assert.rejects(f.market.connect(f.attacker).voteDispute.staticCall(input.id, 2, id('fake outsider decision')));
  await assert.rejects(f.market.resolveDispute.staticCall(input.id, true, id('retired full refund')));
  await tx(f.market.voteDispute(input.id, 2, id('reviewer buyer-win decision')));
  assert.equal((await f.market.disputeCases(input.id)).outcome, 2n);
  assert.equal(await f.market.claimable(await addr(f.buyer)), baseline.buyer + units('50000'));
  assert.equal(await f.token.balanceOf(await f.market.DEAD_SINK()), baseline.dead + units('50000'));
  assert.equal(await f.market.claimable(await addr(f.seller)), baseline.seller);
  assert.equal(await f.market.claimable(await addr(f.referrer)), baseline.referrer);
  assert.equal(await f.market.claimable(await addr(f.protocol)), baseline.protocol);
  await assert.rejects(f.market.connect(f.buyer).dispute.staticCall(input.id, id('no appeal')));
  await solvent();
}));

test('seller alone may respond for 24 hours; a governance uphold is final and releases snapshotted allocations', () => isolated(async () => {
  await qualifyForSubjectiveDispute('uphold prior spend');
  const baseline = await f.market.claimable(await addr(f.seller));
  const input = await offered('dispute upheld', { reviewed: true }); await accept(input); await deliver(input);
  await assert.rejects(f.market.connect(f.seller).dispute.staticCall(input.id, id('seller cannot complain')));
  await tx(f.market.connect(f.buyer).dispute(input.id, id('delivery disagreement')));
  const dispute = await f.market.disputeCases(input.id);
  await assert.rejects(f.market.connect(f.buyer).respondToDispute.staticCall(input.id, id('buyer fake response')));
  await tx(f.market.connect(f.seller).respondToDispute(input.id, id('seller answer')));
  await assert.rejects(f.market.connect(f.seller).respondToDispute.staticCall(input.id, id('second answer')));
  await assert.rejects(f.market.voteDispute.staticCall(input.id, 1, id('early vote')));
  await f.warp(Number(dispute.voteStartsAt));
  await tx(f.market.voteDispute(input.id, 1, id('upheld')));
  assert.equal((await f.market.disputeCases(input.id)).outcome, 1n);
  await assert.rejects(f.market.connect(f.buyer).dispute.staticCall(input.id, id('no appeal')));
  await tx(f.market.finalize(input.id));
  assert.equal(await f.market.claimable(await addr(f.seller)), baseline + units('99999.96'));
}));

test('response and vote boundaries are exact; no matching quorum defaults to uphold with no appeal', () => isolated(async () => {
  await qualifyForSubjectiveDispute('no-quorum prior spend');
  const input = await offered('no-quorum dispute', { reviewed: true }); await accept(input); await deliver(input);
  await tx(f.market.connect(f.buyer).dispute(input.id, id('no quorum complaint')));
  const dispute = await f.market.disputeCases(input.id);
  await f.warp(Number(dispute.voteStartsAt) - 1);
  await f.market.connect(f.seller).respondToDispute.staticCall(input.id, id('last-second response'));
  await f.advance(1);
  await assert.rejects(f.market.connect(f.seller).respondToDispute.staticCall(input.id, id('response too late')));
  await f.warp(Number(dispute.voteEndsAt) - 1);
  await f.market.voteDispute.staticCall(input.id, 1, id('last-second vote'));
  await assert.rejects(f.market.finalizeExpiredDispute.staticCall(input.id));
  await f.advance(1);
  await assert.rejects(f.market.voteDispute.staticCall(input.id, 1, id('vote too late')));
  await tx(f.market.finalizeExpiredDispute(input.id));
  assert.equal((await f.market.disputeCases(input.id)).outcome, 1n);
  await assert.rejects(f.market.connect(f.buyer).dispute.staticCall(input.id, id('no appeal')));
  await tx(f.market.finalize(input.id));
}));

for (const conflict of ['buyer','seller','referrer']) test(`one unconflicted owner resolves a dispute while a ${conflict} owner remains excluded`, () => isolated(async () => {
  const buyer=await addr(f.buyer),seller=await addr(f.seller),protocol=await addr(f.protocol);
  const governor=await f.deploy('ThotGovernor',[[await addr(f.admin),await addr(f[conflict]),await addr(f.attacker)]]);
  const market=await f.deploy('ThotMarket',[await f.token.getAddress(),await f.locks.getAddress(),await f.reserve.getAddress(),await governor.getAddress(),await addr(f.admin),protocol]);
  await tx(f.token.connect(f.buyer).approve(await market.getAddress(),MaxUint256));
  await tx(market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  const create=async(label,gross,sellerSigner)=>{
    const nonce=id(label),input={id:await market.offerId(buyer,nonce),nonce,seller:await addr(sellerSigner),gross,licenseHash:id(label+':license'),evidenceHash:id(label+':evidence')};
    await tx(market.reviewOffer(buyer,input,id(label+':review'),true));await tx(market.connect(f.buyer).createOffer(input, input.gross));
    await tx(market.connect(sellerSigner).acceptOffer(input.id,await market.quoteDigest(input.id)));await tx(market.markDelivered(input.id,id(label+':delivery')));return input;
  };
  const prior=await create('1-of-3 prior',units('10000000'),f.other);await f.advance(DISPUTE_WINDOW);await tx(market.finalize(prior.id));
  assert.equal(await market.finalizedIndependentSpend(buyer),units('10000000'));
  const baseline={buyer:await market.claimable(buyer),seller:await market.claimable(seller),referrer:await market.claimable(await addr(f.referrer)),protocol:await market.claimable(protocol),dead:await f.token.balanceOf(await market.DEAD_SINK())};
  const disputed=await create('1-of-3 disputed',units('1000000'),f.seller);await tx(market.connect(f.buyer).dispute(disputed.id,id('private complaint')));
  await tx(market.connect(f.seller).respondToDispute(disputed.id,id('private seller response')));
  const c=await market.disputeCases(disputed.id);
  assert.equal(c.voteStartsAt-c.openedAt,BigInt(DAY));assert.equal(c.voteEndsAt-c.voteStartsAt,BigInt(7*DAY));
  await assert.rejects(market.voteDispute.staticCall(disputed.id,2,id('premature vote')));
  await f.warp(Number(c.voteStartsAt));
  assert.equal(await market.disputeThreshold(),1n);
  assert.equal(await market.isDisputeReviewer(await addr(f[conflict])),true,'party is an owner, not merely an outsider');
  await assert.rejects(market.connect(f[conflict]).voteDispute.staticCall(disputed.id,2,id('owner conflict')),/REVIEWER_CONFLICT/);
  await assert.rejects(market.connect(f.seller).voteDispute.staticCall(disputed.id,2,id('seller conflict')));
  await assert.rejects(market.connect(f.buyer).voteDispute.staticCall(disputed.id,2,id('buyer conflict')));
  await assert.rejects(market.connect(f.referrer).voteDispute.staticCall(disputed.id,2,id('referrer conflict')));
  await assert.rejects(market.connect(f.other).voteDispute.staticCall(disputed.id,2,id('outsider review')),/REVIEWER/);
  await assert.rejects(governor.connect(f[conflict]).submitAndExecute.staticCall(await market.getAddress(),market.interface.encodeFunctionData('voteDispute',[disputed.id,2,id('controller cannot bypass party exclusion')])));
  await tx(market.voteDispute(disputed.id,2,id('single buyer-win explanation')));
  assert.equal((await market.disputeCases(disputed.id)).buyerVotes,1n);
  assert.equal((await market.disputeCases(disputed.id)).outcome,2n);assert.equal((await market.offers(disputed.id)).status,6n);
  assert.equal(await market.disputeDecisionHashes(disputed.id,await addr(f.admin)),id('single buyer-win explanation'));
  assert.equal(await market.disputeDecisionHashes(disputed.id,await addr(f.attacker)),ZeroHash);
  assert.equal(await market.claimable(buyer),baseline.buyer+units('500000'));
  assert.equal(await f.token.balanceOf(await market.DEAD_SINK()),baseline.dead+units('500000'));
  assert.equal(await market.claimable(seller),baseline.seller);assert.equal(await market.claimable(await addr(f.referrer)),baseline.referrer);assert.equal(await market.claimable(protocol),baseline.protocol);
  await assert.rejects(market.connect(f.admin).voteDispute.staticCall(disputed.id,1,id('no appeal')));
}));

test('seller and referral rates snapshot at quote and survive lock/attribution expiry in an extended dispute', () => isolated(async () => {
  await qualifyForSubjectiveDispute('snapshot prior spend');
  const baseline = {seller:await f.market.claimable(await addr(f.seller)),referrer:await f.market.claimable(await addr(f.referrer)),protocol:await f.market.claimable(await addr(f.protocol))};
  await lock(f.seller, '1000000'); await lock(f.referrer, '100000'); await f.advance(7 * DAY);
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  const input = await offered('snapshots', { reviewed: true });
  const terms = await f.market.offers(input.id);
  assert.equal(terms.sellerAmount, units('99999.96')); assert.equal(terms.referralAmount, units('.006'));
  await accept(input); await deliver(input);
  await tx(f.market.connect(f.buyer).dispute(input.id, id('extended review')));
  await f.advance(181 * DAY);
  await tx(f.locks.connect(f.seller).withdraw(0)); await tx(f.locks.connect(f.referrer).withdraw(0));
  await tx(f.market.finalizeExpiredDispute(input.id)); await tx(f.market.finalize(input.id));
  assert.equal(await f.market.claimable(await addr(f.seller)), baseline.seller + units('99999.96'));
  assert.equal(await f.market.claimable(await addr(f.referrer)), baseline.referrer + units('.006'));
  assert.equal(await f.market.claimable(await addr(f.protocol)), baseline.protocol + units('.034')); await solvent();
}));

test('referral belongs to supplier, has one immutable attribution, and closes only on first accepted sale', () => isolated(async () => {
  const unsolicited = await offered('unsolicited');
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  await assert.rejects(f.market.connect(f.seller).registerReferrer.staticCall(await addr(f.other)));
  await assert.rejects(f.market.connect(f.referrer).registerReferrer.staticCall(await addr(f.seller)));
  assert.equal((await f.market.offers(unsolicited.id)).referralAmount, 0n);
  await accept(unsolicited);
  await assert.rejects(f.market.connect(f.seller).registerReferrer.staticCall(await addr(f.other)));
  await assert.rejects(f.market.connect(f.other).registerReferrer.staticCall(await addr(f.other)));
}));

test('unreviewed buyers, treasury purchases, buyer-as-referrer and expired attribution earn no referrals', () => isolated(async () => {
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.buyer)));
  const selfBuyer = await offered('buyer-referrer', { reviewed: true });
  assert.equal((await f.market.offers(selfBuyer.id)).referralAmount, 0n);
  const unreviewed = await offered('unreviewed'); assert.equal((await f.market.offers(unreviewed.id)).independent, false);
  const treasury = await offered('treasury', { treasury: true });
  assert.equal((await f.market.offers(treasury.id)).referralAmount, 0n);
  await f.advance(180 * DAY);
  const expired = await offered('expired attribution', { reviewed: true });
  assert.equal((await f.market.offers(expired.id)).referralAmount, 0n);
}));

test('independence review binds exact request and the approved referrer at funding', () => isolated(async () => {
  const input = await f.input('review binding');
  await tx(f.market.reviewOffer(await addr(f.buyer), input, id('review without attribution'), true));
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  await tx(f.market.connect(f.buyer).createOffer(input, input.gross));
  assert.equal((await f.market.offers(input.id)).independent, false);
  assert.equal((await f.market.offers(input.id)).referralAmount, 0n);
}));

test('large locks leave the fixed service tariff and flat net referral unchanged', () => isolated(async () => {
  await lock(f.seller, '5000000'); await lock(f.referrer, '5000000'); await f.advance(7 * DAY);
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  await finish(await offered('maximum tiers', { reviewed: true }));
  assert.equal(await f.market.claimable(await addr(f.seller)), units('99999.96'));
  assert.equal(await f.market.claimable(await addr(f.referrer)), units('.006'));
  assert.equal(await f.market.claimable(await addr(f.protocol)), units('.034'));
}));

test('all 361 onchain cumulative limits match an independent 200-digit Decimal calculation', () => isolated(async () => {
  const expected = JSON.parse(execFileSync('python3', ['-c', 'from decimal import Decimal,localcontext; import json\nwith localcontext() as c:\n c.prec=200\n print(json.dumps([str(int(Decimal(50000000*10**18)*(1-Decimal(2)**(-Decimal(d)/180)))) for d in range(361)]))'], { encoding: 'utf8' }));
  for (let d = 0; d <= 360; d++) assert.equal(await f.reserve.cumulativeCap(d), BigInt(expected[d]), `day ${d}`);
  assert.equal(await f.reserve.cumulativeCap(180), units('25000000'));
  assert.equal(await f.reserve.cumulativeCap(360), units('37500000'));
  await assert.rejects(f.reserve.dayCap(360));
}));

test('day-zero, authority and starter caps are charged at offer funding and never restored on cancellation', () => isolated(async () => {
  const cap = await f.reserve.dayCap(0);
  await assert.rejects(f.reserve.connect(f.attacker).purchase.staticCall(await f.input('unauthorized', { buyerAddress: await f.reserve.getAddress(), gross: cap }), id('fake')));
  const input = await offered('full day', { treasury: true, gross: cap });
  assert.equal(await f.reserve.remainingAllowance(), 0n);
  await tx(f.reserve.cancelOffer(input.id)); await tx(f.reserve.collectReturns());
  assert.equal(await f.reserve.grossCommitted(), cap); assert.equal(await f.reserve.dayCommitted(0), cap);
  assert.equal(await f.reserve.remainingAllowance(), 0n);
  assert.equal(await f.token.balanceOf(await f.reserve.getAddress()), units('500000000'));
  await f.advance(DAY);
  assert.equal(await f.reserve.remainingAllowance(), await f.reserve.dayCap(1));
}));

test('unused daily budgets expire; no-independent-demand campaign stops at one million gross', () => isolated(async () => {
  await f.advance(5 * DAY);
  assert.equal(await f.reserve.remainingAllowance(), await f.reserve.dayCap(5));
  for (let index = 0; index < 10 && (await f.reserve.grossCommitted()) < units('1000000'); index++) {
    const available = await f.reserve.remainingAllowance();
    if (available > 0n) {
      const input = await offered('starter exhaustion ' + index, { treasury: true, gross: available });
      await tx(f.reserve.cancelOffer(input.id)); await tx(f.reserve.collectReturns());
    }
    await f.advance(DAY);
  }
  assert.equal(await f.reserve.grossCommitted(), units('1000000'));
  assert.equal(await f.reserve.remainingAllowance(), 0n);
  assert.equal(await f.reserve.independentDemand(), 0n);
}));

test('only independently reviewed finalized receipts generate exactly one gross unit of demand credit', () => isolated(async () => {
  const input = await offered('eligible demand', { reviewed: true });
  await tx(f.reserve.reviewDemand(input.id, id('separate demand review')));
  await assert.rejects(f.reserve.creditDemand.staticCall(input.id));
  await finish(input); await tx(f.reserve.creditDemand(input.id));
  assert.equal(await f.reserve.independentDemand(), units('100000'));
  await assert.rejects(f.reserve.creditDemand.staticCall(input.id));
  const treasury = await offered('ineligible treasury credit', { treasury: true }); await finish(treasury);
  await tx(f.reserve.reviewDemand(treasury.id, id('cannot override buyer class')));
  await assert.rejects(f.reserve.creditDemand.staticCall(treasury.id));
  const unreviewed = await offered('ineligible unreviewed'); await finish(unreviewed);
  await tx(f.reserve.reviewDemand(unreviewed.id, id('late review cannot invent promise')));
  await assert.rejects(f.reserve.creditDemand.staticCall(unreviewed.id));
}));

test('treasury retained fee returns to inactive reserve with no referral or authority replenishment', () => isolated(async () => {
  const input = await offered('treasury retained fee', { treasury: true }); await finish(input);
  assert.equal(await f.market.claimable(await f.reserve.getAddress()), units('.04'));
  assert.equal(await f.market.claimable(await addr(f.protocol)), 0n);
  await tx(f.reserve.collectReturns()); assert.equal(await f.reserve.grossCommitted(), units('100000'));
  assert.equal(await f.token.balanceOf(await f.reserve.getAddress()), units('499900000.04'));
}));

test('campaign sunset blocks new commitments but honors funded prior quotes and full payment lifecycle', () => isolated(async () => {
  const start = Number(await f.reserve.startAt());
  await f.warp(start + 360 * DAY - 60);
  const input = await offered('last quote', { treasury: true, gross: units('100') });
  await f.advance(61); assert.equal(await f.reserve.remainingAllowance(), 0n);
  const late = await f.input('post sunset', { buyerAddress: await f.reserve.getAddress(), gross: 1n });
  await assert.rejects(f.reserve.purchase.staticCall(late, id('review')));
  await finish(input); assert.equal(await f.market.claimable(await addr(f.seller)), units('99.96'));
}));

test('pause stops new offers but preserves funded acceptance, delivery, disputes, refunds and claims', () => isolated(async () => {
  const accepted = await offered('pause funded promise'); const refund = await offered('pause refund');
  await tx(f.market.pause()); await tx(f.reserve.pause());
  await assert.rejects(f.market.connect(f.buyer).createOffer.staticCall(await f.input('paused offer'), units('100000')));
  await finish(accepted); await f.warp(Number((await f.market.offers(refund.id)).issuedAt) + DAY + 1); await tx(f.market.refundExpired(refund.id));
  await tx(f.market.connect(f.seller).claim()); await tx(f.market.connect(f.buyer).claim()); await solvent();
}));

test('governance operator changes and unpause require seven days; cancellation and unauthorized callers fail', () => isolated(async () => {
  const next = await addr(f.other);
  await assert.rejects(f.market.connect(f.attacker).queueOperator.staticCall(next));
  await tx(f.market.queueOperator(next)); await assert.rejects(f.market.executeOperator.staticCall(next));
  await tx(f.market.pause()); await tx(f.market.queueUnpause()); await assert.rejects(f.market.unpause.staticCall());
  await f.advance(7 * DAY); await tx(f.market.executeOperator(next)); await tx(f.market.unpause());
  assert.equal(await f.market.operator(), next); assert.equal(await f.market.paused(), false);
  await assert.rejects(f.market.executeOperator.staticCall(next));
  const operation = await f.reserve.queueOperator.staticCall(next); await tx(f.reserve.queueOperator(next));
  await tx(f.reserve.cancelGovernance(operation)); await f.advance(7 * DAY);
  await assert.rejects(f.reserve.executeOperator.staticCall(next));
}));

test('first campaign activation is timelocked, token-bound and cannot be repeated or sweep the reserve', () => isolated(async () => {
  const reserve = await f.deploy('ThotReserveVault', [f.config.token, await addr(f.admin), await addr(f.admin)]);
  const market = await f.deploy('ThotMarket', [f.config.token, f.config.locks, await reserve.getAddress(), await addr(f.admin), await addr(f.admin), await addr(f.protocol)]);
  const start = (await f.now()) + 7 * DAY + 60;
  await tx(reserve.queueCampaign(await market.getAddress(), start));
  await assert.rejects(reserve.executeCampaign.staticCall(await market.getAddress(), start));
  await f.advance(7 * DAY);
  await assert.rejects(reserve.executeCampaign.staticCall(await market.getAddress(), start)); // insufficient 500m backing
  await assert.rejects(f.reserve.queueCampaign.staticCall(f.config.market, start));
  for (const contract of [f.market, f.reserve]) {
    const names = contract.interface.fragments.filter(x => x.type === 'function').map(x => x.name);
    for (const absent of ['sweep', 'withdraw', 'execute', 'setFee', 'setSellerShare', 'mint']) assert.equal(names.includes(absent), false);
  }
}));

test('successor authorization requires seven days and sunset, and cannot consume existing escrow or lock liabilities', () => isolated(async () => {
  await lock(f.seller, '1000000'); await f.advance(7 * DAY);
  const input = await offered('surviving successor', { treasury: true });
  const nextVault = await f.deploy('ThotReserveVault', [f.config.token, await addr(f.admin), await addr(f.admin)]);
  const amount = await f.token.balanceOf(await f.reserve.getAddress()); const policy = id('published next campaign policy');
  await assert.rejects(f.reserve.queueSuccessor.staticCall(await addr(f.attacker), amount, policy));
  await assert.rejects(f.reserve.connect(f.attacker).queueSuccessor.staticCall(await nextVault.getAddress(), amount, policy));
  await tx(f.reserve.queueSuccessor(await nextVault.getAddress(), amount, policy));
  await assert.rejects(f.reserve.executeSuccessor.staticCall(await nextVault.getAddress(), amount, policy));
  await f.warp(Number(await f.reserve.startAt()) + 360 * DAY);
  await tx(f.reserve.executeSuccessor(await nextVault.getAddress(), amount, policy));
  assert.equal(await f.token.balanceOf(await f.reserve.getAddress()), 0n);
  assert.equal(await f.token.balanceOf(await nextVault.getAddress()), amount);
  assert.equal(await f.market.escrowLiability(), input.gross);
  assert.equal(await f.locks.totalPrincipal(), units('1000000'));
  await tx(f.market.refundExpired(input.id)); await tx(f.reserve.collectReturns());
  assert.equal(await f.token.balanceOf(await f.reserve.getAddress()), input.gross);
  await assert.rejects(f.reserve.executeSuccessor.staticCall(await nextVault.getAddress(), amount, policy));
  await assert.rejects(f.reserve.queueSuccessor.staticCall(await nextVault.getAddress(), amount, policy));
  await solvent();
}));

test('referral expires exactly at 365 paid-activity days, while quoted terms before expiry remain snapshotted', () => isolated(async () => {
  await tx(f.market.connect(f.seller).registerReferrer(await addr(f.referrer)));
  const attribution = await f.market.attributions(await addr(f.seller));
  const term = await f.market.REFERRAL_TERM(); assert.equal(term, BigInt(365 * DAY));
  const first = await offered('referral activation', { reviewed:true });
  const expiresAt = Number(await f.market.firstExternalOrderAt(first.seller)) + Number(term);
  const prepare = async label => {
    const input = await f.input(label);
    await tx(f.market.reviewOffer(await addr(f.buyer), input, id(label + ':independence-reviewed'), true));
    return input;
  };
  const createAt = async (input, timestamp) => {
    await f.provider.send('evm_setNextBlockTimestamp', [timestamp]);
    await tx(f.market.connect(f.buyer).createOffer(input, input.gross));
    assert.equal((await f.market.offers(input.id)).issuedAt, BigInt(timestamp));
  };
  // Review both offers first so the transaction that snapshots each quote lands
  // at the stated boundary instead of drifting forward through setup blocks.
  const before = await prepare('referral before exact expiry');
  const at = await prepare('referral at exact expiry');
  await createAt(before, expiresAt - 1);
  assert.equal((await f.market.offers(before.id)).referralAmount, units('.006'));
  await createAt(at, expiresAt);
  assert.equal((await f.market.offers(at.id)).referralAmount, 0n);
  await accept(before); assert.equal((await f.market.offers(before.id)).referralAmount, units('.006'));
}));

test('unsigned deployment planner sends nothing, validates chain/supply, and rehearses exact addresses with separate governor', () => isolated(async () => {
  const token = await f.deploy('ThotTestToken', [await addr(f.admin), units('1000000000')]);
  const options = { rpcUrl: f.config.rpcUrl, expectedChainId: 31337, token: await token.getAddress(), deployer: await addr(f.admin), governor: await addr(f.other), operator: await addr(f.admin), protocolRecipient: await addr(f.protocol) };
  const beforeNonce = await f.provider.getTransactionCount(await addr(f.admin), 'pending');
  const beforeBlock = await f.provider.getBlockNumber();
  await assert.rejects(prepareThotDeployment({...options, expectedChainId: 31338}), /DEPLOYMENT_CHAIN_NOT_ENABLED/);
  await assert.rejects(prepareThotDeployment({...options, expectedChainId: 46630}), /CHAIN_ID_MISMATCH/);
  const plan = await prepareThotDeployment(options);
  assert.equal(await f.provider.getTransactionCount(await addr(f.admin), 'pending'), beforeNonce);
  assert.equal(await f.provider.getBlockNumber(), beforeBlock);
  assert.equal(plan.unsignedOnly, true); assert.equal(plan.broadcast, false); assert.equal(plan.governance.separateSigner, true);
  assert.equal(plan.waitWindowsSeconds.disputeAfterDelivery, DISPUTE_WINDOW);
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0], /Legacy testnet rehearsal only:.*470M acquisition \/ 30M staking allocation/);
  assert.equal(JSON.stringify(plan).includes(f.config.rpcUrl), false);
  for (const step of plan.deploymentTransactions) {
    const receipt = await tx(f.admin.sendTransaction(step.transaction));
    if (step.action === 'deploy') assert.equal(receipt.contractAddress.toLowerCase(), step.predictedAddress.toLowerCase());
  }
  assert.equal(await token.balanceOf(plan.predictedAddresses.reserve), units('500000000'));
  await tx(f.other.sendTransaction(plan.governance.queue));
  await assert.rejects(f.other.call(plan.governance.execute));
  await f.warp(plan.governance.proposedCampaignStart); await tx(f.other.sendTransaction(plan.governance.execute));
  const wrong = await f.deploy('ThotTestToken', [await addr(f.admin), units('2')]);
  await assert.rejects(prepareThotDeployment({...options,token:await wrong.getAddress()}), /THOT_REQUIRES_EXACT_1_BILLION_SUPPLY/);
}));
