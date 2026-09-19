import {JsonRpcProvider, type JsonRpcPayload} from 'ethers';

const reads=new Set(['eth_call','eth_chainId','eth_blockNumber','eth_getCode','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getLogs','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas']);
const resetCodes=new Set(['ECONNRESET','EPIPE','ECONNREFUSED','EHOSTUNREACH','EAI_AGAIN']);

/** Retry one promptly failed read transport, never a transaction or an RPC error response. */
export class ReadRetryProvider extends JsonRpcProvider {
 override async _send(payload:JsonRpcPayload|JsonRpcPayload[]){
  const started=Date.now();
  try{return await super._send(payload);}
  catch(error){
   const requests=Array.isArray(payload)?payload:[payload];
   const code=error instanceof Error?(error as Error&{code?:string}).code:undefined;
   if(!requests.length||!requests.every(p=>reads.has(p.method))||!code||!resetCodes.has(code)||Date.now()-started>1000||this.destroyed)throw error;
   await new Promise(resolve=>setTimeout(resolve,200));
   if(this.destroyed)throw error;
   return super._send(payload);
  }
 }
}
