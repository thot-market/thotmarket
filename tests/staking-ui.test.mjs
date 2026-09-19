import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STAKING_TIERS, MAX_STAKING_PREVIEW_ATOMS, parseStakingAmount, formatStakingAmount,
  calculateStakingQuote, stakingAnnualizedRates, renderStakingPreview, bindStakingPreview,
} from '../apps/dashboard/staking-ui.js';

const ATOMS = 10n ** 18n;

test('longer terms strictly increase both the term rate and annualized rates', () => {
  assert.deepEqual(STAKING_TIERS.map(tier => [tier.days, tier.rewardBps]), [[30, 500], [60, 1200], [90, 3000]]);
  const rates = STAKING_TIERS.map(tier => stakingAnnualizedRates(tier.id));
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i].aprPercent > rates[i - 1].aprPercent);
    assert.ok(rates[i].hypotheticalApyPercent > rates[i - 1].hypotheticalApyPercent);
  }
  assert.ok(Math.abs(rates[2].aprPercent - 121.66666666666667) < 1e-10);
  assert.ok(Math.abs(rates[2].hypotheticalApyPercent - (1.3 ** (365 / 90) - 1) * 100) < 1e-10);
  assert.ok(Object.isFrozen(STAKING_TIERS) && STAKING_TIERS.every(Object.isFrozen));
});

test('THOT payouts preserve principal and floor only fractional reward atoms', () => {
  for (const tier of STAKING_TIERS) {
    for (const input of ['10000', '1000000000', '0.000000000000000020', '987654321.123456789123456789']) {
      const quote = calculateStakingQuote(input, tier.id);
      assert.equal(quote.payoutAtoms, quote.principalAtoms + quote.rewardAtoms);
      const numerator = quote.principalAtoms * BigInt(tier.rewardBps);
      assert.ok(quote.rewardAtoms * 10_000n <= numerator);
      assert.ok((quote.rewardAtoms + 1n) * 10_000n > numerator);
    }
  }
  assert.equal(calculateStakingQuote('10000').rewardAtoms, 3000n * ATOMS);
  assert.equal(calculateStakingQuote('10000').payoutAtoms, 13000n * ATOMS);
  assert.equal(parseStakingAmount('1000000000'), MAX_STAKING_PREVIEW_ATOMS);
  assert.equal(formatStakingAmount(parseStakingAmount('987654321.123456789123456789')), '987,654,321.123456789123456789');
});

test('invalid and over-supply amounts cannot produce a quote', () => {
  for (const input of ['', ' ', '0', '0.000000000000000001', '-1', '1e9', '.5', '1.', 'NaN', 'Infinity', '1,000', '<script>', '0.0000000000000000001', '1000000000.000000000000000001', '9'.repeat(65), null, 10000]) {
    assert.throws(() => calculateStakingQuote(input), RangeError, String(input));
  }
  assert.throws(() => calculateStakingQuote('10000', '365d'), /Choose a listed/);
});

test('preview shows term payouts first and identifies annual compounding as hypothetical', () => {
  const html = renderStakingPreview();
  assert.match(html, /13,000/);
  assert.match(html, /121\.7% APR/);
  assert.match(html, /189\.8%/);
  assert.match(html, /Hypothetical APY/);
  assert.match(html, /no automatic renewal or compounding/);
  assert.match(html, /Enrollment opens after the reward pool is funded/);
  assert.match(html, /No trace sale required/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<button|undefined|NaN|Guaranteed APY/);
});

function fixture() {
  const listeners = new Map();
  const input = {value: '10000', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; }, matches() { return true; }, closest() { return section; }};
  const selected = {value: '90d'};
  const receipt = {innerHTML: ''}, error = {textContent: '', hidden: true};
  const section = {querySelector(selector) { return selector.includes(':checked') ? selected : selector === '[data-staking-amount]' ? input : selector === '[data-staking-receipt]' ? receipt : error; }};
  const root = {
    querySelectorAll() { return [section]; }, contains(value) { return value === section; },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  return {root, input, selected, receipt, error, listeners, dispatch(type = 'input') { for (const listener of listeners.get(type) ?? []) listener({target: input}); }};
}

test('invalid edits clear previous payout; correcting input and changing duration recover', () => {
  const view = fixture(), cleanup = bindStakingPreview(view.root);
  assert.match(view.receipt.innerHTML, /13,000/);
  view.input.value = ''; view.dispatch();
  assert.equal(view.input.attrs['aria-invalid'], 'true');
  assert.equal(view.error.hidden, false);
  assert.doesNotMatch(view.receipt.innerHTML, /13,000|3,000/);
  view.input.value = '20000'; view.selected.value = '30d'; view.dispatch('change');
  assert.equal(view.input.attrs['aria-invalid'], undefined);
  assert.equal(view.error.hidden, true);
  assert.match(view.receipt.innerHTML, /21,000/);
  assert.match(view.receipt.innerHTML, /60\.8% APR/);
  cleanup();
  assert.equal(view.listeners.get('input').size, 0);
  assert.equal(view.listeners.get('change').size, 0);
});

test('rebinding does not duplicate listeners or let an old cleanup remove the new handler', () => {
  const view = fixture(), oldCleanup = bindStakingPreview(view.root);
  const cleanup = bindStakingPreview(view.root);
  assert.equal(view.listeners.get('input').size, 1);
  oldCleanup();
  view.input.value = '10'; view.dispatch();
  assert.match(view.receipt.innerHTML, />13 <span>THOT/);
  assert.equal(view.listeners.get('input').size, 1);
  cleanup();
  assert.equal(view.listeners.get('input').size, 0);
});
