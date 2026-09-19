/**
 * Comparable-sale estimates. The caller supplies a rights-eligible listing snapshot
 * and receipts read from the configured market at a confirmed chain snapshot.
 * This module neither authenticates receipts nor reads private trace contents.
 */
export interface ThotValuationListing {
  id: string;
  owner_id: string;
  wallet: string;
  workflow: string;
  provenance: string;
  /** Keep imports distinct even when both imports and captures have P0_OPERATOR. */
  provenance_status?: string;
  turn_count: number;
  eligible?: boolean;
}

export interface ThotSaleObservation {
  offer_id: string;
  listing: ThotValuationListing;
  buyer: string;
  buyer_owner_id?: string;
  gross_atoms: string;
  finalized_at: string | number;
  status: 'finalized' | 'refunded' | 'pending' | 'disputed';
  confirmed: boolean;
  source: 'independent' | 'treasury';
  /** An operator-reviewed classification, not proof of unrelated economic owners. */
  independence_reviewed: boolean;
}

export interface ThotValuationOptions {
  /** ISO date or Unix milliseconds. Inject a snapshot time for repeatable results. */
  now?: string | number;
  lookbackDays?: number;
}

type Cohort = {
  workflow: string;
  provenance: string;
  provenance_status: string;
  turn_count_band: '1–4' | '5–19' | '20–49' | '50+';
};

export interface ThotComparableEstimate {
  status: 'estimated' | 'insufficient_data';
  median_gross_atoms: string | null;
  p25_gross_atoms: string | null;
  p75_gross_atoms: string | null;
  sample_count: number;
  distinct_contributors: number;
  distinct_buyers: number;
  minimum_contributors: 3;
  weighting: 'equal_weight_per_contributor';
}

export interface ThotValuationEstimate {
  schema_version: 'thot.valuation/1';
  status: 'estimated' | 'insufficient_data' | 'ineligible';
  listing_id: string;
  currency: 'THOT';
  decimals: 18;
  basis: 'gross_licence_price_conditional_on_sale';
  label: 'Estimated gross licence price, conditional on sale';
  cohort: Cohort | null;
  window: { from: string; to: string; lookback_days: number };
  independent: ThotComparableEstimate;
  sponsored: ThotComparableEstimate;
  limitations: string[];
}

const DAY = 86_400_000;
const MIN_CONTRIBUTORS = 3;
const workflows = new Set(['coding', 'research', 'investment_research', 'legal_research', 'contract_review', 'chat', 'agent', 'other']);
const provenanceLevels = new Set(['P0_OPERATOR', 'P1_WITNESSED', 'P2_TEE', 'P3_UPSTREAM', 'IMPORTED_UNVERIFIED', 'USER_SUPPLIED']);
const provenanceStatuses = new Set(['IMPORTED_UNVERIFIED', 'USER_SUPPLIED', 'VERIFIED', 'UNVERIFIED', 'UNSPECIFIED']);
const wallet = (value: unknown): string | null => typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value) ? value.toLowerCase() : null;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const time = (value: string | number): number => typeof value === 'number' ? value : Date.parse(value);

function cohortFor(listing: ThotValuationListing): Cohort | null {
  if (listing.eligible === false || !identifier(listing.id) || !identifier(listing.owner_id) || !wallet(listing.wallet)) return null;
  if (!workflows.has(listing.workflow) || !provenanceLevels.has(listing.provenance)) return null;
  if (!Number.isSafeInteger(listing.turn_count) || listing.turn_count < 1) return null;
  const status = listing.provenance_status ?? 'UNSPECIFIED';
  if (!provenanceStatuses.has(status)) return null;
  return {
    workflow: listing.workflow,
    provenance: listing.provenance,
    provenance_status: status,
    turn_count_band: listing.turn_count < 5 ? '1–4' : listing.turn_count < 20 ? '5–19' : listing.turn_count < 50 ? '20–49' : '50+',
  };
}

/** R7 interpolation, rounded down to the smallest indivisible THOT unit. */
function quartile(sorted: readonly bigint[], quarter: 1 | 2 | 3): bigint {
  const numerator = (sorted.length - 1) * quarter;
  const lower = Math.floor(numerator / 4), fraction = BigInt(numerator % 4);
  return sorted[lower]! + ((sorted[Math.min(lower + 1, sorted.length - 1)]! - sorted[lower]!) * fraction) / 4n;
}

const ascending = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
type Comparable = { owner: string; seller: string; buyer: string; atoms: bigint };

