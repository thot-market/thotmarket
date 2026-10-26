const SCALE = 10n ** 18n;
const EXAMPLE = { service_fee_thot: '0.04', direct_cost_thot: '0.01', referral_bps: 2000 };

export function parseThot(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,18})?$/.test(value)) throw Error('INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
export function formatThot(atoms) {
  if (atoms < 0n) throw Error('INVALID_AMOUNT');
  const fraction = (atoms % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return (atoms / SCALE).toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}
export function earningsExample(price, count, tariff = EXAMPLE) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw Error('INVALID_SALE_COUNT');
  if (tariff.referral_bps !== 2000) throw Error('UNSUPPORTED_REFERRAL_RATE');
  const gross = parseThot(price), fee = parseThot(tariff.service_fee_thot), costs = parseThot(tariff.direct_cost_thot);
  if (gross > 1000000000n * SCALE) throw Error('INVALID_AMOUNT');
  if (fee < costs) throw Error('INVALID_TARIFF');
  const margin = fee - costs;
  const perSale = margin * BigInt(tariff.referral_bps) / 10000n;
  return { gross, fee, costs, margin, seller: gross >= fee ? gross - fee : null, perSale, referral: perSale * BigInt(count) };
}

if (typeof document !== 'undefined') {
  let tariff = EXAMPLE;
  const set = (selector, value) => document.querySelectorAll(selector).forEach(node => { node.textContent = value; });
  const countInput = document.querySelector('[data-sales-count]');
  const priceInput = document.querySelector('[data-trace-price]');
  function recalculate() {
    try {
      const rawCount = countInput?.value ?? '1000';
      if (!/^(?:0|[1-9][0-9]{0,6})$/.test(rawCount)) throw Error('INVALID_SALE_COUNT');
      const count = Number(rawCount), price = priceInput?.value ?? '10';
      const result = earningsExample(price, count, tariff);
      set('[data-service-fee]', formatThot(result.fee));
      set('[data-direct-cost]', formatThot(result.costs));
      set('[data-net-margin]', formatThot(result.margin));
      set('[data-referral-total]', formatThot(result.referral));
      set('[data-referral-formula]', `${count.toLocaleString('en-US')} sales × ${formatThot(result.margin)} THOT margin × 20%`);
      set('[data-seller-proceeds]', result.seller === null ? '—' : formatThot(result.seller));
      set('[data-sale-formula]', result.seller === null ? 'Choose a price at or above the service fee.' : `${formatThot(result.gross)} THOT price − ${formatThot(result.fee)} THOT fee`);
      countInput?.setAttribute('aria-invalid', 'false');
      priceInput?.setAttribute('aria-invalid', result.seller === null ? 'true' : 'false');
    } catch {
      if (countInput) { countInput.setAttribute('aria-invalid', 'true'); set('[data-referral-total]', '—'); set('[data-referral-formula]', 'Enter a whole number from 0 to 1,000,000.'); }
      if (priceInput) { priceInput.setAttribute('aria-invalid', 'true'); set('[data-seller-proceeds]', '—'); set('[data-sale-formula]', 'Enter a valid THOT price.'); }
    }
  }
  countInput?.addEventListener('input', () => {
    document.querySelectorAll('[data-sales-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.salesPreset === countInput.value)));
    recalculate();
  });
  priceInput?.addEventListener('input', recalculate);
  document.querySelectorAll('[data-sales-preset]').forEach(button => {
    button.addEventListener('click', () => {
      if (!countInput) return;
      countInput.value = button.dataset.salesPreset;
      document.querySelectorAll('[data-sales-preset]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      recalculate();
    });
  });

  const tools = {
    openrouter: { title: 'Keep your models. Give the work a second life.', description: 'Connect your OpenRouter key and use your thot endpoint in compatible tools. Your model requests keep working; eligible conversations go into your private vault.', connection: 'Your key → thot endpoint → OpenRouter', steps: ['Connect your key and choose your sale terms.', 'Use the thot endpoint in your usual API client.', 'Eligible recordings list automatically under those terms.'] },
    claude: { title: 'Keep coding. Keep the useful trail.', description: 'Use the supported capture helper with Claude Code. The debugging, corrections and decisions can become a trace someone wants to learn from.', connection: 'Claude Code → capture helper → private vault', steps: ['Connect the supported capture helper.', 'Authorize the sale policy for eligible recordings.', 'Keep using your CLI while the helper captures the session.'] },
    codex: { title: 'The fix is useful. So is how you found it.', description: 'Use the supported capture helper with Codex. Contribute the research behind the result, with its recorded source and model information.', connection: 'Codex → capture helper → private vault', steps: ['Connect the supported capture helper.', 'Authorize the sale policy for eligible recordings.', 'Keep using your CLI while the helper captures the session.'] },
  };
  document.querySelectorAll('[data-demo-tool]').forEach(button => button.addEventListener('click', () => {
    const tool = tools[button.dataset.demoTool];
    if (!tool) return;
    document.querySelectorAll('[data-demo-tool]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    set('[data-tool-title]', tool.title); set('[data-tool-description]', tool.description); set('[data-tool-connection]', tool.connection);
    document.querySelectorAll('[data-tool-step]').forEach((node, index) => { node.textContent = tool.steps[index]; });
  }));
  recalculate();

  function emptyProof(text) {
    document.querySelectorAll('[data-proof-rows]').forEach(container => {
      const p = document.createElement('p'); p.className = 'proof-empty'; p.textContent = text; container.replaceChildren(p);
    });
  }
  // An environment with no published snapshot leaves the receipts panel neutral:
  // no badge and no status line that could read as an outage, one plain sentence instead.
  function neutralProof() {
    document.querySelectorAll('[data-proof-environment],[data-proof-time]').forEach(node => { node.hidden = true; });
    emptyProof('Public purchase receipts appear here when this environment publishes a verified snapshot.');
  }
  // Live, verifiable sales from the app's public stats; the board stays hidden until there is one.
  async function loadProof() {
    try {
      const link = document.querySelector('[data-workspace-link]');
      const api = link && /^https?:/.test(link.getAttribute('href')) ? new URL(link.href).origin : location.origin;
      const response = await fetch(api + '/v1/public/stats', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('UNAVAILABLE');
      const stats = await response.json(), sales = Array.isArray(stats.recent) ? stats.recent.slice(0, 5) : [];
      if (!stats.independent?.purchases || !sales.length) throw Error('NO_SALES');
      const thot = atoms => { const n = BigInt(atoms ?? 0), base = 10n ** 18n, frac = String(n % base).padStart(18, '0').slice(0, 2).replace(/0+$/, ''); return (n / base).toLocaleString('en-US') + (frac ? '.' + frac : ''); };
      set('[data-proof-environment]', stats.chain?.name ?? 'On chain');
      set('[data-proof-time]', `${stats.independent.purchases.toLocaleString('en-US')} purchases · ${thot(stats.independent.paid_to_sellers_atoms)} THOT paid to sellers`);
      set('[data-proof-heading]', 'Recent sales');
      set('[data-proof-caption]', stats.basis);
      document.querySelectorAll('[data-proof-rows]').forEach(container => {
        container.replaceChildren(...sales.map(item => {
          const row = document.createElement('div'); row.className = 'proof-row';
          const detail = document.createElement('div'), title = document.createElement('strong'), label = document.createElement('small');
          title.textContent = item.title; label.textContent = item.treasury ? `Treasury purchase · ${item.status}` : `Purchase · ${item.status}`;
          detail.append(title, label);
          const amount = document.createElement('div'); amount.className = 'proof-amount';
          const gross = document.createElement('strong'); gross.textContent = thot(item.gross_atoms) + ' THOT'; amount.append(gross);
          row.append(detail, amount);
          if (item.transaction_url) { const a = document.createElement('a'); a.href = item.transaction_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'View transaction'; row.append(a); }
          return row;
        }));
      });
    } catch {
      neutralProof();
      document.querySelector('[data-market-proof]')?.setAttribute('hidden', '');
    }
  }
  void loadProof();
}
