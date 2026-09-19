import { readFile } from 'node:fs/promises';

// Explicit routes only: never resolve a request path against the repository.
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/read': ['article.html', 'text/html; charset=utf-8'],
  '/tutorial': ['tutorial.html', 'text/html; charset=utf-8'],
  '/whitepaper': ['whitepaper.html', 'text/html; charset=utf-8'],
  '/mechanism': ['mechanism.html', 'text/html; charset=utf-8'],
  '/affiliates': ['affiliates.html', 'text/html; charset=utf-8'],
  '/affiliates.html': ['affiliates.html', 'text/html; charset=utf-8'],
  '/referrals.css': ['referrals.css', 'text/css; charset=utf-8'],
  '/referrals.js': ['referrals.js', 'text/javascript; charset=utf-8'],
  '/site.css': ['site.css', 'text/css; charset=utf-8'],
  '/site.js': ['site.js', 'text/javascript; charset=utf-8'],
  '/reading.css': ['reading.css', 'text/css; charset=utf-8'],
  '/assets/thot-logo.png': ['assets/thot-logo.png', 'image/png'],
  '/assets/source-mercor-training.png': ['assets/source-mercor-training.png', 'image/png'],
  '/assets/source-shou-router.png': ['assets/source-shou-router.png', 'image/png'],
  '/assets/source-dylan-router.png': ['assets/source-dylan-router.png', 'image/png'],
  '/assets/source-aidan-data.png': ['assets/source-aidan-data.png', 'image/png'],
  '/assets/robinhood-trade-proof-flow.svg': ['assets/robinhood-trade-proof-flow.svg', 'image/svg+xml'],
  '/assets/thot-feast.jpg': ['assets/thot-feast.jpg', 'image/jpeg'],
  '/assets/thot-research-iceberg.webp': ['assets/thot-research-iceberg.webp', 'image/webp'],
  '/assets/thot-human-capital.webp': ['assets/thot-human-capital.webp', 'image/webp'],
  '/assets/thot-cold-start.webp': ['assets/thot-cold-start.webp', 'image/webp'],
  '/favicon.png': ['assets/thot-logo.png', 'image/png'],
  '/assets/fonts/bricolage-grotesque-latin.woff2': ['assets/fonts/bricolage-grotesque-latin.woff2', 'font/woff2'],
  '/assets/fonts/dm-sans-latin.woff2': ['assets/fonts/dm-sans-latin.woff2', 'font/woff2'],
};

export const publicDocumentRoutes = new Set(['/', '/index.html', '/read', '/tutorial', '/whitepaper', '/mechanism', '/affiliates', '/affiliates.html', '/app', '/app/', '/getting-started']);

export async function readPublicAsset(path: string) {
  const entry = assets[path];
  if (!entry) return undefined;
  return { body: await readFile(new URL('../site/' + entry[0], import.meta.url)), contentType: entry[1] };
}

const proofSchema = 'thot.public-market-proof/1' as const;
const proofNotice = 'Testnet verification receipts do not establish organic traction.';
const proofEnvironments = Object.freeze({
  'https://app.test.thot.market/app': 'dev',
  'https://app.staging.thot.market/app': 'staging',
} as const);
type ProofEnvironment = typeof proofEnvironments[keyof typeof proofEnvironments];
type ProofReceipt = { tx_hash: string; block_number: number; amount_thot: string; source: 'reserve' | 'independent' | 'unknown'; explorer_url: string };
type ProofPurchase = ProofReceipt & { status: 'funded' | 'delivered' | 'finalized' };

export function unavailableMarketProof() {
  return { schema_version: proofSchema, status: 'unavailable' as const, notice: 'Verified public market evidence is not available for this environment.' };
}

