import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { ContractFactory, JsonRpcProvider, MaxUint256, ZeroAddress, parseEther as u, keccak256 } from 'ethers';
import solc from 'solc';

// Real EVM execution on a fresh, loopback-only Anvil. No public RPC, deployment keys or funding.
const DAY = 86400;
const MENU = [[30 * DAY, 500], [60 * DAY, 1200], [90 * DAY, 3000]];
const tx = async promise => (await promise).wait();
let f, snapshot;

async function fixture() {
  const executable = process.env.THOT_ANVIL_PATH ?? process.env.ANVIL_PATH ?? 'anvil';
  const check = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(check.status, 0, 'Install Anvil or set THOT_ANVIL_PATH');
  assert.match(check.stdout, /^anvil Version:/m);
  const sources = {};
  for (const name of ['TokenInterfaces', 'ThotGovernor', 'ThotStakingPool']) {
    sources[`${name}.sol`] = { content: await readFile(new URL(`../src/${name}.sol`, import.meta.url), 'utf8') };
  }
  sources['StakingFixtureToken.sol'] = { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
contract StakingFixtureToken {
    address public immutable admin = msg.sender;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public fee;
    constructor() { balanceOf[msg.sender] = 1_000_000_000 ether; }
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value; return true;
    }
    function transfer(address to, uint256 value) external returns (bool) { move(msg.sender, to, value); return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= value;
        move(from, to, value); return true;
    }
    function move(address from, address to, uint256 value) private {
        balanceOf[from] -= value; balanceOf[to] += value - fee;
    }
    function setFee(uint256 value) external { require(msg.sender == admin); fee = value; }
    function forceDebit(address owner, uint256 amount) external { require(msg.sender == admin); balanceOf[owner] -= amount; }
}` };
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  } })));
  const errors = (result.errors ?? []).filter(error => error.severity === 'error');
  assert.equal(errors.length, 0, errors.map(error => error.formattedMessage).join('\n'));
  const artifacts = Object.fromEntries(['ThotGovernor', 'ThotStakingPool', 'StakingFixtureToken']
    .map(name => [name, result.contracts[`${name}.sol`][name]]));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(executable, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '46630', '--threads', '1', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '', spawnError;
  child.on('error', error => { spawnError = error; });
  child.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-8192); });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 46630, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 10;
  const close = async () => {
    provider.destroy();
    if (child.pid && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try { await provider.send('eth_chainId', []); break; }
      catch { if (attempt >= 100 || spawnError || child.exitCode !== null) throw new Error(`Anvil failed: ${spawnError ?? diagnostic}`);
        await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const addresses = await provider.send('eth_accounts', []);
    const signers = await Promise.all(addresses.slice(0, 5).map(address => provider.getSigner(address)));
    const deploy = async (name, args = []) => {
      const artifact = artifacts[name];
      const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signers[0]).deploy(...args);
      await contract.waitForDeployment(); return contract;
    };
    const token = await deploy('StakingFixtureToken');
    const governor = await deploy('ThotGovernor', [addresses.slice(0, 3)]);
    const pool = await deploy('ThotStakingPool', [await token.getAddress(), await governor.getAddress()]);
    const poolAddress = await pool.getAddress();
    for (const signer of signers) {
      await tx(token.transfer(await signer.getAddress(), u('1000000')));
      await tx(token.connect(signer).approve(poolAddress, MaxUint256));
    }
    const now = async () => Number((await provider.getBlock('latest')).timestamp);
    const warp = async timestamp => { await provider.send('evm_setNextBlockTimestamp', [Number(timestamp)]); await provider.send('evm_mine', []); };
    const govern = async (method, args = [], owner = signers[0]) =>
      tx(governor.connect(owner).submitAndExecute(poolAddress, pool.interface.encodeFunctionData(method, args)));
    return { provider, artifacts, addresses, signers, deploy, token, governor, pool, poolAddress, now, warp, govern, close };
  } catch (error) { await close(); throw error; }
}

before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });
beforeEach(async () => { snapshot = await f.provider.send('evm_snapshot', []); });
afterEach(async () => { await f.provider.send('evm_revert', [snapshot]); });

async function campaign({ cap = u('30000'), budget = u('9000'), terms = MENU, openDays = 7, start, prefund = true } = {}) {
  if (prefund) await tx(f.pool.fund(budget));
  const starts = start ?? await f.now() + 10;
  await f.govern('createCampaign', [starts, starts + openDays * DAY, cap, budget, terms]);
  return { id: await f.pool.campaignCount(), starts, ends: starts + openDays * DAY };
}

async function balanced({ principal, reward, unallocated, free = 0n }) {
  assert.equal(await f.pool.totalPrincipal(), principal);
  assert.equal(await f.pool.totalRewardLiability(), reward);
  assert.equal(await f.pool.totalUnallocatedRewards(), unallocated);
  assert.equal(await f.pool.freeBalance(), free);
  assert.equal(await f.token.balanceOf(f.poolAddress), principal + reward + unallocated + free);
}

test('finalized 30M reward budget backs 100M principal and cannot be allocated twice', async () => {
  const c = await campaign({ cap: u('100000000'), budget: u('30000000') });
  await assert.rejects(campaign({ cap: u('1'), budget: u('0.3'), prefund: false }), /PREFUND_REWARDS/);
  await f.warp(c.starts);
  await tx(f.pool.stake(c.id, 2, u('100000000')));
  await balanced({ principal: u('100000000'), reward: u('30000000'), unallocated: 0n });
  await assert.rejects(f.pool.stake.staticCall(c.id, 2, 1n), /PRINCIPAL_CAP/);
  const position = await f.pool.positions(1);
  await f.warp(Number(position.unlockAt));
  const before = await f.token.balanceOf(f.addresses[0]);
  await tx(f.pool.claim(1));
  assert.equal(await f.token.balanceOf(f.addresses[0]), before + u('130000000'));
  await balanced({ principal: 0n, reward: 0n, unallocated: 0n });
});

test('only the configured controller commits bounded, fully funded campaign terms', async t => {
  assert.equal(await f.governor.getThreshold(), 1n);
  assert.ok(f.artifacts.ThotStakingPool.evm.deployedBytecode.object.length / 2 <= 24576);
  await assert.rejects(f.deploy('ThotStakingPool', [ZeroAddress, await f.governor.getAddress()]));
  await assert.rejects(f.deploy('ThotStakingPool', [await f.token.getAddress(), f.addresses[0]]));
  const starts = await f.now() + 100;
  const args = [starts, starts + 7 * DAY, u('30000'), u('9000'), MENU];
  await assert.rejects(f.pool.createCampaign.staticCall(...args), /GOVERNOR/);
  await assert.rejects(f.govern('createCampaign', args), /PREFUND_REWARDS/);
  await tx(f.pool.fund(u('9000')));
  for (const terms of [[], Array.from({ length: 9 }, (_, i) => [(i + 1) * DAY, 500]),
    [[DAY - 1, 500]], [[731 * DAY, 500]], [[30 * DAY, 0]], [[30 * DAY, 10001]],
    [[60 * DAY, 1200], [30 * DAY, 500]], [[30 * DAY, 500], [30 * DAY, 1000]]]) {
    await assert.rejects(f.govern('createCampaign', [...args.slice(0, 4), terms]));
  }
  await assert.rejects(f.govern('createCampaign', [starts, starts, ...args.slice(2)]), /ENROLLMENT/);
  await assert.rejects(f.govern('createCampaign', [starts, starts + DAY, u('30000'), u('8999'), MENU]), /REWARD_BUDGET/);
  await f.govern('createCampaign', args, f.signers[1]);
  assert.equal(await f.pool.campaignCount(), 1n);
  assert.deepEqual((await f.pool.terms(1)).map(term => [...term]), MENU.map(term => term.map(BigInt)));
  await assert.rejects(f.pool.terms(0), /CAMPAIGN_ID/);
  await balanced({ principal: 0n, reward: 0n, unallocated: u('9000') });
  t.diagnostic(`Standalone staking deployed bytecode: ${f.artifacts.ThotStakingPool.evm.deployedBytecode.object.length / 2} bytes`);
});

test('30/60/90-day positions pay exactly 5/12/30 percent with no trace-sale dependency', async () => {
  const c = await campaign(); await f.warp(c.starts);
  for (let term = 0; term < 3; term++) await tx(f.pool.connect(f.signers[3]).stake(c.id, term, u('10000')));
  const owner = f.addresses[3];
  const expected = [u('500'), u('1200'), u('3000')];
  for (let i = 0; i < 3; i++) {
    const position = await f.pool.positions(i + 1);
    assert.equal(position.owner.toLowerCase(), owner.toLowerCase());
    assert.equal(position.reward, expected[i]);
    assert.equal(position.unlockAt - position.depositedAt, BigInt(MENU[i][0]));
    await assert.rejects(f.pool.connect(f.signers[3]).claim.staticCall(i + 1), /LOCKED/);
    await assert.rejects(f.pool.claim.staticCall(i + 1), /OWNER_OR_CLAIMED/);
  }
  await balanced({ principal: u('30000'), reward: u('4700'), unallocated: u('4300') });
  const walletBefore = await f.token.balanceOf(owner);
  await f.warp(c.ends);
  await tx(f.pool.connect(f.signers[4]).closeCampaign(c.id));
  await f.govern('recoverFreeTokens', [f.addresses[0], u('4300')]);
  await balanced({ principal: u('30000'), reward: u('4700'), unallocated: 0n });
  for (let i = 0; i < 3; i++) {
    const position = await f.pool.positions(i + 1);
    await f.warp(position.unlockAt);
    await tx(f.pool.connect(f.signers[3]).claim(i + 1));
    assert.equal((await f.pool.positions(i + 1)).claimed, true);
    await assert.rejects(f.pool.connect(f.signers[3]).claim.staticCall(i + 1), /OWNER_OR_CLAIMED/);
  }
  assert.equal(await f.token.balanceOf(owner), walletBefore + u('34700'));
  assert.deepEqual([...(await f.pool.activePositionIds(owner))], []);
  assert.equal((await f.pool.campaigns(c.id)).outstandingReward, 0n);
  await balanced({ principal: 0n, reward: 0n, unallocated: 0n });
});

test('concurrent campaigns cannot reuse reward inventory or participant principal', async () => {
  await tx(f.pool.fund(u('600')));
  const a = await campaign({ cap: u('1000'), budget: u('300'), prefund: false });
  const b = await campaign({ cap: u('1000'), budget: u('300'), prefund: false });
  await assert.rejects(campaign({ cap: u('1'), budget: u('.3'), prefund: false }), /PREFUND_REWARDS/);
  await f.warp(b.starts);
  await tx(f.pool.connect(f.signers[3]).stake(a.id, 2, u('1000')));
  await assert.rejects(campaign({ cap: u('1000'), budget: u('300'), prefund: false }), /PREFUND_REWARDS/);
  await assert.rejects(f.govern('recoverFreeTokens', [f.addresses[0], 1]), /PROTECTED_FUNDS/);
  await balanced({ principal: u('1000'), reward: u('300'), unallocated: u('300') });
  await f.govern('closeCampaign', [b.id]);
  await balanced({ principal: u('1000'), reward: u('300'), unallocated: 0n, free: u('300') });
  const next = await campaign({ cap: u('1000'), budget: u('300'), prefund: false });
  assert.equal(next.id, 3n);
  await balanced({ principal: u('1000'), reward: u('300'), unallocated: u('300') });
});

test('claimed principal never recycles lifetime campaign capacity', async () => {
  const c = await campaign({ cap: u('1000'), budget: u('50'), terms: [[30 * DAY, 500]], openDays: 100 });
  await f.warp(c.starts);
  await assert.rejects(f.pool.stake.staticCall(c.id, 0, 0), /PRINCIPAL_CAP/);
  await assert.rejects(f.pool.stake.staticCall(c.id, 3, 1), /TERM_INDEX/);
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 0, u('1000')));
  await f.warp((await f.pool.positions(1)).unlockAt);
  await tx(f.pool.connect(f.signers[3]).claim(1));
  await tx(f.pool.fund(u('100')));
  await assert.rejects(f.pool.connect(f.signers[3]).stake.staticCall(c.id, 0, u('1')), /PRINCIPAL_CAP/);
  assert.equal((await f.pool.campaigns(c.id)).totalDeposited, u('1000'));
  await balanced({ principal: 0n, reward: 0n, unallocated: 0n, free: u('100') });
});

test('immediate new rules, admission pauses and cancellation cannot change an existing promise', async () => {
  const c = await campaign(); await f.warp(c.starts);
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')));
  const original = [...await f.pool.positions(1)];
  await assert.rejects(f.pool.setAdmissionsPaused(c.id, true), /GOVERNOR/);
  await assert.rejects(f.pool.connect(f.signers[4]).closeCampaign(c.id), /GOVERNOR_OR_EXPIRED/);
  await assert.rejects(f.pool.recoverFreeTokens(f.addresses[0], 1), /GOVERNOR/);
  await assert.rejects(f.govern('setAdmissionsPaused', [c.id, true], f.signers[4]), /OWNER/);
  await f.govern('setAdmissionsPaused', [c.id, true], f.signers[2]);
  await assert.rejects(f.pool.stake.staticCall(c.id, 0, u('1')), /ADMISSIONS_CLOSED/);
  await f.govern('setAdmissionsPaused', [c.id, false]);
  await tx(f.pool.connect(f.signers[4]).stake(c.id, 0, u('1000')));
  const second = await campaign({ cap: u('10000'), budget: u('2000'), terms: [[90 * DAY, 2000]] });
  await f.warp(second.starts);
  await tx(f.pool.connect(f.signers[3]).stake(second.id, 0, u('10000')));
  assert.equal((await f.pool.positions(3)).reward, u('2000'));
  assert.deepEqual([...await f.pool.positions(1)], original);
  await f.govern('closeCampaign', [c.id]);
  await assert.rejects(f.pool.stake.staticCall(c.id, 0, u('1')), /ADMISSIONS_CLOSED/);
  await assert.rejects(f.govern('setAdmissionsPaused', [c.id, false]), /CLOSED/);
  await assert.rejects(f.govern('closeCampaign', [c.id]), /CLOSED/);
  const unused = await f.pool.freeBalance();
  assert.equal(unused, u('5950'));
  await f.govern('recoverFreeTokens', [f.addresses[0], unused]);
  await f.warp(original[5]);
  await tx(f.pool.connect(f.signers[3]).claim(1));
  assert.equal((await f.pool.positions(1)).reward, u('3000'));
  assert.equal((await f.pool.positions(3)).claimed, false);
});

test('enrollment closes precisely and each deposit gets its own full lock with no expiry on claims', async () => {
  const c = await campaign();
  await assert.rejects(f.pool.stake.staticCall(c.id, 2, u('10000')), /ADMISSIONS_CLOSED/);
  await f.provider.send('evm_setNextBlockTimestamp', [c.starts]);
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')));
  assert.equal((await f.pool.positions(1)).depositedAt, BigInt(c.starts));
  await f.provider.send('evm_setNextBlockTimestamp', [c.ends - 1]);
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')));
  assert.equal((await f.pool.positions(2)).unlockAt, BigInt(c.ends - 1 + 90 * DAY));
  await f.warp(c.ends);
  await assert.rejects(f.pool.stake.staticCall(c.id, 2, u('1')), /ADMISSIONS_CLOSED/);
  await tx(f.pool.connect(f.signers[4]).closeCampaign(c.id));
  const second = await f.pool.positions(2);
  await f.warp(Number(second.unlockAt) - 1);
  await assert.rejects(f.pool.connect(f.signers[3]).claim.staticCall(2), /LOCKED/);
  await f.warp(Number(second.unlockAt) + 1000 * DAY);
  assert.equal((await f.pool.positions(2)).claimed, false, 'maturity does not push payment or compound');
  await tx(f.pool.connect(f.signers[3]).claim(2));
  await tx(f.pool.connect(f.signers[3]).claim(1));
  await balanced({ principal: 0n, reward: 0n, unallocated: 0n, free: u('3000') });
});

test('integer rounding cannot overallocate and active position reads stay bounded', async () => {
  assert.equal(await f.pool.rewardFor(MaxUint256, 3000), MaxUint256 * 3000n / 10000n);
  assert.equal(await f.pool.rewardFor(1001n, 1200), 120n);
  const c = await campaign({ cap: 64000n, budget: 19200n, openDays: 100 });
  await f.warp(c.starts);
  await assert.rejects(f.pool.stake.staticCall(c.id, 0, 1), /REWARD_BUDGET/);
  for (let i = 0; i < 64; i++) await tx(f.pool.connect(f.signers[3]).stake(c.id, 0, 999n));
  assert.equal((await f.pool.activePositionIds(f.addresses[3])).length, 64);
  await assert.rejects(f.pool.connect(f.signers[3]).stake.staticCall(c.id, 0, 20n), /POSITION_LIMIT/);
  await balanced({ principal: 63936n, reward: 3136n, unallocated: 16064n });
  await f.warp((await f.pool.positions(64)).unlockAt);
  await tx(f.pool.connect(f.signers[3]).claim(32));
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 0, 64n));
  const ids = [...await f.pool.activePositionIds(f.addresses[3])];
  assert.equal(ids.length, 64); assert.equal(new Set(ids).size, 64);
  assert.equal(ids.includes(32n), false); assert.equal(ids.includes(65n), true);
  assert.equal((await f.pool.positions(32)).claimed, true, 'history is not overwritten when a slot becomes free');
  await balanced({ principal: 63001n, reward: 3090n, unallocated: 16061n });
});

test('fee-on-transfer funding, deposits and claims revert without corrupting liabilities', async () => {
  await tx(f.token.setFee(1));
  await assert.rejects(f.pool.fund(u('9000')), /EXACT_TRANSFER/);
  assert.equal(await f.token.balanceOf(f.poolAddress), 0n);
  await tx(f.token.setFee(0));
  const c = await campaign(); await f.warp(c.starts);
  await tx(f.token.setFee(1));
  await assert.rejects(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')), /EXACT_TRANSFER/);
  assert.equal(await f.pool.positionCount(), 0n);
  await balanced({ principal: 0n, reward: 0n, unallocated: u('9000') });
  await tx(f.token.setFee(0));
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')));
  await f.warp((await f.pool.positions(1)).unlockAt);
  await tx(f.token.setFee(1));
  await assert.rejects(f.pool.connect(f.signers[3]).claim(1), /EXACT_TRANSFER/);
  assert.equal((await f.pool.positions(1)).claimed, false);
  await balanced({ principal: u('10000'), reward: u('3000'), unallocated: u('6000') });
  await tx(f.token.setFee(0));
  await tx(f.pool.connect(f.signers[3]).claim(1));
});

test('unexpected balance loss fails closed before new principal can cover a missing reward', async () => {
  const c = await campaign(); await f.warp(c.starts);
  await tx(f.token.forceDebit(f.poolAddress, 1));
  const ownerBefore = await f.token.balanceOf(f.addresses[3]);
  await assert.rejects(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')), /INSOLVENT/);
  assert.equal(await f.token.balanceOf(f.addresses[3]), ownerBefore);
  assert.equal(await f.pool.positionCount(), 0n);
  await assert.rejects(f.govern('recoverFreeTokens', [f.addresses[0], 1]), /INSOLVENT/);
  await tx(f.pool.fund(1));
  await tx(f.pool.connect(f.signers[3]).stake(c.id, 2, u('10000')));
  await f.warp((await f.pool.positions(1)).unlockAt);
  await tx(f.token.forceDebit(f.poolAddress, 1));
  await assert.rejects(f.pool.connect(f.signers[3]).claim(1), /INSOLVENT/);
  await tx(f.pool.fund(1));
  await tx(f.pool.connect(f.signers[3]).claim(1));
  await balanced({ principal: 0n, reward: 0n, unallocated: u('6000') });
});


test('wallet adapter prepares bounded deposits and enforces owner and maturity for claims',async()=>{
 const {stakingWorkspace,prepareStaking}=await import('../../packages/chain/thot-staking.ts');
 const now=await f.now();await tx(f.pool.fund(u('300')));await f.govern('createCampaign',[now+10,now+1000,u('1000'),u('300'),MENU]);await f.warp(now+11);
 const chain={config:{staking:f.poolAddress,token:await f.token.getAddress(),governor:await f.governor.getAddress(),chainId:46630,codeHashes:{staking:keccak256(await f.provider.getCode(f.poolAddress))}},provider:f.provider,token:f.token,
 snapshot:async()=>{const b=await f.provider.getBlock('latest');return {number:b.number,hash:b.hash,timestamp:b.timestamp};},assertSnapshot:async b=>assert.equal((await f.provider.getBlock(b.number)).hash,b.hash),account:async owner=>({balance:String(await f.token.balanceOf(owner))}),transaction:(_kind,method,args)=>({to:f.token.target,data:f.token.interface.encodeFunctionData(method,args),value:'0x0',chainId:'0xb626'})};
 const owner=f.addresses[1];const prepared=await prepareStaking(chain,owner,{action:'stake',campaign_id:'1',term_index:2,amount_atoms:String(u('100'))});
 assert.equal(prepared.quote.reward_atoms,String(u('30')));assert.equal(prepared.transactions.length,2);
 for(const tx of prepared.transactions)await (await f.signers[1].sendTransaction(tx)).wait();
 const state=await stakingWorkspace(chain,owner);assert.equal(state.positions.length,1);assert.equal(state.positions[0].reward,String(u('30')));
 await assert.rejects(()=>prepareStaking(chain,f.addresses[2],{action:'staking-claim',id:state.positions[0].id}),/STAKING_POSITION_NOT_OWNED/);
 await assert.rejects(()=>prepareStaking(chain,owner,{action:'staking-claim',id:state.positions[0].id}),/STAKING_NOT_MATURE/);
 await assert.rejects(()=>prepareStaking(chain,owner,{action:'stake',campaign_id:'1',term_index:9,amount_atoms:'100'}),/STAKING_OFFER_NOT_FOUND/);
 await f.warp(state.positions[0].unlock_at);
 const claim=await prepareStaking(chain,owner,{action:'staking-claim',id:state.positions[0].id});await (await f.signers[1].sendTransaction(claim.transactions[0])).wait();
 assert.equal((await stakingWorkspace(chain,owner)).positions.length,0);
 chain.config.codeHashes.staking='0x'+'00'.repeat(32);await assert.rejects(()=>stakingWorkspace(chain,owner),/STAKING_CODE_PIN_MISMATCH/);
});
