const ATOMS = 10n ** 18n;
export const MAX_STAKING_PREVIEW_ATOMS = 1_000_000_000n * ATOMS;

// The preview is an offer menu, not a quote from a funded onchain pool.
export const STAKING_TIERS = Object.freeze([
  Object.freeze({id: '30d', days: 30, rewardBps: 500}),
  Object.freeze({id: '60d', days: 60, rewardBps: 1200}),
  Object.freeze({id: '90d', days: 90, rewardBps: 3000}),
]);

function tierFor(id) {
  const tier = STAKING_TIERS.find(item => item.id === id);
  if (!tier) throw new RangeError('Choose a listed lock duration.');
  return tier;
}

export function parseStakingAmount(value) {
  if (typeof value !== 'string' || value.length > 64) throw new RangeError('Enter a THOT amount with up to 18 decimal places.');
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) throw new RangeError('Enter a THOT amount with up to 18 decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * ATOMS + BigInt(fraction.padEnd(18, '0'));
  if (amount <= 0n) throw new RangeError('Enter an amount greater than zero.');
  if (amount > MAX_STAKING_PREVIEW_ATOMS) throw new RangeError('Enter no more than 1 billion THOT.');
  return amount;
}

export function formatStakingAmount(atoms) {
  const amount = BigInt(atoms);
  if (amount < 0n) throw new RangeError('Amount cannot be negative.');
  const whole = (amount / ATOMS).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (amount % ATOMS).toString().padStart(18, '0').replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}

export function stakingAnnualizedRates(tierId) {
  const tier = tierFor(tierId), termRate = tier.rewardBps / 10_000;
  return Object.freeze({
    aprPercent: termRate * 365 / tier.days * 100,
    hypotheticalApyPercent: (Math.pow(1 + termRate, 365 / tier.days) - 1) * 100,
  });
}

export function calculateStakingQuote(value, tierId = '90d') {
  const tier = tierFor(tierId), principalAtoms = parseStakingAmount(value);
  const rewardAtoms = principalAtoms * BigInt(tier.rewardBps) / 10_000n;
  if (rewardAtoms === 0n) throw new RangeError('Enter a larger amount; the reward rounds below one token unit.');
  return Object.freeze({
    tier, principalAtoms, rewardAtoms, payoutAtoms: principalAtoms + rewardAtoms,
    ...stakingAnnualizedRates(tierId),
  });
}

const percent = value => value.toFixed(1).replace(/\.0$/, '') + '%';

function receiptHTML(quote) {
  return `<h3>Your ${quote.tier.days}-day preview</h3>
    <dl class="staking-receipt-lines">
      <div><dt>You lock</dt><dd>${formatStakingAmount(quote.principalAtoms)} <span>THOT</span></dd></div>
      <div><dt>Staking reward <span>+${percent(quote.tier.rewardBps / 100)}</span></dt><dd>+${formatStakingAmount(quote.rewardAtoms)} <span>THOT</span></dd></div>
      <div class="staking-total"><dt>At maturity</dt><dd>${formatStakingAmount(quote.payoutAtoms)} <span>THOT</span></dd></div>
    </dl>
    <p class="staking-maturity">Principal + reward, claimable ${quote.tier.days} days after your deposit.</p>
    <p class="staking-apr"><strong>${percent(quote.aprPercent)} APR</strong><span>Simple annualized rate</span></p>`;
}

