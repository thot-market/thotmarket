import {researchFilesHTML} from './library-ui.js';
import {renderLiveStaking,parseStakingAmount} from './staking-ui.js';
import {feePolicyCopy} from './fee-policy-ui.js';
export const isClosedUnpaidPurchase=order=>order?.receipt?.status===0&&['blocked','complete'].includes(order.job_status)&&order.last_error==='AUTHORIZATION_UNAVAILABLE';
// Reconciliation is read-only: adopting a hash never submits the next wallet action.
export async function verifyWalletReplacement({request,expected,from,hash,originalHash,originalNonce,chainId,confirmations=1,token,current=()=>{}}){
 const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
 const hex=value=>typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value);
 const fail=message=>{throw Error(message);};
 const rpc=async(method,params=[])=>{current();const result=await request({method,params});current();return result;};
 if(!/^0x[0-9a-f]{64}$/i.test(hash)||eq(hash,originalHash))fail('Paste the new transaction hash from your wallet activity.');
 const initialChain=await rpc('eth_chainId');
 if(!hex(initialChain)||BigInt(initialChain)!==BigInt(chainId)||(expected.chainId!=null&&BigInt(expected.chainId)!==BigInt(chainId)))fail('Switch to the network for this purchase.');
 const tx=await rpc('eth_getTransactionByHash',[hash]);
 if(!tx||!hex(tx.nonce)||!eq(tx.hash,hash)||!eq(tx.from,from)||!eq(tx.to,expected.to)||!eq(tx.input??tx.data,expected.data)||!hex(tx.value)||BigInt(tx.value)!==BigInt(expected.value??0)||!hex(tx.chainId)||BigInt(tx.chainId)!==BigInt(chainId))fail('This transaction does not match the reviewed wallet action. No recovery record was changed.');
 const original=await rpc('eth_getTransactionByHash',[originalHash]);
 const nonce=originalNonce??original?.nonce;
 if(nonce!==undefined&&nonce!==null){
  if(!hex(nonce)||!hex(tx.nonce)||BigInt(tx.nonce)!==BigInt(nonce))fail('The replacement must use the original transaction nonce.');
 }else{
  // Old session records have no nonce. Only an exact approval can be recovered
  // from current allowance; accepting arbitrary historical payments is unsafe.
  if(!eq(expected.to,token)||!/^0x095ea7b3000000000000000000000000[0-9a-f]{104}$/i.test(expected.data??'')||BigInt(expected.value??0)!==0n)fail('The original nonce is unavailable. Only a verified token approval can be recovered from this older record.');
  const data='0xdd62ed3e'+from.slice(2).toLowerCase().padStart(64,'0')+expected.data.slice(10,74);
  const allowance=await rpc('eth_call',[{to:token,data},'latest']);
  if(!hex(allowance)||BigInt(allowance)<BigInt('0x'+expected.data.slice(74)))fail('The approval is no longer sufficient. No recovery record was changed.');
 }
 const receipt=await rpc('eth_getTransactionReceipt',[hash]);
 if(!receipt||receipt.status!=='0x1'||!eq(receipt.transactionHash,hash)||!hex(receipt.blockNumber)||!/^0x[0-9a-f]{64}$/i.test(receipt.blockHash??''))fail('The replacement has not successfully confirmed yet. Check it again after confirmation.');
 const head=await rpc('eth_blockNumber');
 if(!Number.isSafeInteger(confirmations)||confirmations<1||confirmations>100||!hex(head)||BigInt(head)-BigInt(receipt.blockNumber)+1n<BigInt(confirmations))fail('The replacement needs more confirmations.');
 const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
 const again=await rpc('eth_getTransactionReceipt',[hash]);
 if(!eq(block?.hash,receipt.blockHash)||!eq(again?.transactionHash,hash)||!eq(again?.blockHash,receipt.blockHash)||again?.blockNumber!==receipt.blockNumber||again?.status!=='0x1')fail('Transaction confirmation changed. Check it again.');
 if(BigInt(await rpc('eth_chainId'))!==BigInt(chainId))fail('The wallet network changed. Check the replacement again.');
 return {hash:hash.toLowerCase(),nonce:tx.nonce};
}
// Current allowance satisfies an approval prerequisite, never a purchase receipt.
export async function purchaseApprovalReady({request,expected,from,token,market,chainId,confirmations=1,current=()=>{}}){
 const address=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value);
 const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
 const hex=value=>typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value);
 if(!address(from)||!address(token)||!address(market)||!eq(expected?.to,token)||!/^0x095ea7b3000000000000000000000000[0-9a-f]{104}$/i.test(expected?.data??'')||!eq('0x'+expected.data.slice(34,74),market)||BigInt(expected.value??0)!==0n)return null;
 const amount=BigInt('0x'+expected.data.slice(74));if(amount<=0n)return null;
 if(!Number.isSafeInteger(confirmations)||confirmations<1||confirmations>100)throw Error('Confirmation policy unavailable. Refresh this page.');
 const rpc=async(method,params=[])=>{current();const r=await request({method,params});current();return r;};
 const checkChain=async()=>{const c=await rpc('eth_chainId');if(!hex(c)||BigInt(c)!==BigInt(chainId)||(expected.chainId!=null&&BigInt(expected.chainId)!==BigInt(c)))throw Error('Switch to the network for this purchase.');};
 await checkChain();
 const accounts=await rpc('eth_accounts');if(!accounts?.some(a=>eq(a,from)))throw Error('Connect the wallet for this purchase.');
 const height=await rpc('eth_blockNumber');if(!hex(height)||BigInt(height)<BigInt(confirmations-1))throw Error('Confirmed chain state unavailable.');
 const blockTag='0x'+(BigInt(height)-BigInt(confirmations-1)).toString(16);
 const block=await rpc('eth_getBlockByNumber',[blockTag,false]);
 if(!/^0x[0-9a-f]{64}$/i.test(block?.hash??''))throw Error('Confirmed block unavailable.');
 const data='0xdd62ed3e'+from.slice(2).toLowerCase().padStart(64,'0')+market.slice(2).toLowerCase().padStart(64,'0');
 const approved=await rpc('eth_call',[{to:token,data},blockTag]);
 const latest=await rpc('eth_call',[{to:token,data},'latest']);
 if(!hex(approved)||!hex(latest))throw Error('Approval unavailable on this wallet network.');
 const again=await rpc('eth_getBlockByNumber',[blockTag,false]);
 if(!eq(again?.hash,block.hash))throw Error('Chain state changed. Check approval again.');
 await checkChain();
 const selected=await rpc('eth_accounts');if(!selected?.some(a=>eq(a,from)))throw Error('The wallet account changed.');
 return BigInt(approved)>=amount&&BigInt(latest)>=amount;
}
// Contributors sign explicit enrollment terms; only the reserve worker moves its own funds.
export function createThotUI({state,api,openDialog,dialog,refresh,escape,json,toast,download,getProvider=()=>globalThis.window?.ethereum,recoveryStorage=globalThis.window?.sessionStorage,copyText=text=>globalThis.navigator.clipboard.writeText(text)}) {
 let pending=null,listingMetadata=null,listingScope=null,listingEnrollment=null,listingDirty=false,samplingPreview=null,samplingScope=null,reserveSelection=null,inFlight=false;
 const recoveries=new Map();
 const fmt=value=>{const n=BigInt(value??0),base=10n**18n,frac=String(n%base).padStart(18,'0').slice(0,4).replace(/0+$/,'');return `${(n/base).toLocaleString()}${frac?'.'+frac:''} THOT`;}; // 100 THOT, 99.2 THOT: no padded zeros
 const inputAtoms=value=>{const text=String(value??'').trim();if(!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text))throw Error('Enter a nonnegative THOT amount with at most 18 decimals.');const [whole,fraction='']=text.split('.');return (BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'))).toString();};
 const inputDecimal=value=>{const n=BigInt(value??0),base=10n**18n;return `${n/base}.${String(n%base).padStart(18,'0').replace(/0+$/,'')||'0'}`;};
 const supported=mode=>['thot-anvil','thot-testnet','thot-production'].includes(mode);
 const capabilities=()=>state.role==='operator_security'?(state.thotSampling?.capabilities??state.thot?.capabilities??{}):(state.thot?.capabilities??state.thotSampling?.capabilities??{});
 const production=()=>capabilities().mode==='thot-production';
 const purchasesPaused=()=>state.thot?.market_paused!==false;
 const pauseNotice=()=>state.thot?.market_paused===true?'Purchases are paused. Existing purchases can still be delivered, settled or refunded.':'Purchase availability is unknown. Refresh to check the chain before buying.';
 const concurrentCampaigns=()=>capabilities().reserve_campaigns===true;
 const campaignRows=()=>state.thotSampling?.campaigns??[];
 const campaignAvailable=c=>!c.closed&&!c.paused&&c.status==='active'&&BigInt(c.available_atoms??0)>0n;
 const provider=()=>{const p=getProvider();if(!p?.request)throw Error('Open this app in a browser with an Ethereum wallet.');return p;};
 const operatorWallet=()=>{const address=capabilities().operator_address;if(state.role!=='operator_security'||!/^0x[0-9a-f]{40}$/i.test(address??''))throw Error('The designated operator wallet is not configured. Refresh the deployment status.');return address;};
 const networkName=()=>capabilities().chain_name??(production()?'Robinhood Chain':capabilities().mode==='thot-testnet'?'Robinhood Chain Testnet':'Local Anvil');
 const networkNote=()=>capabilities().mode==='thot-production'?`${networkName()} · THOT payments`:capabilities().mode==='thot-testnet'?'Robinhood Chain Testnet · test assets only. These balances are not dollars or mainnet earnings.':'Local demo · test THOT. Public payments are not active.';
 const chainNow=receipt=>Number(receipt?.block?.timestamp??state.thot?.account?.block?.timestamp??0);
 const disputeSeconds=receipt=>{const seconds=Number(receipt?.dispute_seconds??capabilities().dispute_seconds);return [3600,43200,86400].includes(seconds)?seconds:null;};
 const disputeDuration=receipt=>{const seconds=disputeSeconds(receipt);return seconds?`${seconds/3600} ${seconds===3600?'hour':'hours'}`:'the configured dispute period';};
 const disputeWindow=receipt=>{const seconds=disputeSeconds(receipt);return seconds?`${seconds/3600}-hour dispute window`:'configured dispute window';};
 const date=value=>Number(value)>0?new Date(Number(value)*1000).toLocaleString():null;
 const traceTitle=t=>t.title??state.traceLibrary?.items?.find(item=>item.trace_id===t.trace_id)?.title??t.trace_id;
 const status=['Unfunded','Funded · awaiting your consent','Accepted · delivery pending','Delivered · dispute window','Disputed · payout held','Finalized','Refunded · buyer allocation'];
 const button=(name,label,id='',disabled=false,primary=false)=>`<button ${disabled?'disabled aria-disabled="true"':''} class="button${primary?'':' secondary'}" data-action="thot-${name}" data-id="${escape(id)}">${label}</button>`;
 const walletAddress=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)&&!/^0x0{40}$/i.test(value);
 function sellerWalletHTML(seller){
  if(!walletAddress(seller))return '<div class="thot-seller-wallet"><span class="thot-seller-label">Seller wallet unavailable</span></div>';
  return `<div class="thot-seller-wallet"><div><span class="thot-seller-label">Seller wallet</span><code class="thot-seller-address">${escape(seller)}</code></div><button type="button" class="thot-copy-wallet" data-action="thot-copy-seller-wallet" data-id="${escape(seller)}" aria-label="Copy seller wallet address">Copy</button></div>`;
 }
 const scope=()=>{const actor=state.actor?.id,g=state.generation,p=getProvider();return ()=>{if(p!==getProvider())throw Error('Your wallet provider changed. Review this action again.');if(actor!==state.actor?.id||g!==state.generation){const e=Error('Your account changed. Review this action again.');e.name='StaleWorkspaceError';throw e;}};};
 async function checkNetwork(){
  if(!getProvider()?.request)throw Error('Open this app in a browser with an Ethereum wallet to link an account or sign. '+networkName()+(production()?' uses real THOT.':' uses test assets only.'));
  const c=await provider().request({method:'eth_chainId',params:[]});
  if(BigInt(c)!==BigInt(capabilities().chain_id))throw Error('Switch your wallet to '+networkName()+' (chain '+capabilities().chain_id+') before continuing. Use the network button on this page.');
 }
 async function wallet(){await checkNetwork();const a=await provider().request({method:'eth_requestAccounts',params:[]});await checkNetwork();if(!a[0])throw Error('Choose a wallet account.');return a[0];}
 async function connected(operator=false){const expected=operator?operatorWallet():state.thot?.wallet,a=await wallet();if(a.toLowerCase()!==expected?.toLowerCase())throw Error(operator?'Choose the designated operator wallet to sign this decision.':'Choose the wallet linked to this signed-in account.');return a;}
 const recoveryKey=(operator=false,exit=false)=>`${state.actor?.id}:${operator?'operator':'participant'}:${(operator?capabilities().operator_address:state.thot?.wallet)?.toLowerCase()}:${capabilities().chain_id}:${capabilities().market??''}${exit?':exit':''}`;
 const storageKey=key=>'thot.wallet-recovery.v1:'+key;
 function saveRecovery(operation){
  if(!recoveryStorage)return;
  const {key,id,wallet,authority,confirmDisputeId,purchase,exit,notice,steps,buyer_total,economics,seller}=operation;
  recoveryStorage.setItem(storageKey(key),JSON.stringify({version:1,key,id,wallet,authority,confirmDisputeId,purchase,exit,notice,steps,buyer_total,economics,seller}));
 }
 function savedRecovery(key){
  if(recoveries.has(key))return recoveries.get(key);
  const raw=recoveryStorage?.getItem(storageKey(key));if(!raw)return null;
  let value;try{value=JSON.parse(raw);}catch{throw Error('Saved wallet recovery is unreadable. Check your wallet before another payment.');}
  if(value.version!==1||value.key!==key||!Array.isArray(value.steps)||value.steps.length>20)throw Error('Saved wallet recovery is invalid. Check your wallet before another payment.');
  recoveries.set(key,value);return value;
 }
 const attempted=operation=>(operation.purchase||!operation.steps.some(step=>step.reverted))&&operation.steps.some(step=>step.hash||step.uncertain);
 const needsNewReview=operation=>operation.purchase&&(operation.needsReview||operation.steps.some(step=>step.reverted));
 function walletSummaryHTML(){
  const w=state.thot;
  if(!state.actor||!w?.wallet||!w.account||w.account.balance==null||!supported(w.capabilities?.mode))return '';
  return `<span><small>Wallet balance</small><strong>${escape(fmt(w.account.balance))}</strong></span><span class="wallet-summary-identity"><span title="${escape(w.wallet)}">${escape(w.wallet.slice(0,6)+'…'+w.wallet.slice(-4))}</span><small>${escape(networkName())}${production()?'':' · test tokens'}</small></span>`;
 }
 const approvalStep=step=>/^0x095ea7b3/i.test(step.transaction?.data??'');
 const stepLabel=(step,index,operation)=>approvalStep(step)?'Approve THOT limit':operation.purchase?'Pay':`Wallet action ${index+1}`;
 const complete=step=>step.confirmed||step.allowanceSatisfied||step.paymentSubmitted;
 const purchaseApproval=(operation,step)=>operation.purchase&&approvalStep(step)&&step.transaction?.to?.toLowerCase()===capabilities().token?.toLowerCase();
 async function checkPurchaseApproval(operation,step){
  const c=capabilities();let active=true,timer;
  const current=()=>{operation.current();if(!active)throw Error('Approval check ended.');};
  try{return await Promise.race([
   purchaseApprovalReady({request:args=>provider().request(args),expected:step.transaction,from:operation.wallet??state.thot?.wallet,token:c.token,market:c.market,chainId:c.chain_id,confirmations:Number(c.confirmations??1),current}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Approval check timed out.')),10000);})
  ]);}finally{active=false;clearTimeout(timer);}
 }
 async function refreshPurchaseApproval(operation){
  const step=operation.steps.find(s=>purchaseApproval(operation,s)&&!s.paymentSubmitted);if(!step)return;
  operation.recovering=true;operation.recoveryError=null;step.allowanceSatisfied=false;updateProgress(operation);
  try{const ready=await checkPurchaseApproval(operation,step);operation.current();if(pending!==operation)return;step.allowanceSatisfied=ready===true;if(ready===false)step.confirmed=false;}
  catch(error){try{operation.current();}catch{return;}operation.recoveryError='Could not check approval. Check your wallet connection and network, then try again.';}
  finally{operation.recovering=false;try{operation.current();if(pending===operation)updateProgress(operation);}catch{}}
 }
 function actionLabel(operation){
  if(operation.phase==='resetting')return 'Checking previous payment…';
  if(needsNewReview(operation))return 'Review a new purchase';
  if(operation.recovering)return 'Checking your approval…';
  if(operation.phase==='wallet')return 'Confirm in your wallet…';
  if(operation.phase==='confirming')return 'Checking confirmation…';
  if(operation.phase==='preflight')return 'Checking purchase conditions…';
  if(operation.phase==='approval')return 'Checking your approval…';
  if(operation.phase==='connecting')return 'Connecting to wallet…';
  const step=operation.steps.find(step=>!complete(step));
  if(step&&purchaseApproval(operation,step)&&(step.hash||step.uncertain))return 'Check approval';
  if(step?.hash)return 'Check confirmation';
  if(step?.uncertain)return 'Check wallet activity';
  if(!step)return operation.purchase?'Finish checking purchase':'Finish checking action';
  return approvalStep(step)?'Approve THOT in wallet':operation.purchase?'Pay in wallet':'Continue in wallet';
 }
 function progressHTML(operation){
  const waiting=operation.steps.findIndex(step=>!complete(step));
  const items=operation.steps.map((step,index)=>`<li class="${complete(step)?'complete':index===waiting?'current':''}" ${index===waiting?'aria-current="step"':''}><strong>${index+1}. ${escape(stepLabel(step,index,operation))}</strong><span>${step.allowanceSatisfied?'Approval ready':step.paymentSubmitted?'Approval not resent':step.confirmed?'Confirmed':step.reverted?'Failed — not paid':operation.needsReview&&!complete(step)?'Needs a fresh review':index===waiting&&operation.phase==='wallet'?'Waiting for you in your wallet':step.uncertain?'Submission unknown — check wallet activity':step.hash?'Submitted · checking confirmation':index===waiting?'Ready for your confirmation':'Up next'}</span></li>`).join('');
  const step=operation.steps[waiting];
  const message=needsNewReview(operation)?'This purchase did not complete. Review a fresh purchase from Offers; no payment will be sent by this button.':operation.recovering?'Checking your existing THOT approval. No signature or payment is requested.':operation.recoveryError?operation.recoveryError:operation.phase==='preflight'?'Checking that your reviewed purchase conditions still apply.':operation.steps.some(s=>s.allowanceSatisfied)&&operation.phase!=='wallet'&&operation.phase!=='confirming'?'Your THOT approval is ready. Continue to confirm payment in your wallet.':operation.phase==='wallet'?'Open your wallet to confirm or cancel this request.':step?.uncertain?'Your wallet did not return a transaction ID. Check its activity before doing anything else. We will not resend this action.':step?.hash?'Your transaction has been submitted. You can check it again without paying twice.':operation.steps.every(complete)?'All transactions confirmed. Continue to refresh the result.':operation.purchase?(operation.steps.some(approvalStep)?'First approve the spending limit, then confirm payment. Approval alone does not buy the item.':'Confirm payment in your wallet to buy this item.'):'Review the action, then confirm it in your wallet.';
  return `<ol class="wallet-progress" aria-label="Transaction progress">${items}</ol><p class="checkout-status" role="status" aria-live="polite">${escape(message)}</p>${step?.hash&&!step.reverted?`<details class="wallet-replacement"><summary>Advanced transaction recovery</summary><p>Paste the new transaction ID from wallet activity. We check it before continuing; cancelled or unrelated transactions are not accepted.</p><label for="thot-replacement-hash">Replacement transaction hash</label><input id="thot-replacement-hash" autocomplete="off" spellcheck="false" placeholder="0x…">${button('replace-transaction','Verify replacement',String(waiting),inFlight)}</details><details class="wallet-transaction"><summary>Transaction ID</summary><code>${escape(step.hash)}</code></details>`:''}`;
 }
 function updateProgress(operation){
  if(needsNewReview(operation)){const resume=globalThis.document?.querySelector('.checkout-resume');if(resume)resume.textContent='Review fresh purchase conditions before trying again.';}
  const target=globalThis.document?.querySelector('[data-wallet-progress]');
  if(target){
   const input=target.querySelector?.('#thot-replacement-hash'),value=input?.value;
   const expanded=target.querySelector?.('.wallet-replacement')?.open;
   target.innerHTML=progressHTML(operation);
   const replacement=target.querySelector?.('#thot-replacement-hash');if(replacement&&value)replacement.value=value;
   const details=target.querySelector?.('.wallet-replacement');if(details&&expanded)details.open=true;
  }
  const primary=globalThis.document?.querySelector('[data-action="thot-send"]');if(primary){primary.textContent=actionLabel(operation);primary.disabled=inFlight||operation.recovering===true;}
 }
 async function send(from,step,current,operator=false,operation=pending){
  // A saved success flag is not evidence after reload or a chain reorganization.
  if(step.hash){step.confirmed=false;saveRecovery(operation);}
  // Revalidate saved failure flags against the canonical chain, just like success.
  step.reverted=false;
  if(step.uncertain)throw Error('The wallet did not return a transaction hash. It may already have submitted this action. Check your wallet; this page will not resend it automatically.');
  current();const selected=await connected(operator);current();if(selected.toLowerCase()!==from.toLowerCase())throw Error('Wallet account changed.');
  if(!step.hash){
   if(operation.purchase&&!approvalStep(step)){
    operation.phase='preflight';updateProgress(operation);
    try{await provider().request({method:'eth_call',params:[{from,to:step.transaction.to,data:step.transaction.data,value:step.transaction.value??'0x0'},'latest']});}
    catch(error){current();operation.needsReview=true;updateProgress(operation);throw Error('This purchase could not be validated. Its reviewed conditions may have expired or changed. No payment was sent. Review a new purchase.');}
    current();await checkNetwork();current();const selected=await connected(operator);current();if(selected.toLowerCase()!==from.toLowerCase())throw Error('Wallet account changed.');
   }
   // Persist submission uncertainty before yielding to the wallet. Only an explicit
   // user rejection is safe to retry without a transaction hash.
   step.uncertain=true;saveRecovery(operation);operation.phase='wallet';updateProgress(operation);
   try{
    const hash=await provider().request({method:'eth_sendTransaction',params:[{...step.transaction,from}]});
    if(typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('The wallet returned no valid transaction hash. Check your wallet before taking further action.');
    step.hash=hash;step.uncertain=false;saveRecovery(operation);operation.phase='confirming';updateProgress(operation);
    // Older saved records remain supported; metadata failure never discards a hash.
    try{const tx=await provider().request({method:'eth_getTransactionByHash',params:[hash]});current();if(tx?.hash?.toLowerCase()===hash.toLowerCase()&&/^0x[0-9a-f]+$/i.test(tx.nonce??'')){step.nonce=tx.nonce;saveRecovery(operation);}}catch(error){current();}
   }catch(error){if(Number(error?.code)===4001){step.uncertain=false;saveRecovery(operation);}throw error;}
   current();
  }
  operation.phase='confirming';updateProgress(operation);
  const deadline=performance.now()+15000;
  for(let n=0;n<30;n++){
   if(n>0&&performance.now()>=deadline)break;
   await checkNetwork();current();const r=await provider().request({method:'eth_getTransactionReceipt',params:[step.hash]});current();await checkNetwork();current();
   if(r){
    if(r.transactionHash&&r.transactionHash.toLowerCase()!==step.hash.toLowerCase())throw Error('Wallet returned a receipt for a different transaction.');
    if(r.status!=='0x1'&&r.status!=='0x0')throw Error(`Transaction ${step.hash} has no confirmed execution status yet.`);
    const depth=Number(capabilities().confirmations??1);
    if(!Number.isSafeInteger(depth)||depth<1||depth>100)throw Error('The required confirmation depth is unavailable. Refresh before continuing.');
    if(!/^0x[0-9a-f]+$/i.test(r.blockNumber??'')||!/^0x[0-9a-f]{64}$/i.test(r.blockHash??''))throw Error('The receipt has no confirmed block identity. Check this transaction again.');
    const head=await provider().request({method:'eth_blockNumber',params:[]});current();
    if(!/^0x[0-9a-f]+$/i.test(head??''))throw Error('The latest chain height is unavailable. Check this transaction again.');
    if(BigInt(head)-BigInt(r.blockNumber)+1n>=BigInt(depth)){
     const block=await provider().request({method:'eth_getBlockByNumber',params:[r.blockNumber,false]});current();
     const confirmed=await provider().request({method:'eth_getTransactionReceipt',params:[step.hash]});current();await checkNetwork();current();
     if(block?.hash?.toLowerCase()!==r.blockHash.toLowerCase()||confirmed?.blockHash?.toLowerCase()!==r.blockHash.toLowerCase()||confirmed?.blockNumber!==r.blockNumber||confirmed?.status!==r.status||confirmed?.transactionHash?.toLowerCase()!==step.hash.toLowerCase())throw Error('Transaction confirmation changed. Check the same transaction again; it will not be resubmitted.');
     if(r.status==='0x0'){step.reverted=true;saveRecovery(operation);updateProgress(operation);throw Object.assign(Error(operation.purchase?'Payment reverted. This transaction did not transfer THOT; network gas may have been spent. Review a new purchase.':'Transaction reverted. No later transaction was sent.'),{code:'CONFIRMED_REVERT'});}
     step.confirmed=true;saveRecovery(operation);updateProgress(operation);return;
    }
   }
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('Confirmation is pending. Choose Check confirmation to check the same transaction; it will not be submitted again. If you used Speed up, enter the replacement below.');
 }
 function legacyPurchaseSummary(operation){
  if(!operation.purchase)return '';
  const approval=operation.steps.find(step=>approvalStep(step)&&/^0x[0-9a-f]{136}$/i.test(step.transaction.data));
  return `<div class="checkout-summary"><div><small>Available balance</small><strong>${state.thot?.account?.balance!=null?escape(fmt(state.thot.account.balance)):'Unavailable — refresh to check'}</strong></div>${approval?`<div><small>Reviewed approval limit</small><strong>${escape(fmt(BigInt('0x'+approval.transaction.data.slice(74))))}</strong></div>`:''}</div>`;
 }
 function review(title,prepared,extra=''){
  const operator=prepared.authority==='operator',key=recoveryKey(operator,prepared.exit===true),saved=savedRecovery(key);
  if(saved&&attempted(saved)){
   pending=saved;title=saved.purchase?'Continue your purchase':'Resume your previous wallet action';
   extra=`<p class="checkout-resume">Your ${saved.purchase?'purchase':'wallet action'} is saved. Continue from the last step below.</p>`+(saved.purchase&&saved.buyer_total?purchaseReviewHTML(saved,false):(saved.extra??legacyPurchaseSummary(saved)));
  }else{
   pending={...prepared,key,extra,steps:prepared.transactions.map(transaction=>({transaction,hash:null,confirmed:false,uncertain:false,reverted:false}))};
   recoveries.set(key,pending);
  }
  for(const [i,step] of pending.steps.entries()){delete step.allowanceSatisfied;delete step.paymentSubmitted;if(purchaseApproval(pending,step)&&pending.steps.slice(i+1).some(s=>s.hash&&s.transaction?.to?.toLowerCase()===capabilities().market?.toLowerCase()))step.paymentSubmitted=true;}
  saveRecovery(pending);
  const current=scope(),operation=pending;pending.current=()=>{current();if(recoveryKey(operator,operation.exit===true)!==key)throw Error('The linked wallet or chain changed. Review this action again.');};
  const progress=pending.steps.map(step=>({transaction:step.transaction,hash:step.hash,status:step.confirmed?'confirmed':step.reverted?'reverted':step.uncertain?'submission unknown':step.hash?'pending':'not submitted'}));
  openDialog(title,networkName()+(production()?' · THOT':' · test THOT')+' · review before signing',`${pending.purchase?sellerWalletHTML(pending.seller):''}${extra}<div data-wallet-progress>${progressHTML(pending)}</div><details><summary>Terms and transaction details</summary><p>${escape(pending.notice??'Your wallet will submit the displayed action. Contract state is authoritative.')}</p><pre class="json-view">${json(progress)}</pre></details>`,button('send',actionLabel(pending),'',false,true));
  if(pending.purchase)void refreshPurchaseApproval(pending);
 }
 function holderBenefitsHTML(){
  const h=state.thot?.holder_rewards;if(!h?.policy)return '';
  const tiers=h.policy.tiers;
  if(h.mode==='upfront-discount')return `<section class="panel holder-benefits"><p class="eyebrow">Holder benefits</p><h2>Hold THOT. Pay lower fees.</h2><p>Qualifying buyers pay less at checkout. Qualifying sellers keep more of each sale. Both benefits apply independently and reduce the protocol’s fee.</p><div class="content-grid">${tiers.map(t=>`<div><strong>${t.rebate_bps/100}% service-fee reduction</strong><p>Hold ${fmt(t.minimum_atoms)} or more.</p></div>`).join('')}</div>${h.lock_tier?`<p><strong>${h.lock_tier.rebate_bps/100}% fee reduction</strong> with ${fmt(h.lock_tier.minimum_atoms)} still locked for an original term of at least ${h.lock_tier.duration_seconds/86400} days. The extra discount ends at maturity.</p>`:''}<p>Your qualifying balance: ${fmt(h.qualifying_balance_atoms)} · Your rate: ${h.rate_bps/100}%.</p><p>Wallet holdings and unclaimed staking principal count at purchase funding. Each discount is capped to preserve direct costs and referrals. Reserve purchases do not qualify. No cashback claim is needed.</p>${h.is_owner?`<details><summary>Governance: future fee discounts</summary><p>New funding uses the updated rates. Existing invoices and proceeds do not change.</p><label>First holding threshold (THOT)<input id="holder-first" value="${inputDecimal(tiers[0].minimum_atoms)}"></label><label>First discount (%)<input id="holder-low" type="number" min="0" max="${h.lock_tier?35:25}" step="0.01" value="${tiers[0].rebate_bps/100}"></label><label>Second holding threshold (THOT)<input id="holder-second" value="${inputDecimal(tiers[1].minimum_atoms)}"></label><label>Second discount (%)<input id="holder-high" type="number" min="0" max="${h.lock_tier?35:25}" step="0.01" value="${tiers[1].rebate_bps/100}"></label>${h.lock_tier?`<label>Long-lock principal · THOT<input id="holder-lock-amount" value="${inputDecimal(h.lock_tier.minimum_atoms)}"></label><label>Minimum original lock · days<input id="holder-lock-days" type="number" min="1" max="730" value="${h.lock_tier.duration_seconds/86400}"></label><label>Long-lock fee reduction · %<input id="holder-lock-rate" type="number" min="0" max="35" step="0.01" value="${h.lock_tier.rebate_bps/100}"></label>`:''}${button('holder-policy','Review future fee policy')}</details>`:''}</section>`;
  const rows=(h.orders??[]).filter(o=>BigInt(o.amount_atoms)>0n||BigInt(o.paid_atoms)>0n);
  return `<section class="panel holder-benefits"><p class="eyebrow">Holder benefits</p><h2>Hold THOT. Get fees back.</h2><p>Buyers and sellers earn cashback on the service fee of completed independent item purchases. No stake required; your unclaimed staking principal counts too.</p>
   <div class="content-grid">${tiers.map(t=>`<div><strong>${t.rebate_bps/100}% fee cashback</strong><p>Hold ${fmt(t.minimum_atoms)} or more.</p></div>`).join('')}</div>
   <p><strong>Your current rate: ${h.rate_bps/100}%</strong> · Qualifying balance: ${fmt(h.qualifying_balance_atoms)}</p>
   <p>With a 0.04 THOT service fee, ${tiers.at(-1).rebate_bps/100}% returns ${fmt(40000000000000000n*BigInt(tiers.at(-1).rebate_bps)/10000n)}. This percentage applies to the service fee, not the price.</p>
   <p>Hold the qualifying amount when claiming. Cashback becomes claimable after the purchase settles; refunds and reserve-funded purchases do not qualify. Sale proceeds and referral payments stay unchanged. Available pool: ${fmt(h.inventory_atoms)}; rebates are paid while funding remains.</p>
   ${rows.length?`<h3>Your fee cashback</h3>${rows.map(o=>`<article class="offer-card"><p>Purchase ${escape(o.offer_id.slice(0,12))}…</p><strong>${fmt(BigInt(o.paid_atoms)>0n?o.paid_atoms:o.amount_atoms)}</strong><p>${BigInt(o.paid_atoms)>0n?'Claimed':o.claimable?'Ready to claim':'Pending settlement or pool funding'}</p>${o.claimable?button('holder-rebate','Claim fee cashback',o.offer_id):''}</article>`).join('')}`:'<p>Your qualifying purchases and sales appear here after funding.</p>'}
   ${h.is_owner?`<details><summary>Governance: change future holder benefits</summary><p>One owner can publish a new policy. Existing funded sales retain their policy. Each party's rebate is capped at 25% of the service fee and half of the protocol allocation.</p><label>First holding threshold (THOT)<input id="holder-first" value="${inputDecimal(tiers[0].minimum_atoms)}"></label><label>First cashback (%)<input id="holder-low" type="number" min="0" max="25" step="0.01" value="${tiers[0].rebate_bps/100}"></label><label>Second holding threshold (THOT)<input id="holder-second" value="${inputDecimal(tiers[1].minimum_atoms)}"></label><label>Second cashback (%)<input id="holder-high" type="number" min="0" max="25" step="0.01" value="${tiers[1].rebate_bps/100}"></label>${button('holder-policy','Review future fee policy')}</details>`:''}
  </section>`;
 }
 const active=()=>supported(state.thot?.capabilities.mode);
 const sameWallet=(a,b)=>!!a&&!!b&&a.toLowerCase()===b.toLowerCase();
 const nav=(view,label)=>`<button class="text-button" data-view="${view}">${label}</button>`;
 const heading=(label,title,description)=>`<section class="page-heading"><div><p class="eyebrow">${label}</p><h1>${title}</h1><p>${description}</p></div>${button('refresh','Refresh balances')}</section><p class="legal-note">${escape(networkNote())}</p>`;
 const walletPrompt=()=>`<section class="panel"><h2>Link your wallet</h2><p>Connect a wallet to see your balances and act on offers. The link uses a message signature and grants no spending approval.</p>${button('link','Link a wallet')}${button('network','Switch to '+escape(networkName()))}</section>`;
 const explorerLink=(kind,value)=>{const base=capabilities().explorer_url;if(!base||!/^https:\/\//.test(base)||!/^0x[0-9a-f]+$/i.test(value??''))return '';return `<a href="${escape(base.replace(/\/$/,'')+'/'+kind+'/'+value)}" target="_blank" rel="noopener noreferrer">View on explorer ↗</a>`;};
 const contractDetails=()=>`${capabilities().legacy_workspace_origin?`<p class="legal-note">Earlier test assets remain available. <a href="${escape(capabilities().legacy_workspace_origin)}/app">Open previous test workspace →</a></p>`:''}<p class="legal-note">${escape(networkName())} · chain ${escape(capabilities().chain_id)} ${button('network','Switch wallet network')}</p><details class="technical-details"><summary>Contract details</summary><p>Chain ${escape(capabilities().chain_id)} · market <code>${escape(capabilities().market)}</code>. ${explorerLink('address',capabilities().market)}</p></details>`;
 function settlementHTML(r,{refundPaid=false,buyerTotal=r.buyer_total??r.gross}={}){
  if(r.status===2){const deadline=r.accepted_at?date(Number(r.accepted_at)+48*3600):null;return `<p class="thot-settlement">Delivery pending.${deadline?' Delivery deadline: '+escape(deadline)+'.':''} The ${disputeWindow(r)} starts when delivery is recorded.</p>`;}
  if(r.status===3&&r.delivered_at){const seconds=disputeSeconds(r),deadline=seconds?Number(r.delivered_at)+seconds:null,ready=deadline!==null&&chainNow(r)>=deadline;return `<p class="thot-settlement">Delivered ${escape(date(r.delivered_at))}. ${deadline===null?'Checking the contract’s dispute period.':ready?'The dispute window has ended; automatic payout is pending confirmation.':'Undisputed proceeds become payable '+escape(date(deadline))+'.'}</p>`;}
  if(r.status===4&&r.dispute){const now=chainNow(r),phase=now<r.dispute.vote_starts_at?`The seller may respond until ${date(r.dispute.vote_starts_at)}.`:now<r.dispute.vote_ends_at?`Governance voting closes ${date(r.dispute.vote_ends_at)}.`:'The vote ended without a decision; anyone may apply the default uphold.';return `<p class="thot-settlement">A subjective dispute is holding this payment. ${escape(phase)} ${escape(capabilities().dispute_review_threshold??2)} matching governance vote(s) decide it.</p>`;}
  if(r.status===6){
   const disputed=r.dispute?.outcome===2,total=buyerTotal==null?null:BigInt(buyerTotal),refund=total===null?null:disputed?total/2n:total;
   return `<p class="thot-settlement">${disputed?'Governance found for the buyer. ':''}${refund===null?'Checking the frozen refund amount.':`Refund ${refundPaid?'paid to the buyer wallet':'allocated to the buyer'}: ${escape(fmt(refund))}.`}${refundPaid?'':' Payout is not yet confirmed here; check the available claim balance.'}${disputed&&total!==null?` The remaining ${escape(fmt(total-refund))} was sent to the canonical dead sink.`:''} Seller, referrer and protocol receive no sale proceeds from this purchase.</p>`;
  }
  return '';
 }
 function settlementActions(o){
  const r=o.receipt,now=chainNow(r),seconds=disputeSeconds(r),buyer=sameWallet(o.buyer,state.thot?.wallet),seller=sameWallet(o.seller,state.thot?.wallet);
  if(r.status===3){
   if(seconds===null)return '';
   if(now>=Number(r.delivered_at)+seconds)return button('finalize','Finalize & make payable',o.id);
   const prior=BigInt(state.thot?.account?.finalized_independent_spend??0),minimum=BigInt(capabilities().subjective_dispute_min_qualifying_spend??0);
   return buyer&&r.independent&&!r.treasury&&minimum>0n&&prior+BigInt(r.buyer_total??r.gross??0)>=minimum?button('dispute','Raise a subjective dispute',o.id):'';
  }
  if(r.status===4&&seller&&r.dispute&&now<r.dispute.vote_starts_at)return /^0x0{64}$/.test(r.dispute.response_hash)?button('dispute-respond','Respond to complaint',o.id):button('dispute-waive-response','Finish response period now',o.id);
  return r.status===2&&r.accepted_at&&now>Number(r.accepted_at)+48*3600?button('refundUndelivered','Refund undelivered purchase',o.id):r.status===1&&r.issued_at&&now>Number(r.issued_at)+86400?button('refundExpired','Refund expired offer',o.id):'';
 }
 const modelHTML=m=>m?.evidence==='user_supplied'?`<p>File claims model: <strong>${escape(m.claimed_model??'Not recorded')}</strong> (unverified).</p>`:m?`<p>Requested model: <strong>${escape(m.requested_model??'Not recorded')}</strong><br>Returned model: <strong>${escape(m.returned_model??'Not reported by provider')}</strong>${m.provider_name?` · ${escape(m.provider_name)}`:''}<br>Capture: ${escape(m.capture_status??'Recorded')} · Provider response metadata</p>`:'<p>Model: not recorded for this item.</p>';
 const tradeProofHTML=(value,heading='Trade proof')=>{if(!value)return '';const proof=value.summary??value;return `<section class="panel trade-proof"><h3>${escape(heading)}</h3><p><strong>Observed trade</strong> · ${escape(proof.symbol??'symbol unavailable')} · ${escape(proof.window_days??'?')} day window</p><p>${escape(proof.claim??'Positive trade observation')}</p><p>This establishes an observed fill within the window before or after the item reference. It does not establish P&amp;L, account-wide history or research causality.</p><p class="legal-note">Basis: recorded item time${proof.observed_at?` · observed ${escape(date(proof.observed_at)??proof.observed_at)}`:''}${proof.expires_at?` · expires ${escape(date(proof.expires_at)??proof.expires_at)}`:''}${proof.available_after?` · can be shared after ${escape(date(proof.available_after)??proof.available_after)} when the capture ticket expires`:''}.</p></section>`;};
 const tradeEvidenceOptions=metadata=>{const items=Array.isArray(metadata?.trade_evidence)?metadata.trade_evidence:[];if(!items.length)return '';return `<section class="panel"><h3>Optional trade proof</h3><p>Share one signed proof with this listing only if you explicitly choose it. Buyers see a bounded observed-trade summary.</p><label for="thot-trade-evidence-id">Trade proof</label><select id="thot-trade-evidence-id"><option value="">Do not share trade proof</option>${items.map(e=>`<option value="${escape(e.id)}">${escape(e.symbol??'Trade')} · ${escape(e.window_days??'?')} days · observed ${escape(date(e.trace_ts)??e.trace_ts??'item time')}</option>`).join('')}</select><label><input type="checkbox" id="thot-trade-evidence-disclosure"> I explicitly consent to share this signed proof, including stable owner and job IDs. It never includes raw account data.</label>${items.map(e=>tradeProofHTML(e,'Available proof')).join('')}</section>`};
 const brokerageHTML=(value,listingId)=>value?tradeProofHTML(value,'Trade proof shared by the contributor')+(listingId?button('trade-evidence','Inspect trade proof',listingId):''):'';
 function releaseHTML(release){
  const content=release?.content??release,turns=Array.isArray(content?.turns)?content.turns:[];
  const messages=content?.schema_version==='thot.research-package/1'?researchFilesHTML(content,escape):turns.map((turn,index)=>`<article class="thot-message"><p class="eyebrow">${index+1} · ${escape(turn.role??'Message')}</p><div class="thot-message-content">${escape(typeof turn.content==='string'?turn.content:JSON.stringify(turn.content??''))}</div></article>`).join('');
  return `<details class="thot-reader-terms"><summary>Licence and source details</summary>${release?.license?`<section class="thot-release-license"><h3>Buyer licence</h3><p>${escape(release.license)}</p><p>Content provenance: ${escape(release.provenance?.confidence_tier??'Unspecified')}.</p></section>`:''}${content?.schema_version==='thot.research-package/1'?'<p>Imported research · source declarations are unverified.</p>':modelHTML(release?.capture_model)}${brokerageHTML(release?.brokerage_evidence)}${tradeEvidenceOptions(release)}</details><section class="thot-conversation" aria-label="${content?.schema_version==='thot.research-package/1'?'Licensed research package':'Licensed conversation'}">${messages||'<p>No conversation turns are present in this release. Inspect the exact artifact below.</p>'}</section><details class="technical-details"><summary>Exact release artifact & commitments</summary><pre class="json-view">${json(release)}</pre></details>`;
 }
 const listingMetadataHTML=metadata=>`${modelHTML(metadata?.capture_model)}<p>Rights: <strong>${escape(metadata?.rights_status??'unknown')}</strong> · provenance: <strong>${escape(metadata?.provenance??'unknown')}</strong>.</p><p>The release content stays private here. Inspect your saved item in the vault before authorizing its exact committed release.</p>${tradeEvidenceOptions(metadata)}<details class="technical-details"><summary>Release commitment</summary><p><code>${escape(metadata?.content_hash??'unavailable')}</code></p></details>`;
 function listingComparableHTML(traceId){
  if(listingMetadata?.content_kind==='research')return '<p>Choose a price for the selected research files and licence.</p>';
  const e=state.thot?.valuations?.find(row=>row.trace_id===traceId)?.estimate;
  const group=(g,label)=>g?.status==='estimated'?`<p><strong>${escape(label)} · ${escape(fmt(g.median_gross_atoms))}</strong><br>Middle range ${escape(fmt(g.p25_gross_atoms))}–${escape(fmt(g.p75_gross_atoms))} · ${escape(g.sample_count)} sales.</p>`:`<p>${escape(label)}: not enough comparable sales yet.</p>`;
  return `<section class="journey-review-comparables"><h3>What similar data sold for</h3>${group(e?.independent,'Independent buyers')}${e?.sponsored?.status==='estimated'?group(e.sponsored,'Treasury-sponsored samples'):''}<p>Gross prices, not buyer offers or earnings. Your item may not sell.</p></section>`;
 }
 function listingPreviewHTML(){
  const p=listingMetadata,editable=p.exclusion?.supported===true;
  if(p.content_kind==='research')return `<section class="journey-release"><h3>What you’ll share</h3><p>Exact selected research files under one package licence. Review rights for report, code, data and evidence separately.</p>${researchFilesHTML(p.content,escape,{editable})}${editable?`<label><input id="release-exclusion-rights" type="checkbox"> I can license every remaining file under the proposed licence.</label>${button('release-exclude','Apply selected removals')}`:''}<p>Uploaded research is unverified. Local pattern checks do not establish truth, completeness or licensing rights. Removing files preserves your private original; relationships to removed files are removed too. To redact text, prepare and import a new reviewed package.</p></section>`;
  const sourceLabel=p.provenance_status==='IMPORTED_UNVERIFIED'?'Uploaded history · unverified':p.provenance??'Source unknown';
  return `<section class="journey-release"><header><h3>What you’ll share</h3><p>${p.content.turns.length} messages · ${escape(sourceLabel)}${editable?' · choose messages to remove below':''}</p></header><div class="journey-release-turns">${p.content.turns.map((turn,index)=>`<article class="journey-release-turn"><header><span>${index+1} · ${escape(turn.role??'Message')}</span>${editable?`<label><input type="checkbox" name="excluded_turn" value="${index}"> Remove from release</label>`:''}</header><pre>${escape(typeof turn.content==='string'?turn.content:JSON.stringify(turn.content??''))}</pre></article>`).join('')}</div>${editable?`<div class="journey-release-tools"><details><summary>Apply privacy changes</summary><p>Selected messages are removed from the actual release. Your private original stays unchanged. Recheck the new version before signing.</p><label class="check"><input id="release-exclusion-rights" type="checkbox"> I can license the remaining contributions.</label><label class="check"><input id="release-exclusion-outputs" type="checkbox"> I can also license the remaining assistant responses.</label><p>Without the second choice, assistant responses are excluded.</p>${button('release-exclude','Apply selected removals')}</details></div>`:''}${p.sale_eligibility?.can_list!==true?`<div class="library-attention"><strong>This release is not ready to list.</strong><p>${escape(p.sale_eligibility?.reason_code??'Refresh its release assessment before continuing.')}</p></div>`:''}<details class="journey-release-tools"><summary>Privacy checks & source</summary><p>Provenance tier: ${escape(p.provenance??'Unknown')}.</p><p>Review for anything confidential. Automated checks can miss private details.</p>${(p.privacy?.flags??[]).length?`<p>${escape(p.privacy.flags.join(' · '))}</p>`:''}<p>${escape((p.privacy?.limitations??[]).join(' '))}</p><p>${editable?'Removing messages reruns the release checks.':'This release cannot be edited here. Previously prepared or purchased releases retain their exact signed content.'}</p></details></section>`;
 }
 function showListingReview(){
   const feeCopy=feePolicyCopy(state.thot?.account?.economics,state.thot?.holder_rewards);
   openDialog('Review & sell','Only this reviewed release is licensed. Your original source stays in your private library.',`<div class="journey-review">${listingPreviewHTML()}<aside>${listingComparableHTML(listingMetadata.trace_id)}<div class="thot-sale-form">
<p class="thot-sale-intro">One sale · available for up to 30 days · content delivered after payment.</p>
<div class="thot-sale-fields">
<div class="thot-sale-field"><label for="thot-title">Public title</label><input id="thot-title" maxlength="100" placeholder="Give buyers a clear, specific title" value="${escape(state.traceLibrary?.items?.find(t=>t.trace_id===listingMetadata.trace_id)?.title??'')}"></div>
<div class="thot-sale-field"><label for="thot-price">Sale price <span>(THOT)</span></label><input id="thot-price" inputmode="decimal" placeholder="0.00" aria-describedby="thot-price-share"></div>
</div>
<p id="thot-price-share" class="thot-sale-estimate" role="status">Enter a price to see the service fee and your estimated proceeds.</p>
<div class="thot-sale-field"><label for="thot-license-preset">Buyer licence</label><select id="thot-license-preset"><option value="evaluation">Evaluation · 30 days</option><option value="training">Research &amp; model training</option><option value="custom">Custom terms…</option></select><textarea id="thot-license" rows="4" aria-label="Exact licence text" hidden>Non-exclusive evaluation license for this scrubbed item, for 30 days. No onward transfer, re-identification or account access.</textarea><p id="thot-license-help" class="thot-field-help">The buyer receives exactly this licence.</p></div>
<label class="thot-consent"><input type="checkbox" id="thot-list-consent"><span>I reviewed this item, have the rights to it, and authorize <strong>one automatic sale</strong> of this exact release with the public title and licence above.</span></label>
${tradeEvidenceOptions(listingMetadata)}
<details class="thot-sale-details"><summary>More options &amp; terms</summary><div class="thot-sale-optional"><label class="thot-consent"><input type="checkbox" id="thot-treasury-consent" aria-describedby="thot-reserve-help"><span>Include in reserve review <span class="thot-field-help">(optional)</span></span></label><p id="thot-reserve-help" class="thot-field-help">Three authorized reviewers can inspect one complete release selected from each stable group of 20 unique eligible data you opt in. Repeated access, relisting and reviewer changes do not redraw it. You can sell without opting in.</p></div><p>There is no ordinary pre-purchase item preview. A buyer receives this release only after purchase. After recorded delivery the buyer has a ${escape(disputeWindow())} to raise an onchain dispute; during a dispute, non-conflicted governance reviewers can inspect the purchased release.</p><p>Authorizing this listing is an off-chain wallet signature: it is not a blockchain transaction and costs no gas. The buyer's later purchase is the on-chain step.</p><p>${escape(feeCopy.summary)}</p><p>${escape(feeCopy.details)}</p><p>Authorization lasts up to 30 days. Stop future purchases with an onchain revocation. A funded purchase retains its licensed copy for 30 days.</p><p>Register your referrer in THOT before your first accepted sale.</p>${modelHTML(listingMetadata?.capture_model)}<p>Rights: <strong>${escape(listingMetadata?.rights_status??'unknown')}</strong> · provenance: <strong>${escape(listingMetadata?.provenance??'unknown')}</strong>.</p><p>Release commitment: <code>${escape(listingMetadata?.content_hash??'unavailable')}</code></p></details>
</div></aside></div>`,button('list-confirm',listingMetadata.content_kind==='research'?'Sign & list package':'Sign & list','',listingMetadata.sale_eligibility?.can_list!==true,true));
   const licences={evaluation:'Non-exclusive evaluation license for this scrubbed item, for 30 days. No onward transfer, re-identification or account access.',training:'Non-exclusive licence to use this item for research and to train or evaluate machine-learning models. No onward transfer, resale, re-identification or account access.'};
   const preset=dialog.querySelector?.('#thot-license-preset'),licence=dialog.querySelector?.('#thot-license');
   preset?.addEventListener?.('change',()=>{licence.hidden=preset.value!=='custom';if(licences[preset.value])licence.value=licences[preset.value];});
 }
 // The public share link for a listing, as returned by the listing API. Composed
 // against this origin when the server sends only the path.
 function listingPublicUrl(listing){
  if(!listing)return null;
  if(typeof listing.public_url==='string'&&/^https:\/\//.test(listing.public_url))return listing.public_url;
  if(typeof listing.public_path!=='string'||!/^\/l\/[A-Za-z0-9_-]+$/.test(listing.public_path))return null;
  try{return new URL(listing.public_path,globalThis.window?.location?.origin??undefined).href;}catch{return listing.public_path;}
 }
 function showListingSignatureReview(){
  const prepared=listingEnrollment.prepared,message=prepared.typed_data?.message??{};
  const evidenceHash=typeof message.evidenceHash==='string'?message.evidenceHash:null,licenseHash=typeof message.licenseHash==='string'?message.licenseHash:null;
  const research=listingMetadata.content_kind==='research';
  openDialog('Review the exact commitments','Your wallet signature binds the two hashes below to this exact release.',`<div class="journey-review"><section class="journey-release"><h3>What you are signing</h3>
   <div class="meta-pair"><span>Public title</span><strong>${escape(globalThis.document?.querySelector('#thot-title')?.value??prepared.title)}</strong></div>
   <div class="meta-pair"><span>Sale price</span><strong>${escape(fmt(message.gross??prepared.price_atoms))}</strong></div>
   <div class="meta-pair"><span>Signing wallet</span><strong class="mono">${escape(message.seller??state.thot?.wallet??'')}</strong></div>
   <div class="thot-hash-field"><span id="thot-evidence-hash-label">evidenceHash being signed</span><code class="hash" aria-labelledby="thot-evidence-hash-label">${escape(evidenceHash??'unavailable — reopen this review')}</code></div>
   <div class="thot-hash-field"><span id="thot-license-hash-label">licenseHash being signed</span><code class="hash" aria-labelledby="thot-license-hash-label">${escape(licenseHash??'unavailable — reopen this review')}</code></div>
   <p class="legal-note">The evidenceHash is the digest of the complete release envelope — the displayed release/content commitment together with this licence, its provenance and your consent terms — and the licenseHash commits to exactly the licence text you reviewed.</p>
   <p class="legal-note">Signing is an off-chain signature: no blockchain transaction is sent and no gas is charged. The buyer's later purchase is the on-chain step, and after its recorded delivery the buyer has a ${escape(disputeWindow())} to raise an onchain dispute.</p>
   <details class="thot-sale-details"><summary>Licence and release commitment</summary><p>${escape(globalThis.document?.querySelector('#thot-license')?.value??prepared.license??'')}</p><p>Release/content commitment: <code>${escape(listingMetadata?.content_hash??'unavailable')}</code></p><p>Authorization lasts up to 30 days and authorizes one automatic sale.</p></details>
   </section></div>`,button('list-cancel','Review again','',false)+button('list-sign','Open wallet to sign','',false,true));
 }
 function showListingListed(listing){
  const url=listingPublicUrl(listing);
  openDialog(listing?.content_kind==='research'?'Your package is listed':'Your item is listed','A qualifying purchase now completes automatically; no second approval is needed.',`${url?`<div class="thot-hash-field"><span id="thot-listing-url-label">Public listing URL</span><div class="thot-url-row"><input id="thot-listing-url" readonly aria-labelledby="thot-listing-url-label" value="${escape(url)}"><button class="button secondary small" data-action="thot-copy-listing-url" data-id="${escape(url)}">Copy link</button></div><p class="legal-note">Anyone with this link sees the public listing details and a sign-in-to-buy action — never the conversation itself.</p></div>`:'<p class="legal-note">The public listing page for this item is available in My data.</p>'}<p class="legal-note">Stop future purchases any time from the listing controls; already funded sales remain authorized.</p>`,button('close-dialog','Done'));
 }
 function onInput(element){
  if(['excluded_turn','excluded_file'].includes(element.name)){listingDirty=[...document.querySelectorAll('input[name="excluded_turn"],input[name="excluded_file"]')].some(input=>input.checked);const sign=document.querySelector('[data-action="thot-list-confirm"]');if(sign){sign.disabled=listingDirty||listingMetadata?.sale_eligibility?.can_list!==true;sign.textContent=listingDirty?'Apply removals before signing':listingMetadata.content_kind==='research'?'Sign & list package':'Sign & list';}return true;}
  if(element.id!=='thot-price')return false;const target=document.querySelector('#thot-price-share');if(!target)return true;
  if(!/^(?:0|[1-9]\d*)(?:\.\d{0,18})?$/.test(element.value)){target.textContent='Enter a gross price to estimate your sale proceeds.';return true;}
  const [whole,fraction='']=element.value.split('.'),gross=BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));
  const economics=state.thot?.account?.economics,policy=feePolicyCopy(economics,state.thot?.holder_rewards);if(policy.kind==='unavailable'){target.textContent='Refresh your account to load the current service tariff.';return true;}
  const fee=economics.fee_bps!=null?(gross*BigInt(economics.fee_bps)+9999n)/10000n:BigInt(economics.service_fee);target.textContent=gross*70n<fee*100n?'This price is too low for the current service fee and minimum seller retention.':`Base service fee${policy.kind==='percentage'?' ('+economics.fee_bps/100+'% of the price)':''}: ${fmt(fee)}. Estimated seller proceeds: ${fmt(gross-fee)}. The funding quote includes any applicable discounts and fixes the exact proceeds. A sale or payout is not guaranteed.`;return true;
 }
 function orderCard(o){
  const r=o.receipt,seller=sameWallet(o.seller,state.thot.wallet),buyer=sameWallet(o.buyer,state.thot.wallet);
  const refundPaid=r.status===6&&/^0x[0-9a-f]{64}$/i.test(o.refund_transaction??'');
  const label=r.status===0?'Payment not yet confirmed':r.status===5?(o.payout_transaction?'Payout transaction confirmed':'Finalized · payout pending'):refundPaid?'Refund paid to buyer wallet':r.status===1?(seller?'Funded · awaiting your consent':'Funded · awaiting seller consent'):status[r.status];
  return `<article class="panel thot-order" data-purchase-id="${escape(o.id)}"><span class="pill">${escape(label)}</span><h3>${escape(o.title)}</h3>${buyer?sellerWalletHTML(o.seller):''}<p>${seller?'Your sale':'Your purchase'}${r.status===6?' · refunded':` · seller price ${escape(fmt(r.seller_gross??o.seller_gross??o.gross))}`}</p>${r.status===6?'':`<p>${r.economics?'Service fee '+escape(fmt(r.economics.service_fee)):'Buyer surcharge '+escape(fmt(r.buyer_surcharge??o.buyer_surcharge??0))} · total escrow ${escape(fmt(r.buyer_total??o.buyer_total??o.gross))}. Seller receives ${escape(fmt(r.seller_amount))}. Referral ${escape(fmt(r.referral_amount))}.</p>`}
   ${r.status===1&&seller?button('review','Review exact release',o.id):''}
   ${[2,3,4,5].includes(r.status)&&buyer?button('delivery','Open',o.id):''}
   ${r.status===1&&buyer?button('cancelOffer','Cancel funded offer',o.id):''}
   ${o.last_error?`<p role="status">Processing needs attention (${escape(o.last_error)}). Refresh this purchase; the worker retries recoverable failures. Keep the purchase reference below for support.</p>`:''}${o.job_status==='awaiting_reconciliation'?'<p>Checking a previously submitted transaction. No new payment is needed.</p>':''}
   ${settlementHTML(r,{refundPaid,buyerTotal:r.buyer_total??o.buyer_total??r.gross??o.gross})}${settlementActions(o)}${refundPaid?`<p>${explorerLink('tx',o.refund_transaction)}</p>`:''}
   <details><summary>Purchase receipt</summary><p class="mono">${escape(o.id)}</p></details></article>`;
 }
 function listingCard(l,{browseOnly=false,workspace=state.thot}={}){
  const w=workspace;
  return `<article class="thot-listing" data-listing-id="${escape(l.id)}"><div class="thot-listing-body"><h3>${escape(l.title)}</h3>${sellerWalletHTML(l.seller)}<p>${escape(l.workflow)} · ${l.content_kind==='research'?`${escape(l.file_count)} files`:`${escape(l.turn_count)} turns`} · ${escape(l.provenance)}</p>${l.content_kind==='research'?'<p>Imported research package · unverified source declarations.</p>':modelHTML(l.capture_model)}${brokerageHTML(l.brokerage_claim,!browseOnly&&w.wallet&&!sameWallet(l.seller,w.wallet)?l.id:undefined)}</div><div class="thot-listing-purchase"><p class="eyebrow">Listed price</p><strong class="thot-listing-price">${escape(fmt(l.price_atoms))}</strong><p class="legal-note">Review the exact total before signing.</p><details><summary>License</summary><p>${escape(l.license)}</p></details>${!browseOnly&&w.wallet&&!sameWallet(l.seller,w.wallet)?(l.content_kind==='research'?'':button('assay','Check metadata',l.id))+(w.reserve_buyer&&l.treasury_sample_available?button('buyer-sample','Inspect selected reserve sample',l.id)+(purchasesPaused()?'':button('reserve-buy','Buy using reserve',l.id)):'')+(purchasesPaused()?'':button('buy','View & buy',l.id,false,true)):''}${!browseOnly&&sameWallet(l.seller,w.wallet)?button('unlist','Revoke future sale',l.id):''}</div></article>`;
 }
 function catalogueHTML(catalogue,{failed=false,catalogueError=false}={}){
  const listings=catalogue?.listings??[],available=listings.filter(l=>!sameWallet(l.seller,catalogue?.wallet));
  const accountStatus=failed?'Balances and purchase history could not load. Retry to enable buying.':'Loading balances and purchase history. Browse listings while we enable buying.';
  return `<section id="market-catalogue"><section class="page-heading"><div><p class="eyebrow">Marketplace</p><h1>Buy an item. Put it to work.</h1><p>Browse contributor-authorized conversations, review the price and licence, then pay from your wallet.</p></div><button class="button secondary" data-action="refresh">${failed?'Retry account details':'Refresh'}</button></section>
   <div class="section-head" id="thot-available"><h2>For sale</h2></div>
   <p class="legal-note" data-catalogue-account-status role="status">${accountStatus}</p>
   <div data-catalogue-fetch-status role="status">${catalogue?'':catalogueError?'<p>Listings could not load. Use Refresh to try again.</p>':'<p>Loading listings…</p>'}</div>
   <section class="thot-listings" aria-label="For sale">${catalogue?available.map(l=>listingCard(l,{browseOnly:true,workspace:catalogue})).join('')||'<div class="panel thot-empty"><h3>No data listed yet</h3><p>Contributor-authorized research will appear here.</p></div>':''}</section>
   <section id="thot-purchases" class="panel"><h2>Your purchases</h2><p data-catalogue-history-status>${failed?'Purchase history is unavailable. Retry account details to check it.':'Loading your purchase history…'}</p></section>
   ${state.role==='user'?'<section id="thot-contribute" class="panel"><h2>Sell your data</h2><p>Your selling controls will appear after account details load.</p></section>':''}</section>`;
 }
 function purchasesHTML(){
  const w=state.thot,orders=(w.orders??[]).filter(o=>sameWallet(o.buyer,w.wallet));
  const unpaid=orders.filter(isClosedUnpaidPurchase),open=orders.filter(o=>o.receipt.status<5&&!isClosedUnpaidPurchase(o)),closed=orders.filter(o=>o.receipt.status>=5);
  const waiting=open.some(o=>[0,1,2].includes(o.receipt.status));
  return `<div class="section-head" id="thot-purchases"><h2>Your purchases</h2>${nav('thot','Manage THOT →')}</div>${waiting?'<p id="purchases-freshness" class="legal-note" role="status">Checking delivery automatically. No new payment is sent.</p>':''}<section class="cards">${open.map(orderCard).join('')||'<div class="panel"><p>No open purchases. Choose an item below to get started.</p></div>'}</section>
   ${closed.length?`<details class="technical-details" id="thot-history"><summary>Completed & refunded purchases (${closed.length})</summary><section class="cards">${closed.map(orderCard).join('')}</section></details>`:''}
   ${unpaid.length?`<details class="technical-details" data-unpaid-attempts><summary>Unpaid purchase attempts (${unpaid.length})</summary><section class="cards">${unpaid.map(o=>`<article class="panel thot-unpaid-attempt" data-purchase-id="${escape(o.id)}"><span class="pill">Not paid · unavailable</span><h3>${escape(o.title)}</h3><p>This purchase review is no longer available. No payment was confirmed for this attempt.</p><details><summary>Purchase reference</summary><p class="mono">${escape(o.id)}</p></details></article>`).join('')}</section></details>`:''}
   ${w.orders_truncated?'<p class="legal-note">Showing purchases within the latest 50 account purchase and sale records.</p>':''}`;
 }
 function offersHTML(){
  if(!active())return '';
  const w=state.thot,orders=w.orders??[],traces=state.traces??[],saved=savedRecovery(recoveryKey());
  const available=(w.listings??[]).filter(l=>!sameWallet(l.seller,w.wallet)),own=(w.listings??[]).filter(l=>sameWallet(l.seller,w.wallet));
  const sales=orders.filter(o=>sameWallet(o.seller,w.wallet));
  const recovery=saved&&attempted(saved)?`<section class="panel"><h2>${needsNewReview(saved)?'Purchase needs review':'Payment confirmation pending'}</h2><p>Check the previous wallet action before starting another purchase.</p>${button('resume-payment','Resume wallet action')}</section>`:'';
  return heading('Marketplace','Buy an item. Put it to work.','Browse contributor-authorized conversations, review the price and licence, then pay from your wallet.')+
   `<nav class="thot-section-nav" aria-label="Marketplace sections"><a href="#thot-available">Browse data <span>${available.length}</span></a><a href="#thot-purchases">Your purchases <span>${orders.filter(o=>sameWallet(o.buyer,w.wallet)&&!isClosedUnpaidPurchase(o)).length}</span></a>${state.role==='user'?'<a href="#thot-contribute">Sell your data</a>':''}</nav>`+
   (!w.wallet?walletPrompt():'')+recovery+
   (state.role!=='user'&&w.account&&BigInt(w.account.claimable)>0n?`<section class="panel"><h2>Available to claim</h2><strong>${escape(fmt(w.account.claimable))}</strong><p>Contract funds ready to return to your wallet, including purchase refunds and any eligible referral payouts.</p>${button('claim','Claim tokens')}</section>`:'')+
   `<div class="section-head" id="thot-available"><h2>For sale</h2><p>Review the listing metadata and licence before purchase. The licensed conversation unlocks after payment.</p></div>${purchasesPaused()?`<p role="status">${escape(pauseNotice())}</p>`:''}
   <details class="technical-details"><summary>Check workflow and length</summary><p>Check listing metadata using allowlisted predicate results without seeing the conversation.</p><div class="thot-filters"><div><label for="thot-workflow">Workflow</label><select id="thot-workflow"><option value="coding">Coding</option><option value="investment_research">Investment research</option><option value="research">Research</option><option value="contract_review">Contract review</option></select></div><div><label for="thot-min-turns">Minimum turns</label><input id="thot-min-turns" type="number" min="1" max="1000" value="2"></div></div></details>
   <section class="thot-listings" aria-label="For sale">${available.map(listingCard).join('')||'<div class="panel thot-empty"><h3>No data available yet</h3><p>Contributor-authorized research will appear here. Refresh to check for new listings.</p></div>'}</section>
   <section id="thot-buyer-purchases">${purchasesHTML()}</section>
   ${w.wallet&&state.role==='user'?`<details class="technical-details" id="thot-contribute"><summary>Manage your listings</summary><div class="section-head"><h2>Sell your data</h2>${nav('earnings','View earnings →')}</div><section class="panel"><h3>List an item you choose</h3><p>Set a price and authorize the exact scrubbed release. Buyers can then purchase it automatically.</p>${traces.length?`<label for="thot-trace">Your item</label><select id="thot-trace">${traces.map(t=>`<option value="${escape(t.trace_id)}">${escape(traceTitle(t))}</option>`).join('')}</select>${capabilities().trade_evidence===true?button('trade-evidence-begin','Add trade proof'):''}${button('list-configure','Set listing terms')}`:`<p>Save an item in your private library first.</p>${nav('vault','Open your data →')}`}</section>${own.length?`<h3>Your active listings</h3><section class="thot-listings">${own.map(listingCard).join('')}</section>`:''}${sales.length?`<details class="technical-details"><summary>Your sale receipts (${sales.length})</summary><section class="cards">${sales.map(orderCard).join('')}</section></details>`:''}</details>`:''}${contractDetails()}`;
 }
 function earningsHTML({updatedAt,error=false}={}){
  if(!active())return '';
  const w=state.thot,a=w.account;
  const fresh=error?'Could not refresh. Showing the last saved results.':updatedAt?`Updated ${updatedAt.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',second:'2-digit'})}`:'Waiting for a first update';
  const top=heading('Earnings','What your work has earned.',`Track payments from your item sales. Undisputed proceeds are sent after ${disputeDuration()} from recorded delivery.`);
  if(!w.wallet||!a)return top+walletPrompt()+`<section class="panel"><h2>Your first sale starts with an item.</h2><p>Holding THOT does not generate income. A buyer needs to purchase an item you choose to contribute.</p>${nav('market','Explore offers →')}</section>`;
  const sales=(w.orders??[]).filter(o=>sameWallet(o.seller,w.wallet)&&o.receipt.status>0);
  const total=states=>sales.filter(o=>states.includes(o.receipt.status)).reduce((sum,o)=>sum+BigInt(o.receipt.seller_amount),0n);
  const awaiting=total([1]),pending=total([2,3,4]),finalized=total([5]);
  const saleCards=sales.map(o=>{
   const r=o.receipt,refunded=r.status===6,paid=r.status===5&&/^0x[0-9a-f]{64}$/i.test(o.payout_transaction??'');
   const label=paid?'Paid to your wallet':['','Offer · not yet accepted','Accepted · awaiting delivery','Delivered · pending finalization','Disputed · payment held','Finalized sale','Refunded · no sale proceeds'][r.status];
   return `<article class="panel earning-card"><span class="pill">${label}</span><h3>${escape(o.title)}</h3><div class="money-breakdown"><strong>${escape(fmt(refunded?0:r.seller_amount))}</strong><p>${refunded?'The buyer was refunded.':r.status===1?'Your share if you accept and the sale completes.':r.status===5?(paid?'Sent to your linked wallet by the settlement worker.':'Finalized allocation; it may already have been claimed.'):'Your allocated share, pending completion.'}</p></div><p>${r.treasury?'Treasury-sponsored purchase':'External buyer purchase'} · gross ${escape(fmt(o.gross))} · seller proceeds ${escape(fmt(refunded?0:r.seller_amount))}</p>${settlementHTML(r)}${r.status===3?settlementActions(o):''}${r.status<5?nav('market','Manage in Offers →'):''}${paid?`<details><summary>Wallet payment batch</summary><p class="mono">${escape(o.payout_transaction)}</p>${explorerLink('tx',o.payout_transaction)}<p>This transaction pays your then-claimable balance, which may include other finalized proceeds.</p></details>`:''}<details><summary>Purchase receipt</summary><p class="mono">${escape(o.id)}</p></details></article>`;
  }).join('');
  return top+`<div class="earnings-status"><p id="earnings-freshness" role="status">${escape(fresh)} · Refreshes every minute while visible.</p></div>
   <section class="metrics" aria-label="Your THOT payment summary"><article class="metric"><small>PENDING SALE PROCEEDS</small><strong>${escape(fmt(pending))}</strong><p>Accepted sales awaiting delivery, dispute resolution or finalization.</p></article><article class="metric highlight"><small>AVAILABLE TO CLAIM</small><strong>${escape(fmt(a.claimable))}</strong><p>All claimable contract funds, including any referrals or buyer refunds.</p>${BigInt(a.claimable)>0n?button('claim','Claim tokens'):'<p>No tokens are claimable yet.</p>'}</article><article class="metric"><small>FINALIZED SALES · RECENT RECORDS</small><strong>${escape(fmt(finalized))}</strong><p>Your finalized seller allocations, including any already claimed. Not a lifetime total.</p></article></section>
   ${awaiting>0n?`<section class="panel"><h2>Offers awaiting your decision</h2><p>${escape(fmt(awaiting))} offered as your share. Not included in pending or finalized earnings.</p>${nav('market','Review offers →')}</section>`:''}
   <div class="content-grid"><section><div class="section-head"><h2>Your sale receipts</h2></div>${saleCards||`<section class="panel"><h3>No paid item sales yet.</h3><p>Authorize research you choose to share. Matching purchases execute automatically.</p>${nav('market','Open offers →')}</section>`}<p class="legal-note">${w.orders_truncated?'Showing the latest 50 purchase records; earlier sales are not included in these receipt totals.':'Receipt totals cover the purchase records available in this workspace.'} The claimable balance comes directly from the contract.</p></section></div><details class="technical-details"><summary>How payouts work</summary><p>You authorize a sale when listing. A buyer pays, and the service records delivery of the licensed item. After the ${disputeWindow()}, the worker finalizes the sale and sends proceeds to your linked wallet. Disputed payments wait for resolution; you can also claim finalized funds yourself.</p><p>Your wallet balance includes tokens you bought or received elsewhere. Existing principal-only locks are separate from sale income and the funded staking pools. They do not earn the proposed staking reward.</p>${nav('thot','Manage your lock →')}</details><details class="technical-details"><summary>Price estimates</summary>${valuationsHTML()}</details>${contractDetails()}`;
 }
 function lockLotHTML(l,a){
  const now=Number(a.block?.timestamp??0),unlockAt=Number(l.unlock_at),mature=now>=unlockAt;
  return `<div class="thot-lock-lot"><p><strong>${escape(fmt(l.amount))}</strong><br>Unlocks ${escape(date(unlockAt))}</p><p>${mature?'Principal is ready to withdraw.':'Existing principal remains locked until its agreed date. It does not improve the current purchase or sale tariff.'}</p>${mature?button('withdraw','Withdraw matured principal',String(l.id)):''}</div>`;
 }
 function tokenHTML(){
  if(!active())return '';
  const w=state.thot,a=w.account,e=a?.economics,feeCopy=feePolicyCopy(e,w.holder_rewards);
  return heading('THOT','Put time behind your THOT.','Explore the staking menu, then manage your marketplace balances and existing locks.')+renderLiveStaking(w.staking,escape)+holderBenefitsHTML()+
   (!w.wallet||!a?walletPrompt():`<section class="metrics"><article class="metric"><small>WALLET BALANCE</small><strong>${escape(fmt(a.balance))}</strong><p class="mono">${escape(w.wallet)}</p></article><article class="metric"><small>AVAILABLE TO CLAIM</small><strong>${escape(fmt(a.claimable))}</strong><p>Completed sales, eligible referrals and refunds available in the contract.</p>${BigInt(a.claimable??0)>0n?button('claim','Claim tokens'):''}</article><article class="metric highlight"><small>SERVICE FEE PER PURCHASE</small><strong>${escape(feeCopy.label)}</strong><p>The funding quote fixes your payment and seller proceeds.</p></article></section>`)+
   `<section class="panel"><h2>A price you can check.</h2><p>${escape(feeCopy.summary)}</p><p>${escape(feeCopy.details)}</p>${e?.policy_hash?`<details><summary>Current tariff policy</summary><code>${escape(e.policy_hash)}</code></details>`:''}</section>
   ${w.wallet&&a?`<section class="content-grid"><div class="panel"><h2>Your referrer</h2><p>Register who introduced you before your first accepted sale. A qualifying independent buyer must fund a reviewed purchase of your item within 90 days of registration. The reward window then lasts 365 days from that first qualifying funded purchase.</p><label for="thot-referrer">Your referrer’s wallet</label><input id="thot-referrer" type="text" placeholder="0x…">${button('refer','Review attribution')}<p>The direct referrer receives 20% of positive net contribution after direct cost, before holder discounts. Treasury purchases, self-referrals, refunds and unreviewed transactions do not count.</p>${nav('referrals','Open referral dashboard →')}</div><div class="panel"><h2>Existing locked principal</h2><p>Old locks stay in their custody contract until maturity. These principal-only positions retain their original terms. The new staking pools do not change those positions.</p>${(a.lots??[]).filter(l=>BigInt(l.amount)>0n).map(l=>lockLotHTML(l,a)).join('')||'<p>No locked principal.</p>'}</div></section>`:''}
   <section class="thot-details"><div><h2>Buy useful research.</h2><p>Filter the available metadata and proofs, review the exact total, then purchase. The licensed conversation is delivered after funding.</p>${nav('market','Browse data →')}</div><div><h2>Follow your actual proceeds.</h2><p>Estimated item value, token holdings and funded sale proceeds are separate. Your earnings page tracks the sales that complete.</p>${state.role==='user'?nav('earnings','View earnings →'):nav('market','View purchases →')}<a href="/whitepaper">Read the whitepaper</a></div></section>${contractDetails()}`;
 }
 function valuationsHTML(){
  if(!active()||state.role!=='user')return '';
  const rows=state.thot.valuations??[];
  const comparable=(group,label)=>group?.status==='estimated'?`<p><strong>${escape(label)}: ${escape(fmt(group.median_gross_atoms))}</strong><br>Middle range ${escape(fmt(group.p25_gross_atoms))}–${escape(fmt(group.p75_gross_atoms))}. ${escape(group.sample_count)} sales from ${escape(group.distinct_contributors)} contributors.</p>`:`<p>${escape(label)}: not enough comparable sales yet.</p>`;
  return `<section class="panel thot-valuations"><p class="eyebrow">ESTIMATED · NOT A BALANCE</p><h2>What similar data sold for.</h2><p>See a possible gross licence price before your item sells. We compare workflow, provenance and conversation length across completed sales in the past 90 days, with at least three other contributors. This does not predict whether your item will sell.</p>${rows.map(({trace_id,estimate:e})=>`<article class="thot-valuation"><h3>${escape((state.traces??[]).find(t=>t.trace_id===trace_id)?.title??'Your research item')}</h3>${e.status==='ineligible'?'<p>A linked wallet and eligible item metadata are needed to compare this item.</p>':comparable(e.independent,'Independent buyers')+comparable(e.sponsored,'Treasury-sponsored samples')}<details><summary>Estimate basis</summary><pre class="json-view">${json({cohort:e.cohort,window:e.window,basis:e.basis})}</pre></details></article>`).join('')||'<p>Add data and link your wallet to begin. Estimates appear as eligible sales build up.</p>'}<p class="legal-note">Prices are in THOT, before your seller share. An estimate is neither a funded offer nor money you can withdraw. Treasury purchases are reported separately from independent demand.</p></section>`;
 }
 const operationLabels={
  queueBuyer:'Schedule buyer permission',executeBuyer:'Apply buyer permission',setBuyer:'Update buyer permission',
  queueCampaign:'Schedule campaign activation',executeCampaign:'Activate campaign',
  queueOperator:'Schedule operator replacement',executeOperator:'Apply operator replacement',
  queueTariff:'Schedule service tariff',executeTariff:'Apply service tariff',
  queueSuccessor:'Schedule successor reserve',executeSuccessor:'Transfer to successor reserve',
  queueUnpause:'Schedule purchase resumption',unpause:'Resume purchases',pause:'Pause new purchases',
  cancelGovernance:'Cancel queued authorization',setServiceFeeBps:'Update marketplace fee',
  createCampaign:'Create acquisition campaign',pauseCampaign:'Pause campaign',
  resumeCampaign:'Resume campaign',cancelCampaign:'Cancel unused campaign budget',
 };
 const operationLabel=action=>Object.hasOwn(operationLabels,action)?operationLabels[action]:action;
 function operationStatus(o,threshold){
  if(o.executed){
   if(o.action?.startsWith('queue')&&o.timelock?.executable_at)return o.timelock.ready?'Queue delay elapsed':'Queue delay pending';
   return 'Executed';
  }
  if(o.confirmations<threshold)return 'Awaiting approvals';
  if(o.executable===true)return 'Ready to execute';
  return o.executable===false?'Execution unavailable':'Approval threshold reached';
 }
 function governanceHTML(g){
  if(!g?.owner)return '';
  const delay=Number(g.delay_seconds??86400),marketDelay=Number(g.market_delay_seconds??604800),now=Number(g.block.timestamp),defaultStart=new Date((now+delay+600)*1000),local=new Date(defaultStart-defaultStart.getTimezoneOffset()*60000).toISOString().slice(0,16);
  const details=o=>`<p>Target <code>${escape(o.target)}</code></p><p>Arguments <code>${escape(JSON.stringify(o.args??[]))}</code></p>${o.timelock?.executable_at?`<p>Queue matures ${escape(date(o.timelock.executable_at))} · ${o.timelock.ready?'Ready':'Waiting for the confirmed chain clock'}</p>`:''}`;
  const next=o=>!o.executed||!o.timelock?.executable_at?'':o.action==='queueCampaign'?button('gov-activate-proposal','Apply campaign activation',o.id):o.action==='queueBuyer'?button('gov-buyer-proposal','Apply buyer permission',o.id):['queueOperator','queueTariff','queueSuccessor','queueUnpause'].includes(o.action)?button('gov-apply-proposal','Apply queued change',o.id):'';
  const targetSelect=(id)=>`<label for="${id}">Contract</label><select id="${id}">${concurrentCampaigns()?'':'<option value="reserve">Reserve vault</option>'}<option value="market">Purchase market</option></select>`;
  return `<section class="thot-governance" aria-label="Reserve governance"><section class="panel"><h2>Reserve governance · ${g.threshold} of ${g.owners.length}</h2><p>${g.threshold===1?'Any one listed owner can record and execute a change.':'Each change requires '+g.threshold+' matching owner approvals.'}${concurrentCampaigns()?' Campaign spending remains limited by each approved budget.':' Reserve queue delay: '+escape(delay)+' seconds. Market queue delay: '+escape(marketDelay)+' seconds. Purchase, response and dispute clocks remain separate.'}</p>${concurrentCampaigns()?'':`${g.threshold===1&&delay===0&&!g.campaign_start_at?button('gov-start_campaign',production()?'Activate campaign now':'Activate testnet campaign now'):''}<details><summary>Schedule a campaign start</summary><label for="thot-campaign-start">Campaign start · your local time</label><input id="thot-campaign-start" type="datetime-local" value="${escape(local)}">${button('gov-queue_campaign','Review campaign schedule')}<p>Choose enough time for approvals and the delay. Late activation keeps the original schedule and loses elapsed daily allowance.</p></details>`}<details><summary>Owners and controller</summary><p><code>${escape(g.address)}</code></p>${g.owners.map(a=>`<p><code>${escape(a)}</code></p>`).join('')}</details></section>
  <section class="thot-governance-queue" aria-labelledby="thot-proposals-title"><div class="section-head"><h2 id="thot-proposals-title">Recent governance operations</h2><p>Review approvals and confirmed chain state before executing.</p></div><div class="thot-operation-list">${g.operations.slice().reverse().map(o=>`<article class="thot-operation"><div class="thot-operation-heading"><h3>${escape(operationLabel(o.action))}</h3><span class="pill">${escape(operationStatus(o,g.threshold))}</span></div><p>${o.confirmations} / ${g.threshold} approvals${o.approved_by_you?' · Includes your approval':''}</p>${details(o)}${o.campaign?`<p>Campaign start: ${o.campaign.start_at===0?'Activation block':escape(date(o.campaign.start_at))}.</p>`:''}${!o.executed&&!o.approved_by_you?button('gov-confirm','Approve operation',o.id):''}${!o.executed&&o.approved_by_you?button('gov-revoke','Withdraw approval',o.id):''}${!o.executed&&o.confirmations>=g.threshold?button('gov-execute','Execute approved operation',o.id,o.executable===false):''}${next(o)}${o.executed&&o.timelock?.executable_at?button('gov-cancel-proposal','Cancel this queued authorization',o.id):''}<details><summary>Exact operation</summary><p><code>${escape(o.id)}</code></p><pre class="json-view">${json({target:o.target,calldata:o.data??null,arguments:o.args??[],queue_hash:o.timelock?.operation_hash})}</pre></details></article>`).join('')||'<p class="thot-empty">No governance operations recorded. Review a change below to prepare its exact wallet transactions.</p>'}</div>${Number(g.operation_count??0)>20?'<p>Showing the latest 20 proposals. Older proposals remain onchain.</p>':''}</section>
  <div class="section-head"><h2>Manage governance</h2><p>Changes open a review before any wallet transaction.</p></div>
  <section class="content-grid"><div class="panel"><h2>Reserve buyer permissions</h2><p>Grant or remove permission to inspect the existing contributor-authorized sample and buy within the shared campaign caps. This does not change the three governor owners or dispute reviewers.</p><label for="thot-reserve-buyer">Buyer’s EVM wallet</label><input id="thot-reserve-buyer" type="text" placeholder="0x…"><label for="thot-reserve-buyer-allowed">Permission after execution</label><select id="thot-reserve-buyer-allowed"><option value="true">Authorize inspection and purchases</option><option value="false">Revoke inspection and new purchases</option></select>${button('gov-queue_buyer',concurrentCampaigns()?'Review buyer permissions':'Review buyer-permission queue')}<details><summary>Owner and recent proposal wallets</summary><p>${escape(g.buyer_list_scope??'Addresses observed in current proposals; not an exhaustive registry.')}</p>${(g.buyers??[]).map(b=>`<p><code>${escape(b.address)}</code> · ${b.authorized?'Authorized':'Not authorized'}</p>`).join('')}</details></div><div class="panel"><h2>Pause new purchases</h2><p>Reserve: <strong>${g.paused===true?'Paused':g.paused===false?'Not paused':'Unknown'}</strong>. Market: <strong>${g.market_paused===true?'Paused':g.market_paused===false?'Not paused':'Unknown'}</strong>. Existing delivery, disputes and payouts continue.</p>${g.paused?button('gov-queueUnpause',concurrentCampaigns()?'Resume reserve purchases':'Review reserve unpause queue'):button('gov-pause','Review immediate reserve pause')}${g.market_paused?button('gov-market-unpause','Review market unpause queue'):button('gov-market-pause','Review market pause')}</div></section>
  <details class="thot-governance-settings"><summary>Advanced settings <span>Operators, fees, queue cancellation and successor reserve</span></summary>
  <section class="content-grid"><div class="panel"><h2>Settlement operator</h2><p>Replace a dedicated worker address on each contract. Stage the replacement signer and chain configuration before applying both changes; mismatches pause settlement until they agree. A governance owner cannot be the worker.</p><label for="thot-operator-target">Contract</label><select id="thot-operator-target">${g.threshold===1&&delay===0&&marketDelay===0?'<option value="both">Both contracts · complete replacement</option>':''}<option value="reserve">Reserve vault</option><option value="market">Purchase market</option></select><label for="thot-next-operator">New dedicated EVM address</label><input id="thot-next-operator" placeholder="0x…">${button('gov-queue_operator','Review operator replacement')}<details><summary>Current operators</summary><p>Reserve <code>${escape(g.operator??'Unavailable')}</code></p><p>Market <code>${escape(g.market_operator??'Unavailable')}</code></p></details></div><div class="panel"><h2>Cancel a queued change</h2><p>Cancel a contract’s queued authorization using its exact operation hash. This does not erase governor proposals or undo an executed change.</p>${targetSelect('thot-cancel-target')}<label for="thot-cancel-hash">Queued authorization hash</label><input id="thot-cancel-hash" placeholder="0x…">${button('gov-cancel_queue','Review queue cancellation')}</div></section>
  ${g.percentage_fees?`<section class="panel"><h2>Marketplace fee</h2><p>Changes apply to future purchases. Funded receipts keep their exact amounts.</p><label for="thot-service-fee">Fee · percent of the price</label><input id="thot-service-fee" type="number" min="0.01" max="10" step="0.01" value="${Number(g.tariff?.allocated_overhead_atoms??100)/100}">${button('gov-set_service_fee','Review future fee')}</section>`:g.tariff?`<section class="panel"><h2>Item service tariff</h2><p>These are fixed THOT costs per new purchase. The service fee is direct cost plus 1.5 times allocated overhead, rounded up. Funded purchases keep their original fee and seller allocation. This sets the escrow tariff; separately funded holder cashback can reduce the effective fee after settlement.</p><div class="thot-filters"><div><label for="thot-tariff-direct">Direct cost · THOT</label><input id="thot-tariff-direct" inputmode="decimal" value="${escape(inputDecimal(g.tariff.direct_cost_atoms))}"></div><div><label for="thot-tariff-overhead">Allocated overhead · THOT</label><input id="thot-tariff-overhead" inputmode="decimal" value="${escape(inputDecimal(g.tariff.allocated_overhead_atoms))}"></div></div><label for="thot-tariff-policy">Published cost policy hash</label><input id="thot-tariff-policy" placeholder="0x…">${button('gov-queue_tariff','Review tariff queue')}<p>Current policy <code>${escape(g.tariff.policy_hash)}</code></p></section>`:''}
  ${concurrentCampaigns()?'':`<section class="panel"><h2>Successor reserve</h2><p>Move remaining inventory to a deployed vault using the same token after this campaign’s sunset. This cannot withdraw into an owner wallet or bypass the campaign duration.</p><p>${g.campaign_sunset_at?'Transfer opens '+escape(date(g.campaign_sunset_at))+'.':'Start the campaign before scheduling a successor.'}</p><label for="thot-successor">Successor vault contract</label><input id="thot-successor" placeholder="0x…"><label for="thot-successor-amount">Inventory · THOT</label><input id="thot-successor-amount" inputmode="decimal" placeholder="1000000"><label for="thot-successor-policy">Published successor policy hash</label><input id="thot-successor-policy" placeholder="0x…">${button('gov-queue_successor','Review successor queue','',!g.campaign_start_at)}</section>`}
</details></section>`;
 }
 function purchaseReviewHTML(prepared,reserve){
  return `<section class="checkout-summary" aria-label="Payment summary"><div><small>${reserve?'Funding source':'Available balance'}</small><strong>${reserve?'Campaign reserve':state.thot?.account?.balance!=null?escape(fmt(state.thot.account.balance)):'Balance unavailable — refresh'}</strong></div><div><small>Total payment</small><strong>${escape(fmt(prepared.buyer_total))}</strong></div></section><details><summary>Price breakdown and payment terms</summary><p><strong>Total escrow: ${escape(fmt(prepared.buyer_total))}</strong>.</p>${prepared.economics?`<p>Quoted service fee: ${escape(fmt(prepared.economics.service_fee))}. Seller proceeds: ${escape(fmt(prepared.economics.seller_amount))}. These amounts are fixed at funding.</p>`:''}<p>${reserve?'The reserve supplies THOT; your wallet pays gas. Campaign limits apply.':'Your approval and purchase are capped at this exact total. Applicable holder or locker discounts are already included in the escrow payment and seller proceeds shown here.'}</p></details>`;
 }
 function showCampaignSelection(){
  const w=state.thotSampling,rows=w?.paused?[]:campaignRows().filter(campaignAvailable);
  openDialog('Choose the paying campaign','The contributor’s asking price stays unchanged.',`<p>Your wallet pays gas. The selected campaign supplies the THOT and records the purchase against its own budget.</p>${rows.length?`<label for="thot-buy-campaign">Active campaign</label><select id="thot-buy-campaign"><option value="">Choose a campaign</option>${rows.map(c=>`<option value="${escape(c.id)}">Campaign ${escape(c.id)} · ${escape(fmt(c.available_atoms))} available</option>`).join('')}</select>`:'<p>No loaded campaign has spending available.</p>'}${w?.next_campaign_cursor?button('reserve-campaigns-more','Load more campaigns',w.next_campaign_cursor):''}`,button('reserve-buy-confirm','Review exact purchase','',!rows.length));
 }
 function campaignCreationHTML(w){
  if(!w.governance?.owner)return '';
  return `<section class="panel"><h2>Create an acquisition campaign</h2><p>Set aside a budget to buy useful data. Several campaigns can run at once. Tokens stay in the reserve until a buyer signs a purchase.</p>${w.market_bound===false?`<p>Connect the reserve to this deployment’s purchase market before creating a campaign.</p>${button('gov-bind_market','Review market connection')}`:''}<div class="thot-filters"><div><label for="thot-campaign-budget">Total budget · THOT</label><input id="thot-campaign-budget" inputmode="decimal" value="50000000"></div><div><label for="thot-campaign-days">Duration · days</label><input id="thot-campaign-days" type="number" min="1" max="365" value="90"></div><div><label for="thot-campaign-upfront">Available at the start · THOT</label><input id="thot-campaign-upfront" inputmode="decimal" value="555555.555555555555555555"></div></div><label for="thot-campaign-purpose">What should this campaign buy?</label><textarea id="thot-campaign-purpose" minlength="10" maxlength="240" rows="3" placeholder="For example: market-making research on inventory, hedging and liquidity"></textarea><details><summary>Schedule a future start</summary><label for="thot-new-campaign-start">Start time · your local time</label><input id="thot-new-campaign-start" type="datetime-local"><p>Leave blank to start when the approval transaction executes.</p></details><p>The remaining budget becomes available evenly over the campaign. Unspent allowance carries forward until it ends. You choose which data to buy within the available budget.</p>${button('gov-create_campaign','Review campaign','',w.market_bound===false)}<p>${w.governance.threshold===1?'Any one governance owner can approve it immediately.':'The governance threshold applies.'} This approves a spending ceiling; it does not commit to buying every item.</p></section>`;
 }
 function stakingBudgetHTML(w){
  if(!w.shared_treasury||!w.governance?.owner)return '';
  return `<section class="panel"><h2>Fund a staking offer</h2><p>Use the same treasury balance for a new staking offer. Existing deposits keep their original rewards and unlock dates.</p><label for="thot-stake-budget">Reward budget · THOT</label><input id="thot-stake-budget" value="30000000"><label for="thot-stake-cap">Maximum deposits · THOT</label><input id="thot-stake-cap" value="100000000"><label for="thot-stake-enrollment">Accept new deposits for · days</label><input id="thot-stake-enrollment" type="number" value="90" min="1" max="365"><p>Enrollment opens 15 minutes after the quote’s chain time. Sign before then or refresh the quote.</p>${[[30,5],[60,12],[90,30]].map(([days,reward],i)=>`<div class="thot-filters"><label>Lock days<input id="thot-stake-days-${i}" type="number" min="1" max="730" value="${days}"></label><label>Total reward · %<input id="thot-stake-rate-${i}" type="number" min="0.01" max="100" step="0.01" value="${reward}"></label></div>`).join('')}${button('gov-create_staking_campaign','Review funded staking offer')}<hr><h3>Manage an existing staking offer</h3><p>Use the campaign ID shown on the staking page. Closing enrollment returns only unused rewards to this treasury; existing deposits remain claimable at maturity.</p><label for="thot-stake-campaign-id">Staking campaign ID</label><input id="thot-stake-campaign-id" inputmode="numeric">${button('gov-pause_staking_campaign','Pause new deposits')}${button('gov-resume_staking_campaign','Resume deposits')}${button('gov-close_staking_campaign','Close & return unused rewards')}${button('gov-collect_staking_budget','Collect already released rewards')}</section>`;
 }
 function campaignCardHTML(c,w){
  const open=!c.closed&&!['cancelled','ended'].includes(c.status),owner=w.governance?.owner;
  const controls=owner&&open?`${button(c.paused?'gov-resume_campaign':'gov-pause_campaign',c.paused?'Resume campaign':'Pause campaign',c.id)}${button('gov-cancel_campaign','Cancel unused budget',c.id)}`:owner&&!c.closed&&c.status==='ended'?button('gov-expire_campaign','Release unused budget',c.id):'';
  return `<article class="panel"><span class="pill">${escape(c.status)}</span><h3>Campaign ${escape(c.id)}</h3>${c.policy_name?`<p>${escape(c.policy_name)}</p>`:''}<p>Budget <strong>${escape(fmt(c.budget_atoms))}</strong><br>Purchased ${escape(fmt(c.committed_atoms))}<br>Available now <strong>${escape(fmt(c.available_atoms))}</strong></p><p>Starts ${escape(date(c.start_at))}<br>Ends ${escape(date(c.end_at))}</p>${controls}<details><summary>Campaign policy</summary><p>Available at start ${escape(fmt(c.upfront_atoms))}. The remaining budget unlocks evenly; unused allowance carries forward until the end.</p><code>${escape(c.policy_hash)}</code></details></article>`;
 }
 const treasuryAmount=value=>`<span class="thot-metric-number">${escape(fmt(value).replace(' THOT','').replace(/\.0000$/,''))}</span><span class="thot-metric-unit">THOT</span>`;
 function concurrentReserveHTML(w){
  const blocked=samplingBlocked(),traces=(w.samples??[]).filter(l=>!sameWallet(l.seller,w.wallet));
  return heading('Treasury','Choose the research. Fund the purchase.','Create separate campaign budgets, inspect selected data, and choose which campaign pays.')+
   `<section class="metrics"><article class="metric"><small>RESERVE INVENTORY</small><strong>${treasuryAmount(w.inventory_atoms)}</strong></article><article class="metric"><small>UNALLOCATED</small><strong>${treasuryAmount(w.unallocated_atoms)}</strong><p>Available for new campaigns.</p></article><article class="metric"><small>COMMITTED PURCHASES</small><strong>${treasuryAmount(w.total_gross_committed_atoms)}</strong></article></section>
   ${campaignCreationHTML(w)}${stakingBudgetHTML(w)}<section><div class="section-head"><h2>Acquisition campaigns</h2><p>${w.paused?'All new reserve purchases are paused.':'Choose an active campaign when buying an item.'} Unspent budgets stay in the reserve.</p></div><div class="cards">${(w.campaigns??[]).map(c=>campaignCardHTML(c,w)).join('')||'<div class="panel"><p>No campaigns yet.</p></div>'}</div>${w.next_campaign_cursor?button('campaigns-more','Load more campaigns',w.next_campaign_cursor):''}</section>
   <section class="panel"><h2>Inspect the selected release</h2><p>Authorized reviewers see the same complete release from each stable group of 20 contributor opt-ins. Refreshing does not draw another sample. The contributor sets the asking price; choosing a campaign does not change it.</p><p>Reserve <code>${escape(w.capabilities.reserve)}</code></p></section>
   <section class="cards">${traces.map(l=>`<article class="panel"><h3>${escape(l.title)}</h3>${l.content_kind==='research'?'<p>Imported research package · unverified source declarations.</p>':modelHTML(l.capture_model)}<strong>${escape(fmt(l.price_atoms))}</strong><p>${l.content_kind==='research'?`${escape(l.file_count)} files`:`${escape(l.turn_count)} turns`} · inferred category ${escape(l.workflow)}</p>${w.reserve_buyer?button('buyer-sample','Inspect selected complete release',l.id)+button('reserve-buy','Buy using reserve',l.id,!!blocked):''}</article>`).join('')||'<div class="panel"><p>No eligible reserve samples yet.</p></div>'}</section>${blocked?`<p role="status">${escape(blocked)}</p>`:''}
   <h2>Reserve purchases</h2><section class="cards">${(w.jobs??[]).map(j=>`<article class="panel"><h3>${escape(j.title)}</h3><p>${escape(fmt(j.gross))} · ${escape(status[j.receipt?.status]??j.status)}</p>${j.campaign_id?`<p>Campaign ${escape(j.campaign_id)}</p>`:''}${j.resume_available?button('reserve-resume','Resume purchase',j.id):''}${[2,3,4,5].includes(j.receipt?.status)?button('delivery','Open purchase',j.id):''}${j.receipt?settlementHTML(j.receipt):''}</article>`).join('')}</section>${governanceHTML(w.governance)}${disputesHTML()}`;
 }
 function manualReserveHTML(w){
  const r=w.reserve,blocked=samplingBlocked();
  const traces=(w.samples??[]).filter(l=>!sameWallet(l.seller,w.wallet));
  return heading('Treasury','Inspect first. Buy from the reserve.','Your wallet selects the research. The vault enforces the shared spending limits.')+
   `<section class="metrics"><article class="metric"><small>RESERVE INVENTORY</small><strong>${escape(fmt(r.balance))}</strong></article><article class="metric"><small>AVAILABLE NOW</small><strong>${escape(fmt(r.allowance))}</strong><p>${escape(blocked||'Unused allowance stays in the vault.')}</p></article><article class="metric"><small>COMMITTED</small><strong>${escape(fmt(r.committed))}</strong></article></section>
   <section class="panel"><h2>Authorized reviewers. One persistent draw.</h2><p>All authorized reserve wallets inspect the same complete release selected from each stable group of 20 unique contributor opt-ins. Refreshes, relists and reviewer changes do not redraw it. Your wallet pays gas only if you choose to buy; the reserve pays THOT into escrow.</p><p>Reserve <code>${escape(w.capabilities.reserve)}</code></p></section>
   ${governanceHTML(w.governance)}<section class="cards">${traces.map(l=>`<article class="panel"><h3>${escape(l.title)}</h3>${l.content_kind==='research'?'<p>Imported research package · unverified source declarations.</p>':modelHTML(l.capture_model)}<strong>${escape(fmt(l.price_atoms))}</strong><p>${l.content_kind==='research'?`${escape(l.file_count)} files`:`${escape(l.turn_count)} turns`} · inferred category ${escape(l.workflow)}</p>${button('buyer-sample','Inspect selected complete release',l.id)}${button('reserve-buy','Buy using reserve',l.id,!!blocked||!w.reserve_buyer)}</article>`).join('')||'<div class="panel"><p>No complete one-in-20 contributor group has produced a reserve sample yet.</p></div>'}</section>
   <h2>Reserve purchases</h2><section class="cards">${(w.jobs??[]).map(j=>`<article class="panel"><h3>${escape(j.title)}</h3><p>${escape(fmt(j.gross))} · ${escape(status[j.receipt?.status]??j.status)}</p>${j.resume_available?button('reserve-resume','Resume purchase',j.id):''}${[2,3,4,5].includes(j.receipt?.status)?button('delivery','Open purchase',j.id):''}${j.receipt?settlementHTML(j.receipt):''}</article>`).join('')}</section>${disputesHTML()}`;
 }
 function samplingHTML(){
  const w=state.thotSampling;if(!(state.role==='operator_security'||w?.reserve_buyer||w?.governance?.owner)||!supported(w?.capabilities?.mode))return '';
  if(concurrentCampaigns())return concurrentReserveHTML(w);
  if(w.capabilities.manual_reserve)return manualReserveHTML(w);
  const r=w.reserve,blocked=samplingBlocked(),reserveAddress=capabilities().reserve;
  const amount=value=>`<span class="thot-metric-number">${escape(fmt(value).replace(' THOT','').replace(/\.0000$/,''))}</span><span class="thot-metric-unit">THOT</span>`;
  return heading('Treasury','Buy a sample. Learn what it is worth.','Set the scope and spending limit. The reserve worker buys authorized samples and handles delivery and settlement.')+
   `<section class="metrics"><article class="metric"><small>RESERVE INVENTORY</small><strong>${amount(r.balance)}</strong><p>Actual confirmed contract balance. Inventory is not all available to spend.</p></article><article class="metric highlight"><small>AVAILABLE TO SPEND NOW</small><strong>${amount(r.allowance)}</strong><p>${escape(blocked||'Subject to daily and independent-demand limits.')}</p></article><article class="metric"><small>GROSS COMMITTED</small><strong>${amount(r.committed)}</strong><p>Includes earlier paid acquisitions.</p></article></section>
   <section class="panel"><h2>The reserve pays; the worker executes.</h2><p>Your batch approval sets the workflow, number of items and maximum price. The campaign is the contract’s overall spending schedule, activated separately by its governor. The offchain worker signs only restricted purchase, delivery and settlement calls. The reserve contract enforces its remaining allowance.</p>${reserveAddress?`<p>Reserve <code>${escape(reserveAddress)}</code> ${explorerLink('address',reserveAddress)}</p>`:'<p>Reserve address is not available in this workspace.</p>'}${blocked?`<p role="status">${escape(blocked)} Queuing is disabled until the campaign has an available allowance.</p>`:''}</section>
   <section class="panel"><h2>Choose the next paid sample</h2><p>Only persisted one-in-20 selections can enter this queue. Queueing never draws another release; identical content cannot repeatedly collect the subsidy. Inspect the selected release before deciding whether the reserve should buy it.</p><div class="thot-filters"><div><label for="thot-sample-count">Maximum data (1–20)</label><input id="thot-sample-count" type="number" min="1" max="20" value="5"></div><div><label for="thot-sample-budget">Total budget · THOT</label><input id="thot-sample-budget" inputmode="decimal" value="5000"></div><div><label for="thot-sample-price">Maximum price per item · THOT</label><input id="thot-sample-price" inputmode="decimal" value="1000"></div><div><label for="thot-sample-workflow">Workflow</label><select id="thot-sample-workflow"><option value="">All workflows</option><option value="coding">Coding</option><option value="research">Research</option><option value="investment_research">Investment research</option><option value="contract_review">Contract review</option></select></div></div>${button('sample-preview','Review sampling budget','',Boolean(blocked))}</section>
   <section><div class="section-head"><h2>Purchased samples & queued work</h2></div><div class="cards">${(w.jobs??[]).map(j=>`<article class="panel"><span class="pill">${escape(j.receipt?.status?status[j.receipt.status]:j.status)}</span><h3>${escape(j.title)}</h3><p>${escape(fmt(j.gross))} gross · seller ${escape(fmt(j.receipt?.seller_amount??0))}</p>${[2,3,4,5].includes(j.receipt?.status)?button('delivery','Read paid sample',j.id):''}${j.receipt?settlementHTML(j.receipt):''}${j.error?`<p role="status">Needs attention: ${escape(j.error)}</p>`:''}<details><summary>Purchase reference</summary><p class="mono">${escape(j.id)}</p></details></article>`).join('')||'<div class="panel"><p>No sampling purchases yet. Contributors must first enable automatic sales and opt into treasury sampling.</p></div>'}</div></section>
   <details class="technical-details"><summary>Sampling policies & selection receipts</summary><pre class="json-view">${json(w.batches??[])}</pre></details><p class="legal-note">The worker pays undisputed proceeds ${disputeDuration()} after recorded delivery. A sample purchase is a treasury-funded price observation, not evidence of independent buyer demand.</p>${disputesHTML()}`;
 }
 function samplingBlocked(){
  if(concurrentCampaigns()){
   const w=state.thotSampling;if(!w)return 'Campaign state is unavailable.';
   if(w.paused)return 'Reserve purchases are paused.';
   if(w.market_bound===false)return 'Connect the reserve to its purchase market first.';
   if(!campaignRows().some(campaignAvailable))return 'No loaded campaign has spending available. Refresh or load more campaigns.';
   return '';
  }
  const r=state.thotSampling?.reserve;if(!r)return 'Campaign state is unavailable.';
  if(r.paused)return 'Campaign paused.';
  if(Number(r.start_at)>Number(r.block?.timestamp??0))return `Campaign has not started. Starts ${date(r.start_at)}.`;
  if(BigInt(r.allowance??0)<=0n)return 'No spending allowance is available.';
  return '';
 }
 function disputesHTML(offerId=null,showActions=true){
  if(state.role!=='operator_security'&&!state.thot?.account?.dispute_reviewer)return '';
  const inbox=state.thotDisputes;
  if(!inbox)return '<section class="panel"><h2>DAO dispute review</h2><p>Dispute state has not loaded. Refresh to review confirmed complaints.</p></section>';
  const cards=(inbox.items??[]).filter(item=>!offerId||item.offer_id===offerId).map(item=>{
   const d=item.receipt.dispute,phase=item.receipt.status!==4?'Final decision recorded':!d?'Dispute details unavailable':item.receipt.block.timestamp<d.vote_starts_at?`Seller response closes ${date(d.vote_starts_at)}`:item.receipt.block.timestamp<d.vote_ends_at?`Vote closes ${date(d.vote_ends_at)}`:'Vote closed · default uphold available';
   const complaints=(item.explanations??[]).map(explanation=>`<section><p><strong>${explanation.status==='confirmed'?'Confirmed onchain complaint':'Prepared complaint · not linked to a confirmed event'}</strong></p><p class="thot-message-content">${escape(explanation.reason)}</p><p class="legal-note">Buyer <code>${escape(explanation.wallet)}</code>. ${explanation.transaction_hash?explorerLink('tx',explanation.transaction_hash):'A saved explanation alone does not open a dispute.'}</p></section>`).join('');
   const responses=(item.responses??[]).map(response=>`<section><p><strong>${response.status==='confirmed'?'Seller response hash confirmed onchain':'Prepared seller response'}</strong></p><p class="thot-message-content">${escape(response.response)}</p><p class="legal-note">Seller <code>${escape(response.wallet)}</code>.</p></section>`).join('');
   const decisions=(item.decisions??[]).map(decision=>`<section><p><strong>${decision.status==='confirmed'?'Confirmed governance vote':'Prepared governance vote'} · ${decision.decision===2?'Buyer wins':'Uphold delivery'}</strong></p><p class="thot-message-content">${escape(decision.reason)}</p><p class="legal-note">Reviewer <code>${escape(decision.wallet)}</code>.</p></section>`).join('');
   const voteSummary=d?`<p>Votes: ${escape(d.buyer_votes)} buyer wins · ${escape(d.uphold_votes)} uphold. Threshold ${escape(inbox.threshold??2)} matching votes.</p>`:'';
   const actions=showActions?`${item.can_inspect?button('dispute-evidence','Inspect purchased release',item.offer_id):''}${item.can_vote?button('dispute-vote','Review & vote',item.offer_id):item.can_finalize?button('dispute-finalize','Apply default uphold',item.offer_id):''}`:'';
   return `<article class="panel"><span class="pill">${escape(item.receipt.status===4?'Disputed · payment held':'Dispute history')}</span><h3>${escape(item.title??'Item purchase')}</h3><p>${escape(fmt(item.receipt.gross))} gross · ${escape(phase)}</p>${voteSummary}${complaints}${responses}${decisions}${item.reviewer_conflict?'<p role="status">Your reviewer wallet is a buyer, seller or referrer in this case and cannot vote.</p>':''}${item.notice?`<p role="status">${escape(item.notice)}</p>`:''}${actions}<details><summary>Purchase reference</summary><p class="mono">${escape(item.offer_id)}</p></details></article>`;
  }).join('');
  return `<section class="thot-disputes"><div class="section-head"><h2>DAO dispute review</h2><p>Complaint, response and vote explanations remain encrypted offchain; their hashes are recorded onchain. ${escape(inbox.threshold??capabilities().dispute_review_threshold??2)} matching governance ${Number(inbox.threshold??capabilities().dispute_review_threshold??2)===1?'vote decides':'votes decide'}; an expired vote defaults to uphold with no appeal.</p></div><div class="cards">${cards||'<div class="panel"><p>No disputes in this page of purchase records.</p></div>'}</div>${!offerId&&inbox.next_cursor?button('disputes-more','Inspect the next purchase records',inbox.next_cursor):''}</section>`;
 }
 async function action(name,element){
  if(!name.startsWith('thot-'))return false;
  const op=name.slice(5),id=element.dataset.id,current=scope();
  if(op==='copy-seller-wallet'){
   if(!walletAddress(id))throw Error('Seller wallet unavailable.');
   try{await copyText(id);}catch{throw Error('Could not copy. Select and copy the seller address shown above.');}
   current();toast('Seller wallet copied.');return true;
  }
  if(op.startsWith('gov-')){
   let action=op.slice(4),body={action,id};
   const campaignActions=['create_campaign','bind_market','pause_campaign','resume_campaign','cancel_campaign','expire_campaign'];
   if(campaignActions.includes(action)){
    if(!concurrentCampaigns()||!state.thotSampling?.governance?.owner)throw Error('A governance owner is required to manage campaigns.');
    body={action,target:'reserve',params:{}};
    if(action==='create_campaign'){
     const budget=document.querySelector('#thot-campaign-budget').value.trim(),upfront=document.querySelector('#thot-campaign-upfront').value.trim(),days=Number(document.querySelector('#thot-campaign-days').value),purpose=document.querySelector('#thot-campaign-purpose').value.trim(),startText=document.querySelector('#thot-new-campaign-start').value;
     const budgetAtoms=BigInt(inputAtoms(budget)),upfrontAtoms=BigInt(inputAtoms(upfront));
     if(budgetAtoms<=0n)throw Error('Choose a positive campaign budget.');
     if(budgetAtoms>BigInt(state.thotSampling.unallocated_atoms??0))throw Error('The campaign budget exceeds the unallocated reserve.');
     if(upfrontAtoms>budgetAtoms)throw Error('The upfront allowance cannot exceed the campaign budget.');
     if(!Number.isInteger(days)||days<1||days>365)throw Error('Choose a campaign duration from 1 to 365 days.');
     if(purpose.length<10||purpose.length>240)throw Error('Describe the intended purchases in 10 to 240 characters.');
     const start=startText?Date.parse(startText):0;
     if(startText&&(!Number.isFinite(start)||start<=Date.now()))throw Error('Choose a future campaign start, or leave it blank to start now.');
     body.params={budget_thot:budget,duration_days:days,start_at:Math.floor(start/1000),upfront_thot:upfront,purpose};
    }else if(action!=='bind_market'){
     const campaign=campaignRows().find(c=>String(c.id)===String(id));if(!campaign||campaign.closed)throw Error('Refresh this campaign before changing it.');
     body.params={campaign_id:String(campaign.id)};
    }
   }
   if(['create_staking_campaign','close_staking_campaign','pause_staking_campaign','resume_staking_campaign','collect_staking_budget'].includes(action)){
    if(!state.thotSampling?.shared_treasury||!state.thotSampling?.governance?.owner)throw Error('A shared-treasury governance owner is required.');
    body={action,target:'reserve',params:{}};
    if(action==='create_staking_campaign'){
     body.params={budget_thot:document.querySelector('#thot-stake-budget').value.trim(),principal_cap_thot:document.querySelector('#thot-stake-cap').value.trim(),enrollment_days:Number(document.querySelector('#thot-stake-enrollment').value),terms:[0,1,2].map(i=>({duration_days:Number(document.querySelector('#thot-stake-days-'+i).value),reward_bps:Math.round(Number(document.querySelector('#thot-stake-rate-'+i).value)*100)}))};
    }else if(action!=='collect_staking_budget')body.params={campaign_id:document.querySelector('#thot-stake-campaign-id').value.trim()};
   }
   if(action==='queue_campaign'){const start=Date.parse(document.querySelector('#thot-campaign-start').value);if(!Number.isFinite(start))throw Error('Choose a valid campaign start time.');body={action,start_at:Math.floor(start/1000)};}
   if(action==='queue_buyer')body={action,buyer:document.querySelector('#thot-reserve-buyer').value.trim(),allowed:document.querySelector('#thot-reserve-buyer-allowed').value==='true'};
   if(action==='queue_operator')body={action,target:document.querySelector('#thot-operator-target').value,operator:document.querySelector('#thot-next-operator').value.trim()};
   if(action==='set_service_fee')body={action,target:'market',fee_bps:Math.round(Number(document.querySelector('#thot-service-fee').value)*100)};
   if(action==='queue_tariff')body={action,target:'market',direct_cost_atoms:inputAtoms(document.querySelector('#thot-tariff-direct').value),overhead_atoms:inputAtoms(document.querySelector('#thot-tariff-overhead').value),policy_hash:document.querySelector('#thot-tariff-policy').value.trim()};
   if(action==='queue_successor')body={action,successor:document.querySelector('#thot-successor').value.trim(),amount_atoms:inputAtoms(document.querySelector('#thot-successor-amount').value),policy_hash:document.querySelector('#thot-successor-policy').value.trim()};
   if(action==='cancel_queue')body={action,target:document.querySelector('#thot-cancel-target').value,operation_hash:document.querySelector('#thot-cancel-hash').value.trim()};
   if(action==='market-pause'||action==='market-unpause')body={action:action==='market-pause'?'pause':'queueUnpause',target:'market'};
   if(action==='apply-proposal'||action==='cancel-proposal'){
    const o=state.thotSampling?.governance?.operations.find(o=>o.id===id);if(!o?.executed||!o.timelock?.executable_at)throw Error('Refresh the executed queue first.');const target=o.target_kind??'reserve';
    if(action==='cancel-proposal')body={action:'cancel_queue',target,operation_hash:o.timelock.operation_hash};
    else if(o.action==='queueOperator')body={action:'execute_operator',target,operator:o.args[0]};
    else if(o.action==='queueTariff')body={action:'execute_tariff',target,direct_cost_atoms:o.args[0],overhead_atoms:o.args[1],policy_hash:o.args[2]};
    else if(o.action==='queueSuccessor')body={action:'execute_successor',target,successor:o.args[0],amount_atoms:o.args[1],policy_hash:o.args[2]};
    else if(o.action==='queueUnpause')body={action:'unpause',target};
    else throw Error('This queued action cannot be applied by this form.');
   }
   if(action==='activate-proposal'||action==='buyer-proposal'){
    const o=state.thotSampling?.governance?.operations.find(o=>o.id===id);
    if(action==='activate-proposal'){if(!o?.campaign)throw Error('Refresh campaign governance first.');body={action:'execute_campaign',start_at:o.campaign.start_at};}
    else{if(o?.action!=='queueBuyer'||!o.executed||!o.timelock?.executable_at)throw Error('Refresh the executed buyer-permission queue first.');body={action:'execute_buyer',buyer:o.args[0],allowed:o.args[1]};}
   }
   const prepared=await api('/v1/thot/governance/prepare',{method:'POST',body});current();
   review('Reserve governance',prepared,prepared.review?`<h3>Exact governance change</h3><pre class="json-view">${json(prepared.review)}</pre>`:'');return true;
  }
  if(op==='refresh'){if(state.thot)state.thot.market_paused=null;await refresh();return true;}
  if(op==='network'){
   if(inFlight)throw Error('Finish the current wallet request first.');
   if(!getProvider()?.request)throw Error('Open this app in a browser with an Ethereum wallet.');
   const chainId='0x'+BigInt(capabilities().chain_id).toString(16);
   try{await provider().request({method:'wallet_switchEthereumChain',params:[{chainId}]});}catch(error){
    const c=capabilities(),testnet=c.mode==='thot-testnet'&&Number(c.chain_id)===46630&&c.rpc_url==='https://rpc.testnet.chain.robinhood.com',mainnet=c.mode==='thot-production'&&Number(c.chain_id)===4663&&c.rpc_url==='https://rpc.mainnet.chain.robinhood.com';
    if(Number(error?.code)!==4902||!testnet&&!mainnet)throw error;
    current();await provider().request({method:'wallet_addEthereumChain',params:[{chainId,chainName:testnet?'Robinhood Chain Testnet':'Robinhood Chain',nativeCurrency:{name:testnet?'Test Ether':'Ether',symbol:'ETH',decimals:18},rpcUrls:[c.rpc_url],blockExplorerUrls:[testnet?'https://explorer.testnet.chain.robinhood.com':'https://robinhoodchain.blockscout.com']}]});
    current();await provider().request({method:'wallet_switchEthereumChain',params:[{chainId}]});
   }current();await checkNetwork();toast('Wallet connected to '+networkName()+'.');return true;
  }
  if(op==='link'){
   if(inFlight)return true;inFlight=true;element.disabled=true;
   try{const address=await wallet();current();const c=await api('/v1/thot/wallet/challenge',{method:'POST',body:{address}});current();const bytes=new TextEncoder().encode(c.message),hex='0x'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');const signature=await provider().request({method:'personal_sign',params:[hex,address]});current();const selected=await wallet();current();if(selected.toLowerCase()!==address.toLowerCase())throw Error('Wallet account changed. Link the intended account again.');await api('/v1/thot/wallet/link',{method:'POST',body:{id:c.id,signature}});current();await refresh();return true;}finally{inFlight=false;element.disabled=false;}
  }
  if(op==='resume-payment'){if(inFlight)return true;const saved=savedRecovery(recoveryKey());if(!saved)throw Error('No pending wallet action.');review('Resume wallet action',saved);return true;}
  if(op==='replace-transaction'){
   if(inFlight)return true;
   if(!pending)throw Error('Open the pending action first.');
   const operation=pending,index=Number(id),step=operation.steps[index];
   if(!Number.isInteger(index)||!step?.hash||step.confirmed||step.reverted)throw Error('Choose the pending transaction.');
   const hash=document.querySelector('#thot-replacement-hash')?.value?.trim()??'';
   operation.current();inFlight=true;element.disabled=true;
   const priorError=globalThis.document?.querySelector('#dialog-error');if(priorError)priorError.hidden=true;
   try{
    const from=await connected(operation.authority==='operator');operation.current();
    const result=await verifyWalletReplacement({request:args=>provider().request(args),expected:step.transaction,from,hash,originalHash:step.hash,originalNonce:step.nonce,chainId:capabilities().chain_id,confirmations:Number(capabilities().confirmations??1),token:capabilities().token,current:operation.current});
    operation.current();const selected=await connected(operation.authority==='operator');operation.current();if(selected.toLowerCase()!==from.toLowerCase())throw Error('Wallet account changed.');
    const replacement={...step,hash:result.hash,nonce:result.nonce,replacedHash:step.hash,confirmed:true,uncertain:false};
    const updated={...operation,steps:operation.steps.map((value,i)=>i===index?replacement:value)};
    saveRecovery(updated);operation.steps=updated.steps;recoveries.set(operation.key,operation);
    updateProgress(operation);toast('Replacement verified. Continue to check confirmation and review the remaining wallet action.');
   }finally{inFlight=false;element.disabled=false;updateProgress(operation);}
   return true;
  }
  if(op==='send'&&pending&&needsNewReview(pending)){
   if(inFlight||pending.recovering)return true;
   const operation=pending;operation.current();inFlight=true;operation.phase='resetting';updateProgress(operation);
   try{
    const from=await connected();operation.current();let paid=false;
    for(const step of operation.steps){
     if(purchaseApproval(operation,step))continue;
     if(step.uncertain)throw Error('Payment submission is unknown. Check wallet activity before starting another purchase.');
     if(step.hash){
      try{await send(from,step,operation.current,false,operation);}
      catch(error){if(error.code!=='CONFIRMED_REVERT')throw error;}
      if(!step.reverted)paid=true;
     }
    }
    operation.current();recoveryStorage?.removeItem(storageKey(operation.key));recoveries.delete(operation.key);pending=null;await refresh();dialog.close();toast(paid?'Your previous payment is confirmed. View the purchase in Offers.':'Choose the item in Offers to review a fresh purchase. Your existing THOT approval will be checked automatically.');
   }finally{operation.phase=null;inFlight=false;if(pending===operation)updateProgress(operation);}
   return true;
  }
  if(op==='send'){
   if(inFlight||pending?.recovering)return true;
   if(!pending)throw Error('Review this action again.');
   const operation=pending;operation.current();inFlight=true;element.disabled=true;operation.phase='connecting';operation.recoveryError=null;updateProgress(operation);
   const priorError=globalThis.document?.querySelector('#dialog-error');if(priorError)priorError.hidden=true;
   try{
    const from=await connected(operation.authority==='operator');operation.current();
    if(operation.wallet&&!sameWallet(operation.wallet,from))throw Error('The prepared action requires a different wallet. Review it again.');
    for(const step of operation.steps){
     // Already submitted transactions must reconcile even during a pause.
     if(operation.purchase&&!step.hash&&!step.uncertain&&!step.confirmed){
      let workspace;try{workspace=await api('/v1/thot/workspace?scope=buyer');}catch(error){state.thot.market_paused=null;throw Error('Purchase availability is unknown. Check the chain before submitting payment.');}
      operation.current();state.thot.market_paused=workspace.market_paused??null;if(purchasesPaused())throw Error(pauseNotice());
     }
     if(purchaseApproval(operation,step)){
      delete step.allowanceSatisfied;delete step.paymentSubmitted;
      const later=operation.steps.slice(operation.steps.indexOf(step)+1);
      if(later.some(s=>s.hash&&s.transaction?.to?.toLowerCase()===capabilities().market?.toLowerCase())){
       // A submitted payment must reconcile its own receipt, not rebroadcast approval.
       step.paymentSubmitted=true;updateProgress(operation);continue;
      }
      operation.phase='approval';updateProgress(operation);
      const ready=await checkPurchaseApproval(operation,step);
      if(ready===true){step.allowanceSatisfied=true;updateProgress(operation);continue;}
      if(ready===false){
       await send(from,step,operation.current,operation.authority==='operator',operation);
       if(await checkPurchaseApproval(operation,step)!==true)throw Error('Your current THOT approval is not sufficient. Payment was not sent. Check your wallet activity and approval before continuing.');
       step.allowanceSatisfied=true;updateProgress(operation);continue;
      }
     }

     await send(from,step,operation.current,operation.authority==='operator',operation);
    }
    if(operation.confirmDisputeId){await api('/v1/thot/disputes/confirm',{method:'POST',body:{id:operation.confirmDisputeId,transaction_hash:operation.steps.at(-1).hash}});operation.current();}
    operation.current();recoveryStorage?.removeItem(storageKey(operation.key));recoveries.delete(operation.key);if(pending===operation)pending=null;
    dialog.close();await refresh();toast(operation.purchase?'Payment confirmed. Your purchase is now in Offers; delivery status updates there.':'Transaction confirmed. The displayed contract state has been refreshed.');
   }finally{operation.phase=null;inFlight=false;element.disabled=false;if(pending===operation)updateProgress(operation);}
   return true;
  }
  if(inFlight)throw Error('Finish the current wallet request before starting another action.');
  if(['buy','reserve-buy','reserve-buy-confirm'].includes(op)){const saved=savedRecovery(recoveryKey());if(saved&&attempted(saved)){review('Resume wallet action',saved);return true;}if(purchasesPaused())throw Error(pauseNotice());}
  if(op==='trade-evidence-begin'){
   if(capabilities().trade_evidence!==true)throw Error('Trade proof import is unavailable in this workspace.');
   const trace=document.querySelector('#thot-trace')?.value;if(!trace||!/^[-A-Za-z0-9:_]{1,200}$/.test(trace))throw Error('Choose an item first.');
   const symbol=(window.prompt?.('Symbol (for example AAPL)')??'').trim().toUpperCase(),days=Number(window.prompt?.('Window in days (1–365)')??'');
   if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)||!Number.isInteger(days)||days<1||days>365)throw Error('Enter a valid symbol and a window from 1 to 365 days.');
   const origin=new URL(window.location.origin).origin;
   openDialog('Add a trade proof','Run the helper on the computer where you use Robinhood.',`<p>Run this command, then open its printed link in Chrome:</p><pre>${escape('thot-link robinhood --thot-url '+origin+' --trade-trace '+trace+' --symbol '+symbol+' --window-days '+days)}</pre><p>Your browser session stays local. The helper captures orders and instrument evidence and returns a bounded proof. Sharing that proof with a listing needs separate consent.</p>`,button('trade-evidence-manual','Import an existing proof',trace));return true;
  }
  if(op==='trade-evidence-manual'){
   if(capabilities().trade_evidence!==true)throw Error('Trade proof import is unavailable in this workspace.');
   const trace_id=id||document.querySelector('#thot-trace')?.value;if(!trace_id)throw Error('Choose an item first.');
   const current=scope();const symbol=String(window.prompt?.('Symbol (for example AAPL)')??'').trim().toUpperCase();const window_days=Number(window.prompt?.('Window in days (1–365)')??'');current();
   if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)||!Number.isInteger(window_days)||window_days<1||window_days>365)throw Error('Enter a valid symbol and a window from 1 to 365 days.');
   const begun=await api('/v1/thot/trade-evidence/begin',{method:'POST',body:{trace_id,symbol,window_days}});current();
   openDialog('Add trade proof','Use a local helper to produce a signed proof envelope.',`<p>Job <code>${escape(begun.job_id)}</code> · link ticket <code>${escape(begun.link_ticket)}</code></p><p>Request: <code>${escape(JSON.stringify(begun.request??{symbol,window_days,trace_ts:begun.trace_ts}))}</code></p><details><summary>Advanced local-helper details</summary><p>Witness URL: <code>${escape(begun.witness_url??'not provided')}</code><br>Appraiser URL: <code>${escape(begun.appraiser_url??'not provided')}</code></p></details><p>Import a proof envelope, never cookies or raw orders.</p><label for="thot-trade-evidence-json">Proof envelope JSON (maximum 1 MB)</label><textarea id="thot-trade-evidence-json" rows="10"></textarea>`,button('trade-evidence-complete','Import proof envelope',begun.job_id));return true;
  }
  if(op==='trade-evidence-complete'){
   const current=scope();const raw=document.querySelector('#thot-trade-evidence-json')?.value??'';if(new TextEncoder().encode(raw).byteLength>1_000_000)throw Error('Proof envelope is larger than 1 MB.');let evidence;try{evidence=JSON.parse(raw);}catch{throw Error('Enter valid proof envelope JSON.');}if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))throw Error('Proof envelope must be a JSON object.');
   inFlight=true;element.disabled=true;try{const result=await api('/v1/thot/trade-evidence/complete',{method:'POST',body:{job_id:id,evidence}});current();dialog.close();await refresh();toast(`Trade proof imported: ${result.id??result.evidence_id??'ready for listing'}.`);}finally{inFlight=false;element.disabled=false;}return true;
  }
  if(op==='trade-evidence'){
   const current=scope();const r=await api('/v1/thot/listings/evidence',{method:'POST',body:{listing_id:id,evaluation_only:true,...(state.thot?.reserve_buyer?{funding_source:'reserve'}:{})}});current();openDialog('Observed trade summary','Contributor-approved bounded claim; no private proof or item content.',`${tradeProofHTML(r.brokerage_claim,'Observed trade summary')}<details><summary>Claim summary and release commitment</summary><p>Release hash: <code>${escape(r.release_hash??'unavailable')}</code></p><p>The signed proof remains private. This view shows its approved bounded claim.</p><pre class="json-view">${json(r.brokerage_claim)}</pre></details>`);return true;
  }
  if(op==='list-configure'){
   if(listingEnrollment?.signature&&listingEnrollment.key===recoveryKey()){listingScope=current;openDialog('Finish enabling your signed listing','Use the original signature; this does not authorize another sale.',`<p>The activation response was interrupted. Retrying checks the same prepared listing and exact release commitment.</p>${listingMetadataHTML(listingMetadata)}`,button('list-resume','Finish activation'));return true;}
   const trace_id=id||document.querySelector('#thot-trace')?.value;
   if(!trace_id)throw Error('Choose a saved item to review.');
   const [metadata,preview]=await Promise.all([api('/v1/thot/listings/metadata',{method:'POST',body:{trace_id}}),api('/v1/thot/listings/preview',{method:'POST',body:{trace_id}})]);current();
   if(preview.trace_id!==trace_id||preview.content_hash!==metadata.content_hash||!(Array.isArray(preview.content?.turns)||(preview.content_kind==='research'&&preview.content?.schema_version==='thot.research-package/1'&&Array.isArray(preview.content.files))))throw Error('The release changed while loading. Reopen this item to review it again.');
   listingMetadata={...metadata,...preview};listingScope=current;listingEnrollment=null;listingDirty=false;
   showListingReview();return true;
  }
  if(op==='list-resume'){
   if(!listingEnrollment?.signature||listingEnrollment.key!==recoveryKey())throw Error('Review this listing again with its linked account.');listingScope();inFlight=true;element.disabled=true;
   try{await connected();current();await api('/v1/thot/listings/activate',{method:'POST',body:{id:listingEnrollment.prepared.id,signature:listingEnrollment.signature}});current();listingMetadata=null;listingScope=null;listingEnrollment=null;dialog.close();await refresh();toast('Automatic sale enabled with your original authorization.');}finally{inFlight=false;element.disabled=false;}return true;
  }
  if(op==='release-exclude'){
   if(!listingMetadata||!listingScope||listingMetadata.exclusion?.supported!==true)throw Error('Reopen this release before changing it.');listingScope();
   if(!document.querySelector('#release-exclusion-rights')?.checked)throw Error('Confirm your rights to the remaining release first.');
   const fileMode=listingMetadata.content_kind==='research',excluded_files=[...document.querySelectorAll('input[name="excluded_file"]:checked')].map(input=>input.value);
   const excluded_turns=[...document.querySelectorAll('input[name="excluded_turn"]:checked')].map(input=>Number(input.value));
   if(fileMode?!excluded_files.length:!excluded_turns.length)throw Error('Select at least one file or message to remove.');
   const trace_id=listingMetadata.trace_id,content_hash=listingMetadata.content_hash;
   const preview=await api('/v1/thot/listings/exclude',{method:'POST',body:{trace_id,content_hash,...(fileMode?{excluded_files}:{excluded_turns}),rights_confirmed:true,model_output_licensed:document.querySelector('#release-exclusion-outputs')?.checked===true}});current();listingScope();
   // Any previous prices, consent or prepared signature belong to the old view.
   listingMetadata=null;listingEnrollment=null;listingDirty=false;
   const metadata=await api('/v1/thot/listings/metadata',{method:'POST',body:{trace_id}});current();
   if(preview.trace_id!==trace_id||preview.content_hash!==metadata.content_hash||!(Array.isArray(preview.content?.turns)||(preview.content_kind==='research'&&preview.content?.schema_version==='thot.research-package/1'&&Array.isArray(preview.content.files))))throw Error('The release changed. Reopen the item and review its latest version.');
   listingMetadata={...metadata,...preview};listingScope=current;showListingReview();toast('Release updated. Review the remaining messages and choose fresh sale terms.');return true;
  }
  if(op==='list-confirm'){
   if(!listingMetadata||!listingScope)throw Error('Review the listing details again.');listingScope();
   if(listingDirty)throw Error('Apply the selected removals and review the updated release before signing.');
   if(listingMetadata.sale_eligibility?.can_list!==true)throw Error('This release has not passed its sale checks.');
   if(!document.querySelector('#thot-list-consent').checked)throw Error('Authorize the content rights, metadata and automatic sale first.');
   const treasuryOptIn=document.querySelector('#thot-treasury-consent').checked;
   const body={trace_id:listingMetadata.trace_id,content_hash:listingMetadata.content_hash,title:document.querySelector('#thot-title').value,price_thot:document.querySelector('#thot-price').value,license:document.querySelector('#thot-license').value,rights_confirmed:true,metadata_public:true,automatic_sales:true,dispute_review_consent:'thot.dispute-review/1',treasury_opt_in:treasuryOptIn,...(treasuryOptIn?{treasury_sampling_consent:'thot.treasury-sampling/1'}:{})};
   const evidenceId=(listingMetadata.trade_evidence?.length?document.querySelector('#thot-trade-evidence-id')?.value:'') ,evidenceDisclosure=document.querySelector('#thot-trade-evidence-disclosure')?.checked===true;
   if(evidenceId&&!evidenceDisclosure)throw Error('Confirm the explicit trade-proof disclosure or clear the selection.');
   if(evidenceId&&evidenceDisclosure){const proof=(listingMetadata.trade_evidence??[]).find(e=>e.id===evidenceId);if(!proof?.evidence_hash)throw Error('Selected trade proof has no signed hash. Refresh and try again.');body.trade_evidence_id=evidenceId;body.trade_evidence_hash=proof.evidence_hash;body.trade_evidence_disclosure=true;}
   inFlight=true;element.disabled=true;
   try{
    await connected();current();listingScope();
    const terms=JSON.stringify(body);
    if(listingEnrollment&&listingEnrollment.terms!==terms){
     // A signed authorization must finish; an unsigned prepared listing can be
     // replaced when the contributor deliberately edits the reviewed terms.
     if(listingEnrollment.signature)throw Error('Finish activating the reviewed listing before changing its terms.');
     listingEnrollment=null;
    }
    if(!listingEnrollment){const prepared=await api('/v1/thot/listings',{method:'POST',body});current();listingEnrollment={prepared,terms,signature:null,key:recoveryKey()};}
    const prepared=listingEnrollment.prepared;
    const domain=prepared.typed_data?.domain;if(capabilities().market&&(!domain||BigInt(domain.chainId??0)!==BigInt(capabilities().chain_id)||!sameWallet(domain.verifyingContract,capabilities().market)))throw Error('The sale authorization does not match this chain and market. Refresh and try again.');
    showListingSignatureReview();
   }finally{inFlight=false;element.disabled=false;}return true;
  }
  if(op==='list-cancel'){if(!listingMetadata||!listingScope)throw Error('Review the listing details again.');listingScope();showListingReview();return true;}
  if(op==='list-sign'){
   if(!listingMetadata||!listingScope||!listingEnrollment||!listingEnrollment.prepared)throw Error('Review the listing details again.');listingScope();
   inFlight=true;element.disabled=true;
   const review=listingEnrollment;
   try{
    const from=await connected();current();listingScope();
    if(!listingEnrollment.signature){
     // The wallet prompt must be the topmost interactive element (#78): close
     // this dialog first so no application dialog can cover it while signing.
     dialog.close();
     const signature=await provider().request({method:'eth_signTypedData_v4',params:[from,JSON.stringify(listingEnrollment.prepared.typed_data)]});
     current();listingEnrollment.signature=signature;
    }
    const signature=listingEnrollment.signature;const selected=await connected();current();if(!sameWallet(selected,from))throw Error('Wallet account changed. Review and authorize the listing again.');
    const activated=await api('/v1/thot/listings/activate',{method:'POST',body:{id:listingEnrollment.prepared.id,signature}});current();
    listingMetadata=null;listingScope=null;listingEnrollment=null;await refresh();
    showListingListed(activated??review.prepared);
   }catch(error){
    // A cancelled or failed signature returns the contributor to the same
    // reviewed commitments, with the error shown inside that review.
    if(listingEnrollment===review&&!listingEnrollment.signature)showListingSignatureReview();
    throw error;
   }finally{inFlight=false;element.disabled=false;}return true;
  }
  if(op==='copy-listing-url'){
   if(typeof id!=='string'||!/^https:\/\//.test(id))throw Error('The public listing URL is unavailable. Refresh My data.');
   try{await copyText(id);}catch{throw Error('Could not copy the listing link. Select and copy the address shown.');}
   current();toast('Public listing link copied.');return true;
  }
  if(op==='unlist'){const prepared=await api('/v1/thot/listings/unlist',{method:'POST',body:{id}});current();review('Stop future automatic purchases',prepared);return true;}
  if(op==='sample-preview'){
   const blocked=samplingBlocked();if(blocked)throw Error(blocked+' Queueing is unavailable.');
   const workflow=document.querySelector('#thot-sample-workflow').value;
   samplingPreview={max_samples:Number(document.querySelector('#thot-sample-count').value),max_gross_thot:document.querySelector('#thot-sample-budget').value,price_ceiling_thot:document.querySelector('#thot-sample-price').value,...(workflow?{workflow}:{})};
   samplingScope=current;
   openDialog('Review paid sampling','The reserve pays each selected item’s signed asking price.',`<p>Queue at most ${escape(samplingPreview.max_samples)} persisted selections, at most ${escape(samplingPreview.price_ceiling_thot)} THOT each, within ${escape(samplingPreview.max_gross_thot)} THOT gross total. The worker uses the reserve contract’s available allowance.</p><p>Each eligible row is the existing complete-release selection from a stable group of 20 unique contributor data. Queueing and repeated access do not redraw it.</p><details><summary>Exact queue limits</summary><pre class="json-view">${json(samplingPreview)}</pre></details>`,button('sample-confirm','Queue reserve purchases'));return true;
  }
  if(op==='sample-confirm'){
   const blocked=samplingBlocked();if(blocked)throw Error(blocked+' Queueing is unavailable.');
   if(!samplingPreview||!samplingScope)throw Error('Review the sampling criteria first.');samplingScope();inFlight=true;element.disabled=true;
   try{const result=await api('/v1/thot/sampling',{method:'POST',body:samplingPreview});current();samplingPreview=null;samplingScope=null;dialog.close();await refresh();toast(`Queued ${result.sample_count} paid samples. The worker handles purchases and settlement.`);}finally{inFlight=false;element.disabled=false;}return true;
  }
  if(op==='buyer-sample'){
   if(!state.thot?.reserve_buyer&&!state.thotSampling?.reserve_buyer)throw Error('An authorized reserve reviewer wallet is required.');
   openDialog('Inspect the selected reserve release','No token payment or spending approval.',`<p>The contributor opted this item into reserve review. It is the persisted selection from a complete group of 20 unique eligible data.</p><p>All three authorized reserve reviewers receive this same complete approved release. Refreshing, reconnecting or relisting does not redraw it.</p>`,button('buyer-sample-confirm','Inspect complete release',id));return true;
  }
  if(op==='buyer-sample-confirm'){
   const r=await api('/v1/thot/listings/sample',{method:'POST',body:{listing_id:id,evaluation_only:true,funding_source:'reserve'}});current();
   openDialog('Selected reserve release','Shared one-in-20 review selection; no purchase has occurred.',`${releaseHTML(r.release)}<p>Contributor asking price: ${escape(fmt(r.asking_price_atoms))}.</p><details><summary>Selection receipt</summary><pre class="json-view">${json({selection_id:r.selection_id,release_hash:r.release_hash,policy:r.policy,group_size:r.group_size})}</pre></details>`,button('reserve-buy','Buy using reserve',id));return true;
  }
  if(op==='assay'){const r=await api('/v1/thot/assay',{method:'POST',body:{listing_id:id,workflow:document.querySelector('#thot-workflow').value,min_turns:Number(document.querySelector('#thot-min-turns').value)}});current();openDialog('Workflow and length check','Fixed metadata check; no model reads or prices the conversation.',`<p>Result: <strong>${escape(r.receipt.result)}</strong>. Asking price: ${escape(fmt(r.asking_price_atoms))}.</p><p>Inferred category: ${escape(r.checks?.actual_workflow)}. Workflow matches: ${r.checks?.workflow_matches?'yes':'no'}. Recorded turns: ${escape(r.checks?.actual_turns)}; required: ${escape(r.checks?.minimum_turns)}.</p><p>${escape(r.valuation)}. This is not a quality assessment.</p><details><summary>Property check receipt</summary><pre class="json-view">${json(r.receipt)}</pre></details>`);return true;}
  if(op==='campaigns-more'||op==='reserve-campaigns-more'){
   if(!concurrentCampaigns()||!(state.thotSampling?.reserve_buyer||state.thotSampling?.governance?.owner||state.role==='operator_security'))throw Error('Reserve access is required.');
   if(op==='reserve-campaigns-more'){if(!reserveSelection)throw Error('Choose an item to purchase first.');reserveSelection.current();}
   const page=await api('/v1/thot/sampling?campaign_cursor='+encodeURIComponent(id));current();
   const rows=new Map([...campaignRows(),...(page.campaigns??[])].map(c=>[String(c.id),c]));
   state.thotSampling={...state.thotSampling,...page,campaigns:[...rows.values()]};
   if(op==='reserve-campaigns-more')showCampaignSelection();
   else openDialog('Acquisition campaigns','All unspent budgets remain in the reserve.',`<div class="cards">${campaignRows().map(c=>campaignCardHTML(c,state.thotSampling)).join('')}</div>`,page.next_campaign_cursor?button('campaigns-more','Load more campaigns',page.next_campaign_cursor):'');return true;
  }
  if(op==='reserve-resume'){
   if(!state.thot?.reserve_buyer&&!state.thotSampling?.reserve_buyer)throw Error('An authorized reserve buyer wallet is required.');
   const job=state.thotSampling?.jobs?.find(j=>j.id===id);
   if(!job?.resume_available||job.receipt?.status!==0)throw Error('Refresh the unfunded reserve purchase before resuming it.');
   const prepared=await api('/v1/thot/offers/prepare',{method:'POST',body:{listing_id:job.listing_id,funding_source:'reserve',...(job.campaign_id?{campaign_id:String(job.campaign_id)}:{})}});current();
   if(prepared.id!==job.id||prepared.resumed!==true)throw Error('The purchase reference changed. Refresh before signing.');
   review('Resume reserve purchase',{...prepared,purchase:true},purchaseReviewHTML(prepared,true)+`<p>This resumes ${escape(job.title??'your selected item')} with its original purchase reference${job.campaign_id?' and campaign '+escape(job.campaign_id):''}. It creates no second purchase.</p>`);return true;
  }
  if(op==='reserve-buy'&&concurrentCampaigns()){
   if(!state.thot?.reserve_buyer&&!state.thotSampling?.reserve_buyer)throw Error('An authorized reserve buyer wallet is required.');
   if(!state.thotSampling){const page=await api('/v1/thot/sampling');current();state.thotSampling=page;}
   if(state.thotSampling.paused)throw Error('Reserve purchases are paused.');
   reserveSelection={listing_id:id,current};showCampaignSelection();return true;
  }
  if(op==='reserve-buy-confirm'){
   if(!concurrentCampaigns()||!reserveSelection)throw Error('Choose an item and campaign first.');
   const selection=reserveSelection;selection.current();if(!state.thot?.reserve_buyer&&!state.thotSampling?.reserve_buyer)throw Error('An authorized reserve buyer wallet is required.');
   if(state.thotSampling?.paused)throw Error('Reserve purchases are paused.');
   const selected=document.querySelector('#thot-buy-campaign')?.value,campaign=campaignRows().find(c=>String(c.id)===selected);
   if(!campaign||!campaignAvailable(campaign))throw Error('Choose an active campaign with spending available.');
   const prepared=await api('/v1/thot/offers/prepare',{method:'POST',body:{listing_id:selection.listing_id,funding_source:'reserve',campaign_id:String(campaign.id)}});current();selection.current();if(reserveSelection!==selection)throw Error('The selected item changed. Review the intended purchase again.');reserveSelection=null;
   review('Purchase from campaign '+campaign.id,{...prepared,purchase:true},purchaseReviewHTML(prepared,true)+`<p>Campaign ${escape(campaign.id)} pays the contributor’s asking price. Only this campaign’s available allowance is used.</p>`);return true;
  }
  if(op==='reserve-buy'||op==='buy'){
   const reserve=op==='reserve-buy';let prepared;
   try{prepared=await api('/v1/thot/offers/prepare',{method:'POST',body:{listing_id:id,...(reserve?{funding_source:'reserve'}:{})}});}
   catch(error){const messages={BUYER_BALANCE_FOR_TOTAL_PAYMENT:'Your THOT balance does not cover the quoted total. Add tokens to the linked wallet before buying.',THOT_MARKET_PAUSED:'Purchases are paused. Existing purchases remain available.',AUTHORIZATION_UNAVAILABLE:'The seller authorization is no longer available. Refresh the listings before buying.'};if(error.message==='THOT_MARKET_PAUSED')state.thot.market_paused=true;throw Error(messages[error.message]??error.message);}
   current();review(reserve?'Purchase from campaign reserve':'Buy this item',{...prepared,purchase:true},purchaseReviewHTML(prepared,reserve));return true;
  }
  if(op==='review'){const r=await api('/v1/thot/offers/review',{method:'POST',body:{id}});current();if(!r.transaction){openDialog('Your authorized sale','This purchase already uses your enrollment signature.',releaseHTML(r.release)+`<details><summary>Sale receipt</summary><pre class="json-view">${json(r.receipt)}</pre></details>`);return true;}review('Accept this exact funded release',{transactions:[r.transaction],notice:`Your wallet acceptance binds this content, license and payment split. Delivery is due within 48 hours, followed by a ${disputeWindow(r.receipt)}.`},`<p>Your agreed share: ${escape(fmt(r.receipt.seller_amount))} from ${escape(fmt(r.receipt.gross))} gross.</p>${releaseHTML(r.release)}`);return true;}
  if(op==='download-delivery'){
   if(typeof download!=='function')throw Error('Downloads are unavailable. Refresh this page.');
   const r=await api('/v1/thot/offers/delivery',{method:'POST',body:{id}});current();
   if(!r.release||r.acknowledgment||![3,4,5].includes(r.receipt?.status))throw Error('The licensed release is not ready to download. Check delivery again.');
   download({release:r.release,receipt:r.receipt,delivery_hash:r.delivery_hash},`thot-licensed-trace-${String(id).replace(/[^a-zA-Z0-9_-]/g,'')}.json`);
   toast('Licensed item downloaded. Its buyer licence is included.');return true;
  }
  if(op==='delivery'){const r=await api('/v1/thot/offers/delivery',{method:'POST',body:{id}});current();const content=releaseHTML(r.release)+settlementHTML(r.receipt??{})+`<details><summary>Delivery receipt</summary><pre class="json-view">${json({receipt:r.receipt,delivery_hash:r.delivery_hash,notice:r.notice})}</pre></details>`;if(r.acknowledgment)review('Your purchase',{transactions:[r.acknowledgment],notice:`Confirm only if you received this licensed release. Confirmation starts the ${disputeWindow(r.receipt)}.`},content);else openDialog('Your purchase','Your purchased content. Keep and use it under the buyer licence.',content,button('download-delivery','Download',id,false,true));return true;}
  if(op==='disputes-more'){
   if(state.role!=='operator_security'&&!state.thot?.account?.dispute_reviewer)throw Error('Governance reviewer access is required.');
   const page=await api('/v1/thot/disputes?after_id='+encodeURIComponent(id));current();
   const items=new Map([...(state.thotDisputes?.items??[]),...(page.items??[])].map(item=>[item.offer_id,item]));
   state.thotDisputes={...page,items:[...items.values()]};
   openDialog('Delivery dispute review','Confirmed contract state and privately submitted explanations.',disputesHTML());return true;
  }
  if(op==='dispute-vote'||op==='dispute-evidence'){
   const item=state.thotDisputes?.items?.find(item=>item.offer_id===id);
   if(!item||item.receipt.status!==4)throw Error('Refresh the dispute inbox before inspecting a case.');
   const evidence=item.inspection_authorized===false?null:await api('/v1/thot/disputes/evidence',{method:'POST',body:{id}});current();
   if(evidence&&(evidence.offer_id!==id||evidence.scope!=='disputed_purchased_release'))throw Error('The returned evidence does not match this dispute.');
   if(evidence)item.receipt=evidence.receipt;
   const d=item.receipt.dispute,now=item.receipt.block.timestamp,canVote=now>=d.vote_starts_at&&now<d.vote_ends_at&&d.reviewer_vote===0;
   const evidenceHTML=evidence?`<h3>Purchased licensed release</h3>${tradeProofHTML(evidence.brokerage_claim,'Public trade claim attached to this purchase')}${releaseHTML(evidence.release)}<details><summary>Verified release commitments</summary><pre class="json-view">${json({offer_id:id,release_hash:evidence.release_hash,delivery_hash:evidence.delivery_hash,licensed_content_hash:evidence.licensed_content_hash,block:item.receipt.block})}</pre><p>${escape(evidence.notice)}</p></details>`:'<p>This older sale did not authorize governance content inspection. The existing case can still be adjudicated from the parties’ submitted evidence. Its original terms have not changed.</p>';
   const voteForm=canVote?`<label for="thot-dispute-decision">Vote</label><select id="thot-dispute-decision"><option value="">Choose a vote</option><option value="buyer_wins">Buyer wins · 50% claimable, 50% dead sink</option><option value="uphold">Uphold delivery</option></select><label for="thot-decision-reason">Explanation for your vote</label><textarea id="thot-decision-reason" minlength="10" maxlength="2000" rows="4"></textarea>`:'';
   openDialog('Review a disputed purchase','The purchased release, complaint, response and recorded votes for this case.',`${disputesHTML(id,false)}${evidenceHTML}<p>Total escrow: ${escape(fmt(item.receipt.buyer_total??item.receipt.gross))}, including ${escape(fmt(item.receipt.buyer_surcharge??0))} buyer surcharge. A buyer win makes 50% of the total claimable by the buyer and sends 50% immediately to the canonical dead sink; seller, referrer and protocol receive zero. Upholding releases the snapshotted allocations.</p>${voteForm}<p class="legal-note">One vote per governance reviewer. ${escape(state.thotDisputes?.threshold??capabilities().dispute_review_threshold??2)} matching vote(s) decide the case, and no party or referrer may vote their own case. Evidence access is recorded in the private audit log.</p>`,canVote?button('dispute-vote-preview','Review vote transaction',id):'');return true;
  }
  if(op==='dispute-vote-preview'){
   const decision=document.querySelector('#thot-dispute-decision').value,reason=document.querySelector('#thot-decision-reason').value;
   if(!['buyer_wins','uphold'].includes(decision))throw Error('Choose buyer wins or uphold delivery.');
   const prepared=await api('/v1/thot/disputes/vote',{method:'POST',body:{id,decision,reason}});current();
   review('Confirm governance vote',prepared,`<p><strong>${decision==='buyer_wins'?'Buyer wins: half claimable, half sent to the dead sink.':'Uphold the delivery and release its original allocations.'}</strong></p><p>Your explanation is encrypted offchain; its hash is recorded with your vote.</p>`);return true;
  }
  if(op==='dispute-finalize'){const prepared=await api('/v1/thot/disputes/finalize',{method:'POST',body:{id}});current();review('Apply expired-vote default',prepared,`<p>The seven-day vote window ended without the required matching votes. This transaction upholds delivery under the contract’s default rule.</p>`);return true;}
  if(op==='dispute-respond'){openDialog('Respond to the buyer complaint','Your response is encrypted for governance review; only its hash goes onchain.',`<label for="thot-dispute-response">Seller response</label><textarea id="thot-dispute-response" minlength="10" maxlength="2000" rows="4"></textarea><p>You may respond once during the 24-hour response period. After your response confirms, you can separately choose to finish the period early; otherwise you keep the remaining time.</p>`,button('dispute-response-preview','Review response transaction',id));return true;}
  if(op==='dispute-waive-response'){openDialog('Finish your response period?','Only the seller can waive their own remaining response time.',`<p>You have already submitted your response. Continuing lets governance review and decide this dispute immediately after confirmation. You cannot reopen the remaining response period. Keep waiting if you want to retain that time.</p>`,button('dispute-waive-confirm','I am finished — allow review now',id));return true;}
  if(op==='dispute-waive-confirm'){const prepared=await api('/v1/thot/disputes/waive-response',{method:'POST',body:{id,confirm_final_response:true}});current();review('Finish seller response period',{...prepared,exit:true});return true;}
  if(op==='dispute-response-preview'){const response=document.querySelector('#thot-dispute-response').value,prepared=await api('/v1/thot/disputes/respond',{method:'POST',body:{id,response}});current();review('Confirm seller response',{...prepared,exit:true},`<p>Your encrypted response remains offchain; the response hash is recorded onchain for reviewers to verify.</p>`);return true;}
  if(op==='dispute'){const receipt=state.thot?.orders?.find(order=>order.id===id)?.receipt;openDialog('Dispute this delivery','Your complaint is encrypted for governance review. Its hash goes onchain when you sign.',`<label for="thot-reason">Reason</label><textarea id="thot-reason" minlength="10" maxlength="2000" rows="4"></textarea><p>Only an independent buyer whose current reviewed purchase plus prior finalized reviewed purchases totals at least 10,000,000 THOT can file. Sign within ${disputeDuration(receipt)} of recorded delivery. A buyer win makes half claimable and sends half to the canonical dead sink.</p>`,button('dispute-confirm','Review dispute',id));return true;}
  if(op==='holder-policy'){const prepared=await api('/v1/thot/transaction',{method:'POST',body:{action:'holder-policy',first_threshold_atoms:inputAtoms(document.querySelector('#holder-first').value),second_threshold_atoms:inputAtoms(document.querySelector('#holder-second').value),first_bps:Math.round(Number(document.querySelector('#holder-low').value)*100),second_bps:Math.round(Number(document.querySelector('#holder-high').value)*100),...(document.querySelector('#holder-lock-amount')?{lock_threshold_atoms:inputAtoms(document.querySelector('#holder-lock-amount').value),lock_days:Number(document.querySelector('#holder-lock-days').value),lock_bps:Math.round(Number(document.querySelector('#holder-lock-rate').value)*100)}:{})}});current();review('Change future holder fees',prepared);return true;}
  if(op==='holder-rebate'){const prepared=await api('/v1/thot/transaction',{method:'POST',body:{action:'holder-rebate',offer_id:id}});current();review('Claim your fee cashback',{...prepared,exit:true},`<p>You receive ${escape(fmt(prepared.quote.amount_atoms))}.</p>`);return true;}
  if(op==='stake'){
   const section=[...document.querySelectorAll('[data-staking-campaign]')].find(el=>el.dataset.stakingCampaign===id);
   if(!section)throw Error('Refresh staking offers.');
   const prepared=await api('/v1/thot/transaction',{method:'POST',body:{action:'stake',campaign_id:id,term_index:Number(section.querySelector('input[type="radio"]:checked').value),amount_atoms:parseStakingAmount(section.querySelector('[data-staking-amount]').value).toString()}});current();
   review('Review your stake',prepared,`<p>Lock ${escape(fmt(prepared.quote.principal_atoms))}. Receive ${escape(fmt(prepared.quote.payout_atoms))} at maturity, including ${escape(fmt(prepared.quote.reward_atoms))} in reserved rewards.</p>`);return true;
  }
  const body=op==='lock'?{action:op,amount:document.querySelector('#thot-lock').value}:op==='refer'?{action:op,referrer:document.querySelector('#thot-referrer').value}:op==='withdraw'||op==='extend'?{action:op,lot_id:Number(id)}:op==='dispute-confirm'?{action:'dispute',id,reason:document.querySelector('#thot-reason').value}:{action:op,id};
  const prepared=await api('/v1/thot/transaction',{method:'POST',body});current();review(op==='dispute-confirm'?'Review your dispute':'Review THOT action',{...prepared,...(['claim','finalize','cancelOffer','refundExpired','refundUndelivered','withdraw','staking-claim','dispute-confirm'].includes(op)?{exit:true}:{}),...(op==='dispute-confirm'?{confirmDisputeId:id}:{})});return true;
 }
 const clearPrivateReview=()=>{listingMetadata=null;listingScope=null;listingEnrollment=null;listingDirty=false;};
 return {clearPrivateReview,walletSummaryHTML,catalogueHTML,purchasesHTML,offersHTML,earningsHTML,tokenHTML,valuationsHTML,samplingHTML,disputesHTML,onInput,action};
}
