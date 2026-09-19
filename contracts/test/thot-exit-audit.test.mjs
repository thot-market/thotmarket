import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { id, parseEther as u, MaxUint256 } from 'ethers';
import { deployThotFixture } from '../scripts/thot-local-fixture.mjs';

const DAY = 86400;
const percentage = process.env.THOT_AUDIT_PERCENTAGE === '1';
const tx = async p => (await p).wait();
let f, snap, a, token, locks, governor, reserve, market, pool;
const govern = async (contract, method, args = []) => tx(governor.submitAndExecute(
  await contract.getAddress(), contract.interface.encodeFunctionData(method, args)));
function rng(seed) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }; }

before(async () => {
  f = await deployThotFixture({ activate: false });
  a = await Promise.all(f.signers.map(s => s.getAddress()));
  token = await f.deploy('ThotTestToken', [a[0], u('1000000000')]);
  governor = await f.deploy('ThotGovernor', [[a[0], a[1], a[6]]]);
  locks = await f.deploy('ThotLockVault', [await token.getAddress()]);
  reserve = await f.deploy('ThotCampaignReserve', [await token.getAddress(), await governor.getAddress(), a[5]]);
  market = await f.deploy(percentage ? 'ThotLaunchMarket' : 'ThotMarket', [await token.getAddress(), await locks.getAddress(), await reserve.getAddress(), await governor.getAddress(), a[5], a[4], ...(percentage ? [31337] : [])]);
  pool = await f.deploy('ThotStakingPool', [await token.getAddress(), await governor.getAddress()]);
  if (percentage) {
    const discounts = await f.deploy('ThotFeeDiscounts', [await token.getAddress(), await pool.getAddress(), await governor.getAddress()]);
    await govern(discounts, 'setPolicy', [u('10000'), u('100000'), 2000, 3000]);
    await govern(market, 'bindFeeDiscounts', [await discounts.getAddress()]);
    await govern(market, 'queueUnpause'); await govern(market, 'unpause');
  }
  await tx(token.transfer(await reserve.getAddress(), u('470000000')));
  await govern(reserve, 'bindMarket', [await market.getAddress()]);
  await tx(token.approve(await pool.getAddress(), u('30000000')));
  await tx(pool.fund(u('30000000')));
  await tx(token.transfer(a[1], u('200000000')));
  await tx(token.transfer(a[2], u('50000000')));
  for (const s of [f.admin, f.buyer, f.seller]) {
    for (const target of [market, locks, pool]) await tx(token.connect(s).approve(await target.getAddress(), MaxUint256));
  }
  assert.equal(await token.balanceOf(await reserve.getAddress()), u('470000000'));
  assert.equal(await pool.freeBalance(), u('30000000'));
});
after(async () => { await f?.close(); });
beforeEach(async () => { snap = await f.provider.send('evm_snapshot', []); });
afterEach(async () => { await f.provider.send('evm_revert', [snap]); });

