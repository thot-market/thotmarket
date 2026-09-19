import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id } from 'ethers';
import { deployThotFixture } from '../contracts/scripts/thot-local-fixture.mjs';
import { ThotChain } from '../packages/chain/thot.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoUser } from '../packages/market/src/fixtures.ts';

test('critical THOT reads and delivery sends fail closed after local runtime/chain changes', async t => {
  const f = await deployThotFixture();
  const config = { ...f.config, localDeliverySigner: f.config.operator };
  const chain = new ThotChain(config);
  let app, dir;
  try {
    assert.equal(chain.capabilities().dispute_seconds, null);
    await chain.guard();
    assert.equal(chain.capabilities().dispute_seconds, 43200);
    const input = await f.input('guard funded offer');
    await (await f.market.connect(f.buyer).createOffer(input, input.gross)).wait();
    await (await f.market.connect(f.seller).acceptOffer(input.id, await f.market.quoteDigest(input.id))).wait();
    const baseline = await f.provider.send('evm_snapshot', []);

    await t.test('configuration pins a canonical deployment block and retains local-only activation', async () => {
      assert.throws(() => new ThotChain({ ...config, chainId: 4663 }), /THOT_PRODUCTION_ACTIVATION_PENDING/);
      assert.throws(() => new ThotChain({ ...config, rpcUrl: 'https://example.com' }), /THOT_LOCAL_RPC_REQUIRED/);
      assert.throws(() => new ThotChain({ ...config, deploymentBlockHash: undefined }), /INVALID_DEPLOYMENT_BLOCK_HASH/);
      const wrongAnchor = new ThotChain({ ...config, deploymentBlockHash: id('another deployment block') });
      try { await assert.rejects(wrongAnchor.guard(), /THOT_DEPLOYMENT_ANCHOR_MISMATCH/); }
      finally { wrongAnchor.close(); }
      assert.equal((await chain.offer(input.id)).status, 2);
      assert.equal((await chain.offer(input.id)).dispute_seconds, 43200);
    });

    await t.test('immutable legacy dispute periods are read from the pinned contract instead of shortened by the worker', async () => {
      const legacy = new ThotChain(config), snapshot = await f.provider.send('evm_snapshot', []);
      // Simulate the original pinned deployment's getter; settlement remains enforced by its contract.
      legacy.market.DISPUTE_WINDOW = async () => 86400n;
      try {
        await legacy.guard();
        assert.equal(legacy.capabilities().dispute_seconds, 86400);
        assert.equal((await legacy.offer(input.id)).dispute_seconds, 86400);
        await (await f.market.markDelivered(input.id, input.evidenceHash)).wait();
        const delivery = await legacy.offer(input.id), seller = await f.seller.getAddress();
        const before = await f.token.balanceOf(seller);
        await f.warp(delivery.delivered_at + 3600);
        await assert.rejects(legacy.finalizeAndPay(input.id, seller), /THOT_NOT_FINALIZED/);
        assert.equal(await f.token.balanceOf(seller), before);
        await f.warp(delivery.delivered_at + 86400);
        await legacy.finalizeAndPay(input.id, seller);
        assert.equal(await f.token.balanceOf(seller) - before, BigInt(delivery.seller_amount));
      } finally { legacy.close(); await f.provider.send('evm_revert', [snapshot]); }
    });

    await t.test('deployed one-hour terms remain one hour and unknown dispute periods fail closed', async () => {
      for (const seconds of [3600n, 7200n]) {
        const legacy = new ThotChain(config);
        // Read compatibility only: this does not pretend the fresh fixture's bytecode changes.
        legacy.market.DISPUTE_WINDOW = async () => seconds;
        try {
          if (seconds === 3600n) {
            await legacy.guard();
            assert.equal(legacy.capabilities().dispute_seconds, 3600);
            assert.equal((await legacy.offer(input.id)).dispute_seconds, 3600);
          } else await assert.rejects(legacy.guard(), /THOT_DISPUTE_WINDOW_UNSUPPORTED/);
        } finally { legacy.close(); }
      }
    });

    await t.test('overlapping guards share one four-code read, but later guards never use a stale success cache', async () => {
      let codeReads = 0;
      const original = chain.provider.send.bind(chain.provider);
      chain.provider.send = async (method, params) => { if (method === 'eth_getCode') codeReads++; return original(method, params); };
      try {
        await Promise.all(Array.from({ length: 12 }, () => chain.guard()));
        assert.equal(codeReads, 4);
        await chain.guard(); assert.equal(codeReads, 8);
      } finally { chain.provider.send = original; }
    });

    await t.test('workspace batches account and orders at one confirmed snapshot with one pin check and bounded concurrency', async () => {
      const snapshot = await f.provider.send('evm_snapshot', []);
      const owner = await f.seller.getAddress(), ids = [input.id, ...Array.from({length: 15}, (_, n) => id('unfunded workspace ' + n))];
      const before = await f.token.balanceOf(owner), target = await f.provider.getBlockNumber();
      const original = chain.provider.send.bind(chain.provider);
      let codeReads = 0, active = 0, maxActive = 0, advanced = false;
      let activeAccountReads = 0, maxAccountReads = 0, maxActiveOrders = 0;
      const orderFanoutLimit = 4;
      const orderReadMethods = ['offers', 'quoteDigest', 'paymentFor', 'disputeCases', 'disputeVotes', 'disputeDecisionHashes', 'tariffAtFunding'];
      const orderSelectors = new Map(orderReadMethods.map(name => [chain.market.interface.getFunction(name).selector, name]));
      const activeOrderReads = new Map(), observedOrderReads = new Map();
      const tags = new Set(), offerSelector = chain.market.interface.getFunction('offers').selector;
      chain.provider.send = async (method, params) => {
        if (method === 'eth_getCode') codeReads++;
        const counted = method === 'eth_call' && params[1] !== 'latest';
        const orderMethod = counted ? orderSelectors.get(params[0].data.slice(0, 10)) : undefined;
        const orderId = orderMethod ? '0x' + params[0].data.slice(10, 74) : undefined;
        if (counted) {
          active++; maxActive = Math.max(active, maxActive); tags.add(params[1]);
          if (orderId) {
            assert.equal(activeAccountReads, 0, 'account RPCs finish before order batches begin');
            activeOrderReads.set(orderId, (activeOrderReads.get(orderId) ?? 0) + 1);
            maxActiveOrders = Math.max(maxActiveOrders, activeOrderReads.size);
            const reads = observedOrderReads.get(orderId) ?? [];
            reads.push(orderMethod); observedOrderReads.set(orderId, reads);
          } else {
            activeAccountReads++; maxAccountReads = Math.max(maxAccountReads, activeAccountReads);
            assert.equal(activeOrderReads.size, 0, 'account RPCs must not overlap order batches');
          }
        }
        try {
          if (counted && !advanced && params[0].data.startsWith(offerSelector)) {
            advanced = true;
            await (await f.market.markDelivered(input.id, input.evidenceHash)).wait();
            await (await f.token.transfer(owner, 17n)).wait();
          }
          return await original(method, params);
        } finally {
          if (counted) {
            active--;
            if (orderId) {
              const remaining = activeOrderReads.get(orderId) - 1;
              if (remaining) activeOrderReads.set(orderId, remaining); else activeOrderReads.delete(orderId);
            } else activeAccountReads--;
          }
        }
      };
      try {
        const view = await chain.readWorkspace(owner, ids);
        assert.equal(advanced, true); assert.equal(codeReads, 4);
        assert(maxActiveOrders >= 2 && maxActiveOrders <= orderFanoutLimit, 'a large workspace must read orders concurrently without exceeding four active orders');
        assert(maxAccountReads > 0 && maxAccountReads <= 7, 'the account phase has at most seven independent RPC reads');
        assert(maxActive <= orderFanoutLimit * orderReadMethods.length, 'RPC fanout stays bounded by four orders and their seven required fields');
        assert.equal(active, 0); assert.equal(activeAccountReads, 0); assert.equal(activeOrderReads.size, 0);
        assert.deepEqual([...observedOrderReads.keys()].sort(), [...ids].sort());
        for (const [orderId, methods] of observedOrderReads) assert.deepEqual(methods.sort(), [...orderReadMethods].sort(), `${orderId} reads each required order field exactly once`);
        assert.deepEqual([...tags], ['0x' + target.toString(16)]);
        assert.equal(view.account.balance, before.toString()); assert.equal(view.block.number, target);
        assert.deepEqual(view.offers.map(o => o.id), ids);
        assert(view.offers.every(o => o.block.hash === view.block.hash && o.block.number === view.account.block.number));
        assert.equal(view.offers[0].status, 2); assert.equal(Number((await f.market.offers(input.id)).status), 3);
        assert.equal(await f.token.balanceOf(owner), before + 17n);
        codeReads = 0;
        const next = await chain.readWorkspace(owner, [input.id]);
        assert.equal(codeReads, 4, 'a later request must verify bytecode pins again');
        assert.equal(next.offers[0].status, 3); assert.equal(next.account.balance, (before + 17n).toString());
      } finally { chain.provider.send = original; await f.provider.send('evm_revert', [snapshot]); }
    });

    await t.test('a reorg during a batched workspace prevents returning the entire stale account/order snapshot', async () => {
      const snapshot = await f.provider.send('evm_snapshot', []);
      await (await f.token.transfer(await f.other.getAddress(), 1n)).wait();
      const target = await f.provider.getBlockNumber(); let targetReads = 0;
      const original = chain.provider.getBlock.bind(chain.provider);
      chain.provider.getBlock = async (tag, ...rest) => {
        if (tag === target && ++targetReads === 2) {
          await f.provider.send('evm_revert', [snapshot]);
          await f.advance(1);
        }
        return original(tag, ...rest);
      };
      try { await assert.rejects(chain.readWorkspace(await f.seller.getAddress(), [input.id]), /THOT_SNAPSHOT_CHANGED/); }
      finally { chain.provider.getBlock = original; }
    });

    await t.test('changed code at the same block height blocks account data, offer data, and operator signing', async () => {
      const beforeBlock = await f.provider.getBlockNumber();
      const beforeNonce = await f.provider.getTransactionCount(f.config.operator, 'pending');
      await f.provider.send('anvil_setCode', [f.config.market, '0x60006000fd']);
      assert.equal(await f.provider.getBlockNumber(), beforeBlock);
      await assert.rejects(chain.account(await f.seller.getAddress()), /THOT_CODE_PIN_MISMATCH/);
      await assert.rejects(chain.offer(input.id), /THOT_CODE_PIN_MISMATCH/);
      await assert.rejects(chain.acknowledgeAvailability(input.id, input.evidenceHash), /THOT_CODE_PIN_MISMATCH/);
      assert.equal(await f.provider.getTransactionCount(f.config.operator, 'pending'), beforeNonce);
      await f.provider.send('evm_revert', [baseline]);
      assert.equal((await chain.offer(input.id)).status, 2);
    });

    await t.test('a reorg while reading an account invalidates the returned snapshot', async () => {
      const snapshot = await f.provider.send('evm_snapshot', []);
      await (await f.token.transfer(await f.other.getAddress(), 1n)).wait();
      const target = await f.provider.getBlockNumber(); let targetReads = 0;
      const original = chain.provider.getBlock.bind(chain.provider);
      chain.provider.getBlock = async (tag, ...rest) => {
        if (tag === target && ++targetReads === 2) {
          await f.provider.send('evm_revert', [snapshot]);
          await f.advance(1); // Same height, a different canonical block and state.
        }
        return original(tag, ...rest);
      };
      try { await assert.rejects(chain.account(await f.seller.getAddress()), /THOT_SNAPSHOT_CHANGED/); }
      finally { chain.provider.getBlock = original; }
    });

    await t.test('unsigned claim/referral endpoints also guard against a runtime change', async () => {
      dir = await mkdtemp(join(tmpdir(), 'thot-guard-'));
      app = await createApplication({ dataDir: dir, memory: true, thot: config });
      const sellerAddress = await f.seller.getAddress();
      await app.db.transaction(tx => tx.insert('thot_records', 'wallet:' + demoUser.id, demoUser.id, { kind: 'wallet', address: sellerAddress }));
      const snapshot = await f.provider.send('evm_snapshot', []);
      await f.provider.send('anvil_setCode', [f.config.token, '0x60006000fd']);
      await assert.rejects(app.thot.transaction(demoUser, { action: 'claim' }), /THOT_CODE_PIN_MISMATCH/);
      await assert.rejects(app.thot.transaction(demoUser, { action: 'refer', referrer: await f.referrer.getAddress() }), /THOT_CODE_PIN_MISMATCH/);
      await f.provider.send('evm_revert', [snapshot]);
      assert.equal((await app.thot.transaction(demoUser, { action: 'claim' })).transactions.length, 1);
    });

    await t.test('seller valuation reuses its guarded workspace block, checks reorgs and never caches across requests', async () => {
      const runtime = app.thot.chain, owner = await f.seller.getAddress();
      const anchor = await runtime.snapshot(), traceId = 'workspace-valuation-target';
      await app.db.transaction(async tx => {
        await tx.insert('traces', traceId, demoUser.id, {trace_id: traceId, deleted: false, rights_status: 'eligible', provenance_id: 'workspace-provenance', provenance_status: 'IMPORTED_UNVERIFIED'});
        await tx.insert('trace_features', traceId, demoUser.id, {workflow_type: 'coding', counts: {turns: 3}});
        await tx.insert('provenance_receipts', 'workspace-provenance', demoUser.id, {receipt: {confidence_tier: 'P0_OPERATOR'}});
        for (let n = 1; n <= 3; n++) await tx.insert('thot_records', 'workspace-observation:' + n, 'comparable:' + n, {
          kind: 'sale_observation', confirmation_block: anchor,
          observation: {offer_id: id('comparable sale ' + n), listing: {id: 'listing:' + n, owner_id: 'comparable:' + n, wallet: '0x' + String(n).padStart(40, '0'), workflow: 'coding', provenance: 'P0_OPERATOR', provenance_status: 'IMPORTED_UNVERIFIED', turn_count: 3, eligible: true}, buyer: '0x' + String(n + 10).padStart(40, '0'), buyer_owner_id: 'buyer:' + n, gross_atoms: String(n * 100), finalized_at: anchor.timestamp * 1000 - 1, status: 'finalized', confirmed: true, source: 'independent', independence_reviewed: true},
        });
      });
      const send = runtime.provider.send.bind(runtime.provider), canonical = runtime.isCanonicalBlock.bind(runtime);
      let codeReads = 0, checkedBlocks = [], advanceDuringValuation = true;
      runtime.provider.send = async (method, params) => {if (method === 'eth_getCode') codeReads++; return send(method, params);};
      runtime.isCanonicalBlock = async (observation, confirmed) => {
        checkedBlocks.push(confirmed);
        if (advanceDuringValuation) {advanceDuringValuation = false; await f.advance(2);}
        return canonical(observation, confirmed);
      };
      try {
        const first = await app.thot.workspace(demoUser), valuation = first.valuations.find(v => v.trace_id === traceId).estimate;
        assert.equal(first.account.wallet, owner);
        assert.equal(codeReads, 4, 'valuation must not perform a second deployment guard inside the same request');
        assert.equal(checkedBlocks.length, 1, 'duplicate observation anchors remain deduplicated');
        assert.equal(checkedBlocks[0], first.account.block, 'anchor checks use the actual account/order block object');
        assert.equal(valuation.window.to, new Date(first.account.block.timestamp * 1000).toISOString());
        assert.equal(valuation.independent.median_gross_atoms, '200');
        codeReads = 0; checkedBlocks = [];
        const next = await app.thot.workspace(demoUser);
        assert.equal(codeReads, 4, 'a later workspace independently checks all runtime pins again');
        assert(next.account.block.number > first.account.block.number);
        assert.equal(checkedBlocks[0], next.account.block);

        const beforeCodeChange = await f.provider.send('evm_snapshot', []);
        await f.provider.send('anvil_setCode', [f.config.token, '0x60006000fd']);
        await assert.rejects(app.thot.workspace(demoUser), /THOT_CODE_PIN_MISMATCH/);
        await f.provider.send('evm_revert', [beforeCodeChange]);

        const beforeReorg = await f.provider.send('evm_snapshot', []);
        await f.advance(1);
        runtime.isCanonicalBlock = async (observation, confirmed) => {
          await f.provider.send('evm_revert', [beforeReorg]);
          await f.advance(3);
          return canonical(observation, confirmed);
        };
        await assert.rejects(app.thot.workspace(demoUser), /THOT_SNAPSHOT_CHANGED/, 'a reorg during valuation rejects the entire workspace instead of returning stale earnings');
      } finally {runtime.provider.send = send; runtime.isCanonicalBlock = canonical;}
    });

    await t.test('resetting the local RPC after startup rejects critical reads before any delivery send', async () => {
      await f.provider.send('anvil_reset', []);
      await assert.rejects(chain.account(await f.seller.getAddress()), /THOT_DEPLOYMENT_ANCHOR_MISMATCH/);
      await assert.rejects(chain.offer(input.id), /THOT_DEPLOYMENT_ANCHOR_MISMATCH/);
      const nonce = await f.provider.getTransactionCount(f.config.operator, 'pending');
      await assert.rejects(chain.acknowledgeAvailability(input.id, input.evidenceHash), /THOT_DEPLOYMENT_ANCHOR_MISMATCH/);
      assert.equal(await f.provider.getTransactionCount(f.config.operator, 'pending'), nonce);
    });
  } finally { if (app) await app.close(); chain.close(); await f.close(); if (dir) await rm(dir, { recursive: true, force: true }); }
});
