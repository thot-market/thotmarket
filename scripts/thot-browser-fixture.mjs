import assert from 'node:assert/strict';
import {keccak256, parseEther} from 'ethers';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';

/** Always spawns a new loopback Anvil. No supplied RPC, keys or chain configuration. */
export async function deployBrowserFixture(economics = 'quoted-cost') {
  assert(['quoted-cost', 'percentage'].includes(economics), 'Unsupported local economics');
  const f = await deployThotFixture({activate: false});
  try {
    if (economics === 'percentage') {
      const addresses = await Promise.all(f.signers.map(s => s.getAddress()));
      const token = await f.deploy('ThotTestToken', [addresses[0], parseEther('1000000000')]);
      const governor = await f.deploy('ThotGovernor', [addresses.slice(0, 3)]);
      const govern = async (contract, method, args = []) =>
        (await governor.submitAndExecute(await contract.getAddress(), contract.interface.encodeFunctionData(method, args))).wait();
      const reserve = await f.deploy('ThotTreasury', [await token.getAddress(), await governor.getAddress(), addresses[0]]);
      const staking = await f.deploy('ThotStakingPool', [await token.getAddress(), await reserve.getAddress()]);
      const locks = await f.deploy('ThotLockVault', [await token.getAddress()]);
      const market = await f.deploy('ThotLaunchMarket', [await token.getAddress(), await locks.getAddress(), await reserve.getAddress(), await governor.getAddress(), addresses[0], addresses[4], 31337]);
      await govern(reserve, 'bindStakingPool', [await staking.getAddress()]);
      await govern(reserve, 'bindMarket', [await market.getAddress()]);
      const feeDiscounts = await f.deploy('ThotFeeDiscounts', [await token.getAddress(), await staking.getAddress(), await governor.getAddress()]);
      // Selected 20% / 30% holder discounts; buyer qualifies for 30%, seller 20%.
      await govern(feeDiscounts, 'setPolicy', [parseEther('10000'), parseEther('100000'), 2000, 3000]);
      await govern(feeDiscounts, 'setLockPolicy', [parseEther('100000'), 90 * 86400, 3500]);
      await govern(market, 'bindFeeDiscounts', [await feeDiscounts.getAddress()]);
      await govern(market, 'queueUnpause'); await govern(market, 'unpause');
      await (await token.transfer(await reserve.getAddress(), parseEther('500000000'))).wait();
      await (await token.transfer(addresses[1], parseEther('200000'))).wait();
      await (await token.transfer(addresses[2], parseEther('10000'))).wait();
      const config = {...f.config, percentageFees: true, sharedTreasury: true, reserveCampaigns: true, manualReserve: true, governanceKind: 'controller', codeHashes: {}};
      for (const [name, contract] of Object.entries({token, locks, market, reserve, staking, governor, feeDiscounts})) {
        config[name] = await contract.getAddress();
        config.codeHashes[name] = keccak256(await f.provider.getCode(config[name]));
      }
      const block = await f.provider.getBlock('latest');
      config.deploymentBlock = block.number; config.deploymentBlockHash = block.hash;
      Object.assign(f, {token, locks, market, reserve, config, manifest: {...f.manifest, config, codeHashes: config.codeHashes}});
    }
    // Exercise the approval step too; the general fixture preapproves its market.
    await (await f.token.connect(f.buyer).approve(await f.market.getAddress(), 0)).wait();
    const expectedGenesis = (await f.provider.getBlock(0)).hash;
    const originalAdvance = f.advance;
    f.advance = async seconds => {
      assert(Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3 * 86400);
      const rpc = new URL(f.config.rpcUrl);
      assert.equal(rpc.hostname, '127.0.0.1'); assert.equal(rpc.protocol, 'http:');
      assert.equal((await f.provider.getNetwork()).chainId, 31337n);
      assert.match(await f.provider.send('web3_clientVersion', []), /anvil/i);
      assert.equal((await f.provider.getBlock(0)).hash, expectedGenesis);
      // originalAdvance closes over the provider of the child we created, never user input.
      await originalAdvance(seconds);
    };
    return f;
  } catch (error) {await f.close(); throw error;}
}
