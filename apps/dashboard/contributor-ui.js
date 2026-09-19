export function createContributorUI({libraryUI,state,api,openDialog,dialog,refresh,toast,escape,json,badge,date,short}) {
  let preview = null;
  let importDraft = null;
  let activeLink = null;
  let pollTimer = null;
  let pollJobId = null;
  let pendingOAuth = typeof location !== 'undefined' && new URLSearchParams(location.search).has('oauth_state_id');

  const portfolio = () => state.contributorPortfolio ?? { items: [], robinhood: { status: 'not_linked' } };
  const credential = () => portfolio().robinhood ?? { status: 'not_linked' };
  const isLinked = () => credential().status === 'linked' || credential().status === 'verified';
  const appraisal = item => item.appraisal ?? item.current_appraisal ?? item.appraisal_history?.at?.(-1);
  const usd = value => new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(value));
  const dollars = minor => /^\d+$/.test(String(minor)) ? new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(minor)/100) : 'Not estimated';
  function downloadFile(contents,filename,type='application/json') { const url=URL.createObjectURL(new Blob([contents],{type}));const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }

  function robinhoodCard() {
    const link = credential();
    const status = link.status ?? 'not_linked';
    const pending = ['pending','created','capture_pending','awaiting_local_capture','capturing','verifying','issuing'].includes(status);
    const stage=link.stage??status;
    const labels = {not_linked:'Not connected',awaiting_plaid_link:'Finish in Plaid',created:'Opening sign-in',pending:'Connection in progress',awaiting_browser_login:'Finish signing in',capture_pending:'Finishing connection',awaiting_local_capture:'Connection in progress',capturing:'Checking account',verifying:'Verifying connection',issuing:'Finishing connection',linked:'Connected',verified:'Connected',failed:'Could not connect',expired:'Connection expired',cancelled:'Connection cancelled',disconnected:'Disconnected'};
    const displayState=pending?stage:status;
    const failureText=status==='failed'&&link.error==='NO_BROKERAGE_ACCOUNT'?'No investment account found':null;
    const capability = portfolio().capabilities?.browser_linking;
    const plaid=portfolio().capabilities?.plaid_linking===true, sandbox=portfolio().capabilities?.plaid_environment==='sandbox', witnessed=portfolio().capabilities?.robinhood_linking===true;
    const viaPlaid=link.connector==='plaid'||link.receipt?.provider==='plaid';
    if(pendingOAuth&&plaid){pendingOAuth=false;setTimeout(()=>resumePlaid().catch(error=>toast(error.message)),0);}
    const action = isLinked()
      ? `<button class="text-button" data-action="inspect-robinhood">View details</button>${viaPlaid?'<button class="button secondary small" data-action="refresh-plaid">Refresh</button>':''}${!viaPlaid?'<button class="button secondary small" data-action="link-robinhood">Renew Robinhood connection</button>':''}<button class="button secondary small" data-action="disconnect-robinhood">Disconnect</button>`
      : pending
        ? `<button class="button secondary small" data-action="poll-robinhood" data-id="${escape(link.job_id ?? '')}">View progress</button><button class="text-button" data-action="cancel-robinhood" data-id="${escape(link.job_id ?? '')}">Cancel</button>`
        : plaid ? `${witnessed?`<button class="button" data-action="link-robinhood">${status==='expired'&&!viaPlaid?'Renew Robinhood connection':'Connect real Robinhood'}</button>`:''}${status==='expired'&&viaPlaid?'<button class="button secondary" data-action="refresh-plaid">Refresh Plaid connection ↗</button>':`<button class="button secondary" data-action="link-plaid">${sandbox?'Try Plaid sandbox':'Connect with Plaid'} ↗</button>`}`
        : capability === false && !witnessed ? `<button class="button" disabled>Connection unavailable</button>` : `<button class="button" data-action="link-robinhood">Connect Robinhood ↗</button>`;
    const s=link.summary;
    const summaryLine=s?`<p class="brokerage-summary"><strong>${escape(usd(s.portfolio_value))}</strong> across ${escape(s.investment_accounts)} investment account${s.investment_accounts===1?'':'s'} · ${escape(s.positions)} positions · ${escape(s.trades_90d)} trades (${escape(usd(s.traded_volume_90d))}) in the last ${escape(s.window_days)} days</p>`:'';
    return `<article class="panel credential-card ${isLinked()?'linked':''}"><div><p class="eyebrow">BROKERAGE ACCOUNT</p><h2>${plaid?'Brokerage account':'Robinhood'}</h2><p>${isLinked()?'Verified account control can qualify your conversations for offers that require a brokerage account. Buyers learn only that you control a brokerage account, never balances or positions.':plaid?'Connect a brokerage account to qualify for offers that require one.':'Connect your account to qualify for offers that require a brokerage account.'}</p>${summaryLine}${plaid&&sandbox?`<p class="capability-note">Plaid Sandbox: a test institution, not a real account.</p>`:''}${capability===false&&!plaid&&!witnessed?`<p class="capability-note">Robinhood connection is unavailable in this setup.</p>`:''}</div><div class="credential-status">${badge(status)}<strong>${escape(failureText ?? labels[displayState] ?? status.replaceAll('_',' '))}</strong>${isLinked()?`<small>Verified ${escape(date(link.verified_at))} · expires ${escape(date(link.expires_at))}</small>`:''}<div class="credential-actions">${action}</div></div></article>`;
  }

  function linkProgressDialog(link) {
    const stage=link.stage??link.status;
    const messages={awaiting_local_capture:['Return to your connection tab','Continue in the thot market tab opened by thot-link. If that tab or its terminal was closed, cancel this attempt and start again.'],awaiting_browser_login:['Sign in to Robinhood','Use the browser window that opened. We will finish connecting automatically.'],capturing:['Checking your account','Please wait while we check your connection.'],verifying:['Verifying connection','Please wait while we verify your connection.'],issuing:['Finishing connection','Your connection is almost ready.']};
    if(portfolio().capabilities?.browser_mode==='existing_chrome')messages.awaiting_browser_login=['Connecting Robinhood','Checking the Robinhood session in your regular Chrome browser.'];
    const [title,message]=messages[stage]??['Connecting Robinhood','Finish signing in in the browser window, then keep this page open.'];
    openDialog(title,'',`<div class="link-progress simple"><span class="spinner"></span><p>${escape(message)}</p></div>`,`<button class="text-button" data-action="cancel-robinhood" data-id="${escape(link.job_id)}">Cancel</button>`);
  }

  function itemCard(item) {
    const estimate = appraisal(item);
    const source = item.source ?? item.source_type ?? 'Coding session JSONL';
    const eligible=estimate?.eligible_for_brokerage_research===true&&item.rights_status==='eligible';
    return `<article class="panel portfolio-card"><header><div><p class="eyebrow">${escape(source)}</p><h3>${escape(item.title ?? 'Imported AI conversation')}</h3></div>${badge(item.evidence?.status ?? item.evidence_status ?? 'user_supplied')}</header><p class="portfolio-summary">${escape(item.summary ?? `${item.turn_count ?? 0} detected turns`)}</p><div class="portfolio-facts"><span><small>Imported</small>${escape(date(item.imported_at ?? item.created_at))}</span><span><small>Session</small>${escape(item.turn_count ?? 0)} turns</span><span><small>Demo estimate</small>${estimate ? escape(dollars(estimate.estimated_value_minor)) : 'Pending'}</span></div><div class="portfolio-actions"><button class="text-button" data-action="inspect-portfolio" data-id="${escape(item.trace_id ?? item.id)}">View details</button>${eligible&&portfolio().capabilities?.demo_offers!==false?`<button class="button small" data-action="prepare-demo-offer" data-id="${escape(item.trace_id??item.id)}">See research offer ↗</button>`:''}</div></article>`;
  }

  function sectionHTML() {
    if(libraryUI)return libraryUI.sectionHTML()+`<details class="library-brokerage"><summary>Brokerage connection</summary>${robinhoodCard()}</details>`;
    const items = portfolio().items ?? [];
    return `<section class="contributor-demo"><div class="section-head"><div><h2>Your AI conversations</h2><p>Build a private portfolio from work you choose. <a href="/getting-started">First-time setup ↗</a></p></div>${items.length?'<button class="text-button" data-action="import-research">Add another conversation</button>':''}</div><article class="panel capture-card"><div><p class="eyebrow">${portfolio().capabilities?.tee_capture?'TEE CAPTURE':'CAPTURE YOUR SESSION'}</p><h3>Capture from Codex / Claude Code</h3><p>Connect the project you are working in and save its session to your private vault.</p></div><button class="button" data-action="start-agent-capture">See capture command ↗</button></article>${robinhoodCard()}<div class="portfolio-grid">${items.length?items.map(itemCard).join(''):`<div class="panel empty-wide"><div class="empty"><span class="empty-symbol" aria-hidden="true">▤</span><h3>Upload an AI conversation</h3><p>Supports Claude Code and Codex coding-session files (.jsonl). Review one conversation, then save it to your private portfolio.</p><button class="button secondary" data-action="import-research">Upload Claude Code or Codex conversation</button><small class="empty-truth">Uploaded history: thot market records your file, but cannot verify the original conversation.</small></div></div>`}</div>${items.length?'<p class="portfolio-disclaimer">Demo estimates are illustrative. They are not offers or earnings.</p>':''}</section>`;
  }

  function offerDemoHTML(){
    if(portfolio().capabilities?.demo_offers===false)return '';
    const items=(portfolio().items??[]).filter(item=>['eligible','eligible_with_restrictions'].includes(item.rights_status));
    if(!items.length)return '';
    return `<section class="technical-details offer-demo"><h2>Simulated research offers</h2><p>Try the existing demo with conversations saved using offer settings. Prices and settlement are simulated.</p>${robinhoodCard()}<div class="portfolio-grid">${items.map(itemCard).join('')}</div></section>`;
  }

  function importDialog() {
    preview = null;
    importDraft = null;
    openDialog('Upload a coding session','Choose one saved Claude Code or Codex coding session. You will review it before anything is saved.',`<form id="research-preview-form"><div class="field"><label for="research-file">Session file</label><input id="research-file" type="file" accept=".jsonl,application/x-ndjson" required><small>Claude Code or Codex coding-session JSONL, up to 2 MB. Choose one .jsonl session file from either coding tool.</small></div><button class="button" type="submit">Review session ↗</button></form>`);
  }

  function previewDialog(result) {
    preview = result;
    openDialog('Review conversation','Save the conversation text and supported tool activity in your private vault.',`<div class="import-preview"><div class="meta-pair"><span>Session</span><strong>${escape(result.title??importDraft?.filename??'Conversation')}</strong></div><div class="meta-pair"><span>Date</span><strong>${escape(date(result.source_date))}</strong></div><div class="meta-pair"><span>Content</span><strong>${escape(result.turn_count ?? 0)} turns</strong></div>${(result.privacy_flags??[]).length?`<div class="privacy-callout"><strong>Check before importing</strong><p>${result.privacy_flags.map(escape).join(' · ')}</p></div>`:''}<details class="technical-details"><summary>Prepare for a sale later (optional)</summary><p>Saving keeps this conversation private; these settings do not list or sell it. In Offers, preview the exact release, set its price and sign once to enable an automatic THOT sale. A matching purchase then needs no further approval.</p><label class="consent-check"><input id="research-rights" type="checkbox"><span>I can license the parts of this conversation I choose to offer, and want this import eligible for listing.</span></label><label class="consent-check"><input id="research-license" type="checkbox" disabled><span>Include assistant responses when I preview a future listing; I can license those responses.</span></label></details><details class="technical-details"><summary>Import details</summary>${(result.warnings??result.parse_warnings??[]).length?`<div class="privacy-callout warn"><strong>Import notes</strong><p>${(result.warnings??result.parse_warnings).map(escape).join(' · ')}</p></div>`:''}<div class="meta-pair"><span>Format</span><strong>${escape(result.format ?? 'Claude Code JSONL')}</strong></div><div class="meta-pair"><span>Size</span><strong>${escape(result.size_bytes ?? 0)} bytes</strong></div><div class="meta-pair"><span>Commitment</span><strong class="mono">${escape(result.content_commitment)}</strong></div><p class="legal-note">This is a user-supplied, unverified import. The receipt records what thot market analyzed.</p></details></div>`,`<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" id="confirm-research" data-action="confirm-research">Save privately</button>`);
  }

  async function openPlaid(job, receivedRedirectUri) {
    if(!window.Plaid)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdn.plaid.com/link/v2/stable/link-initialize.js';s.onload=resolve;s.onerror=()=>reject(new Error('Plaid Link failed to load.'));document.head.append(s);});
    const finish=async(fn,message)=>{try{await fn();await refresh();if(message)toast(message);}catch(error){await refresh();toast(error.message);}};
    window.Plaid.create({token:job.link_token,...(receivedRedirectUri?{receivedRedirectUri}:{}),
      onSuccess:public_token=>finish(async()=>{const result=await api(`/v1/contributor/plaid/link-jobs/${encodeURIComponent(job.job_id)}/complete`,{method:'POST',body:{public_token}});if(result.status!=='linked')throw new Error(result.error==='NO_BROKERAGE_ACCOUNT'?'No investment account was found at that institution. Connect a brokerage account.':`Connection ${result.status}: ${result.error??''}`);},'Brokerage account connected through Plaid.'),
      onExit:error=>finish(async()=>{await api(`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(job.job_id)}/cancel`,{method:'POST',body:{}});if(error)throw new Error(`Plaid Link ended: ${error.error_message??error.error_code}`);})}).open();
  }
  async function resumePlaid() {
    const returned=location.href; history.replaceState(null,'',location.pathname);
    await openPlaid(await api('/v1/contributor/plaid/link-token'),returned);
  }

  async function poll(jobId, announce = false) {
    if (!jobId) return;
    const result = await api(`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(jobId)}`);
    if(pollJobId!==jobId)return;
    state.contributorPortfolio = {...portfolio(), robinhood: result};
    const remainsPending=['pending','created','capture_pending','awaiting_local_capture','capturing','verifying','issuing'].includes(result.status);
    if (remainsPending) {
      clearTimeout(pollTimer); pollTimer=setTimeout(()=>poll(jobId).catch(()=>{}),2500);
      if(dialog.open)linkProgressDialog(result);
    } else {
      clearTimeout(pollTimer); pollTimer=null;
      if (announce) toast(result.status==='linked'||result.status==='verified'?'Robinhood account credential verified.':`Robinhood linking ended: ${result.status}.`);
    }
    if (!dialog.open) await refresh();
    else if (!remainsPending || document.querySelector('[data-action="poll-robinhood"]')) { dialog.close(); await refresh(); }
  }

  async function handle(action, button) {
    if (action === 'import-research') { importDialog(); return true; }
    if (action === 'confirm-research') {
      if (!preview) throw new Error('Choose and review a conversation first.');
      if(!importDraft)throw new Error('The selected file is no longer available. Choose it again.');
      const offers=document.querySelector('#research-rights')?.checked===true;
      let result;try{result=await api('/v1/contributor/import/confirm',{method:'POST',body:{filename:importDraft.filename,text:importDraft.text,content_commitment:preview.content_commitment,...(offers?{category:'research_flow',rights_confirmed:true,model_output_licensed:!!document.querySelector('#research-license')?.checked}:{category:'general',save_privately:true})}});}catch(error){const code=error.code??error.message;if(['REMOTE_OBJECT_WRITE_FAILED','REMOTE_OBJECT_READ_FAILED','REMOTE_OBJECT_DELETE_FAILED','REMOTE_QUOTA_NAMESPACE_MISSING','REMOTE_QUOTA_POLICY_MISMATCH','VAULT_OWNER_QUOTA','VAULT_GLOBAL_QUOTA','VAULT_JOURNAL_CAPACITY','VAULT_DISK_HEADROOM'].includes(code))throw new Error('We could not finish saving right now. Keep this file and retry; your selected file is still ready to save.');if(code==='IMPORT_CONSENT_CONFLICT')throw new Error('This conversation is already in your vault with different offer settings. Editing those settings is not available yet.');throw error;}
      preview=null; importDraft=null; dialog.close(); await refresh(); toast(result.duplicate?'This conversation was already in your vault; no duplicate was created.':offers?'Conversation saved privately with sale rights. Preview and sign a listing in Offers when ready.':'Conversation saved privately. No sale has been authorized.'); return true;
    }
    if (action === 'link-plaid') { await openPlaid(await api('/v1/contributor/plaid/link-jobs',{method:'POST',body:{}})); return true; }
    if (action === 'refresh-plaid') { const result=await api('/v1/contributor/plaid/refresh',{method:'POST',body:{}}); await refresh(); toast(result.status==='linked'?'Brokerage credential refreshed from your retained Plaid connection.':`Refresh ended: ${result.status}.`); return true; }
    if (action === 'link-robinhood') {
      const job=await api('/v1/contributor/robinhood/link-jobs',{method:'POST',body:{claim:'controls_brokerage'}});
      const started=await api(`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(job.job_id)}/browser`,{method:'POST',body:{}});
      activeLink={...job,...started};
      pollJobId=job.job_id;
      state.contributorPortfolio={...portfolio(),robinhood:activeLink};
      linkProgressDialog(activeLink);
      clearTimeout(pollTimer); pollTimer=setTimeout(()=>poll(job.job_id,true).catch(()=>{}),1200); return true;
    }
    if (action === 'poll-robinhood') { pollJobId=button.dataset.id;await poll(button.dataset.id,true); return true; }
    if (action === 'download-link-ticket') { if(!activeLink?.link_ticket)throw new Error('This link ticket is no longer available. Start a new link job.');downloadFile(JSON.stringify({link_ticket:activeLink.link_ticket,witness_url:activeLink.witness_url,appraiser_url:activeLink.appraiser_url},null,2)+'\n','thot-robinhood-link-ticket.json');return true; }
    if (action === 'download-link-public-key') { const pem=portfolio().capabilities?.link_issuer_public_key_pem;if(!pem)throw new Error('The pinned link issuer key is unavailable. Refresh before continuing.');downloadFile(String(pem),'thot-link-issuer.pem','application/x-pem-file');return true; }
    if (action === 'cancel-robinhood') { clearTimeout(pollTimer);pollTimer=null;pollJobId=null;activeLink=null;await api(`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(button.dataset.id)}/cancel`,{method:'POST',body:{}}); dialog.close(); await refresh(); toast('Robinhood linking cancelled. No credential was activated.'); return true; }
    if (action === 'disconnect-robinhood') { await api('/v1/contributor/robinhood/disconnect',{method:'POST',body:{}}); await refresh(); toast('Robinhood disconnected. It cannot be used for new matching or releases.'); return true; }
    if (action === 'inspect-robinhood') { const link=credential(),s=link.summary; const summaryRows=s?`<h3>Your account, private to you</h3><div class="meta-pair"><span>Portfolio value</span><strong>${escape(usd(s.portfolio_value))}</strong></div><div class="meta-pair"><span>Positions</span><strong>${escape(s.positions)} · largest ${escape(Math.round(s.largest_position_share*100))}% of holdings</strong></div><div class="meta-pair"><span>Trades, last ${escape(s.window_days)} days</span><strong>${escape(s.trades_90d)} (${escape(s.buys_90d)} buys, ${escape(s.sells_90d)} sells) · ${escape(usd(s.traded_volume_90d))}</strong></div><div class="meta-pair"><span>Symbols traded</span><strong>${escape(s.symbols_traded_90d.join(', ')||'none')}</strong></div><p class="legal-note">Computed inside thot market from Plaid holdings and transactions at connection time, then the Plaid connection was removed. Nothing here is shared with buyers. A Sharpe ratio needs a return series over time, which a single snapshot cannot give.</p>`:'';
      openDialog(link.receipt?.provider==='plaid'?'Brokerage account connected':'Robinhood connected','thot market verified a fresh account connection.',`<h3>What this does in thot market</h3><p>Buyers of investment research require a verified brokerage account. This credential can make your conversation eligible for those offers. It does not increase its demo estimate. A buyer sees only <span class="mono">controls_brokerage:true</span>.</p>${summaryRows}<h3>Credential</h3><div class="meta-pair"><span>Source</span><strong>${escape(link.receipt?.provider==='plaid'?`Plaid ${link.receipt?.provider_method==='plaid_sandbox_api'?'sandbox':'API'}`:'Witnessed Robinhood session')}</strong></div><div class="meta-pair"><span>Verified</span><strong>${escape(date(link.verified_at))}</strong></div><div class="meta-pair"><span>Valid until</span><strong>${escape(date(link.expires_at))}</strong></div><p class="legal-note">This confirms account control through the connection flow. It does not prove identity, performance, holdings, or that your research caused a trade.</p><details class="technical-details"><summary>Technical receipt</summary><pre class="json-view">${json(link.receipt ?? link)}</pre><button class="text-button" data-action="download-robinhood-proof" data-id="${escape(link.credential_id??link.receipt?.receipt_id??'')}">Download original proof ↓</button></details>`); return true; }
    if (action === 'download-robinhood-proof') { if(!button.dataset.id)throw new Error('The linked credential identifier is unavailable. Refresh before downloading proof.');const proof=await api(`/v1/contributor/robinhood/credentials/${encodeURIComponent(button.dataset.id)}/proof`);downloadFile(JSON.stringify(proof,null,2)+'\n',`thot-robinhood-proof-${button.dataset.id}.json`);return true; }
    if(action==='prepare-demo-offer'){openDialog('Prepare a simulated research offer','This local setup demonstrates eligibility and exact-release consent. It does not create a real buyer or move money.',`<p>thot market will create a labeled simulated buyer mandate and a manual licensing policy limited to the <span class="mono">brokerage_control</span> predicate and a scrubbed trace body.</p><p>No content is released by this step. You will review the exact scrubbed bytes, disclosed predicate, price and license in Offers before deciding whether to authorize.</p>`,`<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" data-action="confirm-demo-offer" data-id="${escape(button.dataset.id)}">Create simulated offer ↗</button>`);return true;}
    if(action==='confirm-demo-offer'){await api(`/v1/contributor/portfolio/${encodeURIComponent(button.dataset.id)}/demo-offer`,{method:'POST',body:{}});dialog.close();state.view='market';await refresh();toast('Simulated brokerage-research offer prepared. Review the exact release before authorizing.');return true;}
    if (action === 'inspect-portfolio') { const item=(portfolio().items??[]).find(x=>(x.trace_id??x.id)===button.dataset.id); if(!item)throw new Error('That portfolio item is unavailable.'); const value=appraisal(item); openDialog(item.title??'AI conversation','Evidence and the versioned appraisal are separate records.',`<div class="meta-pair"><span>Evidence</span><strong>${badge(item.evidence?.status??item.evidence_status??'user_supplied')}</strong></div><div class="meta-pair"><span>Content commitment</span><strong class="mono">${escape(item.content_commitment??item.trace_id)}</strong></div>${item.agent_capture_id?`<button class="button secondary" data-action="verify-agent-capture" data-id="${escape(item.agent_capture_id)}">Check capture integrity</button>`:''}<h3>Appraisal explanation</h3>${value?`<div class="estimate"><strong>${escape(dollars(value.estimated_value_minor))}</strong><span>demonstration estimate · ${escape(value.estimator_version??'versioned')}</span></div><pre class="json-view">${json(value.contributions??value)}</pre>`:'<p>Appraisal is pending.</p>'}<p class="legal-note">Evidence strength, estimated value, offer price and earned balance are different records. A linked brokerage credential may establish buyer eligibility; it does not authenticate this conversation.</p>`); return true; }
    return false;
  }

  function onChange(target) {
    if (target.id === 'research-rights' || target.id === 'research-license') {
      const offers=document.querySelector('#research-rights')?.checked===true,confirm=document.querySelector('#confirm-research'),license=document.querySelector('#research-license');if(confirm){confirm.disabled=false;confirm.textContent=offers?'Save privately with sale rights':'Save privately';}if(license)license.disabled=!offers;
      return true;
    }
    return false;
  }

  async function onSubmit(form) {
    if(form.id==='robinhood-proof-form'){
      if(!activeLink?.job_id)throw new Error('This link job is no longer active. Start a new one.');
      const file=document.querySelector('#robinhood-proof')?.files?.[0];if(!file)throw new Error('Choose the signed public proof envelope.');
      if(file.size>1_000_000)throw new Error('Choose a proof envelope no larger than 1 MB.');
      if(!file.name.toLowerCase().endsWith('.json'))throw new Error('Choose the helper’s .json public proof envelope.');
      let evidence;try{evidence=JSON.parse(await file.text());}catch{throw new Error('The proof envelope is not valid JSON.');}
      if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))throw new Error('The proof envelope must be a JSON object.');
      await api(`/v1/contributor/robinhood/link-jobs/${encodeURIComponent(activeLink.job_id)}/complete`,{method:'POST',body:{evidence}});
      activeLink=null;pollJobId=null;clearTimeout(pollTimer);pollTimer=null;dialog.close();await refresh();toast('Robinhood account credential verified and linked.');return true;
    }
    if (form.id !== 'research-preview-form') return false;
    const file=document.querySelector('#research-file')?.files?.[0];
    if(!file)throw new Error('Choose one Claude Code or Codex JSONL file.');
    if(file.size>2*1024*1024)throw new Error('Choose a coding-session JSONL file smaller than 2 MB.');
    if(!file.name.toLowerCase().endsWith('.jsonl'))throw new Error('Choose a .jsonl coding-session file.');
    importDraft={filename:file.name,text:await file.text()};
    const result=await api('/v1/contributor/import/preview',{method:'POST',body:importDraft});
    previewDialog(result); return true;
  }

  function resetPreview() { preview=null; importDraft=null; }
  function reset() { libraryUI?.reset();clearTimeout(pollTimer); pollTimer=null; pollJobId=null; activeLink=null; resetPreview(); }
  return {sectionHTML,offerDemoHTML,handle,onChange,onSubmit,reset,resetPreview};
}
