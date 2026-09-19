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

  async function loadWorkspace() {
    try {
      const response = await fetch('/v1/public/site-config', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const config = await response.json();
      if (config.access !== 'wallet') return;
      // Fixed destinations keep referral CTAs out of user-controlled redirects.
      if (!['https://app.test.thot.market/app', 'https://app.staging.thot.market/app', 'https://app.thot.market/app'].includes(config.appUrl)) return;
      document.querySelectorAll('[data-workspace-link]').forEach(node => { node.href = config.appUrl; });
    } catch { /* The same-origin /app access page remains available. */ }
  }

  function emptyProof(text) {
    document.querySelectorAll('[data-proof-rows]').forEach(container => {
      const p = document.createElement('p'); p.className = 'proof-empty'; p.textContent = text; container.replaceChildren(p);
    });
  }
  async function loadProof() {
    try {
      const response = await fetch('/v1/public/market-proof', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('UNAVAILABLE');
      const proof = await response.json();
      if (proof.status !== 'available' || proof.chain_id !== 46630 || proof.test_assets !== true || proof.scope !== 'testnet-verification') throw Error('UNAVAILABLE');
      const date = new Date(proof.as_of);
      if (!Number.isFinite(date.getTime()) || !Number.isSafeInteger(proof.block_number)) throw Error('UNAVAILABLE');
      const timestamp = date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
      set('[data-proof-time]', `Snapshot ${timestamp} · block ${proof.block_number.toLocaleString('en-US')}`);
      // Never silently display changed economics under fixed 20% public copy.
      earningsExample('10', 1, proof.tariff);
      tariff = proof.tariff; recalculate();
      set('[data-tariff-note]', `Illustration using the verified ${proof.environment} testnet tariff at block ${proof.block_number.toLocaleString('en-US')} (${timestamp}). Test tokens have no monetary value. This is not your balance or a production price quote.`);
      if (!Array.isArray(proof.purchases) || proof.purchases.length > 5) throw Error('UNAVAILABLE');
      if (!proof.purchases.length) { emptyProof('No confirmed purchases appear in this environment’s published snapshot yet. Try the workspace and follow the next receipt.'); return; }
      const purchases = proof.purchases.map(item => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(item.tx_hash) || !Number.isSafeInteger(item.block_number) || item.block_number > proof.block_number || !['funded', 'delivered', 'finalized'].includes(item.status)) throw Error('INVALID_RECEIPT');
        const explorer = `https://explorer.testnet.chain.robinhood.com/tx/${item.tx_hash}`;
        if (item.explorer_url !== explorer) throw Error('INVALID_RECEIPT');
        return { ...item, amount: formatThot(parseThot(item.amount_thot)), explorer };
      });
      document.querySelectorAll('[data-proof-rows]').forEach(container => {
        const rows = purchases.map(item => {
          const row = document.createElement('div'); row.className = 'proof-row';
          const detail = document.createElement('div'), title = document.createElement('strong'), label = document.createElement('small');
          title.textContent = { funded: 'Funded · awaiting delivery', delivered: 'Delivered · awaiting settlement', finalized: 'Finalized · proceeds allocated' }[item.status];
          label.textContent = item.source === 'reserve' ? 'Reserve-funded test purchase' : item.source === 'independent' ? 'Non-reserve test purchase' : 'Test purchase';
          detail.append(title, label);
          const amount = document.createElement('div'); amount.className = 'proof-amount';
          const gross = document.createElement('strong'), basis = document.createElement('small'); gross.textContent = item.amount + ' test THOT'; basis.textContent = 'Gross purchase price'; amount.append(gross, basis);
          const link = document.createElement('a'); link.href = item.explorer; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View transaction'; link.setAttribute('aria-label', 'View transaction ' + item.tx_hash.slice(0, 10));
          row.append(detail, amount, link); return row;
        });
        container.replaceChildren(...rows);
      });
    } catch {
      set('[data-proof-time]', 'Public receipts are not available in this snapshot.');
      emptyProof('Open the workspace to see available market activity. We only show transaction receipts here when they can be verified.');
    }
  }
  void loadWorkspace(); void loadProof();
}
