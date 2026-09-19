// Keep existing helper links working after the homepage moved to this route.
// Only known app fragments are forwarded, always to the same origin.
if (/^#(?:thot|thot-robinhood|trace)=/.test(window.location.hash) || new URLSearchParams(window.location.search).has('oauth_state_id')) {
  window.location.replace('/app' + window.location.search + window.location.hash);
}

(() => {
  'use strict';

  // Only the server's launch configuration can enable a trading destination.
  // A failed or incomplete response leaves the trading link hidden.
  async function showPublishedToken() {
    try {
      const response = await fetch('/v1/public/launch-config', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const config = await response.json();
      if (config.state !== 'launched' || config.chain !== 'Robinhood Chain') return;
      if (typeof config.tokenAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(config.tokenAddress)) return;
      if (typeof config.tokenUrl !== 'string') return;
      const url = new URL(config.tokenUrl);
      if (url.protocol !== 'https:' || url.username || url.password) return;
      document.querySelectorAll('[data-token-link]').forEach((link) => {
        link.href = url.href;
        link.rel = 'noopener noreferrer';
        link.hidden = false;
      });
      const tokenState = document.getElementById('token-state');
      if (tokenState) tokenState.textContent = 'Published token contract available through the Trade THOT link.';
    } catch {
      // Launch information is optional; the rest of the page works without it.
    }
  }

  void showPublishedToken();
})();
