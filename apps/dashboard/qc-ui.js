// Local automatic checks are private evidence, separate from permission to sell.
export function traceQcStatus(check){
  const state=check?.state??'not_scheduled',outcome=check?.outcome;
  const attention=Number(check?.recordings_attention??0),total=Number(check?.recordings_total??1);
  let label={preparing:'Preparing checks',queued:'Queued for checks',running:'Checking',complete:'Checked',failed:'Check unavailable',not_scheduled:'Waiting for checks'}[state]??'Check unavailable';
  let tone=state==='complete'?'checked':state==='failed'?'unavailable':'pending';
  if(state==='complete'&&outcome==='error'){label='Check unavailable';tone='unavailable';}
  else if(state==='complete'&&(attention>0||['flag','reject'].includes(outcome))){label='Needs attention';tone='attention';}
  const note=total>1?(attention?`${attention} of ${total} recordings need attention`:`${Number(check?.recordings_checked??0)} of ${total} recordings checked`):'';
  return {label,tone,note,state};
}

export function createTraceQcUI({state,api,escape}){
  let generation=0,current=null,timer=null;
  const scopeLabel=scope=>scope==='release'?'Sale version':'Private copy';
  const sources=item=>(item.capture_segments??[]).length?item.capture_segments.map((s,i)=>({id:s.trace_id,label:`Recording ${i+1}`})):[{id:item.trace_id,label:'Saved trace'}];
  function live(context){
    if(!context||context!==current||context.generation!==generation||context.accountGeneration!==state.generation||typeof document==='undefined')return null;
    const panel=document.querySelector('#trace-quality-check');
    if(panel?.dataset?.qcGeneration!==String(context.generation))return null;
    const dialog=panel.closest('dialog');
    return dialog&&!dialog.open?null:panel;
  }
  function begin(item){
    reset();
    current={generation,accountGeneration:state.generation,sources:sources(item),id:item.trace_id,scope:'private',busy:false,result:null,request:0,message:'',failures:0,refreshable:true};
    if(!current.sources.some(s=>s.id===current.id))current.id=current.sources[0].id;
    return `<section id="trace-quality-check" class="trace-qc" data-qc-generation="${generation}" aria-label="Automatic quality check">
      <div class="trace-qc-summary" data-testid="qc-reader-status" aria-live="polite"><span class="trace-qc-icon" aria-hidden="true">·</span><div><strong>Loading check status…</strong><small>Automatic · private</small></div></div>
      <div id="trace-qc-message" class="trace-qc-caption" role="status"></div>
      <details id="trace-qc-details"><summary>Check details</summary>
        <div class="trace-qc-controls">
          ${current.sources.length>1?`<label>Recording<select name="trace_id">${current.sources.map(s=>`<option value="${escape(s.id)}"${s.id===current.id?' selected':''}>${escape(s.label)}</option>`).join('')}</select></label>`:`<input type="hidden" name="trace_id" value="${escape(current.id)}">`}
          <label>Version<select name="scope"><option value="private">Private copy</option><option value="release">Sale version</option></select></label>
        </div>
        <div id="trace-qc-result"></div>
      </details>
    </section>`;
  }
  function readerStatus(context){
    if(!context.result)return {label:context.message?'Status unavailable':'Loading check status…',tone:'pending',note:'Automatic · private',state:'loading'};
    const result=context.result,report=result.report;
    const check={...result.automation};
    if(result.status==='complete'&&report){check.state='complete';check.outcome=report.status;if(result.selected_source?.coverage?.status==='incomplete'&&report.status==='pass')check.outcome='flag';}
    const status=traceQcStatus(check);
    const important=(report?.findings??[]).filter(f=>['flag','reject'].includes(f.severity)).length;
    status.note=check.state==='complete'?(important?`${important} ${important===1?'finding':'findings'} · ${scopeLabel(context.scope)}`:`${scopeLabel(context.scope)} · Local checks`):{queued:'Runs automatically in the background',running:'You can keep reading',preparing:'Waiting for the saved content',failed:'Your trace is still saved',not_scheduled:'Runs automatically in the background'}[check.state]??'Automatic · private';
    return status;
  }
  function resultHTML(context){
    const result=context.result;
    if(result?.status!=='complete'||!result.report)return '<p class="trace-qc-caption">Checks run automatically on saved content. Only you can see the results.</p>';
    const report=result.report,priority={reject:0,flag:1,info:2};
    const findings=Array.isArray(report.findings)?[...report.findings].sort((a,b)=>(priority[a.severity]??3)-(priority[b.severity]??3)).slice(0,40):[];
    const findingHTML=f=>`<li><span>${escape(f.message)}</span>${f.turn_indices?.length?`<small>Turns ${f.turn_indices.slice(0,8).map(i=>Number(i)+1).join(', ')}${f.turn_indices.length>8?'…':''}</small>`:''}</li>`;
    return `<div class="trace-qc-result" data-qc-status="${escape(report.status)}">${result.scope==='release'?'<p class="trace-qc-caption">Checking the sale version. The conversation below is your private copy.</p>':''}${result.selected_source?.coverage?.warning?`<p class="trace-qc-caption">${escape(result.selected_source.coverage.warning)}</p>`:''}
      ${findings.length?`<ul class="trace-qc-findings">${findings.map(findingHTML).join('')}</ul>`:`<p class="trace-qc-caption">${report.status==='error'?'These checks could not assess this version.':'No issues found by these local checks.'}</p>`}
      <p class="trace-qc-caption">Checks do not verify task success, set a price or approve a sale. AI review not run.</p>
      <div class="trace-qc-feedback"><span>Does this look right?</span><div>${[['agree','Looks right'],['disagree','Something is wrong'],['unsure','Not sure']].map(([decision,label])=>`<button class="text-button" type="button" data-action="qc-review" data-decision="${decision}" aria-pressed="${result.review?.decision===decision}">${label}</button>`).join('')}</div>${result.review?'<small>Feedback saved for this version.</small>':''}</div>
      <details class="trace-qc-technical"><summary>Version & check information</summary><dl><div><dt>Content version</dt><dd>${escape(result.selected_source?.content_hash??report.content_digest??'Unavailable')}</dd></div><div><dt>Check version</dt><dd>${escape(report.policy_version??'Unavailable')}</dd></div></dl><p>Only you can see these results. Human feedback is stored separately from the automated findings.</p></details>
    </div>`;
  }
  function paint(context){
    const panel=live(context);if(!panel)return;
    const status=readerStatus(context),header=panel.querySelector('[data-testid="qc-reader-status"]');
    header.dataset.qcState=status.state;header.dataset.qcTone=status.tone;
    header.innerHTML=`<span class="trace-qc-icon" aria-hidden="true">${{checked:'✓',attention:'!',unavailable:'!',pending:'·'}[status.tone]}</span><div><strong>${escape(status.label)}</strong><small>${escape(status.note)}</small></div>${context.result?.automation?.retryable?'<button class="button secondary small" type="button" data-action="qc-retry">Retry check</button>':''}`;
    panel.querySelector('#trace-qc-message').textContent=context.message;
    const result=panel.querySelector('#trace-qc-result'),html=resultHTML(context);
    // Preserve open detail sections and keyboard focus when polling unchanged data.
    if(result.innerHTML!==html){const technicalOpen=result.querySelector('.trace-qc-technical')?.open,focused=result.contains(document.activeElement)?document.activeElement.dataset.decision:null;result.innerHTML=html;if(technicalOpen&&result.querySelector('.trace-qc-technical'))result.querySelector('.trace-qc-technical').open=true;if(focused)result.querySelector(`[data-decision="${focused}"]`)?.focus();}
    panel.querySelector('#trace-qc-details > summary').textContent=status.tone==='attention'?'Review findings':'Check details';
    panel.querySelectorAll('button,select').forEach(el=>{el.disabled=context.busy;});
  }
  function errorMessage(error){
    const code=error?.message??'';
    if(/QC_STORAGE_LIMIT/.test(code))return 'Saved-check limit reached. Existing results are still available.';
    if(/QC_SOURCE_LIMIT/.test(code))return 'This version is too large for these checks. Your trace is still saved.';
    if(/RELEASE_EVIDENCE_UNAVAILABLE|RELEASE_NOT_READY|QC_RELEASE_UNAVAILABLE/.test(code))return 'Prepare a sale version first. Your private copy is checked separately.';
    if(/CHANGED|STALE|SUPERSEDED/.test(code))return 'This version changed. Checking its latest status…';
    if(/UNAVAILABLE|NOT_FOUND|FORBIDDEN/.test(code))return 'This version is unavailable. Reopen the trace to continue.';
    return 'Could not refresh check status. Your trace is still saved.';
  }
  function schedule(context){
    clearTimeout(timer);timer=null;
    const pending=['preparing','queued','running','not_scheduled'].includes(context.result?.automation?.state);
    const initialRetry=!context.result&&context.refreshable&&context.failures>0&&context.failures<=3;
    if(!live(context)||context.busy||!pending&&!initialRetry)return;
    timer=setTimeout(()=>{if(!live(context))return;if(document.hidden){schedule(context);return;}void loadSaved(context);},Math.min(15000,2000*2**Math.min(context.failures,3)));
  }
  async function loadSaved(context){
    if(!live(context))return;
    const request=++context.request;
    try{const result=await api(`/v1/contributor/library/${encodeURIComponent(context.id)}/qc?scope=${context.scope}`);if(live(context)&&context.request===request&&!context.busy){context.result=result;context.message='';context.failures=0;context.refreshable=true;paint(context);schedule(context);}}
    catch(error){if(live(context)&&context.request===request&&!context.busy){context.message=errorMessage(error);context.failures++;context.refreshable=!/UNAVAILABLE|NOT_FOUND|FORBIDDEN|RELEASE_NOT_READY/.test(error?.message??'');if(!context.refreshable)context.result=null;paint(context);schedule(context);}}
  }
  async function mount(){await loadSaved(current);}
  function onChange(element){
    const context=current,panel=live(context);
    if(!panel?.contains(element)||!['scope','trace_id'].includes(element.name))return false;
    if(context.busy)return true;
    const id=panel.querySelector('[name="trace_id"]').value,scope=panel.querySelector('[name="scope"]').value;
    if(!context.sources.some(s=>s.id===id)||!['private','release'].includes(scope))return true;
    clearTimeout(timer);++context.request;context.id=id;context.scope=scope;context.result=null;context.message='';context.failures=0;context.refreshable=true;
    paint(context);void loadSaved(context);return true;
  }
  async function handle(action,button){
    if(!['qc-review','qc-retry'].includes(action))return false;
    const context=current;if(!live(context)||context.busy)return true;
    const result=context.result,decision=button.dataset.decision;
    if(action==='qc-retry'&&!result?.automation?.retryable)return true;
    if(action==='qc-review'&&(!result?.report_digest||!['agree','disagree','unsure'].includes(decision)))return true;
    clearTimeout(timer);++context.request;context.busy=true;context.message='';paint(context);
    try{
      const response=action==='qc-retry'?await api(`/v1/contributor/library/${encodeURIComponent(context.id)}/qc/retry`,{method:'POST',body:{scope:context.scope},idempotencyKey:crypto.randomUUID()}):await api(`/v1/contributor/library/${encodeURIComponent(result.trace_id)}/qc/review`,{method:'POST',body:{scope:result.scope,source_version:result.selected_source.source_version,report_digest:result.report_digest,decision,feedback:decision==='agree'?['useful']:decision==='unsure'?['unclear']:[]}});
      if(live(context)){context.result=response;context.busy=false;context.failures=0;paint(context);schedule(context);}
    }catch(error){if(live(context)){context.busy=false;context.message=errorMessage(error);const changed=/CHANGED|STALE|SUPERSEDED/.test(error?.message??'');if(changed)context.result=null;paint(context);if(changed)void loadSaved(context);else schedule(context);}}
    return true;
  }
  function reset(){clearTimeout(timer);timer=null;generation++;current=null;}
  return {begin,mount,handle,onSubmit:async()=>false,onChange,reset};
}