function summarize(rows: readonly Comparable[]): ThotComparableEstimate {
  const owners = new Map<string, bigint[]>();
  const sellers = new Set<string>(), buyers = new Set<string>();
  for (const row of rows) {
    const prices = owners.get(row.owner) ?? [];
    prices.push(row.atoms); owners.set(row.owner, prices);
    sellers.add(row.seller); buyers.add(row.buyer);
  }
  // A contributor with many sales must not outweigh all other contributors.
  const prices = [...owners.values()].map(values => quartile(values.sort(ascending), 2)).sort(ascending);
  const contributors = Math.min(owners.size, sellers.size);
  const enough = contributors >= MIN_CONTRIBUTORS;
  return {
    status: enough ? 'estimated' : 'insufficient_data',
    median_gross_atoms: enough ? quartile(prices, 2).toString() : null,
    p25_gross_atoms: enough ? quartile(prices, 1).toString() : null,
    p75_gross_atoms: enough ? quartile(prices, 3).toString() : null,
    sample_count: rows.length,
    distinct_contributors: contributors,
    distinct_buyers: buyers.size,
    minimum_contributors: 3,
    weighting: 'equal_weight_per_contributor',
  };
}

/**
 * Estimates the gross price of a comparable licence IF a sale occurs. It cannot
 * infer the probability of sale or expected income without unsold exposure data.
 * Independent and treasury-sponsored purchases always remain separate cohorts.
 */
export async function estimateThotValuation(
  target: ThotValuationListing,
  observations: readonly ThotSaleObservation[],
  options: ThotValuationOptions = {},
): Promise<ThotValuationEstimate> {
  const now = time(options.now ?? Date.now()), days = options.lookbackDays ?? 90;
  if (!Number.isFinite(now) || !Number.isSafeInteger(days) || days < 1 || days > 365) throw new RangeError('INVALID_THOT_VALUATION_WINDOW');
  const start = now - days * DAY;
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(now).getTime())) throw new RangeError('INVALID_THOT_VALUATION_WINDOW');
  const cohort = cohortFor(target), key = JSON.stringify(cohort);
  const targetWallet = wallet(target.wallet);
  const independent: Comparable[] = [], sponsored: Comparable[] = [];
  // Conflicting or repeated receipt IDs are suppressed altogether, rather than
  // allowing input order to choose which version influences the public estimate.
  const counts = new Map<string, number>();
  for (const observation of observations) if (identifier(observation.offer_id)) counts.set(observation.offer_id, (counts.get(observation.offer_id) ?? 0) + 1);
  if (cohort) for (const observation of observations) {
    const l = observation.listing, seller = wallet(l.wallet), buyer = wallet(observation.buyer);
    if (counts.get(observation.offer_id) !== 1 || observation.confirmed !== true || observation.status !== 'finalized') continue;
    if (observation.source !== 'independent' && observation.source !== 'treasury') continue;
    if (observation.source === 'independent' && observation.independence_reviewed !== true) continue;
    if (!seller || !buyer || seller === buyer || l.owner_id === observation.buyer_owner_id) continue;
    if (l.id === target.id || l.owner_id === target.owner_id || seller === targetWallet) continue;
    if (observation.buyer_owner_id === target.owner_id || buyer === targetWallet) continue;
    if (JSON.stringify(cohortFor(l)) !== key) continue;
    const finalized = time(observation.finalized_at);
    if (!Number.isFinite(finalized) || finalized < start || finalized > now) continue;
    if (typeof observation.gross_atoms !== 'string' || !/^[1-9]\d{0,77}$/.test(observation.gross_atoms)) continue;
    const atoms = BigInt(observation.gross_atoms);
    if (atoms > (1n << 256n) - 1n) continue;
    (observation.source === 'independent' ? independent : sponsored).push({owner: l.owner_id, seller, buyer, atoms});
  }
  const marketEstimate = summarize(independent), sponsoredEstimate = summarize(sponsored);
  return {
    schema_version: 'thot.valuation/1',
    status: !cohort ? 'ineligible' : marketEstimate.status,
    listing_id: target.id,
    currency: 'THOT', decimals: 18,
    basis: 'gross_licence_price_conditional_on_sale',
    label: 'Estimated gross licence price, conditional on sale',
    cohort,
    window: {from: new Date(start).toISOString(), to: new Date(now).toISOString(), lookback_days: days},
    independent: marketEstimate,
    sponsored: sponsoredEstimate,
    limitations: [
      'A comparable-sale estimate is not a funded offer, cash balance, guaranteed payout or estimate of the probability of selling.',
      'Gross licence prices precede the seller retention tier. No dollar conversion or future token price is assumed.',
      'Workflow, provenance and turn count do not establish equal quality or equivalent licence rights.',
      'Prices are medians per contributor, then equally weighted across contributors; the range is the 25th to 75th percentile, not a confidence interval.',
      'Only supplied, confirmed finalized receipts in this window are covered. An incomplete snapshot is not a complete market history.',
      'Treasury-sponsored purchases are shown separately and do not establish independent buyer demand.',
      'Distinct accounts and wallets do not prove distinct people or unrelated buyers; independence review remains an operator judgment.',
      'Provenance labels are matched as supplied. Imports, operator records and an estimate do not prove authenticated ChatGPT or Claude history.',
    ],
  };
}