test('seeded mixed escrow states close every obligation with operator absent and admissions paused', async t => {
  const orders = [], expected = new Map(), gas = {};
  const add = (who, amount) => expected.set(who, (expected.get(who) ?? 0n) + amount);
  const measure = async (name, p) => { const receipt = await tx(p); gas[name] = Math.max(gas[name] ?? 0, Number(receipt.gasUsed)); return receipt; };
  await tx(market.connect(f.seller).registerReferrer(a[3]));
  await tx(token.transfer(await market.getAddress(), 7n)); // donated surplus is not a liability
  let escrow = 0n, burned = 0n, successfulFunding = 0, rejected = 0;
  for (const seed of [17, 91, 20260919]) {
    const random = rng(seed), states = [0, 1, 2, 3, 4, 5, 6];
    for (let i = states.length - 1; i > 0; i--) { const j = random() % (i + 1); [states[i], states[j]] = [states[j], states[i]]; }
    for (const state of states) {
      const gross = state >= 4 ? u(percentage ? '10100000' : '10000000') : u(String(1 + random() % 1000));
      const nonce = id(`audit:${seed}:${state}`), oid = await market.offerId(a[1], nonce);
      const input = { id: oid, nonce, seller: a[2], gross, licenseHash: id('audit licence'), evidenceHash: id(`audit material:${seed}:${state}`) };
      await tx(market.connect(f.attacker).reviewOffer(a[1], input, id('independent audit review'), true));
      const fee = percentage ? (gross + 99n) / 100n : u('.04');
      const discount = percentage ? fee * 3000n / 10000n : 0n;
      const payment = gross - discount;
      await measure('fund', market.connect(f.buyer).createOffer(input, payment)); successfulFunding++;
      const funded = await market.offers(oid);
      assert.equal(funded.sellerAmount, gross - fee + discount);
      assert.equal(funded.referralAmount, percentage ? fee / 5n : u('.006'));
      escrow += payment;
      await assert.rejects(market.connect(f.buyer).createOffer.staticCall(input, gross)); rejected++;
      if (state === 0) {
        await measure('cancel', market.connect(f.buyer).cancelOffer(oid)); escrow -= payment; add(a[1], payment);
      } else if (state >= 2) {
        await tx(market.connect(f.seller).acceptOffer(oid, await market.quoteDigest(oid)));
        if (state >= 3) await tx(market.connect(f.buyer).markDelivered(oid, id('buyer acknowledges exact material')));
        if (state >= 4) {
          await tx(market.connect(f.buyer).dispute(oid, id('synthetic complaint')));
          if (state !== 6) {
            await tx(market.connect(f.seller).respondToDispute(oid, id('synthetic response')));
            await tx(market.connect(f.seller).waiveDisputeResponseWindow(oid));
            await measure('adjudicate', market.voteDispute(oid, state === 4 ? 2 : 1, id('synthetic finding')));
            if (state === 4) { escrow -= payment; add(a[1], payment / 2n); burned += payment - payment / 2n; }
          }
        }
      }
      orders.push({ oid, state, gross, payment, fee, discount });
      assert.equal(await market.escrowLiability(), escrow);
      const claims = [...expected.values()].reduce((x, y) => x + y, 0n);
      assert.equal(await market.claimLiability(), claims);
      assert.equal(await token.balanceOf(await market.getAddress()), escrow + claims + 7n);
    }
  }
  await govern(market, 'pause');
  // Neither the operator nor UI participates in the close-out.
  await f.advance(10 * DAY);
  for (const { oid, state, gross, payment, fee, discount } of orders) {
    if (state === 0 || state === 4) continue;
    if (state === 1) { await measure('refundExpired', market.connect(f.other).refundExpired(oid)); add(a[1], payment); }
    else if (state === 2) { await measure('refundUndelivered', market.connect(f.other).refundUndelivered(oid)); add(a[1], payment); }
    else {
      if (state === 6) await measure('expireDispute', market.connect(f.other).finalizeExpiredDispute(oid));
      await measure('finalize', market.connect(f.other).finalize(oid));
      const referral = percentage ? fee / 5n : u('.006');
      add(a[2], gross - fee + discount); add(a[3], referral); add(a[4], fee - 2n * discount - referral);
    }
    escrow -= payment;
    assert.equal(await market.escrowLiability(), escrow);
  }
  assert.equal(escrow, 0n);
  for (const [owner, amount] of expected) {
    assert.equal(await market.claimable(owner), amount);
    const before = await token.balanceOf(owner);
    await measure('claimFor', market.connect(f.other).claimFor(owner));
    assert.equal(await token.balanceOf(owner), before + amount);
    await assert.rejects(market.claimFor.staticCall(owner)); rejected++;
  }
  assert.equal(await market.claimLiability(), 0n);
  assert.equal(await token.balanceOf(await market.getAddress()), 7n);
  assert.equal(await token.balanceOf(await market.DEAD_SINK()), burned);
  assert.equal(successfulFunding, 21);
  t.diagnostic(JSON.stringify({ seeds: [17, 91, 20260919], successfulFunding, rejected, leftoverEscrow: '0', leftoverClaims: '0', maxGas: gas }));
});

