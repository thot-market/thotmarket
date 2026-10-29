import {JsonRpcProvider, type JsonRpcPayload} from 'ethers';

const reads=new Set(['eth_call','eth_chainId','eth_blockNumber','eth_getCode','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getLogs','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas']);
const resetCodes=new Set(['ECONNRESET','EPIPE','ECONNREFUSED','EHOSTUNREACH','EAI_AGAIN']);

// Hedge only small, unusually slow reads. Hedging large contract-read batches
// doubles provider load and can turn a busy account page into an RPC timeout.
export const HEDGE_AFTER_MS=1200;

/** Hedge slow read batches and retry one promptly failed read transport; never a transaction or an RPC error response. */
export class ReadRetryProvider extends JsonRpcProvider {
 override async _send(payload:JsonRpcPayload|JsonRpcPayload[]){
  const requests=Array.isArray(payload)?payload:[payload];
  if(!requests.length||requests.length>4||!requests.every(p=>reads.has(p.method)))return this.retrying(payload);
  const first=this.retrying(payload);let timer:ReturnType<typeof setTimeout>|undefined;
  const hedge=new Promise<void>(resolve=>{timer=setTimeout(resolve,HEDGE_AFTER_MS);}).then(()=>this.destroyed?first:this.retrying(payload));
  try{return await Promise.any([first,hedge]);}
  catch(error){throw error instanceof AggregateError?error.errors[0]:error;}
  finally{clearTimeout(timer);}
 }
 private async retrying(payload:JsonRpcPayload|JsonRpcPayload[]){
  const started=Date.now();
  try{return await super._send(payload);}
  catch(error){
   const code=error instanceof Error?(error as Error&{code?:string}).code:undefined;
   if(!code||!resetCodes.has(code)||Date.now()-started>1000||this.destroyed)throw error;
   await new Promise(resolve=>setTimeout(resolve,200));
   if(this.destroyed)throw error;
   return super._send(payload);
  }
 }
}
