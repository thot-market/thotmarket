import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ContractFactory, JsonRpcProvider, keccak256, parseEther, MaxUint256, id } from 'ethers';
import solc from 'solc';

const root = new URL('../../', import.meta.url);
let compilation;
export async function compileThot({auditActors=false}={}) {
  if (compilation && (!auditActors || compilation.ExitProbeToken)) return compilation;
  const sources = {};
  for (const name of await readdir(new URL('contracts/src/', root))) {
    if (name.endsWith('.sol')) sources[name] = { content: await readFile(new URL('contracts/src/' + name, root), 'utf8') };
  }
  // Deliberately only a local fixture token. Production takes the existing Pons ERC20 address.
  sources['ThotTestToken.sol'] = { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
contract ThotTestToken {
 string public constant name = "Local test THOT (no monetary value)";
 string public constant symbol = "testTHOT"; uint8 public constant decimals = 18;
 uint256 public immutable totalSupply;
 mapping(address=>uint256) public balanceOf;
 mapping(address=>mapping(address=>uint256)) public allowance;
 event Transfer(address indexed from,address indexed to,uint256 amount);
 event Approval(address indexed owner,address indexed spender,uint256 amount);
 constructor(address owner,uint256 supply) { totalSupply=supply;balanceOf[owner]=supply;emit Transfer(address(0),owner,supply); }
 function approve(address spender,uint256 amount) external returns(bool) { allowance[msg.sender][spender]=amount;emit Approval(msg.sender,spender,amount);return true; }
 function transfer(address to,uint256 amount) external returns(bool) { _move(msg.sender,to,amount);return true; }
 function transferFrom(address from,address to,uint256 amount) external returns(bool) {
  if(allowance[from][msg.sender]!=type(uint256).max) allowance[from][msg.sender]-=amount;
  _move(from,to,amount);return true;
 }
 function _move(address from,address to,uint256 amount) private { require(to!=address(0));balanceOf[from]-=amount;balanceOf[to]+=amount;emit Transfer(from,to,amount); }
}` };
  if(auditActors)sources['ExitActors.sol']={content:await readFile(new URL('contracts/test/fixtures/ExitActors.sol',root),'utf8')};
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } } })));
  const errors = (result.errors ?? []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  compilation = Object.fromEntries(['ThotTestToken', 'ThotLockVault', 'ThotMarket', 'ThotLaunchMarket', 'ThotReserveVault', 'ThotCampaignReserve', 'ThotTreasury', 'ThotGovernor', 'ThotStakingPool', 'ThotHolderRewards', 'ThotFeeDiscounts']
    .map(name => [name, result.contracts[name + '.sol'][name]]));
  if(auditActors)for(const name of ['ExitProbeToken','ExitBeneficiary'])compilation[name]=result.contracts['ExitActors.sol'][name];
  return compilation;
}

/** Standalone isolated Anvil; never connects to public chain or handles production keys. */
export async function deployThotFixture({ outputDir, activate = true, chainId = 31337, auditActors = false,
  anvilPath = process.env.THOT_ANVIL_PATH ?? process.env.ANVIL_PATH ?? 'anvil' } = {}) {
  if (![31337, 46630].includes(chainId)) throw new Error('Unsupported isolated fixture chain ID');
  // Check the selected executable before expensive Solidity compilation or opening
  // a socket. Explicit overrides never silently fall back to another binary.
  if (typeof anvilPath !== 'string' || !anvilPath.trim() || anvilPath.includes('\0')) throw new Error('Invalid Anvil executable');
  const check = spawnSync(anvilPath, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
  if (check.error || check.status !== 0 || !/^anvil Version:/m.test(check.stdout ?? '')) {
    throw new Error('Local Anvil unavailable. Install Foundry v1.7.1 on PATH or set THOT_ANVIL_PATH to its Anvil executable.');
  }
  const artifacts = await compileThot({auditActors});
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(anvilPath, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--threads', '1', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '', spawnFailed = false;
  child.stderr.on('data', value => { diagnostic = (diagnostic + value.toString()).slice(-8192); });
  child.on('error', error => { spawnFailed = true; diagnostic = error.message; });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(rpcUrl, chainId, { cacheTimeout: -1, batchMaxCount: 1 }); provider.pollingInterval = 20;
  const close = async () => { provider.destroy(); if (child.exitCode === null && child.pid) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } };
  try {
    for (let i = 0; ; i++) {
      try { await provider.send('eth_chainId', []); break; }
      catch { if (i > 100 || spawnFailed || child.exitCode !== null) throw new Error('Local Anvil unavailable: ' + diagnostic); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const addresses = await provider.send('eth_accounts', []);
    const signers = await Promise.all(addresses.map(address => provider.getSigner(address)));
    const [admin, buyer, seller, referrer, protocol, attacker, other] = signers;
    const deploy = async (name, args = []) => {
      const artifact = artifacts[name]; const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, admin).deploy(...args);
      await contract.waitForDeployment(); return contract;
    };
    const token = await deploy('ThotTestToken', [addresses[0], parseEther('1000000000')]);
    const locks = await deploy('ThotLockVault', [await token.getAddress()]);
    const reserve = await deploy('ThotReserveVault', [await token.getAddress(), addresses[0], addresses[0]]);
    const market = await deploy('ThotMarket', [await token.getAddress(), await locks.getAddress(), await reserve.getAddress(), addresses[0], addresses[0], addresses[4]]);
    await (await token.transfer(await reserve.getAddress(), parseEther('500000000'))).wait();
    for (const index of [1, 2, 3, 5, 6]) await (await token.transfer(addresses[index], parseEther('20000000'))).wait();
    for (const signer of signers.slice(0, 7)) {
      await (await token.connect(signer).approve(await market.getAddress(), MaxUint256)).wait();
      await (await token.connect(signer).approve(await locks.getAddress(), MaxUint256)).wait();
    }
    const now = async () => Number((await provider.getBlock('latest')).timestamp);
    const warp = async timestamp => { await provider.send('evm_setNextBlockTimestamp', [Number(timestamp)]); await provider.send('evm_mine', []); };
    const advance = async seconds => warp((await now()) + Number(seconds));
    const activateCampaign = async () => {
      const startAt = (await now()) + 7 * 86400 + 30;
      await (await reserve.queueCampaign(await market.getAddress(), startAt)).wait();
      await warp(startAt);
      await (await reserve.executeCampaign(await market.getAddress(), startAt)).wait();
      return startAt;
    };
    if (activate) await activateCampaign();
    const block = await provider.getBlock('latest');
    const config = { mechanism: 'thot-v0.9', rpcUrl, chainId, confirmations: 1, token: await token.getAddress(), locks: await locks.getAddress(), reserve: await reserve.getAddress(), market: await market.getAddress(), operator: addresses[0], protocolRecipient: addresses[4], deploymentBlock: block.number, deploymentBlockHash: block.hash, codeHashes: {} };
    const manifest = { scope: 'Isolated local Anvil rehearsal. testTHOT has no monetary value. No public-chain transaction or production key.', config,
      accounts: { operator: addresses[0], buyer: addresses[1], seller: addresses[2], referrer: addresses[3], protocol: addresses[4], attacker: addresses[5] },
      compiler: solc.version(), evmVersion: 'shanghai', campaignActivated: activate, codeHashes: {} };
    for (const key of ['token', 'locks', 'reserve', 'market']) {
      manifest.codeHashes[key] = keccak256(await provider.getCode(config[key]));
      config.codeHashes[key] = manifest.codeHashes[key];
    }
    if (outputDir) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(outputDir + '/deployment.json', JSON.stringify(manifest, null, 2) + '\n');
      await writeFile(outputDir + '/chain-config.json', JSON.stringify(config, null, 2) + '\n');
      for (const [name, artifact] of Object.entries(artifacts)) await writeFile(outputDir + '/' + name + '.json', JSON.stringify(artifact, null, 2) + '\n');
    }
    const input = async (label, { buyerAddress = addresses[1], sellerAddress = addresses[2], gross = parseEther('100000') } = {}) => {
      const nonce = id(label);
      return { id: await market.offerId(buyerAddress, nonce), nonce, seller: sellerAddress, gross, licenseHash: id(label + ':exact-license'), evidenceHash: id(label + ':private-material-commitment') };
    };
    return { provider, signers, admin, buyer, seller, referrer, protocol, attacker, other, token, locks, reserve, market, deploy, artifacts, config, manifest, now, warp, advance, activateCampaign, input, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputDir = process.argv[2] ?? fileURLToPath(new URL('work/thot-contracts/', root));
  const fixture = await deployThotFixture({ outputDir });
  console.log(JSON.stringify(fixture.manifest, null, 2));
  console.log('Local fixture stays active until interrupted. Public-chain deployment is not performed.');
  const stop = async () => { await fixture.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
