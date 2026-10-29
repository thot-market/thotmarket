const address=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value);
const hash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value);
const hex=value=>typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const chainHex=chainId=>'0x'+BigInt(chainId).toString(16);

export async function atomicCartSupported(request,wallet,chainId){
 if(!address(wallet)||!Number.isSafeInteger(Number(chainId)))return false;
 const chain=chainHex(chainId);
 try{
  const result=await request({method:'wallet_getCapabilities',params:[wallet,[chain]]});
  const entry=Object.entries(result??{}).find(([key])=>hex(key)&&BigInt(key)===BigInt(chain));
  return ['supported','ready'].includes(entry?.[1]?.atomic?.status);
 }catch{return false;}
}

export function atomicCartCalls(items,{token,market,chainId}){
 if(!address(token)||!address(market)||!Number.isSafeInteger(Number(chainId))||!Array.isArray(items)||items.length<1||items.length>20)throw Error('Atomic checkout is unavailable for this cart.');
 let total=0n;const payments=[];
 for(const item of items){
  const tx=item?.prepared?.transactions,amount=BigInt(item?.prepared?.buyer_total??0);
  if(!Array.isArray(tx)||tx.length!==2||amount<=0n||!hash(item.prepared.id)||
   !same(tx[0]?.to,token)||!same(tx[1]?.to,market)||
   !/^0x095ea7b3[0-9a-f]{128}$/i.test(tx[0]?.data??'')||
   !same('0x'+tx[0].data.slice(34,74),market)||
   BigInt('0x'+tx[0].data.slice(74))!==amount||
   !/^0x[0-9a-f]+$/i.test(tx[1]?.data??'')||
   [tx[0],tx[1]].some(t=>BigInt(t.value??0)!==0n||BigInt(t.chainId??0)!==BigInt(chainId)))throw Error('A prepared item does not match this wallet, token and market. Review the cart again.');
  total+=amount;payments.push({to:market,data:tx[1].data,value:'0x0'});
 }
 const approval=amount=>'0x095ea7b3'+market.slice(2).toLowerCase().padStart(64,'0')+amount.toString(16).padStart(64,'0');
 return {total,chainId:chainHex(chainId),calls:[{to:token,data:approval(total),value:'0x0'},...payments,{to:token,data:approval(0n),value:'0x0'}]};
}

export function atomicCartRequestId(){return '0x'+crypto.randomUUID().replaceAll('-','').padStart(64,'0');}

export async function atomicCartConfirmation(request,record,confirmations){
 if(!hash(record?.id)||!address(record?.wallet)||!Number.isSafeInteger(Number(record?.chainId))||!Number.isSafeInteger(confirmations)||confirmations<1||confirmations>100)throw Error('Saved checkout is invalid.');
 const rpc=async(method,params=[])=>request({method,params});
 if(BigInt(await rpc('eth_chainId'))!==BigInt(record.chainId))throw Error('Switch to the original checkout network.');
 let status;
 try{status=await rpc('wallet_getCallsStatus',[record.id]);}
 catch(error){if(/no matching bundle found/i.test(String(error?.message??'')))return {state:'not_found'};throw error;}
 if(!same(status?.id,record.id)||BigInt(status?.chainId??0)!==BigInt(record.chainId))throw Error('Wallet returned a different checkout.');
 if(status.status===100)return {state:'pending'};
 if(status.status===400||status.status===500)return {state:'failed'};
 if(status.status!==200||status.atomic!==true||!Array.isArray(status.receipts)||!status.receipts.length)throw Error('Wallet checkout status is uncertain. Check the same batch again; do not resubmit.');
 const hashes=[...new Set(status.receipts.map(r=>r.transactionHash?.toLowerCase()))];
 if(!hashes.length||hashes.some(h=>!hash(h))||status.receipts.some(r=>r.status!=='0x1'))throw Error('Wallet did not confirm a successful atomic batch. Check the batch in your wallet.');
 const head=await rpc('eth_blockNumber');if(!hex(head))return {state:'pending'};
 for(const txHash of hashes){
  const receipt=await rpc('eth_getTransactionReceipt',[txHash]);
  if(!same(receipt?.transactionHash,txHash)||receipt?.status!=='0x1'||!hex(receipt.blockNumber)||!hash(receipt.blockHash)||BigInt(head)-BigInt(receipt.blockNumber)+1n<BigInt(confirmations))return {state:'pending'};
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  const again=await rpc('eth_getTransactionReceipt',[txHash]);
  if(!same(block?.hash,receipt.blockHash)||!same(again?.blockHash,receipt.blockHash)||!same(again?.transactionHash,txHash)||again?.status!=='0x1')throw Error('Checkout confirmation changed. Check the same batch again.');
 }
 if(BigInt(await rpc('eth_chainId'))!==BigInt(record.chainId))throw Error('The wallet network changed. Check the same batch again.');
 return {state:'confirmed',transactionHashes:hashes};
}
