/** Keep provider keys and the one-time proxy token out of browser persistence. */
export function createOpenRouterUI({state,api,openDialog,dialog,escape,toast,refresh,getProvider=()=>globalThis.window?.ethereum}) {
  let generation=0;
  const revocations=new Map();
  const scope=()=>{const g=generation,actor=state.actor?.id,workspace=state.generation,provider=getProvider();return()=>{if(g!==generation||actor!==state.actor?.id||workspace!==state.generation||provider!==getProvider())throw Error('Your account changed. Open Connections again.');};};
  const intro=()=>`<section class="panel connection-card"><div><p class="eyebrow">KEEP YOUR TOOLS</p><h2>Your key. Your work. Your trace vault.</h2><p>Connect OpenRouter once, then use the thot endpoint in an OpenAI-compatible client. Requests sent through it are recorded privately.</p></div><button class="button secondary" data-action="openrouter-open">Connect OpenRouter →</button></section>`;
  async function open(){
    reset();
    if(state.role!=='user')throw Error('Sign in as a contributor to connect your own key.');
    const current=scope(),status=await api('/v1/contributor/openrouter');current();
    const streamSales=state.thot?.capabilities?.stream_sales===true;
    const linkedWallet=state.thot?.wallet;
    const policies=streamSales?(await api('/v1/thot/streams')).policies??[]:[];current();
    const policyRows=policies.map(p=>`<article class="panel"><p><strong>${escape(p.price_thot)} THOT per trace</strong> · expires ${escape(new Date(p.valid_until*1000).toLocaleString())}</p><p>${p.offchain_revoked?'New offers stopped in thot.':'Automatic offers active in thot.'} ${p.onchain_revoked===true?'Wallet authorization revoked on chain.':p.onchain_revoked===false?'Wallet authorization is not yet confirmed revoked on chain.':'Chain confirmation is unavailable.'}</p>${!p.offchain_revoked?`<button class="button secondary" data-action="openrouter-stop-policy" data-id="${escape(p.id)}">Stop new offers</button>`:p.onchain_revoked!==true?`<button class="button secondary" data-action="openrouter-chain-revoke" data-id="${escape(p.id)}">Confirm wallet revocation</button>`:''}</article>`).join('');
    const rows=(status.requests??[]).map(r=>`<tr><td>${escape(r.returned_model??'Not reported')}<small>Requested: ${escape(r.requested_model??r.model)}${r.provider_name?` · Provider: ${escape(r.provider_name)}`:''}</small></td><td>${escape(r.status.toLowerCase().replaceAll('_',' '))}</td><td>${escape(new Date(r.created_at).toLocaleString())}</td><td>${r.content_deleted?'Deleted':r.status==='COMPLETED'?'In your vault':'Recording incomplete'}</td></tr>`).join('');
    openDialog('Connect OpenRouter','Continue using your own OpenRouter account. thot records the work you send through this connection.',
      `<div class="panel"><p><strong>1.</strong> Connect your provider key below.</p><p><strong>2.</strong> Set your client’s base URL to <code>${escape(location.origin+'/v1/openrouter')}</code> and use the new thot proxy key.</p><p><strong>3.</strong> ${streamSales?'Sign the connection’s sale terms once. Subsequent completed, eligible traces are offered automatically at your chosen price. Payments follow completed purchases.':'Your requests appear in your private vault. A separate sale authorization is required to offer them to buyers.'}</p></div>`+
      (!status.enabled?'<p role="status">OpenRouter connections are not enabled on this deployment.</p>':
      status.connected?`<p><strong>Connected.</strong> Your saved OpenRouter key is encrypted. Your proxy key was shown once. Reconnect to replace it. ${status.sale_policy_id?'This connection has a signed sale policy.':'This connection records privately.'}</p><button class="button secondary" data-action="openrouter-disconnect">Disconnect provider & proxy key</button><p>Disconnect stops new recordings and proxy access. It does not cancel signed sale authorizations or funded purchases. Use the sale-policy controls below to stop offers and revoke an unfunded authorization on chain.</p>`:
      `<form id="openrouter-connect-form"><label for="openrouter-api-key">Your OpenRouter API key</label><input id="openrouter-api-key" type="password" autocomplete="off" spellcheck="false" maxlength="512" required placeholder="sk-or-…">${streamSales?'<label for="openrouter-sale-price">Gross asking price per completed trace (THOT)</label><input id="openrouter-sale-price" inputmode="decimal" value="100" required><p>Your proceeds are the asking price minus the quoted service fee. Holding or locking THOT does not change the fee. This is your asking price, not an assay estimate. The connection policy lasts 30 days and covers subsequent traces only.</p>':''}<label class="consent-label"><input id="openrouter-recording-consent" type="checkbox" required> Record every request and response sent through this endpoint, including submitted history and tool calls, in my private thot vault. OpenRouter bills my account. ${streamSales?'I have the rights to contribute this content, including model outputs, and authorize automatic non-exclusive evaluation sales at this asking price. Ordinary buyers receive the trace only after purchase. Local filtering may miss confidential prompts, tool output, code, or personal details; only route content I am willing to sell. Non-conflicted governance reviewers may inspect that purchased release only during an onchain dispute.':'This connection does not authorize a sale.'}</label>${streamSales?'<label class="consent-label"><input id="openrouter-treasury-consent" type="checkbox"> Optional: include eligible completed traces in reserve review. The named reserve reviewers may inspect one complete approved release from each stable group of 20 unique traces. Repeated access never redraws the selection.</label>':''}<details><summary>Recording and billing details</summary><p>${escape(status.notice)}</p></details><button class="button" type="submit">${streamSales?'Sign terms & connect':'Connect & create proxy key'}</button></form>`)+
      (streamSales?`<h3>Automatic sale policies</h3>${policyRows||'<p>No unexpired signed sale policies.</p>'}<p>Stopping offers hides the linked listings in thot. Until your wallet revocation is confirmed on chain, an already prepared but unfunded authorization may still be used. Funded purchases keep their agreed terms. If your wallet already submitted a revocation, wait for chain confirmation before sending another.</p>`:'')+
      `<details><summary>Client setup</summary><p>Use an OpenAI-compatible Chat Completions client with a full model ID, such as <code>openai/gpt-4.1-mini</code>. Configure automatic retries to 0, or reuse an Idempotency-Key for the same logical request. A new key means a new billable request.</p><p>This endpoint supports <code>/chat/completions</code> with streaming and tool calls. ChatGPT and Claude website subscriptions are separate connections.</p></details>`+
      `<h3>Recent relay requests</h3>${rows?`<div class="table-wrap"><table><thead><tr><th>Model</th><th>Status</th><th>Time</th><th>Trace</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p>No requests recorded through this connection yet.</p>'}`);
    const form=dialog.querySelector('#openrouter-connect-form');let submitting=false;
    form?.addEventListener('submit',async event=>{
      event.preventDefault();if(submitting)return;const button=form.querySelector('button[type="submit"]'),input=form.querySelector('#openrouter-api-key');
      try{current();if(!form.isConnected||state.role!=='user')return;}catch{return;}
      if(!form.reportValidity())return;submitting=true;button.disabled=true;
      const api_key=input.value.trim();input.value='';
      try{
        let salePolicy={};
        if(streamSales){
          const provider=getProvider(),caps=state.thot?.capabilities??{};
          if(!provider?.request||!/^0x[0-9a-f]{40}$/i.test(linkedWallet??''))throw Error('Connect your THOT wallet before enabling automatic trace sales.');
          const selected=await provider.request({method:'eth_accounts'});current();
          if(selected?.[0]?.toLowerCase()!==linkedWallet.toLowerCase())throw Error('Choose the wallet linked to this account.');
          const chain=await provider.request({method:'eth_chainId'});current();
          if(BigInt(chain)!==BigInt(caps.chain_id))throw Error('Switch to the configured THOT network before signing.');
          const price=form.querySelector('#openrouter-sale-price')?.value?.trim();
          if(!/^(?:[1-9][0-9]*|0)(?:\.[0-9]{1,18})?$/.test(price??'')||!/[1-9]/.test(price))throw Error('Enter a positive THOT asking price.');
          const prepared=await api('/v1/thot/streams/prepare',{method:'POST',body:{price_thot:price,treasury_sampling_opt_in:form.querySelector('#openrouter-treasury-consent')?.checked===true}});current();
          const typed=prepared.typed_data;
          if(!typed?.domain||BigInt(typed.domain.chainId??0)!==BigInt(caps.chain_id)||typed.domain.verifyingContract?.toLowerCase()!==caps.market?.toLowerCase()||typed.message?.seller?.toLowerCase()!==linkedWallet.toLowerCase())throw Error('The connection authorization does not match this wallet and market.');
          const signature=await provider.request({method:'eth_signTypedData_v4',params:[linkedWallet,JSON.stringify(typed)]});current();
          const again=await provider.request({method:'eth_accounts'});current();
          if(again?.[0]?.toLowerCase()!==linkedWallet.toLowerCase())throw Error('Wallet changed while signing. Reconnect with the original account.');
          salePolicy={sale_policy_id:prepared.id,sale_policy_signature:signature,rights_confirmed:true,model_output_licensed:true};
        }
        const result=await api('/v1/contributor/openrouter/connect',{method:'POST',sensitive:true,body:{api_key,recording_consent:true,notice_version:status.notice_version,...salePolicy}});current();if(!form.isConnected)return;
        // Never interpolate a provider key or proxy credential into HTML or logs.
        openDialog('Your connection is ready','Save this proxy key in your client. It is shown only once.',`<label for="openrouter-base">Base URL</label><input id="openrouter-base" readonly><label for="openrouter-proxy">thot proxy key</label><input id="openrouter-proxy" type="password" readonly autocomplete="off"><button class="button secondary" data-action="openrouter-copy">Copy proxy key</button><p>Every request through this endpoint is recorded in your private vault. ${streamSales?'Eligible completed traces are automatically offered under the terms you just signed. No per-trace signing is needed. ':''}Keep the proxy key private: it can spend against your connected OpenRouter account.</p><p>Open Connections to manage proxy access and signed sale policies separately.</p>`);
        dialog.querySelector('#openrouter-base').value=location.origin+'/v1/openrouter';dialog.querySelector('#openrouter-proxy').value=result.token;
        toast('OpenRouter connected. Save the proxy key in your client.');
      }catch(error){try{current();if(form.isConnected)toast(error.message);}catch{}}finally{submitting=false;if(form.isConnected)button.disabled=false;}
    });
  }
  async function handle(action,element){
    if(!action?.startsWith('openrouter-'))return false;
    if(state.role!=='user'||!state.actor)throw Error('Sign in as a contributor to manage this connection.');
    if(action==='openrouter-open')await open();
    else if(action==='openrouter-disconnect'){const current=scope();await api('/v1/contributor/openrouter/disconnect',{method:'POST',body:{}});current();await open();toast('Provider key and proxy access revoked. Signed sale policies remain until stopped separately.');}
    else if(action==='openrouter-stop-policy'){
      const current=scope(),id=element?.dataset?.id;
      if(!id||!/^stream:[A-Za-z0-9-]+$/.test(id))throw Error('Refresh Connections and choose a sale policy.');
      await api('/v1/thot/streams/revoke',{method:'POST',body:{id}});current();await open();toast('New offers stopped in thot. Confirm the wallet transaction to invalidate prepared, unfunded sales on chain.');
    }
    else if(action==='openrouter-chain-revoke'){
      const current=scope(),id=element?.dataset?.id,caps=state.thot?.capabilities??{},wallet=state.thot?.wallet;
      if(!id||!/^stream:[A-Za-z0-9-]+$/.test(id)||!/^0x[0-9a-f]{40}$/i.test(wallet??''))throw Error('Link your THOT wallet and refresh Connections.');
      const listed=await api('/v1/thot/streams');current();
      const policy=listed.policies?.find(p=>p.id===id);
      if(!policy)throw Error('This sale policy is no longer available. Refresh Connections.');
      if(policy.onchain_revoked===true){await open();toast('Wallet revocation is confirmed on chain.');return true;}
      const prepared=await api('/v1/thot/streams/revoke',{method:'POST',body:{id}});current();
      const tx=prepared.transactions?.[0];
      if(prepared.transactions?.length!==1||tx?.to?.toLowerCase()!==caps.market?.toLowerCase()||!/^0x27a69ad5[0-9a-f]{64}$/i.test(tx.data??'')||BigInt(tx.chainId??0)!==BigInt(caps.chain_id)||BigInt(tx.value??0)!==0n)throw Error('The revocation transaction does not match this THOT market.');
      const provider=getProvider();if(!provider?.request)throw Error('New offers are stopped in thot. Open a wallet to invalidate prepared authorizations on chain.');
      const selected=await provider.request({method:'eth_accounts'});current();
      if(selected?.[0]?.toLowerCase()!==wallet.toLowerCase())throw Error('New offers are stopped in thot. Choose the linked seller wallet to revoke on chain.');
      const chain=await provider.request({method:'eth_chainId'});current();
      if(BigInt(chain)!==BigInt(caps.chain_id))throw Error('New offers are stopped in thot. Switch to the configured THOT network.');
      let attempt=revocations.get(id);if(!attempt){attempt={hash:null,uncertain:false};revocations.set(id,attempt);}
      if(attempt.uncertain)throw Error('The wallet may have submitted this revocation without returning a hash. Check wallet activity before retrying.');
      if(!attempt.hash){
        attempt.uncertain=true;
        try{const hash=await provider.request({method:'eth_sendTransaction',params:[{to:tx.to,data:tx.data,value:'0x0',chainId:tx.chainId,from:wallet}]});current();if(!/^0x[0-9a-f]{64}$/i.test(hash??''))throw Error('Wallet returned no valid hash. Check wallet activity before retrying.');attempt.hash=hash;attempt.uncertain=false;}
        catch(error){if(Number(error?.code)===4001)attempt.uncertain=false;throw error;}
      }
      const receipt=await provider.request({method:'eth_getTransactionReceipt',params:[attempt.hash]});current();
      if(receipt?.transactionHash&&receipt.transactionHash.toLowerCase()!==attempt.hash.toLowerCase())throw Error('Wallet returned a receipt for another transaction.');
      if(receipt?.status==='0x0')throw Error('Revocation transaction reverted. New offers remain stopped in thot; check your wallet.');
      if(receipt?.status!=='0x1')throw Error('Revocation was submitted but is not confirmed yet. Reopen Connections to check this transaction.');
      await open();toast('Wallet revocation submitted and included. Wait for chain finality before relying on it. Funded purchases remain in force.');
    }
    else if(action==='openrouter-copy'){const current=scope();current();const input=dialog.querySelector('#openrouter-proxy');if(!input?.value)throw Error('Reconnect to create a new proxy key.');await navigator.clipboard.writeText(input.value);current();toast('Proxy key copied.');}
    return true;
  }
  function reset(){generation++;const field=dialog.querySelector('#openrouter-proxy');if(field)field.value='';const key=dialog.querySelector('#openrouter-api-key');if(key)key.value='';}
  dialog.addEventListener('close',reset);
  return {intro,handle,reset};
}