export function renderStakingPreview() {
  const quote = calculateStakingQuote('10000');
  return `<section class="staking-preview" data-staking-preview aria-labelledby="staking-preview-title">
    <header class="staking-intro"><h2 id="staking-preview-title">Preview staking.</h2><p>More time locked. A higher reward rate. No trace sale required.</p></header>
    <div class="staking-calculator">
      <div class="staking-controls">
        <fieldset class="staking-duration"><legend>Choose your lock</legend>
          <div class="staking-options">${STAKING_TIERS.map(tier => `<label class="staking-option">
            <input type="radio" name="staking-preview-duration" value="${tier.id}" ${tier.id === '90d' ? 'checked' : ''}>
            <span class="staking-option-content"><span class="staking-days">${tier.days} days</span><strong>+${percent(tier.rewardBps / 100)}</strong><span>THOT reward</span><small>${percent(stakingAnnualizedRates(tier.id).aprPercent)} APR</small></span>
          </label>`).join('')}</div>
        </fieldset>
        <label class="staking-amount-label" for="staking-preview-amount">THOT to lock</label>
        <div class="staking-amount-field"><input id="staking-preview-amount" data-staking-amount type="text" inputmode="decimal" value="10000" maxlength="64" autocomplete="off" spellcheck="false" aria-describedby="staking-amount-error staking-amount-help"><span aria-hidden="true">THOT</span></div>
        <p class="staking-input-error" id="staking-amount-error" data-staking-error hidden></p>
        <p class="staking-input-help" id="staking-amount-help">Each deposit has its own term. Principal and reward unlock together.</p>
      </div>
      <div class="staking-receipt" data-staking-receipt aria-live="polite" aria-atomic="true">${receiptHTML(quote)}</div>
    </div>
    <p class="staking-enrollment">Enrollment opens after the reward pool is funded.</p>
    <details class="staking-rate-details"><summary>APR and hypothetical APY</summary>
      <p>The term reward is the actual offer: 30% over 90 days means 10,000 THOT becomes 13,000 THOT. APR compares that rate over a 365-day year without compounding.</p>
      <div class="staking-rate-table-wrap"><table><caption>Annualized comparisons for the preview menu</caption><thead><tr><th scope="col">Lock</th><th scope="col">Term reward</th><th scope="col">APR</th><th scope="col">Hypothetical APY</th></tr></thead><tbody>${STAKING_TIERS.map(tier => {const rates = stakingAnnualizedRates(tier.id); return `<tr><th scope="row">${tier.days} days</th><td>${percent(tier.rewardBps / 100)}</td><td>${percent(rates.aprPercent)}</td><td>${percent(rates.hypotheticalApyPercent)}</td></tr>`;}).join('')}</tbody></table></div>
      <p>Hypothetical APY assumes you could repeatedly reinvest principal and rewards at the same rate for a year. This campaign has no automatic renewal or compounding, and future offers are not guaranteed. Rewards are paid in THOT; these are not dollar returns.</p>
    </details>
    <div class="staking-future"><h3>Your stake, your terms.</h3><p>Holding-based fee cashback is a separate program shown below when enabled. Future offers can add further trace-sale or referral benefits for holders and stakers, including active positions. Your deposit’s agreed base reward and unlock date stay fixed.</p></div>
  </section>`;
}

const bindings = new WeakMap();

export function bindStakingPreview(root) {
  bindings.get(root)?.();
  const update = section => {
    const input = section.querySelector('[data-staking-amount]');
    const selected = section.querySelector('input[type="radio"]:checked');
    const receipt = section.querySelector('[data-staking-receipt]');
    const error = section.querySelector('[data-staking-error]');
    if (!input || !selected || !receipt || !error) return;
    try {
      let quote;
      if(section.dataset?.stakingTerms){
        const tier=JSON.parse(section.dataset?.stakingTerms).find(t=>t.id===selected.value);
        if(!tier)throw Error('Choose a listed lock duration.');
        const principalAtoms=parseStakingAmount(input.value),rewardAtoms=principalAtoms*BigInt(tier.rewardBps)/10000n;
        if(rewardAtoms===0n)throw Error('Enter a larger amount.');
        quote={tier,principalAtoms,rewardAtoms,payoutAtoms:principalAtoms+rewardAtoms,aprPercent:tier.rewardBps/100*365/tier.days};
      }else quote=calculateStakingQuote(input.value,selected.value);
      receipt.innerHTML = receiptHTML(quote);
      input.removeAttribute('aria-invalid');
      error.textContent = ''; error.hidden = true;
    } catch (issue) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = issue.message; error.hidden = false;
      receipt.innerHTML = '<h3>Your staking preview</h3><p class="staking-empty">Enter a valid amount to see your reward and total at maturity.</p>';
    }
  };
  const listener = event => {
    const element = event.target;
    if (!element?.matches?.('[data-staking-amount], [data-staking-duration], input[name="staking-preview-duration"]')) return;
    const section = element.closest('[data-staking-preview]');
    if (section && (root === section || root.contains(section))) update(section);
  };
  root.addEventListener('input', listener);
  root.addEventListener('change', listener);
  if (root.matches?.('[data-staking-preview]')) update(root);
  else root.querySelectorAll('[data-staking-preview]').forEach(update);
  const cleanup = () => {
    root.removeEventListener('input', listener);
    root.removeEventListener('change', listener);
    if (bindings.get(root) === cleanup) bindings.delete(root);
  };
  bindings.set(root, cleanup);
  return cleanup;
}

