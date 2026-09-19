const CLERK_JS_VERSION = '6.31.0';
const CLERK_UI_VERSION = '1.32.2';

function configuredOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The sign-in service URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The sign-in service URL is invalid.');
  return url.origin;
}

function loadScript(document, src, attributes = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('The email sign-in service could not be loaded. Please refresh and try again.')), { once: true });
    document.head.append(script);
  });
}

export function createClerkAuthUI({ document, window, fetch, onSession, onSignedOut, onIdentityChanging = () => {}, onError }) {
  let clerk = null, listener = null, epoch = 0, mounted = null, currentIdentity = Symbol('not-initialized'), objectSequence = 0;
  const objectIds = new WeakMap();

  function identityKey(session, user) {
    if (!session) return null;
    if (!objectIds.has(session)) objectIds.set(session, ++objectSequence);
    return `${session.id ?? objectIds.get(session)}:${user?.id ?? ''}`;
  }

  async function verifySession(session, expectedEpoch) {
    const token = await session.getToken();
    if (expectedEpoch !== epoch || !token) return;
    const response = await fetch('/v1/auth/session', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store', redirect: 'error' });
    if (expectedEpoch !== epoch) return;
    const result = await response.json().catch(() => ({}));
    if (expectedEpoch !== epoch) return;
    if (!response.ok) {
      if (response.status === 403) throw new Error('This email is not invited to this thot market demo yet. Ask the demo owner for access.');
      throw new Error('thot market could not verify this sign-in. Please sign out and try again.');
    }
    await onSession({ actor: result.actor, token, permissions:result.permissions??{} });
  }

  function transition(resources) {
    const session = resources?.session ?? null, key = identityKey(session, resources?.user);
    if (key === currentIdentity) return;
    currentIdentity = key;
    const current = ++epoch;
    onIdentityChanging();
    if (!session) { void onSignedOut(); return; }
    void verifySession(session, current).catch(error => { if (current === epoch) onError(error); });
  }

  function mountSignIn(target) {
    if (!clerk || !target) return false;
    if (mounted && mounted !== target) clerk.unmountSignIn?.(mounted);
    mounted = target; clerk.mountSignIn(target, { fallbackRedirectUrl: '/app', signUpFallbackRedirectUrl: '/app' }); return true;
  }

  async function initialize(config, injected = null) {
    const origin = configuredOrigin(config.frontend_api_url);
    if (!/^pk_(test|live)_[^\s]{20,500}$/.test(config.publishable_key ?? '')) throw new Error('Email sign-in is not configured correctly.');
    if (injected?.clerk) clerk = injected.clerk;
    else {
      await loadScript(document, `${origin}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`);
      await loadScript(document, `${origin}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, { 'data-clerk-publishable-key': config.publishable_key });
      clerk = window.Clerk;
    }
    if (!clerk) throw new Error('The email sign-in service did not initialize.');
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, signInFallbackRedirectUrl: '/app', signUpFallbackRedirectUrl: '/app', afterSignOutUrl: '/app' });
    listener?.();
    listener = clerk.addListener?.(transition);
    transition({ session: clerk.session, user: clerk.user });
  }

  async function getToken() {
    const session = clerk?.session;
    if (!session) return null;
    return session.getToken();
  }

  async function signOut() { ++epoch; currentIdentity = null; await clerk?.signOut(); }
  function destroy() { ++epoch; listener?.(); listener = null; if (mounted) clerk?.unmountSignIn?.(mounted); mounted = null; }

  function mountUserButton(target) { if (clerk && target) clerk.mountUserButton(target); }
  function unmountUserButton(target) { if (clerk && target) clerk.unmountUserButton(target); }
  return { initialize, mountSignIn, mountUserButton, unmountUserButton, getToken, signOut, destroy };
}
