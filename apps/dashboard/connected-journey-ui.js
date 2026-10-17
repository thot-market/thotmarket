/** Presentation only. Account, consent and payment state come from the existing APIs. */
export function welcomeHTML(signIn) {
  return `<section class="journey-welcome"><div><p class="eyebrow">The AI relay that pays you back.</p><h1>Use AI.<br><em>Get paid.</em></h1><p>Keep your tools. Earn THOT when your traces sell.</p><div class="journey-signin">${signIn}</div><p class="journey-fine">Your work stays private until you choose what to share.</p></div><aside class="journey-example" aria-label="How thot works"><div class="journey-example-step"><span aria-hidden="true">⌘</span><div><strong>You did the work.</strong><p>A conversation with your usual AI tool.</p></div></div><div class="journey-arrow" aria-hidden="true">↓</div><div class="journey-example-step"><span aria-hidden="true">▤</span><div><strong>Keep a useful trace.</strong><p>Save privately. Review what you share.</p></div></div><div class="journey-arrow" aria-hidden="true">↓</div><div class="journey-example-result"><span>On your terms</span><h2>A trace sold.<br>THOT earned.</h2><p>A buyer must complete a purchase. Saving or listing alone does not earn tokens.</p></div></aside></section><section class="journey-tools" aria-label="Supported tools"><span>Keep using</span><strong>OpenRouter</strong><strong>Claude Code</strong><strong>Codex</strong></section>`;
}

export function createConnectedJourneyUI({state,openDialog,escape,thotUI}) {
  const option=(name,copy,action,client='')=>`<button class="journey-option" data-action="${action}"${client?` data-client="${client}"`:''}><span><strong>${name}</strong><small>${copy}</small></span><span aria-hidden="true">→</span></button>`;
  function chooser(){
    openDialog('Keep using your tools.','Choose how to bring your AI work to thot.',`<div class="journey-chooser">${option('OpenRouter','Connect your key. Record through the thot relay.','openrouter-open')}${option('Claude Code','Import history or connect local sessions.','journey-local','claude')}${option('Codex','Import history or connect local sessions.','journey-local','codex')}</div><p class="legal-note">Saving is private. Listing a trace requires separate permission.</p>`);
  }
  async function handle(action,button){
    if(action==='journey-add'){chooser();return true;}
    if(action==='journey-local'){
      const client=button.dataset.client==='claude'?'claude':'codex',name=client==='claude'?'Claude Code':'Codex';
      openDialog(name,'Choose what you want to save.',`<div class="journey-chooser">${option('Import a conversation','Choose one coding-session JSONL file, up to 2 MB.','import-research')}${option('Daily history uploads','Opt in to private uploads from folders you select.','history-sync-open',client)}${option('Capture a new session','Launch through the helper to record new work.','setup-'+client)}</div><details class="technical-details"><summary>Import or live capture?</summary><p>Uploaded history is unverified. Live capture records sessions launched through the helper; it does not collect other conversations. Each connection has its own consent and revocation controls.</p></details>`);return true;
    }
    if(action==='journey-connections'){
      openDialog('Your connections','Manage each way you save work.',`<div class="journey-chooser">${option('OpenRouter','Provider key, relay configuration and signed sale policies.','openrouter-open')}${option('Daily history uploads','Status, pause, resume or revoke an uploader.','history-sync-manage')}${option('Live capture','Connected coding tools and capture permissions.','library-connections')}</div>`);return true;
    }
    if(action==='journey-wallet'){
      openDialog('Your wallet','Token holdings and sale proceeds are separate.',`<div class="journey-wallet-detail">${thotUI.walletSummaryHTML()||'<p>Balance unavailable. Refresh account details to try again.</p>'}</div>${state.thot?.wallet?`<p class="journey-address"><code>${escape(state.thot.wallet)}</code></p>`:''}<div class="actions"><button class="button secondary" data-view="thot">Manage THOT</button>${state.role==='user'?'<button class="button secondary" data-view="earnings">View earnings</button>':''}<button class="button secondary" data-action="refresh">Refresh balances</button></div>`);return true;
    }
    return false;
  }
  return {handle};
}