/** Reconstruct public evidence field by field. Unknown fields and prose never cross this boundary. */
export function sanitizePublicMarketProof(value: unknown, environment: ProofEnvironment) {
  const invalid = () => { throw Error('INVALID_PUBLIC_MARKET_PROOF'); };
  const object = (input: unknown): Record<string, unknown> => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid();
    return input as Record<string, unknown>;
  };
  const integer = (input: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) return invalid();
    return input;
  };
  const hash = (input: unknown): string => {
    if (typeof input !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(input)) return invalid();
    return input;
  };
  const amount = (input: unknown): string => {
    if (typeof input !== 'string' || input.length > 96 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(input)) return invalid();
    return input;
  };
  const snapshot = object(value);
  if (snapshot.schema_version !== proofSchema || snapshot.environment !== environment
    || snapshot.network !== 'Robinhood testnet' || snapshot.chain_id !== 46630
    || snapshot.test_assets !== true || snapshot.scope !== 'testnet-verification'
    || snapshot.amount_basis !== 'finalized seller proceeds' || snapshot.purchase_amount_basis !== 'gross purchase price') return invalid();
  if (typeof snapshot.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(snapshot.as_of)
    || !Number.isFinite(Date.parse(snapshot.as_of))) return invalid();
  const canonicalTime = snapshot.as_of.includes('.') ? snapshot.as_of : snapshot.as_of.replace('Z', '.000Z');
  if (new Date(snapshot.as_of).toISOString() !== canonicalTime) return invalid();
  const blockNumber = integer(snapshot.block_number);
  const scan = object(snapshot.scan);
  const fromBlock = integer(scan.from_block);
  const throughBlock = integer(scan.through_block, fromBlock, blockNumber);
  if (typeof scan.complete_since_deployment !== 'boolean') return invalid();
  const tariff = object(snapshot.tariff);
  if (!Array.isArray(snapshot.receipts) || snapshot.receipts.length > 100) return invalid();
  const publicReceipt = (input: unknown): ProofReceipt => {
    const receipt = object(input);
    const txHash = hash(receipt.tx_hash);
    const explorerUrl = 'https://explorer.testnet.chain.robinhood.com/tx/' + txHash;
    if (receipt.explorer_url !== explorerUrl || typeof receipt.source !== 'string' || !['reserve', 'independent', 'unknown'].includes(receipt.source)) return invalid();
    return { tx_hash: txHash, block_number: integer(receipt.block_number, fromBlock, throughBlock), amount_thot: amount(receipt.amount_thot), source: receipt.source as ProofReceipt['source'], explorer_url: explorerUrl };
  };
  const receipts = snapshot.receipts.map(publicReceipt);
  if (!Array.isArray(snapshot.purchases) || snapshot.purchases.length > 5) return invalid();
  const purchases: ProofPurchase[] = snapshot.purchases.map(input => {
    const purchase = object(input);
    if (typeof purchase.status !== 'string' || !['funded', 'delivered', 'finalized'].includes(purchase.status)) return invalid();
    return { ...publicReceipt(purchase), status: purchase.status as ProofPurchase['status'] };
  });
  for (const entries of [receipts, purchases]) {
    if (new Set(entries.map(entry => entry.tx_hash.toLowerCase())).size !== entries.length) return invalid();
  }
  return {
    schema_version: proofSchema, status: 'available' as const,
    network: 'Robinhood testnet', chain_id: 46630, environment,
    as_of: snapshot.as_of, block_number: blockNumber, block_hash: hash(snapshot.block_hash), confirmations: integer(snapshot.confirmations, 1),
    test_assets: true, scope: 'testnet-verification', amount_basis: 'finalized seller proceeds', purchase_amount_basis: 'gross purchase price', notice: proofNotice,
    tariff: {
      service_fee_thot: amount(tariff.service_fee_thot), direct_cost_thot: amount(tariff.direct_cost_thot),
      allocated_overhead_thot: amount(tariff.allocated_overhead_thot), net_contribution_thot: amount(tariff.net_contribution_thot),
      referral_bps: integer(tariff.referral_bps, 0, 10_000), dispute_seconds: integer(tariff.dispute_seconds),
      activation_seconds: integer(tariff.activation_seconds), term_seconds: integer(tariff.term_seconds),
    },
    receipts, purchases, scan: { from_block: fromBlock, through_block: throughBlock, complete_since_deployment: scan.complete_since_deployment },
  };
}

/** Only exact, operator-configured stable test workspaces select a checked-in snapshot. */
export async function readPublicMarketProof(appUrl?: string) {
  const environment = appUrl === 'https://app.test.thot.market/app' || appUrl === 'https://app.staging.thot.market/app'
    ? proofEnvironments[appUrl] : undefined;
  if (!environment) return unavailableMarketProof();
  try {
    // The two source names are fixed; request paths, origins, and query data never select files.
    const source = environment === 'dev' ? 'market-proof-dev.json' : 'market-proof-staging.json';
    const data = await readFile(new URL('../site/assets/' + source, import.meta.url));
    if (data.length > 128 * 1024) return unavailableMarketProof();
    return sanitizePublicMarketProof(JSON.parse(data.toString('utf8')), environment);
  } catch {
    return unavailableMarketProof();
  }
}

export type LaunchConfiguration = { state?: string; tokenAddress?: string; ponsLaunchAddress?: string };

export function publicLaunchConfig(config: LaunchConfiguration = {}) {
  const address = (value?: string) => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) && !/^0x0{40}$/i.test(value) ? value : null;
  const tokenAddress = address(config.tokenAddress), launchAddress = address(config.ponsLaunchAddress);
  const launched = config.state === 'launched' && tokenAddress !== null && launchAddress !== null;
  return {
    state: launched ? 'launched' : 'preview',
    chain: 'Robinhood Chain',
    tokenAddress: launched ? tokenAddress : null,
    tokenUrl: launched ? `https://www.ponsfamily.com/launchpad/${launchAddress}` : null,
    holdingIncome: false,
    mechanismStatus: 'selected-not-live',
  };
}
