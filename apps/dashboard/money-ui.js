// Browser wallets sign and submit directly. The API never receives a private key.
export function createMoneyUI({state,api,openDialog,dialog,refresh,escape,json,toast}) {
  let funding=null,approval=null;
  const active=()=>state.money?.mode==='anvil';
  function scope() {
    const actor=state.actor?.id,role=state.role,generation=state.generation;
    return ()=>{if(state.actor?.id!==actor||state.role!==role||state.generation!==generation){const e=new Error('Your account changed. Review this action again.');e.name='StaleWorkspaceError';throw e;}};
  }
  const thot=value=>{const v=BigInt(value??0);return `${v/10n**18n}.${String(v%10n**18n).padStart(18,'0').slice(0,4)} THOT`;};
  const cash=value=>(Number(BigInt(value??0))/1e6).toFixed(2)+' test dollars';
  async function wallet() {
    if(!window.ethereum)throw new Error('Connect a browser wallet configured for the local Anvil network (chain 31337), then try again. This demo uses test assets.');
    const accounts=await window.ethereum.request({method:'eth_requestAccounts'});
    if(await window.ethereum.request({method:'eth_chainId'})!=='0x7a69')throw new Error('Switch your wallet to the local Anvil network, chain 31337.');
    if(!accounts[0])throw new Error('Choose a wallet account to continue.');
    return accounts[0];
  }
  async function send(from,transaction) {
    const hash=await window.ethereum.request({method:'eth_sendTransaction',params:[{...transaction,from}]});
    for(let i=0;i<120;i++){
      const receipt=await window.ethereum.request({method:'eth_getTransactionReceipt',params:[hash]});
      if(receipt){if(receipt.status!=='0x1')throw new Error('The wallet transaction failed. Your trace is still private.');return hash;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('The transaction is still waiting. Retry funding to recover the confirmed deposit.');
  }
  async function startApproval(preview) {
    const current=scope(),actor=state.actor.id,recipient=await wallet();current();
    const quote=await api('/v1/money/quote/'+encodeURIComponent(preview.candidate_id),{method:'POST',body:{wallet_address:recipient}});
    current();
    approval={preview,quote,recipient,actor,current};
    openDialog('Receive THOT for this release','Your wallet signature approves the content you just reviewed and this payout.',`<p><strong>65% buys your THOT. 20% buys and burns THOT. 15% pays the operator.</strong> Direct costs: zero.</p><div class="meta-pair"><span>Sale price</span><strong>${escape(cash(quote.message.gross))}</strong></div><div class="meta-pair"><span>Minimum combined purchase</span><strong>${escape(thot(quote.message.minThot))}</strong></div><p>Your share of the purchased tokens is 65/85. The remaining 20/85 is destroyed, reducing total supply. A worse swap price cancels the entire transaction and keeps the release locked.</p><div class="meta-pair"><span>Your receiving wallet</span><strong class="mono">${escape(recipient)}</strong></div><p>Quote expires ${escape(new Date(quote.message.deadline*1000).toLocaleTimeString())}. Signing costs no gas. Payment and delivery will wait for settlement.</p><details><summary>Exact release and license commitments</summary><pre class="json-view">${json({release:preview.release_artifact_hash,license:preview.license_hash,market:quote.domain.verifyingContract})}</pre></details>`,`<button class="button secondary" data-action="close-dialog">Keep private</button><button class="button" data-action="money-sign">Sign & authorize release</button>`);
  }
  async function receipt(id) {
    const order=await api('/v1/money/settlements/'+encodeURIComponent(id));
    if(order.status!=='FINALIZED')return openDialog('Payment is still pending','The buyer cannot download this trace yet.',`<p>${({PRICE_MOVED:'The pool price moved beyond the minimum you approved. Your release stays locked while settlement waits.',ESCROW_REFUNDED_OR_INSUFFICIENT:'The order no longer has enough escrow. The buyer may have refunded it. Your release stays locked.',QUOTE_EXPIRED_OR_MARKET_PAUSED:'This quote expired or settlement was paused. Your release stays locked; an expired quote requires a new approval.',RECOVERY_REQUIRED:'Payment may already be confirmed. The worker is recovering its receipt before unlocking the release.'})[order.last_error]??'Your authorization is saved. Settlement will check payment before releasing your trace.'}</p><p>You can return here to check the result. Payment must finish before the buyer can download.</p><p>Status: <strong>${escape(order.status)}</strong></p>`,`<button class="button" data-action="money-receipt" data-id="${escape(id)}">Refresh payment status</button>`);
    const r=order.receipt;
    openDialog('Payment complete','Confirmed on local Anvil · test assets · one atomic transaction.',`<section class="metrics"><article class="metric highlight"><small>CONTRIBUTOR RECEIVED</small><strong>${escape(thot(r.paid_thot_atoms))}</strong><p>Transferred to the wallet you approved.</p></article><article class="metric"><small>SUPPLY DESTROYED</small><strong>${escape(thot(r.burned_thot_atoms))}</strong><p>Total supply decreased by this amount.</p></article><article class="metric"><small>OPERATOR RECEIVED</small><strong>${escape(cash(r.operator_payment_atoms))}</strong><p>No direct costs deducted.</p></article></section><p><strong>The exact licensed release is now available to its buyer.</strong></p><details><summary>Verify transaction and commitments</summary><pre class="json-view" aria-label="Onchain settlement receipt">${json(r)}</pre></details>`);
  }
  async function action(name,button) {
    if(!active())return false;
    const id=button.dataset.id;
    if(name==='fund-mandate-draft') {
      const m=state.mandates.find(m=>m.mandate_id===id);
      funding={id,revision:m.draft_revision??1,actor:state.actor.id,current:scope()};
      openDialog('Fund your buy order','Your wallet deposits test dollars into escrow on local Anvil.',`<p><strong>${escape(cash(m.economics.total_budget_minor))}</strong> funds this order, at ${escape(cash(m.economics.unit_price_minor))} per accepted trace.</p><p>Your wallet will approve the exact budget, then deposit it. Funding freezes these terms. Activate matching after confirmation.</p><p>Unused funds remain refundable from escrow. A refund that wins the race prevents settlement and keeps the trace locked.</p>`,`<button class="button secondary" data-action="close-dialog">Keep unfunded</button><button class="button" data-action="money-fund">Approve & deposit test dollars</button>`);return true;
    }
    if(name==='money-fund') {
      const current=funding.current;current();const from=await wallet();current();
      button.disabled=true;button.textContent='Waiting for your wallet…';
      try {
        const localKey=`thot-anvil-funding:${state.money.market}:${funding.id}:${from}`;
        let hash=sessionStorage.getItem(localKey);
        if(!hash){const prepared=await api(`/v1/buyer/mandates/${funding.id}/fund`,{method:'POST',body:{expected_revision:funding.revision,wallet_address:from}});current();if(prepared.status==='funded')hash=prepared.transaction_hash;else for(const tx of prepared.transactions){current();hash=await send(from,tx);current();}sessionStorage.setItem(localKey,hash);}
        await api(`/v1/buyer/mandates/${funding.id}/fund`,{method:'POST',body:{transaction_hash:hash}});
        sessionStorage.removeItem(localKey);dialog.close();await refresh();toast('Deposit confirmed. Activate matching when you are ready.');
      }finally{button.disabled=false;button.textContent='Approve & deposit test dollars';}return true;
    }
    if(name==='money-sign') {
      const current=approval.current;current();
      const p=approval.preview,q=approval.quote;
      const signature=await window.ethereum.request({method:'eth_signTypedData_v4',params:[approval.recipient,JSON.stringify({domain:q.domain,types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],...q.types},primaryType:q.primaryType,message:q.message})]});
      current();
      const result=await api('/v1/sale-authorizations',{method:'POST',body:{candidate_id:p.candidate_id,release_artifact_hash:p.release_artifact_hash,license_hash:p.license_hash,expected_gross_minor:p.expected_gross_minor,expected_direct_costs_max_minor:p.expected_direct_costs_max_minor,credential_receipt_ids:p.credential_receipt_ids,outcome_receipt_ids:p.outcome_receipt_ids,payout_preference:'token',quote_id:q.quote_id,wallet_signature:signature}});
      await refresh();await receipt(result.license_id);return true;
    }
    if(name==='money-receipt'){await receipt(id);return true;}
    if(name==='settlement'){const e=state.earnings.entitlements.find(e=>e.entitlement_id===id);if(e){await receipt(e.license_id);return true;}}
    return false;
  }
  function decorate(main) {
    if(!active())return;
    main.insertAdjacentHTML('afterbegin','<p class="legal-note" data-testid="anvil-mode"><strong>Anvil money demo.</strong> Real contract execution with test dollars and local THOT. Browser wallets are required for funding and payout approval.</p>');
    for(const button of main.querySelectorAll('[data-action="mandate"],[data-action="burn"]'))button.remove();
    for(const button of main.querySelectorAll('[data-action="edit-mandate-draft"]'))if(state.mandates.find(m=>m.mandate_id===button.dataset.id)?.status!=='draft')button.remove();
    for(const button of main.querySelectorAll('[data-action="fund-mandate-draft"]'))button.textContent='Fund with your wallet ↗';
    for(const c of state.candidates.filter(c=>c.status==='LICENSED')){
      const card=main.querySelector(`[data-action="preview"][data-id="${c.candidate_id}"]`)?.closest('article');
      card?.insertAdjacentHTML('beforeend',`<button class="button secondary" data-action="money-receipt" data-id="${escape(c.license_id)}">View payment status</button>`);
    }
  }
  return {active,action,startApproval,receipt,decorate};
}
