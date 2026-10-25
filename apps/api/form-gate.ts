import {scryptSync, randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {ensure} from '../../packages/storage/src/index.ts';

/**
 * Form/cookie gate for a private hosted site (#93): an app-served HTML login
 * page replaces the ingress HTTP Basic Auth prompt that browser automation and
 * locked-down testers cannot fill. Successful sign-in sets a short-lived
 * HttpOnly Secure cookie; each tester has their own credential and session, so
 * one tester can be cut off (remove the credential and redeploy) without
 * rotating everyone. The token-gated log port and broker access are separate
 * services and are untouched by this module.
 */
export type FormGateCredential = Record<string, string>;
export type FormGateConfig = {cookieName: string; sessionHours: number; credentials: FormGateCredential};

const CREDENTIAL_PATTERN = /^scrypt\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/;

export function hashFormGatePassword(password: string, salt = randomBytes(16)) {
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 64).toString('base64')}`;
}

function verifyFormGatePassword(password: string, stored: string) {
  if (typeof stored !== 'string' || !CREDENTIAL_PATTERN.test(stored)) return false;
  const [, saltText, hashText] = stored.split('$');
  try {
    const expected = Buffer.from(hashText!, 'base64');
    // Re-derive with the stored salt so both sides have equal length buffers.
    return timingSafeEqual(scryptSync(password, Buffer.from(saltText!, 'base64'), expected.length), expected);
  } catch {
    return false;
  }
}

export function loadFormGateConfig(env: NodeJS.ProcessEnv): FormGateConfig | undefined {
  if (env.THOT_FORM_GATE !== 'true') return undefined;
  ensure(env.THOT_FORM_GATE_USERS, 'FORM_GATE_CONFIGURATION_REQUIRED');
  let users: unknown;
  try { users = JSON.parse(env.THOT_FORM_GATE_USERS!); } catch { return ensure(false, 'INVALID_FORM_GATE_USERS') as never; }
  ensure(users && typeof users === 'object' && !Array.isArray(users), 'INVALID_FORM_GATE_USERS');
  const credentials: FormGateCredential = {};
  for (const [username, stored] of Object.entries(users as Record<string, unknown>)) {
    ensure(/^[A-Za-z0-9_.-]{3,32}$/.test(username) && typeof stored === 'string' && CREDENTIAL_PATTERN.test(stored), 'INVALID_FORM_GATE_USERS');
    credentials[username] = stored;
  }
  ensure(Object.keys(credentials).length >= 1 && Object.keys(credentials).length <= 64, 'INVALID_FORM_GATE_USERS');
  const sessionHours = env.THOT_FORM_GATE_SESSION_HOURS ? Number(env.THOT_FORM_GATE_SESSION_HOURS) : 12;
  ensure(Number.isSafeInteger(sessionHours) && sessionHours >= 1 && sessionHours <= 168, 'INVALID_FORM_GATE_SESSION_HOURS');
  const cookieName = env.THOT_FORM_GATE_COOKIE ?? 'thot_gate';
  ensure(/^[A-Za-z0-9_]{3,32}$/.test(cookieName), 'INVALID_FORM_GATE_COOKIE');
  return {cookieName, sessionHours, credentials};
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));

// The gate page loads before any stylesheet is reachable, so its styles ride along.
const formGateStyle = `<style>body{margin:0;background:#fbfaf3;color:#1d2a20;font:16px/1.6 "DM Sans","Trebuchet MS",sans-serif}main{max-width:420px;margin:0 auto;padding:48px 22px}.gate{display:grid;gap:8px}h1{font-size:24px;margin:0 0 6px}.gate p{color:#6c7567;margin:0 0 10px}.gate-error{color:#a54c3d}.gate label{font-size:13px;font-weight:600}.gate input{padding:12px;border:1px solid #bac5b1;border-radius:8px;font-size:15px}.gate button{padding:13px;border:0;border-radius:8px;background:#223f2a;color:#f1f5ec;font-size:15px;font-weight:600}.gate a{color:#3a6554}</style>`;

const gatePage = ({heading, detail, next, error}: {heading: string; detail?: string; next: string; error?: boolean}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · thot market</title>
<link rel="icon" href="/favicon.png" type="image/png">${formGateStyle}</head>
<body><main><form class="gate" method="post" action="/gate">
<h1>${escapeHtml(heading)}</h1>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
${error ? '<p class="gate-error" role="alert">That username or password is not valid. Try again.</p>' : ''}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="gate-username">Username</label><input id="gate-username" name="username" autocomplete="username" required maxlength="32">
<label for="gate-password">Password</label><input id="gate-password" name="password" type="password" autocomplete="current-password" required maxlength="256">
<button type="submit">Sign in</button>
</form></main></body></html>`;

// Self-signed-out confirmation and login errors never carry credentials.
const gateSignedOutPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed out · thot market</title>${formGateStyle}</head>
<body><main><div class="gate"><h1>Signed out</h1><p>Sign in again to continue.</p><a href="/gate">Sign in</a></div></main></body></html>`;

// Routes that authenticate with their own device token instead of a tester
// session: capture/history device uploads and helper pairing. They mirror the
// ingress exemptions the private stacks already grant these endpoints.
const SELF_AUTHENTICATED = [/^\/v1\/history-devices\/[^/]+\/(status|imports|pause|resume|disconnect)$/, /^\/v1\/capture-devices\/[^/]+\/(captures|disconnect)$/, /^\/v1\/agent-captures\/[^/]+\/(parts|complete|checkpoint|authorize|heartbeat)$/, /^\/v1\/device-pairing\/sessions(\/(token|events))?$/];

type GateSession = {username: string; expires: number};

export function createFormGate(config: FormGateConfig, {clock = Date.now}: {clock?: () => number} = {}) {
  const sessions = new Map<string, GateSession>();
  const failures = new Map<string, {count: number; windowStart: number}>();
  const sessionTtlMs = config.sessionHours * 3600_000;

  const cookieValue = (cookie?: string) => {
    for (const part of (cookie ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === config.cookieName) return rest.join('=');
    }
    return '';
  };

  const validSession = (cookie?: string) => {
    const token = cookieValue(cookie);
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expires <= clock()) { sessions.delete(token); return false; }
    // Revoking a tester's credential ends their existing session too.
    return Object.hasOwn(config.credentials, session.username);
  };

  const clearExpired = () => {
    const now = clock();
    for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
    for (const [key, entry] of failures) if (now - entry.windowStart > 60_000) failures.delete(key);
  };

  const reply = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    // The gate page inlines its styles and loads nothing else; under the
    // application's strictest CSP that needs this response-scoped policy.
    res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...headers});
    res.end(body);
  };

  const readForm = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Object.assign(new Error('FORM_GATE_BODY_TOO_LARGE'), {status: 413}); chunks.push(chunk as Buffer); }
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    return {
      username: (params.get('username') ?? '').slice(0, 32),
      password: (params.get('password') ?? '').slice(0, 256),
      next: params.get('next') ?? '/'
    };
  };

  const safeNext = (value: string) => /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@/?#]*$/.test(value) ? value : '/';

  const issue = (res: ServerResponse, username: string, next: string) => {
    clearExpired();
    ensure(sessions.size < 512, 'FORM_GATE_SESSION_LIMIT', 429);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, {username, expires: clock() + sessionTtlMs});
    reply(res, 303, '', {
      'Set-Cookie': `${config.cookieName}=${token}; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}; Secure; HttpOnly; SameSite=Strict`,
      Location: next
    });
  };

  /** Handle /gate requests. Returns true when the response was written here. */
  const handleGateEndpoint = async (req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> => {
    if (route === '/gate/logout') {
      // POST-only: a cross-site GET or image tag must not end a tester session.
      if (req.method !== 'POST') { reply(res, 405, gateSignedOutPage, {Allow: 'POST'}); return true; }
      for await (const _ of req) { void _; break; }
      logout(res);
      return true;
    }
    if (route !== '/gate' && route !== '/gate/') return false;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const url = new URL(req.url ?? '/gate', 'http://gate.local');
      reply(res, 200, gatePage({heading: 'Sign in to this site', next: safeNext(url.searchParams.get('next') ?? '/')}));
      return true;
    }
    if (req.method === 'POST') {
      const form = await readForm(req);
      const ip = req.socket.remoteAddress ?? 'unknown';
      clearExpired();
      const entry = failures.get(ip) ?? {count: 0, windowStart: clock()};
      if (clock() - entry.windowStart > 60_000) { entry.count = 0; entry.windowStart = clock(); }
      if (entry.count >= 10) { reply(res, 429, gatePage({heading: 'Too many attempts', detail: 'Wait a minute before trying again.', next: form.next, error: true})); return true; }
      const stored = config.credentials[form.username];
      if (!stored || !verifyFormGatePassword(form.password, stored)) {
        entry.count += 1; failures.set(ip, entry);
        reply(res, 401, gatePage({heading: 'Sign in to this site', next: form.next, error: true}));
        return true;
      }
      entry.count = 0; failures.set(ip, entry);
      issue(res, form.username, safeNext(form.next));
      return true;
    }
    reply(res, 405, gatePage({heading: 'Sign in to this site', next: '/'}), {Allow: 'GET, HEAD, POST'});
    return true;
  };

  const logout = (res: ServerResponse) => {
    reply(res, 200, gateSignedOutPage, {'Set-Cookie': `${config.cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`});
  };

  /** Enforce the session cookie. Returns true when a gate response was written. */
  const guard = async (req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> => {
    if (route === '/gate' || route === '/gate/' || route === '/gate/logout' || route === '/healthz') return false;
    if (req.method === 'POST' && SELF_AUTHENTICATED.some(pattern => pattern.test(route))) return false;
    if (validSession(req.headers.cookie)) return false;
    // Browsers navigating get the login page; API clients get a status instead.
    if ((req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(String(req.headers.accept ?? ''))) {
      const target = route + ((req.url ?? route).slice(route.length) || '');
      reply(res, 303, '', {Location: '/gate?next=' + encodeURIComponent(safeNext(target).slice(0, 512))});
      return true;
    }
    res.writeHead(401, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify({error: 'GATE_AUTH_REQUIRED'}));
    return true;
  };

  return {handleGateEndpoint, guard, validSession, logout};
}

/** Hash one tester password for the sealed credential set (reads from stdin). */
export async function formGateCredentialFromStdin(username: string) {
  ensure(/^[A-Za-z0-9_.-]{3,32}$/.test(username), 'INVALID_FORM_GATE_USERNAME');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  ensure(password.length >= 10 && password.length <= 256, 'INVALID_FORM_GATE_PASSWORD');
  return {username, stored: hashFormGatePassword(password)};
}