// Terms and capacities come from the pinned pool, not the illustrative menu above.
export function renderLiveStaking(state, escape) {
  if (!state) return renderStakingPreview();
  const now=state.block.timestamp;
  const campaigns=state.campaigns.filter(c=>!c.closed&&now<c.enrollment_ends_at);
  const cards=campaigns.map(c=>{
    const active=!c.paused&&now>=c.starts_at, terms=c.terms.map(t=>({id:String(t.index),days:t.duration/86400,rewardBps:t.reward_bps}));
    const menu=escape(JSON.stringify(terms)),name=`staking-duration-${c.id}`;
    return `<section class="staking-preview" data-staking-preview data-staking-terms="${menu}" data-staking-campaign="${escape(c.id)}"><header class="staking-intro"><h2>Stake THOT. Earn more THOT.</h2><p>Campaign #${escape(c.id)} · Fully reserved rewards. No trace sale required.</p></header><div class="staking-calculator"><div class="staking-controls"><fieldset class="staking-duration"><legend>Choose your lock</legend><div class="staking-options">${terms.map((t,i)=>`<label class="staking-option"><input type="radio" name="${name}" data-staking-duration value="${t.id}" ${i===terms.length-1?'checked':''}><span class="staking-option-content"><span class="staking-days">${t.days} days</span><strong>+${percent(t.rewardBps/100)}</strong><span>THOT reward</span><small>${percent(t.rewardBps/100*365/t.days)} APR</small></span></label>`).join('')}</div></fieldset><label class="staking-amount-label" for="staking-amount-${c.id}">THOT to lock</label><div class="staking-amount-field"><input id="staking-amount-${c.id}" data-staking-amount type="text" inputmode="decimal" value="10000" maxlength="64"><span>THOT</span></div><p class="staking-input-error" data-staking-error hidden></p><p>Principal and reward unlock together.</p><button class="button primary" data-action="thot-stake" data-id="${escape(c.id)}" ${active?'':'disabled'}>${active?'Review stake':'Enrollment paused or not yet open'}</button></div><div class="staking-receipt" data-staking-receipt aria-live="polite"></div></div><p>${formatStakingAmount(BigInt(c.principal_cap)-BigInt(c.total_deposited))} THOT deposit capacity remaining · ${formatStakingAmount(c.unallocated_reward)} THOT rewards reserved for new deposits.</p><p>Enroll by ${escape(new Date(c.enrollment_ends_at*1000).toLocaleString())}. Your term begins when your deposit confirms.</p><details><summary>APR and hypothetical APY</summary><p>APR is the simple annualized comparison. Hypothetical APY assumes repeated renewal at the same rate, which this campaign does not promise.</p><ul>${terms.map(t=>`<li>${t.days} days: ${percent(t.rewardBps/100)} term reward · ${percent(t.rewardBps/100*365/t.days)} APR · ${percent((Math.pow(1+t.rewardBps/10000,365/t.days)-1)*100)} hypothetical APY</li>`).join('')}</ul><p>Rewards are THOT, not a dollar return. No automatic renewal or early withdrawal.</p></details></section>`;
  }).join('');
  return (cards||'<section class="panel"><h2>Staking</h2><p>No campaign is accepting new deposits. Existing positions retain their agreed terms.</p></section>')+`<section class="panel"><h2>Your staking positions</h2>${state.positions.map(p=>`<article class="thot-lock-lot"><p><strong>${formatStakingAmount(p.principal)} THOT locked</strong> + ${formatStakingAmount(p.reward)} THOT reward</p><p>Claim ${formatStakingAmount(BigInt(p.principal)+BigInt(p.reward))} THOT from ${escape(new Date(p.unlock_at*1000).toLocaleString())}.</p>${now>=p.unlock_at?`<button class="button primary" data-action="thot-staking-claim" data-id="${escape(p.id)}">Claim principal + reward</button>`:'<p>Reward reserved. Waiting for maturity.</p>'}</article>`).join('')||'<p>No active stakes yet.</p>'}<details><summary>Pool contract</summary><code>${escape(state.address)}</code></details></section>`;
}
