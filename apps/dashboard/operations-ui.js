export function createOperationsUI({api,refresh,openDialog,dialog,toast,state,escape,json,money}){
  let billingRecords=[];
  const sectionHTML=()=>'<section class="panel audit-card"><p class="eyebrow">SAFETY & ACCOUNTING</p><h2>Pause safely. Review the evidence.</h2><p>Incident controls stop new work without erasing existing debts. Billing decisions require a configured verifier and an independent reviewer.</p><div class="operator-actions"><button class="button secondary" data-action="operations-status">Review incident controls →</button><button class="button secondary" data-action="billing-status">Review billing evidence →</button></div></section>';
  const checkOwner=owner=>{if(state.actor?.id!==owner||state.role!=='operator_security')throw new Error('Return to the operator account that opened this review.');};
  function formTask(form,task){
    const error=form.querySelector('[role="alert"]');
    form.addEventListener('submit',event=>{event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;
      Promise.resolve().then(task).catch(e=>{error.textContent=e.message;error.hidden=false;}).finally(()=>{if(button.isConnected)button.disabled=false;});
    });
  }
  async function operations(){
    const owner=state.actor?.id,generation=state.generation;checkOwner(owner);const record=await api('/v1/operator/operations');checkOwner(owner);if(generation!==state.generation)throw new Error('Return to the operator account that opened this review.');const key=crypto.randomUUID();let body,saved=false;
    openDialog('Incident controls','Pauses do not undo payments, submitted inference or downloaded copies.',`<p>${record.alerts.length?escape(record.alerts.join(' · ')):'No configured operational alert is currently active.'}</p><form id="operations-form"><p>Revision ${escape(record.control.revision)}. Newer operator changes cannot be overwritten by this review.</p>${[['sales','Pause new sales and matching'],['inference','Pause new inference requests'],['deliveries','Pause licensed downloads']].map(([name,label])=>`<label class="consent-check"><input name="${name}" type="checkbox" ${record.control[name]?'checked':''}><span>${label}</span></label>`).join('')}<div class="field"><label for="incident-reason">Reason</label><select id="incident-reason"><option value="MAINTENANCE">Maintenance</option><option value="SECURITY_INCIDENT">Security incident</option><option value="PROVIDER_INCIDENT">Provider incident</option><option value="ACCOUNTING_REVIEW">Accounting review</option></select></div><label class="consent-check"><input id="incident-resume" type="checkbox"><span>I have reviewed the incident before resuming any paused activity.</span></label><p class="legal-note">Committed settlement, billing review, cancellation, retention and deletion continue. Already submitted external requests cannot be recalled.</p><p role="alert" hidden></p><button type="submit" class="button">Save incident controls</button></form><details><summary>Safe aggregate metrics</summary><pre class="json-view">${json(record.metrics)}</pre></details>`);
    const form=document.querySelector('#operations-form');
    formTask(form,async()=>{
      checkOwner(owner);
      if(!body){const paused=Object.fromEntries(['sales','inference','deliveries'].map(name=>[name,form.elements[name].checked]));const reviewed=document.querySelector('#incident-resume').checked;
        if(['sales','inference','deliveries'].some(name=>record.control[name]&&!paused[name])&&!reviewed)throw new Error('Confirm incident review before resuming paused activity.');
        body={expected_revision:record.control.revision,paused,reason_code:document.querySelector('#incident-reason').value,acknowledge_resume:reviewed};
        for(const control of form.querySelectorAll('input,select'))control.disabled=true;}
      if(!saved){await api('/v1/operator/controls',{method:'POST',body,idempotencyKey:key});saved=true;}
      checkOwner(owner);await refresh();dialog.close();toast('Incident controls recorded. Existing obligations were not erased.');
    });
  }
  async function billing(){
    const owner=state.actor?.id,generation=state.generation;checkOwner(owner);const result=await api('/v1/operator/billing');checkOwner(owner);if(generation!==state.generation)throw new Error('Return to the operator account that opened this review.');billingRecords=result.records;
    openDialog('Billing evidence & review','Signed accounting evidence is not proof of invoice payment.',`<p>${result.capabilities.enabled?'A billing verifier and independent reviewers are configured. Review the source evidence out of band before approving.':'Billing decisions are disabled until a trusted verifier and two independent operator identities are configured.'}</p><p class="legal-note">A provider-billing verifier must authenticate the original evidence. An uploaded JSON file or operator assertion alone cannot clear an uncertain charge. No payment is sent.</p>${billingRecords.length?billingRecords.map(record=>`<div class="meta-pair"><span>${escape(record.kind)} · ${escape(record.status)}<br>${escape(money(record.amount_minor))} · ${escape(record.environment)}</span><button class="text-button" data-action="billing-record" data-id="${escape(record.evidence_record_id)}">Inspect review →</button></div>`).join(''):'<p>No billing evidence recorded.</p>'}${result.capabilities.enabled?'<button class="button secondary" data-action="billing-submit">Import signed billing evidence →</button>':''}`);
  }
  async function handle(action,button){
    if(['operations-status','billing-status','billing-record','billing-approve','billing-reject','billing-submit'].includes(action)&&state.role!=='operator_security')throw new Error('Operator permission required.');
    if(action==='operations-status'){await operations();return true;}
    if(action==='billing-status'){await billing();return true;}
    if(action==='billing-record'){
      const r=billingRecords.find(r=>r.evidence_record_id===button.dataset.id);if(!r)throw new Error('Refresh the evidence list.');
      openDialog('Review signed billing evidence','The original signed evidence is immutable. This review will not send money.',`<pre class="json-view">${json(r)}</pre><p class="legal-note">An approval relies on the configured verifier’s signature and your independent review of the committed source evidence. Do not approve on amount alone.</p>${r.status==='PENDING_REVIEW'?'<label class="consent-check"><input id="billing-confirm" type="checkbox"><span>I independently reviewed the source evidence and exact request, tariff, amount and evidence commitments.</span></label>':''}`,r.status==='PENDING_REVIEW'?`<button class="button secondary" data-action="billing-reject" data-id="${escape(r.evidence_record_id)}">Reject evidence</button><button class="button" data-action="billing-approve" data-id="${escape(r.evidence_record_id)}">Approve reviewed evidence</button>`:'');return true;
    }
    if(action==='billing-approve'||action==='billing-reject'){
      if(action==='billing-approve'&&!document.querySelector('#billing-confirm')?.checked)throw new Error('Confirm independent source-evidence review first.');
      await api('/v1/operator/billing/'+encodeURIComponent(button.dataset.id)+(action==='billing-approve'?'/approve':'/reject'),{method:'POST',body:{}});await billing();return true;
    }
    if(action==='billing-submit'){
      const owner=state.actor.id,key=crypto.randomUUID();let body,saved=false;
      openDialog('Import signed billing evidence','Only a configured verifier’s signature can be accepted.','<form id="billing-form"><div class="field"><label for="billing-json">Signed evidence JSON</label><textarea id="billing-json" maxlength="100000" required spellcheck="false"></textarea><small>No API key, signing key, prompt, account record or raw invoice belongs here. See the billing evidence schema.</small></div><label class="consent-check"><input id="billing-source-review" type="checkbox" required><span>I reviewed the signed evidence and submit it for independent approval.</span></label><p role="alert" hidden></p><button type="submit" class="button">Submit evidence for review</button></form>');
      const form=document.querySelector('#billing-form');formTask(form,async()=>{
        checkOwner(owner);if(!body){try{body=JSON.parse(document.querySelector('#billing-json').value);}catch{throw new Error('Enter a valid signed JSON evidence object.');}for(const field of form.querySelectorAll('input,textarea'))field.disabled=true;}
        if(!saved){await api('/v1/operator/billing/evidence',{method:'POST',body,idempotencyKey:key});saved=true;}checkOwner(owner);await billing();
      });return true;
    }
    return false;
  }
  return {sectionHTML,handle};
}
