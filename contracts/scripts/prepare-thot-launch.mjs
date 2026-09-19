import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Contract,ContractFactory,JsonRpcProvider,getAddress,getCreateAddress,keccak256,parseEther as u,Interface,ZeroAddress,toUtf8Bytes} from 'ethers';
import {compileThot} from './thot-local-fixture.mjs';
import {governanceCall} from '../../packages/chain/thot-governance-call.ts';
import {DEPLOYMENT,SAFE} from '../../packages/chain/thot-safe.mjs';
const check=(v,e)=>{if(!v)throw Error(e);};
const tokenABI=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
/** Read-only, resumable fresh-suite planner. Never reads a private key or broadcasts.
 * Preserve input.startNonce and record every returned deployment transaction hash.
 * A changed nonce or foreign deployment stops instead of predicting new addresses.
 */
export async function prepareLaunch(input,provider){
 const chainId=Number(input.chainId),deployer=getAddress(input.deployer),safeAddress=getAddress(input.governor),tokenAddress=getAddress(input.token),operator=getAddress(input.operator);
 check([31337,46630,4663].includes(chainId)&&BigInt((await provider.getNetwork()).chainId)===BigInt(chainId),'CHAIN');
 check(Number.isSafeInteger(input.startNonce)&&input.startNonce>=0,'START_NONCE');
 const owners=input.owners.map(getAddress);check(owners.length===3&&new Set(owners).size===3&&owners.includes(deployer)&&!owners.includes(operator)&&operator!==ZeroAddress,'AUTHORITIES');
 const safe=new Contract(safeAddress,SAFE,provider),token=new Contract(tokenAddress,tokenABI,provider);
 check(keccak256(await provider.getCode(safeAddress))===DEPLOYMENT.proxyRuntimeHash,'SAFE_PROXY');
 const singleton=getAddress('0x'+(await provider.getStorage(safeAddress,0)).slice(-40));
 check(keccak256(await provider.getCode(singleton))===DEPLOYMENT.singletonHash,'SAFE_SINGLETON');
 check((await safe.getOwners()).map(getAddress).sort().join()===owners.slice().sort().join()&&await safe.getThreshold()===1n,'SAFE_OWNERS');
 check(await token.decimals()===18n&&await token.totalSupply()===u('1000000000'),'TOKEN_SUPPLY');
 const [modules,next]=await safe.getModulesPaginated('0x0000000000000000000000000000000000000001',1);check(!modules.length&&BigInt(next)===1n,'SAFE_MODULES');
 for(const slot of ['fallback_manager.handler.address','guard_manager.guard.address'])check(BigInt(await provider.getStorage(safeAddress,keccak256(toUtf8Bytes(slot))))===0n,'SAFE_HANDLER');
 const confirmed=async receipt=>{check(receipt?.status===1,'RECEIPT_FAILED');const canonical=await provider.getBlock(receipt.blockNumber);check(canonical?.hash===receipt.blockHash,'RECEIPT_REORG');check(chainId===31337||await provider.getBlockNumber()>=receipt.blockNumber+1,'RECEIPT_CONFIRMATIONS');};
 const artifacts=await compileThot(),names=['ThotLockVault','ThotTreasury','ThotStakingPool','ThotLaunchMarket','ThotFeeDiscounts'];
 const nonceFor=i=>input.startNonce+i+(i===4?1:0);
 const addresses=Object.fromEntries(names.map((n,i)=>[n,getCreateAddress({from:deployer,nonce:nonceFor(i)})]));
 const args={ThotLockVault:[tokenAddress],ThotTreasury:[tokenAddress,safeAddress,operator],ThotStakingPool:[tokenAddress,addresses.ThotTreasury],
  ThotLaunchMarket:[tokenAddress,addresses.ThotLockVault,addresses.ThotTreasury,safeAddress,operator,addresses.ThotTreasury,chainId],
  ThotFeeDiscounts:[tokenAddress,addresses.ThotStakingPool,safeAddress]};
 // Pool binding must precede fee-policy construction. Return only the next ready
 // deployment/action; rerun after its receipt, never broadcast a speculative batch.
 const config={mode:chainId===31337?'local-anvil':chainId===46630?'robinhood-testnet':'production',rpcUrl:input.rpcUrl,chainId,chainName:'Robinhood Chain',confirmations:chainId===31337?1:2,
  percentageFees:true,sharedTreasury:true,reserveCampaigns:true,manualReserve:true,streamSales:true,governanceKind:'safe',safeSingleton:singleton,safeSingletonCodeHash:DEPLOYMENT.singletonHash,
  token:tokenAddress,locks:addresses.ThotLockVault,reserve:addresses.ThotTreasury,staking:addresses.ThotStakingPool,market:addresses.ThotLaunchMarket,feeDiscounts:addresses.ThotFeeDiscounts,governor:safeAddress,
  ...(chainId===31337?{localDeliverySigner:operator}:{operatorAddress:operator}),codeHashes:{}};
 const result={schema:'thot.launch-plan/1',chainId,addresses,config,transactions:[],phase:'deploy',complete:false};
 const governance=(target,method,values)=>governanceCall(config,deployer,target.target,target.interface.encodeFunctionData(method,values));
 const treasury=new Contract(config.reserve,artifacts.ThotTreasury.abi,provider);
 for(let i=0;i<names.length;i++){
  const name=names[i],address=addresses[name],data=(await new ContractFactory(artifacts[name].abi,artifacts[name].evm.bytecode.object).getDeployTransaction(...args[name])).data;
  const code=await provider.getCode(address);
  if(code==='0x'){
   // One reserved deployer nonce binds the pool before policy construction.
   // The same owner can complete every step without another owner's key.
   if(name==='ThotFeeDiscounts'&&getAddress(await treasury.stakingPool())!==config.staking){
    check(await treasury.stakingPool()===ZeroAddress,'POOL_ALREADY_BOUND');
    check(await provider.getTransactionCount(deployer,'pending')===input.startNonce+4,'DEPLOYER_NONCE_CHANGED');result.phase='bind-pool-before-policy';result.transactions=[governanceCall(config,deployer,config.reserve,treasury.interface.encodeFunctionData('bindStakingPool',[config.staking]))];return result;
   }
   check(await provider.getTransactionCount(deployer,'pending')===nonceFor(i),'DEPLOYER_NONCE_CHANGED');
   result.transactions=[{from:deployer,nonce:nonceFor(i),chainId:'0x'+chainId.toString(16),data,value:'0x0'}];result.expectedContract=address;result.contract=name;return result;
  }
  const hash=input.deploymentReceipts?.[name];check(typeof hash==='string','DEPLOYMENT_RECEIPT_REQUIRED:'+name);
  const receipt=await provider.getTransactionReceipt(hash),transaction=await provider.getTransaction(hash);
  await confirmed(receipt);
  check(receipt?.status===1&&getAddress(receipt.contractAddress)===address&&transaction?.from===deployer&&transaction.nonce===nonceFor(i)&&transaction.data===data&&transaction.to===null,'DEPLOYMENT_RECEIPT_MISMATCH:'+name);
 }
 const market=new Contract(config.market,artifacts.ThotLaunchMarket.abi,provider),policy=new Contract(config.feeDiscounts,artifacts.ThotFeeDiscounts.abi,provider),pool=new Contract(config.staking,artifacts.ThotStakingPool.abi,provider);
 result.phase='configure';
 for(const [target,read,method,value] of [[treasury,'market','bindMarket',config.market],[market,'feeDiscounts','bindFeeDiscounts',config.feeDiscounts]]){
  const current=await target[read]();if(current===ZeroAddress){result.transactions=[governance(target,method,[value])];return result;}check(getAddress(current)===value,'BINDING');
 }
 if(await policy.version()===0n){result.transactions=[governance(policy,'setPolicy',[u('10000'),u('100000'),2000,3000])];return result;}
 check(await policy.firstThreshold()===u('10000')&&await policy.secondThreshold()===u('100000')&&await policy.firstBps()===2000n&&await policy.secondBps()===3000n,'HOLDER_POLICY_CHANGED');
 if(await policy.lockThreshold()===0n){result.transactions=[governance(policy,'setLockPolicy',[u('100000'),90*86400,3500])];return result;}
 check(await policy.lockThreshold()===u('100000')&&await policy.lockDuration()===90n*86400n&&await policy.lockBps()===3500n,'LOCK_POLICY_CHANGED');
 check((await market.costQuote(u('1000'))).serviceFee===u('10'),'FEE_POLICY_CHANGED');
 result.phase='fund';
 if(!input.fundingReceipt){
  check(await token.balanceOf(config.reserve)===0n&&await pool.campaignCount()===0n,'FUNDING_RECEIPT_REQUIRED');
  check(await token.balanceOf(deployer)>=u('500000000'),'INSUFFICIENT_PROJECT_INVENTORY');
  result.transactions=[{from:deployer,to:tokenAddress,chainId:'0x'+chainId.toString(16),value:'0x0',data:tokenABI.encodeFunctionData('transfer',[config.reserve,u('500000000')])}];return result;
 }
 const receipt=await provider.getTransactionReceipt(input.fundingReceipt);await confirmed(receipt);
 const fundingTx=await provider.getTransaction(input.fundingReceipt);check(fundingTx?.from===deployer&&getAddress(fundingTx.to)===tokenAddress&&fundingTx.data===tokenABI.encodeFunctionData('transfer',[config.reserve,u('500000000')]),'FUNDING_TRANSACTION');
 check(receipt.logs.some(l=>{if(getAddress(l.address)!==tokenAddress)return false;try{const p=tokenABI.parseLog(l);return p.name==='Transfer'&&getAddress(p.args.from)===deployer&&getAddress(p.args.to)===config.reserve&&p.args.value===u('500000000');}catch{return false;}}),'FUNDING_TRANSFER');
 check(await market.paused(),'MARKET_ALREADY_ACTIVE');
 check(await token.balanceOf(config.reserve)===u('500000000')&&await pool.campaignCount()===0n,'FUNDED_STATE_CHANGED');
 const anchor=await provider.getBlock('latest');config.deploymentBlock=anchor.number;config.deploymentBlockHash=anchor.hash;
 for(const name of ['token','locks','reserve','staking','market','feeDiscounts','governor'])config.codeHashes[name]=keccak256(await provider.getCode(config[name]));
 result.phase='funded-paused';result.complete=true;result.notice='Contracts are funded but purchases stay paused. Configure and verify the acquisition/staking campaigns, explicit reserve buyers, app/operator and acceptance evidence before unpausing. Reallocation never touches admitted obligations.';
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const input=JSON.parse(await readFile(process.argv[2],'utf8'));const provider=new JsonRpcProvider(input.rpcUrl,undefined,{cacheTimeout:-1});
 try{const result=await prepareLaunch(input,provider);await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log('Unsigned next step written: '+result.phase);}finally{provider.destroy();}
}