test('64-position staking and lock histories close out after cancellation and donation without operator approval', async t => {
  const start = await f.now() + 20, menu = [[30 * DAY, 500], [60 * DAY, 1200], [90 * DAY, 3000]];
  await govern(pool, 'createCampaign', [start, start + 7 * DAY, u('100000000'), u('30000000'), menu]);
  await f.warp(start);
  const random = rng(314159), ledger = [], lotLedger = [], gas = {};
  let principal = 0n, rewards = 0n, lockPrincipal = 0n;
  for (let i = 0; i < 64; i++) {
    const amount = u(String(1 + random() % 100)), tier = random() % 3;
    await tx(pool.connect(f.seller).stake(1, tier, amount));
    ledger.push({ id: i + 1, amount, reward: amount * BigInt(menu[tier][1]) / 10000n });
    principal += amount; rewards += ledger.at(-1).reward;
    const lockAmount = BigInt(1 + random() % 10000), unlock = await f.now() + 100 * DAY;
    await tx(locks.connect(f.seller).deposit(lockAmount, unlock));
    lockPrincipal += lockAmount; lotLedger.push(lockAmount);
  }
  await assert.rejects(pool.connect(f.seller).stake.staticCall(1, 0, u('1')), /POSITION_LIMIT/);
  await assert.rejects(locks.connect(f.seller).deposit.staticCall(1, await f.now() + 100 * DAY), /LOT_LIMIT/);
  assert.equal(await pool.totalPrincipal(), principal);
  assert.equal(await pool.totalRewardLiability(), rewards);
  assert.equal(await locks.totalPrincipal(), lockPrincipal);
  await tx(token.transfer(await pool.getAddress(), 13n));
  await govern(pool, 'closeCampaign', [1]);
  const unused = u('30000000') - rewards + 13n;
  assert.equal(await pool.freeBalance(), unused);
  await govern(pool, 'recoverFreeTokens', [a[0], unused]);
  await assert.rejects(govern(pool, 'recoverFreeTokens', [a[0], 1n]), /PROTECTED_FUNDS/);
  await f.advance(101 * DAY);
  const balance = await token.balanceOf(a[2]);
  // Random order stresses swap/remove indexing; every accepted position must remain reachable.
  for (let i = ledger.length - 1; i > 0; i--) { const j = random() % (i + 1); [ledger[i], ledger[j]] = [ledger[j], ledger[i]]; }
  for (const entry of ledger) {
    const r = await tx(pool.connect(f.seller).claim(entry.id)); gas.stakingClaim = Math.max(gas.stakingClaim ?? 0, Number(r.gasUsed));
  }
  for (let i = 0; i < 64; i++) {
    const r = await tx(locks.connect(f.seller).withdraw(i)); gas.lockWithdraw = Math.max(gas.lockWithdraw ?? 0, Number(r.gasUsed));
  }
  assert.equal(await token.balanceOf(a[2]), balance + principal + rewards + lockPrincipal);
  assert.equal(await pool.totalPrincipal(), 0n); assert.equal(await pool.totalRewardLiability(), 0n);
  assert.equal(await pool.totalUnallocatedRewards(), 0n); assert.equal(await locks.totalPrincipal(), 0n);
  assert.equal(await token.balanceOf(await pool.getAddress()), 0n);
  assert.equal(await token.balanceOf(await locks.getAddress()), 0n);
  assert.equal((await pool.activePositionIds(a[2])).length, 0);
  // A long history does not consume active capacity forever.
  await tx(locks.connect(f.seller).deposit(1, await f.now() + 100 * DAY));
  assert.equal(await locks.lotCount(a[2]), 64n);
  await f.advance(101 * DAY); await tx(locks.connect(f.seller).withdraw(0));
  for (const value of Object.values(gas)) assert(value < 1_000_000, 'exit must fit the selected conservative local gas budget');
  t.diagnostic(JSON.stringify({ seed: 314159, positions: 64, lots: 64, maxGas: gas, leftoverPrincipal: '0', leftoverRewards: '0' }));
});
