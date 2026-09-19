export function createInferenceUI({state,api,openDialog,dialog,refresh,escape,json,money,badge}) {
  let active=null,capture=null;
  const url=id=>'/v1/inference/requests/'+encodeURIComponent(id);
  const requireOwner=flow=>{if(state.role!=='user'||state.actor?.id!==flow.owner)throw new Error('Return to the contributor account that authorized this request.');};
  function actionHTML(item) {
    if(item.currency!=='USD'||item.disposition!=='inference_credit')return '';
    return `<div class="inference-action"><button class="button secondary small" data-action="external-inference" data-id="${escape(item.entitlement_id??item.id)}">${state.inferenceCapabilities?.enabled?'Start a model conversation':'Model connection status'} ↗</button><small>External calls require separate consent and an operator spending cap.</small></div>`;
  }
  function historyHTML() {
    const requests=state.inferenceRequests??[];
    return `<section class="panel audit-card"><h2>Metered inference requests</h2><p>${state.inferenceCapabilities?.enabled?'External inference is enabled. Only a separately authorized prompt is sent; vault traces are not automatically included.':'External inference is disabled. Local simulations do not call a model.'}</p>${requests.length?requests.map(r=>`<div class="meta-pair"><span>${escape(r.provider)} · ${escape(r.request_id.slice(0,8))}<br>${badge(r.status)}</span><span>${escape(money(r.actual_minor??r.reserved_minor,r.currency))}${r.actual_minor===undefined?' held':' accrued'} <button class="text-button" data-action="inference-record" data-id="${escape(r.request_id)}">Inspect request →</button></span></div>`).join(''):'<p class="legal-note">No external inference requests recorded.</p>'}</section>`;
  }
  async function showRecord(id) {
    const r=await api(url(id));
    const caution=r.status==='UNCERTAIN'?'The provider charge is unknown. Credit stays reserved, and new requests are blocked pending operator reconciliation. Do not replay this request directly at the provider.':r.status==='PROCESSING'?'The request may still be running. Refresh its status; it will not be automatically resubmitted.':'Charges use the approved token tariff and are recorded as a provider payable, not proof of invoice payment.';
    openDialog(r.status==='COMPLETED'?'Your model response':'Model request status',r.status==='COMPLETED'?'Read the response, then choose whether to save it to your private portfolio.':caution,`${badge(r.status)}${r.billing_resolution?`<p>Billing review: ${escape(r.billing_resolution.replaceAll('_',' ').toLowerCase())}. This does not establish that a response was successfully delivered or an invoice was paid.</p>`:''}${r.output?`<h3>Response</h3><pre class="json-view">${escape(r.output.text)}</pre>`:''}<div class="meta-pair"><span>${r.actual_minor===undefined?'Credit held':'Credit used'}</span><strong>${escape(money(r.actual_minor??r.reserved_minor,r.currency))}</strong></div><details class="technical-details"><summary>Usage and technical receipt</summary><p>${escape(caution)}</p><pre class="json-view">${json({...r,output:undefined})}</pre></details>`,
      `<button class="button secondary" data-action="inference-record" data-id="${escape(id)}">Refresh status</button>${r.status==='COMPLETED'&&!r.content_deleted?`<button class="button" data-action="capture-inference" data-id="${escape(id)}">Save conversation to portfolio</button>`:''}${r.status==='QUEUED'?`<button class="button secondary" data-action="cancel-external-inference" data-id="${escape(id)}">Cancel & release credit</button><button class="button" data-action="execute-external-inference" data-id="${escape(id)}">Send authorized prompt</button>`:!r.content_deleted&&r.status!=='PROCESSING'?`<button class="button secondary" data-action="delete-inference-prompt" data-id="${escape(id)}">Delete local prompt & response</button>`:''}`);
  }
  async function handle(action,button) {
    const id=button.dataset.id;
    if(action==='external-inference'){
      const capability=await api('/v1/inference/capabilities');state.inferenceCapabilities=capability;
      if(!capability.enabled){openDialog('Inference is not connected','No external request can run in this configuration.','<p>The metered inference adapter is implemented but disabled. The operator must explicitly configure credentials, a current verified rate card and a spending cap.</p><p class="legal-note">Synthetic sale proceeds are not real provider funding. No credentials are requested in this form. See docs/inference.md for setup and reconciliation boundaries.</p>');return true;}
      const entitlement=state.earnings.entitlements.find(e=>(e.entitlement_id??e.id)===id);
      if(!entitlement||BigInt(entitlement.available_minor)<BigInt(capability.reservation_minor))throw new Error('This entitlement has insufficient credit for the displayed maximum reservation.');
      openDialog('Authorize external inference','This is a real provider call when configured—not a simulation.',`<p>${escape(capability.notice)}</p><div class="meta-pair"><span>Provider / model</span><strong>${escape(capability.provider)} / ${escape(capability.rate_card.model)}</strong></div><div class="meta-pair"><span>Maximum credit reservation</span><strong>${escape(money(capability.reservation_minor))}</strong></div><p class="legal-note">Only the prompt you enter below is sent, first for input-token counting and then for generation. No vault trace or account evidence is attached. Provider data policies still apply; requesting no stored response does not guarantee zero retention. Unknown charges remain held.</p><div class="field"><label for="inference-prompt">Your prompt</label><textarea id="inference-prompt" maxlength="20000" spellcheck="false"></textarea></div><label class="consent-check"><input id="external-inference-consent" type="checkbox"><span>I authorize sending this prompt to the displayed provider and using up to the displayed credit amount under this rate card.</span></label><details><summary>Approved rate card</summary><pre class="json-view">${json(capability.rate_card)}</pre></details>`, '<button class="button secondary" data-action="close-dialog">Keep private</button><button class="button" data-action="submit-external-inference">Reserve credit & send prompt</button>');
      active={owner:state.actor.id,entitlement:id,capability,key:crypto.randomUUID(),requestId:null,body:null};return true;
    }
    if(action==='submit-external-inference'){
      const flow=active;if(!flow)throw new Error('Reopen the inference authorization form.');requireOwner(flow);
      if(!flow.body){
        if(!document.querySelector('#external-inference-consent')?.checked)throw new Error('Confirm the external-processing authorization before proceeding.');
        const prompt=document.querySelector('#inference-prompt')?.value;if(!prompt?.trim())throw new Error('Enter a prompt.');
        flow.body={entitlement_id:flow.entitlement,prompt,provider:flow.capability.provider,rate_card_hash:flow.capability.rate_card_hash,max_cost_minor:flow.capability.reservation_minor,consent_external_processing:true};
        document.querySelector('#inference-prompt').disabled=true;document.querySelector('#external-inference-consent').disabled=true;
      }
      if(!flow.requestId){const result=await api('/v1/inference/requests',{method:'POST',body:flow.body,idempotencyKey:flow.key});flow.requestId=result.request_id;}
      requireOwner(flow);await api(url(flow.requestId)+'/execute',{method:'POST',body:{}});requireOwner(flow);await refresh();await showRecord(flow.requestId);return true;
    }
    if(action==='capture-inference'){
      const r=await api(url(id));
      if(r.status!=='COMPLETED'||r.content_deleted)throw new Error('Only a completed conversation with retained content can be saved.');
      capture={owner:state.actor.id,id,key:crypto.randomUUID()};
      openDialog('Save this conversation','Save the original prompt and response to your private portfolio.',`<h3>Response</h3><pre class="json-view">${escape(r.output?.text??'')}</pre><p>thot market records this capture as operator evidence. It is not a provider-signed or TEE-verified conversation. Saving does not share it with a buyer or make another model call.</p><label class="consent-check"><input id="capture-rights" type="checkbox"><span>I have the right to store and analyze this prompt and response.</span></label><label class="consent-check"><input id="capture-output-license" type="checkbox"><span>Optional: I have the rights to include assistant output in future release previews. I still approve every release.</span></label>`,`<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" data-action="confirm-capture-inference" data-id="${escape(id)}">Save to portfolio</button>`);return true;
    }
    if(action==='confirm-capture-inference'){
      if(!capture||capture.id!==id)throw new Error('Open the conversation again before saving.');
      const flow=capture;requireOwner(flow);
      if(!document.querySelector('#capture-rights')?.checked)throw new Error('Confirm your rights before saving this conversation.');
      await api(url(id)+'/capture',{method:'POST',idempotencyKey:flow.key,body:{rights_confirmed:true,model_output_licensed:document.querySelector('#capture-output-license')?.checked===true}});
      requireOwner(flow);capture=null;dialog.close();state.view='vault';await refresh();return true;
    }
    if(action==='inference-record'){await showRecord(id);return true;}
    if(action==='execute-external-inference'){await api(url(id)+'/execute',{method:'POST',body:{}});await refresh();await showRecord(id);return true;}
    if(action==='cancel-external-inference'){await api(url(id)+'/cancel',{method:'POST',body:{}});await refresh();await showRecord(id);return true;}
    if(action==='delete-inference-prompt'){
      openDialog('Delete local inference content','Usage and accounting records will remain.','<p>This removes the inference request’s encrypted prompt and response. A conversation separately saved to your portfolio remains there. It cannot erase provider-side records or undo a provider charge.</p>',`<button class="button secondary" data-action="close-dialog">Keep content</button><button class="button" data-action="confirm-delete-inference" data-id="${escape(id)}">Delete local content</button>`);return true;
    }
    if(action==='confirm-delete-inference'){await api(url(id)+'/delete-content',{method:'POST',body:{}});dialog.close();await refresh();return true;}
    return false;
  }
  return {actionHTML,historyHTML,handle};
}
