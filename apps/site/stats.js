// Live, verifiable market numbers from the app's public stats endpoint.
(async () => {
  const link = document.querySelector('[data-workspace-link]');
  const api = link && /^https?:/.test(link.getAttribute('href')) ? new URL(link.href).origin : location.origin;
  const thot = atoms => { const n = BigInt(atoms ?? 0), base = 10n ** 18n, frac = String(n % base).padStart(18, '0').slice(0, 2).replace(/0+$/, ''); return (n / base).toLocaleString('en-US') + (frac ? '.' + frac : ''); };
  const set = (key, value) => { const node = document.querySelector(`[data-stat="${key}"]`); if (node) node.textContent = value; };
  const note = document.querySelector('[data-stats-note]'), recent = document.querySelector('[data-stats-recent]');
  try {
    const response = await fetch(api + '/v1/public/stats', { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error('UNAVAILABLE');
    const s = await response.json(), i = s.independent;
    set('listings', s.listings_active.toLocaleString('en-US')); set('purchases', i.purchases.toLocaleString('en-US'));
    set('paid', thot(i.paid_to_sellers_atoms)); set('people', `${i.sellers} · ${i.buyers}`);
    recent.replaceChildren(...(s.recent.length ? s.recent.map(r => {
      const li = document.createElement('li'), title = document.createElement('strong'), meta = document.createElement('span');
      title.textContent = r.title; meta.textContent = `${thot(r.gross_atoms)} THOT · ${r.status}${r.treasury ? ' · treasury purchase' : ''}`;
      li.append(title, meta);
      if (r.transaction_url) { const a = document.createElement('a'); a.href = r.transaction_url; a.rel = 'noopener'; a.textContent = 'View transaction'; li.append(a); }
      return li;
    }) : [Object.assign(document.createElement('li'), { textContent: 'No sales yet.' })]));
    const share = document.querySelector('[data-stats-share]');
    if (share) { share.href = 'https://x.com/intent/post?' + new URLSearchParams({ text: `${i.purchases} purchases and ${thot(i.paid_to_sellers_atoms)} THOT paid to sellers on thot market, every sale on chain.`, url: 'https://thot.market/stats' }); share.hidden = false; }
    note.textContent = `${s.basis} Updated ${new Date(s.as_of).toLocaleString()}${s.index?.complete === false ? ' · index still catching up' : ''}.`;
  } catch {
    note.textContent = 'Live numbers are unavailable right now. Try again in a minute.';
    recent.replaceChildren();
  }
})();
