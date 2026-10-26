// Public share page for an active listing. It renders the same public metadata
// the listing API returns — never trace content, which is delivered only after a
// completed purchase — plus a sign-in-to-buy action into the workspace.
import type { Document } from '../../packages/storage/src/index.ts';

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));

/** Whole THOT from 18-decimal atoms, trailing zeros trimmed. */
export function thotAmount(atoms: unknown): string {
  if (typeof atoms !== 'string' || !/^\d{1,78}$/.test(atoms)) return 'Unavailable';
  const whole = atoms.slice(0, -18) || '0', fraction = atoms.slice(-18).replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction.slice(0, 4) : ''} THOT`;
}

const isoDate = (value: unknown) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : 'Unknown date';
};

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="icon" href="/favicon.png" type="image/png"><link rel="stylesheet" href="/listing.css">
</head><body><main>${body}</main></body></html>`;

export type PublicListingRecord = {
  title?: unknown; price_atoms?: unknown; license?: unknown; provenance?: unknown; workflow?: unknown;
  turn_count?: unknown; file_count?: unknown; file_types?: unknown; total_bytes?: unknown; content_kind?: unknown; capture_model?: unknown; created_at?: unknown; seller?: unknown;
};

/** Metadata-only listing page. `appUrl` is the workspace URL used for the buy action. */
export function renderListingPage(listing: PublicListingRecord, appUrl: string) {
  const model = (listing.capture_model ?? null) as Document | null;
  const claimedModel = model?.evidence === 'user_supplied' ? String(model.claimed_model ?? 'Not recorded') + ' (claimed)' : String(model?.returned_model ?? model?.requested_model ?? 'Not recorded');
  const megabytes = typeof listing.total_bytes === 'number' ? ` · ${(listing.total_bytes / 1e6).toFixed(listing.total_bytes < 1e5 ? 2 : 1)} MB` : '';
  const types = Array.isArray(listing.file_types) && listing.file_types.length ? ` · ${listing.file_types.map(String).join(', ')}` : '';
  const size = listing.content_kind === 'research' ? `${escapeHtml(listing.file_count ?? '—')} files${escapeHtml(megabytes + types)}` : `${escapeHtml(listing.turn_count ?? '—')} turns`;
  const row = (label: string, value: string) => `<div class="listing-row"><span>${label}</span><strong>${value}</strong></div>`;
  return shell(`${escapeHtml(listing.title ?? 'Listing')} · thot market`, `
<article class="listing-page"><header><a class="listing-brand" href="/"><img src="/assets/thot-logo.png" alt="" width="34" height="38"><span>thot market</span></a></header>
<h1>${escapeHtml(listing.title ?? 'Untitled listing')}</h1>
<p class="listing-price">${escapeHtml(thotAmount(listing.price_atoms))}</p>
<section class="listing-meta" aria-label="Public listing details">
${row('Provenance tier', escapeHtml(listing.provenance ?? 'Unknown'))}
${row('Capture model', claimedModel)}
${row('Workflow', escapeHtml(listing.workflow ?? 'Unknown'))}
${row('Size', size)}
${row('Seller wallet', `<code>${escapeHtml(listing.seller ?? 'Unavailable')}</code>`)}
${row('Listed', escapeHtml(isoDate(listing.created_at)))}
</section>
<section class="listing-license"><h2>Buyer licence</h2><p>${escapeHtml(listing.license ?? 'See the workspace for the exact licence.')}</p></section>
<p class="listing-note">This page shows public listing details only. The licensed conversation is delivered to the buyer after payment.</p>
<div class="listing-actions"><a class="listing-buy" href="${escapeHtml(appUrl)}">Sign in to buy</a><a class="listing-browse" href="${escapeHtml(appUrl)}#thot-available">Browse all traces</a></div>
</article>`);
}

/** A hidden, unlisted or unknown listing is clearly unavailable, never a 404. */
export function renderListingUnavailablePage(appUrl: string) {
  return shell('No longer available · thot market', `
<article class="listing-page listing-unavailable"><header><a class="listing-brand" href="/"><img src="/assets/thot-logo.png" alt="" width="34" height="38"><span>thot market</span></a></header>
<h1>No longer available</h1>
<p class="listing-note">This listing is no longer available for purchase.</p>
<div class="listing-actions"><a class="listing-browse" href="${escapeHtml(appUrl)}#thot-available">Browse available traces</a></div>
</article>`);
}
