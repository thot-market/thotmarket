import {Interface,ZeroAddress,concat,getAddress,zeroPadValue} from 'ethers';
import type {ThotChainConfig} from './thot.ts';

const safe=new Interface(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)']);
const controller=new Interface(['function submitAndExecute(address,bytes)']);
/** Owner-sent, unsigned 1-of-N execution. Never delegatecall or reimburse gas
 * from the Safe. The caller must verify ownership and threshold before preparing.
 * Safe nonce is consumed at execution; this calldata is not a signed nonce-bound
 * authorization and must not be blindly retried after an uncertain receipt. */
export function governanceCall(config:ThotChainConfig,wallet:string,target:string,data:string){
 const encoded=config.governanceKind==='safe'
  ?safe.encodeFunctionData('execTransaction',[target,0,data,0,0,0,0,ZeroAddress,ZeroAddress,
    concat([zeroPadValue(getAddress(wallet),32),'0x'+'00'.repeat(32),'0x01'])])
  :controller.encodeFunctionData('submitAndExecute',[target,data]);
 return {from:getAddress(wallet),to:config.governor!,data:encoded,value:'0x0',chainId:'0x'+config.chainId.toString(16)};
}
