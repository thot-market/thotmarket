import type { Document } from '../../packages/storage/src/index.ts';
import type { createApplication } from '../../packages/market/src/bootstrap.ts';

const CHAIN_WINDOW_CAP = 50;
const OFFER_ID = /^0x[\da-f]{64}$/i;

type Application = Awaited<ReturnType<typeof createApplication>>;
type ChainOffer = {
  status: number;
  seller_amount: string;
  buyer_total: string;
};
type Workspace = { offers: ChainOffer[]; block: { number: number; hash?: string; timestamp: number } };
type WorkspaceChain = { readWorkspace(owner: undefined, offerIds: string[]): Promise<Workspace> };

export interface OperatorProductReport {
  schema_version: 'thot.operator-product/1';
  observed_at: string;
  chain: {
    mode: string;
    asset_classification: 'test_assets' | 'unconfigured' | 'unavailable';
    observation: { status: 'observed' | 'unavailable'; reason?: string; block_number?: number; block_timestamp?: number };
  };
  listings: { recorded: number; active: number; inactive: number };
  orders: {
    recorded: number;
    chain_window: { cap: 50; selected: number; excluded_older: number; invalid_offer_ids: number; truncated: boolean };
    state: { offered: number | null; accepted: number | null; delivered: number | null; disputed: number | null; finalized: number | null; refunded: number | null; missing: number | null };
  };
  deliveries: { thot_delivered_current: number | null; legacy_recorded: number; legacy_delivered: number; legacy_available: number; legacy_other: number };
  settlements: {
    scope: 'finalized_on_chain_within_bounded_window';
    finalized: number | null;
    refunded: number | null;
    seller_payout_atoms: string | null;
    buyer_payment_atoms: string | null;
  };
  legacy_licenses: { recorded: number; note: 'Legacy licenses are not THOT chain settlement evidence.' };
  traces: { retained: number; readable: number; retained_not_readable: number; storage_object_records: number };
}

function atom(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw Error('INVALID_CHAIN_ATOM_TOTAL');
  return BigInt(value);
}

function stateCounts(offers: ChainOffer[]) {
  const counts = { offered: 0, accepted: 0, delivered: 0, disputed: 0, finalized: 0, refunded: 0, missing: 0 };
  for (const offer of offers) {
    switch (offer.status) {
      case 1: counts.offered++; break;
      case 2: counts.accepted++; break;
      case 3: counts.delivered++; break;
      case 4: counts.disputed++; break;
      case 5: counts.finalized++; break;
      case 6: counts.refunded++; break;
      default: counts.missing++;
    }
  }
  return counts;
}

/**
 * Coarse operator product telemetry. It intentionally exposes neither record
 * bodies, object references, wallet addresses, nor any private vault content.
 */
export async function operatorProduct(app: Application): Promise<OperatorProductReport> {
  const [records, licenses, deliveries, traces, traceObjects] = await app.db.transaction(async tx => Promise.all([
    tx.list('thot_records'), tx.list('licenses'), tx.list('deliveries'), tx.list('traces'), tx.list('trace_objects'),
  ]));
  const now = app.service.now();
  const listings = records.filter(row => row.kind === 'listing');
  const intents = records.filter(row => row.kind === 'intent');
  const validIntents = intents
    .filter(row => typeof row.offer_id === 'string' && OFFER_ID.test(row.offer_id))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  const selected = validIntents.slice(-CHAIN_WINDOW_CAP);
  const capabilities = app.thot.capabilities() as Document;
  const mode = typeof capabilities.mode === 'string' ? capabilities.mode : 'unavailable';
  const assetClassification: OperatorProductReport['chain']['asset_classification'] = capabilities.test_assets === true
    ? 'test_assets' : mode === 'unconfigured' ? 'unconfigured' : 'unavailable';
  const legacyDelivery = { delivered: 0, available: 0, other: 0 };
  for (const delivery of deliveries) {
    if (delivery.status === 'DELIVERED') legacyDelivery.delivered++;
    else if (delivery.status === 'AVAILABLE') legacyDelivery.available++;
    else legacyDelivery.other++;
  }
  const retained = traces.filter(row => row.deleted !== true && typeof row.retention_expires_at === 'string' && row.retention_expires_at > now);
  const readable = retained.filter(row => (row.projection?.status ?? 'READY') === 'READY').length;
  const base = {
    schema_version: 'thot.operator-product/1' as const,
    observed_at: new Date().toISOString(),
    listings: { recorded: listings.length, active: listings.filter(row => row.active === true).length, inactive: listings.filter(row => row.active !== true).length },
    orders: {
      recorded: intents.length,
      chain_window: { cap: 50 as const, selected: selected.length, excluded_older: validIntents.length - selected.length, invalid_offer_ids: intents.length - validIntents.length, truncated: validIntents.length > CHAIN_WINDOW_CAP },
    },
    deliveries: { legacy_recorded: deliveries.length, legacy_delivered: legacyDelivery.delivered, legacy_available: legacyDelivery.available, legacy_other: legacyDelivery.other },
    legacy_licenses: { recorded: licenses.length, note: 'Legacy licenses are not THOT chain settlement evidence.' as const },
    traces: { retained: retained.length, readable, retained_not_readable: retained.length - readable, storage_object_records: traceObjects.length },
  };
  const unavailable = (reason: string): OperatorProductReport => ({
    ...base,
    chain: { mode, asset_classification: assetClassification, observation: { status: 'unavailable', reason } },
    orders: { ...base.orders, state: { offered: null, accepted: null, delivered: null, disputed: null, finalized: null, refunded: null, missing: null } },
    deliveries: { ...base.deliveries, thot_delivered_current: null },
    settlements: { scope: 'finalized_on_chain_within_bounded_window', finalized: null, refunded: null, seller_payout_atoms: null, buyer_payment_atoms: null },
  });
  const chain = (app.thot as unknown as { chain?: WorkspaceChain }).chain;
  if (!chain) return unavailable(mode === 'unconfigured' ? 'THOT_CHAIN_NOT_CONFIGURED' : 'THOT_CHAIN_WORKSPACE_UNAVAILABLE');
  try {
    const workspace = await chain.readWorkspace(undefined, selected.map(row => String(row.offer_id)));
    if (workspace.offers.length !== selected.length) throw Error('INCOMPLETE_THOT_CHAIN_WORKSPACE');
    const state = stateCounts(workspace.offers);
    let sellerPayout = 0n, buyerPayment = 0n;
    for (const offer of workspace.offers) if (offer.status === 5) { sellerPayout += atom(offer.seller_amount); buyerPayment += atom(offer.buyer_total); }
    return {
      ...base,
      chain: { mode, asset_classification: assetClassification, observation: { status: 'observed', block_number: workspace.block.number, block_timestamp: workspace.block.timestamp } },
      orders: { ...base.orders, state },
      deliveries: { ...base.deliveries, thot_delivered_current: state.delivered },
      settlements: { scope: 'finalized_on_chain_within_bounded_window', finalized: state.finalized, refunded: state.refunded, seller_payout_atoms: sellerPayout.toString(), buyer_payment_atoms: buyerPayment.toString() },
    };
  } catch {
    return unavailable('THOT_CHAIN_WORKSPACE_READ_UNAVAILABLE');
  }
}
