import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ContractFactory,keccak256,parseEther,ZeroAddress} from 'ethers';
import solc from 'solc';
import {deployThotFixture} from '../contracts/scripts/thot-local-fixture.mjs';
import {ThotChain} from '../packages/chain/thot.ts';
import {ThotGovernance} from '../packages/market/src/thot-governance.ts';

async function deployLegacyTwoOwnerGovernor(f,owners){
 // Explicit historical policy for older deployments; the selected current controller
 // is one-of-three on every chain, including local chain 31337.
 const current=readFileSync(new URL('../contracts/src/ThotGovernor.sol',import.meta.url),'utf8');
 assert.match(current,/THRESHOLD = 1;/);
 const source=current.replace('THRESHOLD = 1;','THRESHOLD = 2;');
 const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'LegacyTwoOwnerGovernor.sol':{content:source}},settings:{optimizer:{enabled:true,runs:1},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
 assert.deepEqual((compiled.errors??[]).filter(e=>e.severity==='error'),[]);
 const artifact=compiled.contracts['LegacyTwoOwnerGovernor.sol'].ThotGovernor;
 const governor=await new ContractFactory(artifact.abi,artifact.evm.bytecode.object,f.admin).deploy(owners);
 await governor.waitForDeployment();return governor;
}

test('explicit legacy two-owner controller preserves unsigned approval and timelock coverage',async()=>{
 const f=await deployThotFixture({activate:false});let chain;
 try{
  const a=await Promise.all(f.signers.map(s=>s.getAddress())),tx=async p=>(await p).wait();
  const governor=await deployLegacyTwoOwnerGovernor(f,[a[0],a[1],a[6]]);
  const reserve=await f.deploy('ThotReserveVault',[await f.token.getAddress(),await governor.getAddress(),a[0]]);
  const market=await f.deploy('ThotMarket',[await f.token.getAddress(),await f.locks.getAddress(),await reserve.getAddress(),await governor.getAddress(),a[0],a[4]]);
  assert.equal(await governor.getThreshold(),2n);assert.equal(await reserve.GOVERNANCE_DELAY(),86400n);assert.equal(await market.GOVERNANCE_DELAY(),604800n);
  const block=await f.provider.getBlock('latest');
  const config={...f.config,reserve:await reserve.getAddress(),market:await market.getAddress(),governor:await governor.getAddress(),manualReserve:true,localDeliverySigner:a[0],deploymentBlock:block.number,deploymentBlockHash:block.hash,codeHashes:{...f.config.codeHashes}};
  for(const key of ['reserve','market','governor'])config.codeHashes[key]=keccak256(await f.provider.getCode(config[key]));
  chain=new ThotChain(config);const api=new ThotGovernance(chain);
  const prepare=(input,owner=a[0])=>api.prepare(owner,input);
  const submit=async(input)=>{
   const nonce=await governor.nextNonce(),p=await prepare(input),t=p.transactions[0],decoded=governor.interface.parseTransaction(t);
   assert.equal(decoded.name,'submit');assert.equal(decoded.args[0],config.reserve);assert.equal(t.value,'0x0');assert.equal(t.to,config.governor);
   const op=await governor.operationId(nonce,decoded.args[0],decoded.args[1]);
   await tx(f.admin.sendTransaction(t));return {op,p};
  };
  const approve=async op=>{const p=await prepare({action:'confirm',id:op},a[1]);await tx(f.buyer.sendTransaction(p.transactions[0]));};
  const execute=async op=>{const p=await prepare({action:'execute',id:op});await tx(f.admin.sendTransaction(p.transactions[0]));};
  const governed=async input=>{const r=await submit(input);await approve(r.op);await execute(r.op);return r;};
  await assert.rejects(prepare({action:'queue_buyer',buyer:a[3],allowed:true},a[3]),/GOVERNANCE_OWNER_REQUIRED/);
  await assert.rejects(prepare({action:'queue_buyer',buyer:ZeroAddress,allowed:true}),/INVALID_RESERVE_BUYER/);
  await assert.rejects(prepare({action:'queue_buyer',buyer:config.reserve,allowed:true}),/INVALID_RESERVE_BUYER/);
  await assert.rejects(prepare({action:'queue_buyer',buyer:a[3],allowed:'false'}),/BUYER_PERMISSION_REQUIRED/);
  await assert.rejects(prepare({action:'execute_buyer',buyer:a[3],allowed:true}),/GOVERNANCE_ACTION_NOT_QUEUED/);
  const before=await governor.operationCount(),unsigned=await prepare({action:'queue_buyer',buyer:a[3],allowed:true});
  assert.equal(await governor.operationCount(),before,'preparation submits nothing');assert.equal(unsigned.review.authorized_now,false);assert.equal(unsigned.review.authorize_after_execution,true);
  assert.equal(reserve.interface.parseTransaction({data:unsigned.review.calldata}).name,'queueBuyer');
  const q=await submit({action:'queue_buyer',buyer:a[3],allowed:true});
  await assert.rejects(execute(q.op),/GOVERNANCE_APPROVALS_REQUIRED/);await approve(q.op);await execute(q.op);
  assert.equal(await reserve.authorizedBuyers(a[3]),false,'queue alone grants no read or purchase authority');
  const queued=(await api.workspace(a[0])).operations.find(o=>o.id===q.op);assert.equal(queued.action,'queueBuyer');assert.deepEqual(queued.args,[a[3],true]);assert.equal(queued.timelock.ready,false);
  await assert.rejects(prepare({action:'execute_buyer',buyer:a[3],allowed:false}),/GOVERNANCE_ACTION_NOT_QUEUED/,'opposite permission cannot borrow queued authorization');
  const apply=await submit({action:'execute_buyer',buyer:a[3],allowed:true});await approve(apply.op);
  await assert.rejects(execute(apply.op),/GOVERNANCE_TIMELOCK_PENDING/);assert.equal((await api.workspace(a[0])).operations.find(o=>o.id===apply.op).executable,false);
  await f.advance(86401);await execute(apply.op);assert.equal(await reserve.authorizedBuyers(a[3]),true);
  await assert.rejects(execute(apply.op),/GOVERNANCE_OPERATION_EXECUTED/);
  assert.equal((await api.workspace(a[0])).buyers.find(b=>b.address===a[3]).authorized,true);
  assert.equal((await api.workspace(a[3])).owner,false,'buyer permission does not make a governor owner');
  assert.equal(await market.isDisputeReviewer(a[3]),false,'buyer permission does not make a dispute reviewer');
  await governed({action:'queue_buyer',buyer:a[3],allowed:false});const remove=await submit({action:'execute_buyer',buyer:a[3],allowed:false});await approve(remove.op);await f.advance(86401);await execute(remove.op);assert.equal(await reserve.authorizedBuyers(a[3]),false);
  const pause=await submit({action:'pause'});await assert.rejects(execute(pause.op),/GOVERNANCE_APPROVALS_REQUIRED/);await approve(pause.op);await execute(pause.op);assert.equal(await reserve.paused(),true,'two signatures pause without an extra time delay');
  await assert.rejects(prepare({action:'unpause'}),/GOVERNANCE_ACTION_NOT_QUEUED/);
  await governed({action:'queueUnpause'});const resume=await submit({action:'unpause'});await approve(resume.op);await assert.rejects(execute(resume.op),/GOVERNANCE_TIMELOCK_PENDING/);await f.advance(86401);await execute(resume.op);assert.equal(await reserve.paused(),false);
  assert.equal(await f.token.balanceOf(config.reserve),0n,'these governance actions move no THOT');
 }finally{chain?.provider.destroy();await f.close();}
});

