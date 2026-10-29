import {JsonRpcProvider, type JsonRpcPayload} from 'ethers';

const reads=new Set(['eth_call','eth_chainId','eth_blockNumber','eth_getCode','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getLogs','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas']);
// Only deterministic state reads may use another public endpoint. Nonces, gas,
// transaction submission and the head-number read stay on the primary provider.
const fallbackReads=new Set(['eth_call','eth_getBlockByNumber','eth_getCode','eth_getStorageAt']);
const resetCodes=new Set(['ECONNRESET','EPIPE','ECONNREFUSED','EHOSTUNREACH','EAI_AGAIN']);

// Hedge only small, unusually slow reads. Hedging large contract-read batches
// doubles provider load and can turn a busy account page into an RPC timeout.
export const HEDGE_AFTER_MS=1200;
export const FALLBACK_AFTER_MS=800;

/** Hedge slow read batches and retry one promptly failed read transport; never a transaction or an RPC error response. */
export class ReadRetryProvider extends JsonRpcProvider {
 private fallback?:{provider:JsonRpcProvider;chainId:number;validated?:Promise<void>};
 /** The alternate endpoint is read-only here and must prove the configured chain ID. */
 setReadFallback(provider:JsonRpcProvider,chainId:number){
  if(this.fallback||!Number.isSafeInteger(chainId)||chainId<=0)throw Error('INVALID_READ_FALLBACK');
  this.fallback={provider,chainId};
 }
 override async _send(payload:JsonRpcPayload|JsonRpcPayload[]){
  const requests=Array.isArray(payload)?payload:[payload];
  if(this.fallback&&requests.length&&requests.every(p=>fallbackReads.has(p.method))){
   const first=this.retrying(payload);let timer:ReturnType<typeof setTimeout>|undefined;
   const alternate=new Promise<void>(resolve=>{timer=setTimeout(resolve,FALLBACK_AFTER_MS);}).then(()=>this.destroyed?first:this.fallbackSend(payload));
   try{return await Promise.any([first,alternate]);}
   catch(error){throw error instanceof AggregateError?error.errors[0]:error;}
   finally{clearTimeout(timer);}
  }
  if(!requests.length||requests.length>4||!requests.every(p=>reads.has(p.method)))return this.retrying(payload);
  const first=this.retrying(payload);let timer:ReturnType<typeof setTimeout>|undefined;
  const hedge=new Promise<void>(resolve=>{timer=setTimeout(resolve,HEDGE_AFTER_MS);}).then(()=>this.destroyed?first:this.retrying(payload));
  try{return await Promise.any([first,hedge]);}
  catch(error){throw error instanceof AggregateError?error.errors[0]:error;}
  finally{clearTimeout(timer);}
 }
 private async fallbackSend(payload:JsonRpcPayload|JsonRpcPayload[]){
  const fallback=this.fallback!;
  fallback.validated??=fallback.provider.send('eth_chainId',[]).then(id=>{
   if(BigInt(id)!==BigInt(fallback.chainId))throw Error('READ_FALLBACK_CHAIN_MISMATCH');
  }).catch(error=>{fallback.validated=undefined;throw error;});
  await fallback.validated;
  const response=await fallback.provider._send(payload);
  // A JSON-RPC error is an ordinary _send return value in ethers. It must not
  // win the read race over a still-running healthy primary response.
  if(response.some(item=>'error' in item))throw Error('READ_FALLBACK_RPC_ERROR');
  return response;
 }
 override destroy(){this.fallback?.provider.destroy();super.destroy();}
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
