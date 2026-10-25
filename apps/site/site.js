// Keep existing helper links working after the homepage moved to this route.
// Only known app fragments are forwarded, always to the same origin.
if (/^#(?:thot|thot-robinhood|thot-history|trace)=/.test(window.location.hash) || new URLSearchParams(window.location.search).has('oauth_state_id')) {
  window.location.replace('/app' + window.location.search + window.location.hash);
}

(() => {
  'use strict';

  // Only the server's launch configuration can enable a trading destination.
  // A failed or incomplete response leaves the trading link hidden.
  async function showPublishedToken() {
    const tokenState=document.getElementById('token-state');
    if(tokenState)tokenState.textContent='Published token information is unavailable. Check again shortly.';
    try {
      const response = await fetch('/v1/public/launch-config', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const config = await response.json();
      if(config.state!=='launched'||config.chain!=='Robinhood Chain'){if(tokenState)tokenState.textContent='Trading links are not enabled for this environment.';return;}
      if (typeof config.tokenAddress !== 'string' || (!/^0x[0-9a-fA-F]{40}$/.test(config.tokenAddress)||/^0x0{40}$/i.test(config.tokenAddress))) return;
      if (typeof config.tokenUrl !== 'string') return;
      const url = new URL(config.tokenUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname!=='www.ponsfamily.com' || !/^\/launchpad\/0x[0-9a-fA-F]{40}$/.test(url.pathname) || url.search || url.hash) return;
      document.querySelectorAll('[data-token-link]').forEach((link) => {
        link.href = url.href;
        link.rel = 'noopener noreferrer';
        link.hidden = false;
      });
      if(tokenState)tokenState.textContent='THOT is live on Robinhood Chain.';
      const contract=document.getElementById('token-contract'),address=document.getElementById('thot-contract-address'),copy=document.getElementById('copy-token-address');
      if(address)address.textContent=config.tokenAddress;if(contract)contract.hidden=false;
      if(copy)copy.addEventListener('click',async()=>{const status=document.getElementById('token-copy-status');try{await navigator.clipboard.writeText(config.tokenAddress);if(status)status.textContent='Contract address copied.';}catch{if(status)status.textContent='Copy unavailable. Select the displayed address to copy it.';}});
    } catch {
      // Launch information is optional; the rest of the page works without it.
    }
  }

  void showPublishedToken();
})();
