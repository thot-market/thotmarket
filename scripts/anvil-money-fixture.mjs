import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {ContractFactory,JsonRpcProvider,ZeroAddress,parseUnits,keccak256,Contract} from 'ethers';
import solc from 'solc';

const root=new URL('../',import.meta.url);
async function artifact(name,dir){return JSON.parse(await readFile(new URL(dir+name+'.json',root),'utf8'));}
const robinhood={rpc:'https://rpc.mainnet.chain.robinhood.com',chainId:4663,block:61231817,hash:'0x389efb48b0182efff410c241375b7360e324e4e6c73f148be37e77cba2ef81d8',manager:'0x8366a39cc670b4001a1121b8f6a443a643e40951',quoter:'0x8dc178efb8111bb0973dd9d722ebeff267c98f94'};
export async function deployMoneyFixture({outputDir,pool=globalThis.process.env.THOT_MONEY_POOL??'local-v2'}={}) {
  if(!['local-v2','robinhood-v4'].includes(pool))throw Error('Unknown money fixture pool');
  const fork=pool==='robinhood-v4';
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const process=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--threads','1','--silent',...(fork?['--fork-url',robinhood.rpc,'--fork-block-number',String(robinhood.block),'--retries','2','--timeout','15000']:[])],{stdio:['ignore','ignore','pipe']});
  let diagnostic='';process.stderr.on('data',b=>{diagnostic+=b.toString();});
  const rpcUrl=`http://127.0.0.1:${port}`,provider=new JsonRpcProvider(rpcUrl,31337,{cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=50;
  const close=async()=>{provider.destroy();if(process.exitCode===null){process.kill('SIGTERM');await new Promise(r=>process.once('exit',r));}};
  try {
    for(let n=0;n<300;n++){try{await provider.send('eth_chainId',[]);break;}catch{if(n===299)throw new Error('Anvil did not start: '+diagnostic);await new Promise(r=>setTimeout(r,100));}}
    if(fork && (await provider.getBlock(robinhood.block)).hash!==robinhood.hash)throw Error('FORK_ANCHOR_MISMATCH');
    const accounts=await provider.send('eth_accounts',[]);
    const [operator,buyer,contributor,treasury,attacker]=accounts;
    const signer=await provider.getSigner(operator);
    const sources={};for(const name of ['AtomicTraceMarket.sol','TestPayment.sol','ThotToken.sol','TokenInterfaces.sol'])sources[name]={content:await readFile(new URL('contracts/src/'+name,root),'utf8')};
    if(fork)sources['RobinhoodV4Router.sol']={content:await readFile(new URL('contracts/integrations/RobinhoodV4Router.sol',root),'utf8')};
    const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
    const compiled=JSON.parse(solc.compile(JSON.stringify(input)));
    const errors=compiled.errors?.filter(e=>e.severity==='error')??[];if(errors.length)throw new Error(errors.map(e=>e.formattedMessage).join('\n'));
    const deploy=async(a,args=[])=>{const c=await new ContractFactory(a.abi,a.bytecode??a.evm.bytecode.object,signer).deploy(...args);await c.waitForDeployment();return c;};
    const thot=await deploy(compiled.contracts['ThotToken.sol'].ThotToken,[operator,parseUnits('1000000000',18)]);
    const payment=await deploy(compiled.contracts['TestPayment.sol'].TestPayment,[operator,parseUnits('1000000',6)]);
    let factory,router,pair,liquidity;
    const addresses={thot:await thot.getAddress(),payment:await payment.getAddress()};
    const supply=await thot.totalSupply();
    if(fork){
      const deployedQuoter=new Contract(robinhood.quoter,['function poolManager() view returns(address)'],provider);
      if((await deployedQuoter.poolManager()).toLowerCase()!==robinhood.manager)throw Error('QUOTER_MANAGER_MISMATCH');
      router=await deploy(compiled.contracts['RobinhoodV4Router.sol'].RobinhoodV4Router,[robinhood.manager,robinhood.quoter,addresses.payment,addresses.thot]);
      addresses.router=await router.getAddress();addresses.manager=robinhood.manager;addresses.quoter=robinhood.quoter;
      await (await thot.approve(addresses.router,parseUnits('10000001',18))).wait();
      await (await payment.approve(addresses.router,parseUnits('100001',6))).wait();
      const price=BigInt(addresses.payment)<BigInt(addresses.thot)?(2n**96n)*10000000n:(2n**96n)/10000000n;
      await (await router.seed(price,10n**18n)).wait();
      pair=await router.poolId();
      liquidity={payment_atoms:(await payment.balanceOf(robinhood.manager)).toString(),thot_atoms:(await thot.balanceOf(robinhood.manager)).toString()};
      // Quotes must use the deployed quoter without changing pool balances.
      const before=[await payment.balanceOf(robinhood.manager),await thot.balanceOf(robinhood.manager)];
      const quote=await router.getAmountsOut.staticCall(parseUnits('85',6),[addresses.payment,addresses.thot]);
      if(quote[1]<=0n || before[0]!==await payment.balanceOf(robinhood.manager) || before[1]!==await thot.balanceOf(robinhood.manager))throw Error('QUOTE_CHANGED_BALANCES');
    }else{
      // Exact published Uniswap artifacts, not a replacement constant-price router.
      factory=await deploy(await artifact('UniswapV2Factory','node_modules/@uniswap/v2-core/build/'),[operator]);
      router=await deploy(await artifact('UniswapV2Router02','node_modules/@uniswap/v2-periphery/build/'),[await factory.getAddress(),ZeroAddress]);
      addresses.router=await router.getAddress();addresses.factory=await factory.getAddress();
      await (await thot.approve(addresses.router,parseUnits('10000000',18))).wait();
      await (await payment.approve(addresses.router,parseUnits('100000',6))).wait();
      const block=await provider.getBlock('latest');
      await (await router.addLiquidity(addresses.payment,addresses.thot,parseUnits('100000',6),parseUnits('10000000',18),parseUnits('100000',6),parseUnits('10000000',18),operator,block.timestamp+600)).wait();
      pair=await factory.getPair(addresses.payment,addresses.thot);addresses.pair=pair;
      liquidity={payment_atoms:parseUnits('100000',6).toString(),thot_atoms:parseUnits('10000000',18).toString()};
    }
    const market=await deploy(compiled.contracts['AtomicTraceMarket.sol'].AtomicTraceMarket,[addresses.payment,addresses.thot,addresses.router,operator,treasury]);
    await (await payment.transfer(buyer,parseUnits('10000',6))).wait();
    await (await payment.transfer(attacker,parseUnits('1000',6))).wait();
    const anchor=await provider.getBlock('latest');
    const config={rpcUrl,market:await market.getAddress(),...{payment:addresses.payment,thot:addresses.thot,router:addresses.router},operator,deploymentBlock:anchor.number,deploymentBlockHash:anchor.hash,maxSlippageBps:100};
    const manifest={pool,...(fork?{fork:robinhood}:{}),scope:(fork?'Pinned Robinhood fork with deployed Uniswap v4 core/quoter. ':'')+'Local Anvil, chain 31337. No public-chain transactions. Six-decimal test dollars, local THOT, synthetic liquidity capital.',config,accounts:{operator,buyer,contributor,treasury,attacker},pair,initial_thot_supply:supply.toString(),liquidity,dependencies:{solc:solc.version(),...(fork?{uniswap_v4_deployments:'https://developers.uniswap.org/docs/protocols/v4/deployments'}:{uniswap_v2_core:'1.0.1',uniswap_v2_periphery:'1.1.0-beta.0'})},code_hashes:{}};
    for(const [name,address] of Object.entries({...addresses,market:config.market}))manifest.code_hashes[name]=keccak256(await provider.getCode(address));
    if(outputDir){await mkdir(outputDir,{recursive:true});await writeFile(outputDir+'/deployment.json',JSON.stringify(manifest,null,2)+'\n');}
    return {provider,config,manifest,market,thot,payment,router,factory,pair,accounts:{operator,buyer,contributor,treasury,attacker},close};
  }catch(error){await close();throw error;}
}