for(const chainId of [31337,46630])test(`chain ${chainId} one-owner administration activates, prices, cancels, replaces operators and honors successor sunset`,async()=>{
 const f=await deployThotFixture({activate:false,chainId});
 try{
  const a=await Promise.all(f.signers.map(s=>s.getAddress())),tx=async p=>(await p).wait();
  const governor=await f.deploy('ThotGovernor',[[a[0],a[1],a[6]]]);
  const token=await f.deploy('ThotTestToken',[a[0],parseEther('1000000000')]);
  const locks=await f.deploy('ThotLockVault',[await token.getAddress()]);
  const reserve=await f.deploy('ThotReserveVault',[await token.getAddress(),await governor.getAddress(),a[5]]);
  const market=await f.deploy('ThotMarket',[await token.getAddress(),await locks.getAddress(),await reserve.getAddress(),await governor.getAddress(),a[5],a[4]]);
  await tx(token.transfer(await reserve.getAddress(),parseEther('500000000')));
  const config={...f.config,manualReserve:true,governor:await governor.getAddress(),token:await token.getAddress(),reserve:await reserve.getAddress(),market:await market.getAddress()};
  // Real isolated RPC/contracts; no public-RPC configuration or broadcast credential is used.
  const chain={config,provider:f.provider,reserve,snapshot:async()=>{const b=await f.provider.getBlock('latest');return {number:b.number,hash:b.hash,timestamp:b.timestamp};},assertSnapshot:async b=>assert.equal((await f.provider.getBlock(b.number)).hash,b.hash)};
  const api=new ThotGovernance(chain),owner=a[1];
  const run=async(input,signer=f.buyer)=>{const p=await api.prepare(await signer.getAddress(),input);for(const t of p.transactions)await tx(signer.sendTransaction(t));return p;};
  assert.equal(await governor.getThreshold(),1n);assert.equal(await reserve.GOVERNANCE_DELAY(),0n);assert.equal(await market.GOVERNANCE_DELAY(),0n);assert.equal(await market.disputeThreshold(),1n);
  assert.equal(await market.DISPUTE_WINDOW(),43200n);assert.equal(await market.SELLER_RESPONSE_WINDOW(),86400n);
  await assert.rejects(api.prepare(a[3],{action:'start_campaign'}),/GOVERNANCE_OWNER_REQUIRED/);
  const activation=await run({action:'start_campaign'});assert.equal(activation.transactions.length,2);assert.equal(await governor.operationCount(),2n);
  assert.ok(await reserve.startAt()>0n);assert.ok(await reserve.remainingAllowance()>0n);assert.equal(await reserve.grossCommitted(),0n);
  await assert.rejects(api.prepare(owner,{action:'start_campaign'}),/CAMPAIGN_ALREADY_STARTED/);
  const q=await run({action:'queue_buyer',buyer:a[3],allowed:true});assert.equal(q.review.owner_action,'submitAndExecute');
  const queued=(await api.workspace(owner)).operations.find(o=>o.action==='queueBuyer');assert.equal(queued.executed,true);assert.equal(queued.timelock.ready,true);
  assert.equal(await reserve.authorizedBuyers(a[3]),false);
  await run({action:'cancel_queue',operation_hash:queued.timelock.operation_hash});
  await assert.rejects(api.prepare(owner,{action:'execute_buyer',buyer:a[3],allowed:true}),/GOVERNANCE_ACTION_NOT_QUEUED/);
  await run({action:'queue_buyer',buyer:a[3],allowed:true});await run({action:'execute_buyer',buyer:a[3],allowed:true});assert.equal(await reserve.authorizedBuyers(a[3]),true);
  await run({action:'pause',target:'market'});assert.equal(await market.paused(),true);assert.equal(await reserve.paused(),false);
  await run({action:'queueUnpause',target:'market'});await run({action:'unpause',target:'market'});assert.equal(await market.paused(),false);
  const policy='0x'+'45'.repeat(32),tariff={target:'market',direct_cost_atoms:parseEther('0.02').toString(),overhead_atoms:parseEther('0.04').toString(),policy_hash:policy};
  await run({action:'queue_tariff',...tariff});const tariffOp=(await api.workspace(owner)).operations.find(o=>o.action==='queueTariff');assert.equal(tariffOp.timelock.operation_hash,await market.tariffOperation(tariff.direct_cost_atoms,tariff.overhead_atoms,policy));
  await run({action:'execute_tariff',...tariff});assert.equal((await market.costQuote(parseEther('1'))).serviceFee,parseEther('0.08'));
  await assert.rejects(api.prepare(owner,{action:'queue_operator',operator:a[0],target:'both'}),/OPERATOR_MUST_BE_SEPARATE/);
  const operators=await run({action:'queue_operator',operator:a[2],target:'both'});assert.equal(operators.transactions.length,4);assert.equal(await reserve.operator(),a[2]);assert.equal(await market.operator(),a[2]);
  const successor=await f.deploy('ThotReserveVault',[await token.getAddress(),await governor.getAddress(),a[2]]),successorArgs={successor:await successor.getAddress(),amount_atoms:parseEther('1000').toString(),policy_hash:policy};
  await run({action:'queue_successor',...successorArgs});await assert.rejects(api.prepare(owner,{action:'execute_successor',...successorArgs}),/CAMPAIGN_SUNSET_PENDING/);
  await f.advance(360*86400+1);await run({action:'execute_successor',...successorArgs});assert.equal(await token.balanceOf(await successor.getAddress()),parseEther('1000'));
  assert.equal(await token.balanceOf(owner),0n,'administration never transfers reserve funds into the owner wallet');
 }finally{await f.close();}
});
