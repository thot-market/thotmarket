// Live market numbers from the app's public stats endpoint. Supply first; sales once the app publishes them.
(async () => {
  const link = document.querySelector('[data-workspace-link]');
  const api = link && /^https?:/.test(link.getAttribute('href')) ? new URL(link.href).origin : location.origin;
  const thot = atoms => { const n = BigInt(atoms ?? 0), base = 10n ** 18n, frac = String(n % base).padStart(18, '0').slice(0, 2).replace(/0+$/, ''); return (n / base).toLocaleString('en-US') + (frac ? '.' + frac : ''); };
  const set = (key, value) => { const node = document.querySelector(`[data-stat="${key}"]`); if (node) node.textContent = value; };
  const row = (title, meta, href, label) => {
    const li = document.createElement('li'), strong = document.createElement('strong'), span = document.createElement('span');
    strong.textContent = title; span.textContent = meta; li.append(strong, span);
    if (href) { const a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.textContent = label; li.append(a); }
    return li;
  };
  const empty = text => [Object.assign(document.createElement('li'), { textContent: text })];
  const note = document.querySelector('[data-stats-note]'), newest = document.querySelector('[data-stats-newest]'), recent = document.querySelector('[data-stats-recent]');
  try {
    const response = await fetch(api + '/v1/public/stats', { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error('UNAVAILABLE');
    const s = await response.json(), i = s.independent;
    set('listings', s.listings_active.toLocaleString('en-US')); set('sellers', (s.sellers_listing ?? 0).toLocaleString('en-US'));
    newest.replaceChildren(...(s.newest_listings?.length ? s.newest_listings.map(l => row(l.title, `${thot(l.price_atoms)} THOT · ${l.summary}`, api + l.public_path, 'View listing')) : empty('Nothing listed yet. Be the first.')));
    if (i) {
      set('purchases', i.purchases.toLocaleString('en-US')); set('paid', thot(i.paid_to_sellers_atoms));
      recent.replaceChildren(...s.recent.map(r => row(r.title, `${thot(r.gross_atoms)} THOT · ${r.status}${r.treasury ? ' · treasury purchase' : ''}`, r.transaction_url, 'View transaction')));
      document.querySelectorAll('[data-sales]').forEach(node => { node.hidden = false; });
    }
    const share = document.querySelector('[data-stats-share]');
    if (share) {
      const text = i ? `${i.purchases} purchases and ${thot(i.paid_to_sellers_atoms)} THOT paid to sellers on thot market.` : `${s.listings_active} items for sale from ${s.sellers_listing} sellers on thot market. Your AI chats are worth something.`;
      share.href = 'https://x.com/intent/post?' + new URLSearchParams({ text, url: 'https://thot.market/stats' }); share.hidden = false;
    }
    note.textContent = `${i ? s.basis + ' ' : ''}Updated ${new Date(s.as_of).toLocaleString()}.`;
  } catch {
    note.textContent = 'Live numbers are unavailable right now. Try again in a minute.';
    newest.replaceChildren();
  }
})();
