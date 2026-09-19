import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicLaunchConfig, readPublicAsset, readPublicMarketProof, type LaunchConfiguration } from '../api/public-site.ts';

export type SiteServerOptions = {
  publicOrigin?: string;
  reviewerUrl?: string;
  appUrl?: string;
  launch?: LaunchConfiguration;
};

/** Only an operator-configured HTTPS origin can become the explicit reviewer link. */
export function reviewerOrigin(value?: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0'
      || host === '::' || host === '::1' || /^127\./.test(host) || /^::ffff:7f[0-9a-f]{2}:/.test(host);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.search || url.hash || loopback) return null;
    return url.origin;
  } catch { return null; }
}

/** Wallet access links only to the configured workspace, never a supplied callback. */
export function workspaceUrl(value?: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!reviewerOrigin(url.origin) || url.username || url.password || url.search || url.hash
      || ![url.origin, url.origin + '/app'].includes(value)) return null;
    return url.origin + '/app';
  } catch { return null; }
}

export function publicSiteConfig(options: Pick<SiteServerOptions, 'reviewerUrl' | 'appUrl'> = {}) {
  // An explicit new app setting must never silently fall back to the old reviewer app.
  if (options.appUrl !== undefined) {
    const app = workspaceUrl(options.appUrl);
    return { appUrl: app, reviewerUrl: null, access: app ? 'wallet' : 'unavailable', privateAppHosted: false };
  }
  const review = reviewerOrigin(options.reviewerUrl);
  return { reviewerUrl: review, access: review ? 'invited-reviewers' : 'unavailable', privateAppHosted: false };
}

const accessAssets: Record<string, [string, string]> = {
  '/app': ['access.html', 'text/html; charset=utf-8'],
  '/app/': ['access.html', 'text/html; charset=utf-8'],
  '/access.js': ['access.js', 'text/javascript; charset=utf-8'],
};

/** Static public website only: this module never imports the application or its data stores. */
export function createSiteServer(options: SiteServerOptions = {}) {
  let expectedHost: string | undefined;
  if (options.publicOrigin) {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== options.publicOrigin || origin.username || origin.password) throw Error('INVALID_SITE_PUBLIC_ORIGIN');
    expectedHost = origin.host;
  }
  const accessConfig = publicSiteConfig(options);
  const launch = publicLaunchConfig(options.launch);
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (options.publicOrigin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status: number, body: string | Buffer, contentType = 'application/json; charset=utf-8', cache = 'no-store') => {
      const bytes = typeof body === 'string' ? Buffer.from(body) : body;
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': bytes.length, 'Cache-Control': cache });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    try {
      const host = req.headers.host;
      if (!host) { send(400, '{"error":"INVALID_HOST"}'); return; }
      let parsed: URL;
      try { parsed = new URL('http://' + host); } catch { send(400, '{"error":"INVALID_HOST"}'); return; }
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) { send(400, '{"error":"INVALID_HOST"}'); return; }
      if (expectedHost && host !== expectedHost) { send(403, '{"error":"INVALID_HOST"}'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Connection', 'close');
        req.resume();
        send(405, '{"error":"METHOD_NOT_ALLOWED"}');
        return;
      }
      const target = req.url ?? '/';
      if (target.length > 8192) { send(414, '{"error":"URI_TOO_LONG"}'); return; }
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) { send(400, '{"error":"INVALID_PATH"}'); return; }
      // Keep the original path: normalization must not turn a traversal into a public route.
      const path = target.split('?', 1)[0]!;
      if (path === '/healthz') { send(200, '{"status":"ok","service":"thot-public-site","privateAppHosted":false}'); return; }
      if (path === '/v1/public/site-config') {
        send(200, JSON.stringify(accessConfig));
        return;
      }
      if (path === '/v1/public/launch-config') { send(200, JSON.stringify(launch)); return; }
      if (path === '/v1/public/market-proof' || path === '/v1/public/market-proof.json') {
        send(200, JSON.stringify(await readPublicMarketProof(options.appUrl)));
        return;
      }
      if (path === '/affiliates/') {
        res.setHeader('Location', '/affiliates');
        send(301, '', 'text/plain; charset=utf-8');
        return;
      }
      const access = accessAssets[path];
      const asset = access
        ? { body: await readFile(new URL(access[0], import.meta.url)), contentType: access[1] }
        : await readPublicAsset(path);
      if (!asset) { send(404, '{"error":"NOT_FOUND"}'); return; }
      const cache = asset.contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=3600';
      send(200, asset.body, asset.contentType, cache);
    } catch (error) {
      // Neither request URLs nor filesystem errors belong in public responses or logs.
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      if (!res.headersSent) send(missing ? 404 : 500, missing ? '{"error":"NOT_FOUND"}' : '{"error":"INTERNAL_ERROR"}');
      else res.destroy();
    }
  });
  server.maxHeadersCount = 50;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startSiteServer(options: SiteServerOptions & { port?: number; bind?: string } = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_SITE_PORT');
  const bind = options.bind ?? process.env.THOT_SITE_BIND ?? '127.0.0.1';
  const server = createSiteServer({
    publicOrigin: options.publicOrigin ?? process.env.THOT_SITE_PUBLIC_ORIGIN,
    reviewerUrl: options.reviewerUrl ?? process.env.THOT_REVIEWER_URL,
    appUrl: options.appUrl ?? process.env.THOT_APP_URL,
    launch: options.launch ?? { state: process.env.THOT_LAUNCH_STATE, tokenAddress: process.env.THOT_TOKEN_ADDRESS, ponsLaunchAddress: process.env.THOT_PONS_LAUNCH_ADDRESS },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startSiteServer();
  const address = server.address();
  process.stdout.write(`thot public website listening on port ${typeof address === 'object' && address ? address.port : 8080}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
}
