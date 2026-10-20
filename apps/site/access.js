(() => {
  'use strict';
  const link = document.getElementById('reviewer-link');
  const status = document.getElementById('access-status');
  const helperNote = document.getElementById('helper-note');
  const migration = document.getElementById('access-migration');
  // A helper capability belongs to its original app. Never relay it to another origin.
  const helper = /^#(?:thot|thot-robinhood|thot-history|trace)=/.test(window.location.hash);
  if (helper) helperNote.hidden = false;
  const navigationFragments = new Set(['', '#referrals', '#thot-available', '#thot-purchases', '#thot-history', '#thot-contribute', '#my-work', '#earnings', '#receipts', '#thot', '#leaderboard']);
  // Only these non-secret view names may move to the configured application.
  // Keep every capability, OAuth query and unknown fragment on its original host.
  const ordinaryEntry = !window.location.search && navigationFragments.has(window.location.hash);

  function showMigration() {
    document.getElementById('access-workspace').hidden = true;
    migration.hidden = false;
    link.hidden = true;
    link.removeAttribute('href');
    helperNote.hidden = true;
  }
  // The built page stays closed even if a stale configuration response is cached.
  if (migration && !migration.hidden) { showMigration(); return; }

  function safeOrigin(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.search || url.hash
        || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1'
        || /^127\./.test(host) || /^::ffff:7f[0-9a-f]{2}:/.test(host)) return null;
      return url.origin;
    } catch { return null; }
  }

  function safeWorkspace(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return safeOrigin(url.origin) && value === url.origin + '/app' ? value : null;
    } catch { return null; }
  }

  function copy(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  async function loadAccess() {
    status.textContent = 'Workspace access is currently unavailable. Please try again shortly.';
    try {
      const response = await fetch('/v1/public/site-config', { credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const config = await response.json();
      if (config.access === 'migration') { showMigration(); return; }
      const wallet = config.access === 'wallet';
      const target = wallet ? safeWorkspace(config.appUrl) : config.access === 'invited-reviewers' ? safeOrigin(config.reviewerUrl) : null;
      if (!target) return;
      link.href = target;
      link.hidden = false;
      if (wallet) {
        if (target === window.location.origin + window.location.pathname.replace(/\/$/, '')) {
          link.hidden = true;
          link.removeAttribute('href');
          status.textContent = 'Workspace access is unavailable: the configured destination returns to this access page.';
          return;
        }
        if (ordinaryEntry) {
          window.location.replace(target + window.location.hash);
          return;
        }
        copy('access-intro', 'Your workspace is available.');
        copy('access-description', 'Sign in to import conversations, connect your tools and manage the work you choose to sell.');
        copy('access-link-label', 'Open workspace');
        status.textContent = helper
          ? 'This connection link belongs to its original app. Its capability has not been forwarded.'
          : 'Open the workspace to continue. Sign-in and connection data stay on their original origin.';
      } else {
        copy('access-intro', 'The app is in private preview.');
        copy('access-title', 'For invited reviewers.');
        copy('access-description', 'Open your private trace workspace. Sign in with your invited email account to review the contribution journey.');
        copy('access-link-label', 'Open reviewer app');
        status.textContent = 'Opens the separate reviewer app. Sign in with your invited account.';
      }
    } catch {
      // The unavailable state remains truthful when configuration cannot be loaded.
    }
  }
  void loadAccess();
})();
