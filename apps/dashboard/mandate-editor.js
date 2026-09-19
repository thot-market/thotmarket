const decimals = { USD: 2, USDC: 6 };
const workflows = ['coding', 'research', 'investment_research', 'legal_research', 'contract_review', 'chat', 'agent', 'other'];
const tiers = ['P0_OPERATOR', 'P1_WITNESSED', 'P2_TEE', 'P3_UPSTREAM'];
const rights = ['eligible', 'eligible_with_restrictions'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = value => escape(JSON.stringify(value, null, 2));

// Money stays in strings/BigInt throughout the form; never round it through Number.
export function decimalToMinor(value, currency) {
  const places = decimals[currency];
  if (places === undefined || typeof value !== 'string' || !new RegExp(`^(0|[1-9][0-9]*)(?:\\.[0-9]{1,${places}})?$`).test(value.trim())) throw new Error(`Enter an exact ${currency} amount with no commas and at most ${places ?? 0} decimal places.`);
  const [whole, fraction = ''] = value.trim().split('.');
  const minor = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
  if (minor >= 10n ** 78n) throw new Error('This amount exceeds the supported ledger range.');
  return minor.toString();
}
export function minorToDecimal(value, currency) {
  if (!(currency in decimals) || !/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('The stored amount cannot be edited safely.');
  const places = decimals[currency], minor = BigInt(value), base = 10n ** BigInt(places);
  return `${minor / base}.${(minor % base).toString().padStart(places, '0')}`;
}
const integer = (value, label, minimum = 0) => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  return Number(value);
};
const timestamp = (value, label) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value), parsed = new Date(value);
  if (!parts || !Number.isFinite(parsed.getTime()) || [parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds()].some((part, i) => part !== Number(parts[i + 1]))) throw new Error(`${label} must be a valid UTC timestamp, such as 2026-09-30T12:00:00Z.`);
  return value;
};
function predicates(value, kind) {
  let parsed;
  try { parsed = JSON.parse(value.trim() || '[]'); } catch { throw new Error(`${kind} requirements must be a JSON array. Use [] for no requirement.`); }
  if (!Array.isArray(parsed) || parsed.length > 10000) throw new Error(`${kind} requirements must be a bounded JSON array.`);
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${kind} requirements must contain objects.`);
    const allowed = kind === 'Credential' ? ['type', 'accepted_values', 'freshness_days'] : ['type', 'security_ids', 'max_lag_days'];
    if (Object.keys(item).some(key => !allowed.includes(key))) throw new Error(`${kind} requirement contains an unsupported field.`);
    if (kind === 'Credential') {
      if (!['workplace_cohort', 'professional_cohort'].includes(item.type) || !Array.isArray(item.accepted_values) || !item.accepted_values.length || !item.accepted_values.every(value => typeof value === 'string' && /^cohort:[a-z0-9_:-]{1,120}$/.test(value))) throw new Error('Credential requirements need a supported cohort type and nonempty cohort:… values.');
      if ('freshness_days' in item && (typeof item.freshness_days !== 'number' || !Number.isSafeInteger(item.freshness_days) || item.freshness_days < 0)) throw new Error('Credential freshness_days must be a nonnegative whole number.');
    } else {
      if (!['security_traded', 'security_held', 'security_action'].includes(item.type)) throw new Error('Outcome requirement type must be security_traded, security_held or security_action.');
      if ('security_ids' in item && (!Array.isArray(item.security_ids) || !item.security_ids.every(value => typeof value === 'string' && /^[a-z0-9_-]+:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(value)))) throw new Error('Security identifiers must include their provider and mapping version, for example broker:AAPL@mapping-v1.');
      if ('max_lag_days' in item && (typeof item.max_lag_days !== 'number' || !Number.isSafeInteger(item.max_lag_days) || item.max_lag_days < 0)) throw new Error('Outcome max_lag_days must be a nonnegative whole number.');
    }
  }
  return parsed;
}

/** Complete editable sections only. Identity, state and funding amounts stay server-managed. */
export function draftFromForm(data, revision, now = Date.now()) {
  const value = name => String(data.get(name) ?? '').trim();
  const selected = (name, allowed, required = false) => {
    const values = data.getAll(name).map(String);
    if (required && !values.length || values.some(item => !allowed.includes(item)) || new Set(values).size !== values.length) throw new Error(`Choose valid ${name.replaceAll('_', ' ')}.`);
    return values;
  };
  const currency = value('currency'), unit = decimalToMinor(value('unit_price'), currency), budget = decimalToMinor(value('total_budget'), currency);
  if (BigInt(unit) <= 0n || BigInt(budget) < BigInt(unit)) throw new Error('The unit price must be positive, and the total budget must cover at least one unit.');
  const criteria = { provenance_tiers: selected('provenance_tiers', tiers, true), workflow_types: selected('workflow_types', workflows), rights_required: selected('rights_required', rights, true) };
  const start = value('date_start'), end = value('date_end');
  if (start || end) {
    if (!start || !end) throw new Error('Supply both date-window boundaries, or clear both.');
    criteria.date_range = { start: timestamp(start, 'Date-window start'), end: timestamp(end, 'Date-window end') };
    if (Date.parse(end) < Date.parse(start)) throw new Error('The date-window end cannot precede its start.');
  }
  const credential = predicates(value('credential_predicates'), 'Credential'), outcome = predicates(value('outcome_predicates'), 'Outcome');
  if (credential.length) criteria.credential_predicates = credential;
  if (outcome.length) criteria.outcome_predicates = outcome;
  const expires = timestamp(value('expires_at'), 'Expiry');
  if (Date.parse(expires) <= now) throw new Error('Choose a future expiry.');
  const thresholdText = value('threshold'), threshold = Number(thresholdText);
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(thresholdText) || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('The assay threshold must be between 0 and 1.');
  const license = { purpose: value('purpose'), model_training: data.has('model_training'), onward_transfer: data.has('onward_transfer'), exclusive: data.has('exclusive'), retention_days: integer(value('retention_days'), 'Retention days', 1) };
  if (!license.purpose || license.purpose.length > 4096) throw new Error('Enter a nonempty license purpose.');
  const template = value('license_template_id');
  if (!template) throw new Error('Enter an operator-approved license template identifier.');
  if (template === 'development-research-v1' && (license.purpose !== 'research' || license.model_training || license.onward_transfer || license.exclusive || license.retention_days > 30)) throw new Error('The development research license is non-exclusive, research-only, at most 30 days, with no model training or onward transfer.');
  const mode = value('funding_mode');
  if (!['offchain_escrow', 'onchain_escrow'].includes(mode)) throw new Error('Choose a supported funding mode.');
  return {
    criteria, assay: { assay_id: 'safe-features', version: '1', threshold, input_scope: 'safe-features-v1', output_schema: 'accepted-score-relevance/1' },
    economics: { currency, unit_price_minor: unit, total_budget_minor: budget, max_units: integer(value('max_units'), 'Maximum units', 1), direct_cost_policy_id: 'direct-costs/v1' },
    license, funding: { mode }, expires_at: expires, license_template_id: template,
    ...(revision === undefined ? {} : { expected_revision: integer(String(revision), 'Draft revision', 1) }),
  };
}

export function newDraftInput(category = 'general', now = Date.now()) {
  if (!['general', 'research_flow', 'professional_flow'].includes(category)) throw new Error('Unknown mandate category.');
  const criteria = { provenance_tiers: ['P0_OPERATOR'], workflow_types: [{ general: 'coding', research_flow: 'investment_research', professional_flow: 'contract_review' }[category]], rights_required: ['eligible'] };
  if (category === 'research_flow') criteria.outcome_predicates = [{ type: 'security_traded', security_ids: ['broker:AAPL@mapping-v1'] }];
  if (category === 'professional_flow') criteria.credential_predicates = [{ type: 'workplace_cohort', accepted_values: ['cohort:law_firm_eligible_v1'], freshness_days: 30 }];
  return { criteria, assay: { assay_id: 'safe-features', version: '1', threshold: 0.5, input_scope: 'safe-features-v1', output_schema: 'accepted-score-relevance/1' }, economics: { currency: 'USD', unit_price_minor: '10000', total_budget_minor: '100000', max_units: 10, direct_cost_policy_id: 'direct-costs/v1' }, license: { purpose: 'research', model_training: false, onward_transfer: false, exclusive: false, retention_days: 30 }, funding: { mode: 'offchain_escrow' }, license_template_id: 'development-research-v1', expires_at: new Date(now + 7 * 86400000).toISOString() };
}

const field = (name, label, value, attributes = '', help = '') => `<div class="field"><label for="draft-${name}">${escape(label)}</label><input id="draft-${name}" name="${name}" value="${escape(value)}" ${attributes}>${help ? `<small>${escape(help)}</small>` : ''}</div>`;
const check = (name, label, checked, value = 'on') => `<label class="consent-check"><input type="checkbox" name="${name}" value="${escape(value)}" ${checked ? 'checked' : ''}><span>${escape(label)}</span></label>`;
const options = (values, current) => values.map(value => `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(value.replaceAll('_', ' '))}</option>`).join('');
function formHTML(m,anvil=false) {
  return `<form id="mandate-draft-form"><p class="legal-note">Saving changes neither funds nor activates this mandate. Once any funding or sale is committed, its terms are frozen; create a new mandate for different terms.</p>
    <h3>Price & budget</h3><div class="field"><label for="draft-currency">Settlement currency</label><select id="draft-currency" name="currency">${anvil?'<option value="USDC">Test dollars · 6 decimals</option>':options(['USD', 'USDC'], m.economics.currency)}</select><small>${anvil?'Six-decimal tUSD on local Anvil. This is a test asset, not Circle-issued USDC.':'USD has 2 decimal places; USDC has 6. Changing currency changes the denomination, not an exchange rate. Local funding remains simulated.'}</small></div>
    <div class="sample-grid">${field('unit_price', 'Price per accepted trace', minorToDecimal(m.economics.unit_price_minor, m.economics.currency), 'required inputmode="decimal" autocomplete="off"', 'Exact decimal amount; no commas or scientific notation.')}${field('total_budget', 'Total budget', minorToDecimal(m.economics.total_budget_minor, m.economics.currency), 'required inputmode="decimal" autocomplete="off"')}${field('max_units', 'Maximum licensed traces', m.economics.max_units, 'required inputmode="numeric"')}${field('expires_at', 'Mandate expiry · UTC', m.expires_at, 'required spellcheck="false"', 'Keep the full UTC timestamp, ending in Z.')}</div>
    <div class="field"><label for="draft-funding-mode">Funding mode</label><select id="draft-funding-mode" name="funding_mode">${options(['offchain_escrow', 'onchain_escrow'], m.funding.mode)}</select><small>This selects the mandate contract. It does not connect a wallet or move real funds.</small></div>
    <hr class="divider"><h3>Matching criteria</h3><p class="legal-note">These are required filters, not a claim that matching evidence is already available. An empty workflow selection allows any supported workflow.</p><h4>Workflow types</h4><div class="sample-grid">${workflows.map(value => check('workflow_types', value.replaceAll('_', ' '), m.criteria.workflow_types.includes(value), value)).join('')}</div><h4>Accepted provenance tiers</h4><div class="sample-grid">${tiers.map(value => check('provenance_tiers', value, m.criteria.provenance_tiers.includes(value), value)).join('')}</div><p class="legal-note">P0 local operator evidence is not P1 witnessed, P2 TEE or P3 upstream evidence.</p><h4>Required rights status</h4>${rights.map(value => check('rights_required', value.replaceAll('_', ' '), m.criteria.rights_required.includes(value), value)).join('')}
    <details><summary>Optional time window & evidence requirements</summary><div class="sample-grid">${field('date_start', 'Trace window start · UTC', m.criteria.date_range?.start ?? '', 'spellcheck="false"', 'Leave both boundaries blank for no time-window filter.')}${field('date_end', 'Trace window end · UTC', m.criteria.date_range?.end ?? '', 'spellcheck="false"')}</div><div class="field"><label for="draft-credentials">Credential requirements · JSON array</label><textarea id="draft-credentials" name="credential_predicates" spellcheck="false" rows="6">${json(m.criteria.credential_predicates ?? [])}</textarea><small>Types: workplace_cohort or professional_cohort. Require accepted_values such as ["cohort:law_firm_eligible_v1"], with optional freshness_days. [] clears the requirements.</small></div><div class="field"><label for="draft-outcomes">Outcome requirements · JSON array</label><textarea id="draft-outcomes" name="outcome_predicates" spellcheck="false" rows="6">${json(m.criteria.outcome_predicates ?? [])}</textarea><small>Types: security_traded, security_held or security_action. Optional security_ids require an explicit mapping, such as ["broker:AAPL@mapping-v1"]; optional max_lag_days. [] clears the requirements.</small></div></details>
    <hr class="divider"><h3>Private assay</h3><p class="legal-note">Approved safe-features / version 1. Input: safe-features-v1. Output: accepted-score-relevance/1. Arbitrary buyer code and semantic topic search are unavailable.</p>${field('threshold', 'Acceptance threshold · 0 to 1', m.assay.threshold, 'required inputmode="decimal"')}<p class="legal-note">Direct-cost policy is fixed to direct-costs/v1. Buyer rejection details do not expose private source traces.</p>
    <hr class="divider"><h3>License terms</h3>${field('license_template_id', 'Operator-approved template ID', m.license_template_id, 'required spellcheck="false"', 'The built-in development-research-v1 template is synthetic-only: research, non-exclusive, at most 30 days, no training or onward transfer. Other templates require prior operator approval.')}<div class="sample-grid">${field('purpose', 'Licensed purpose', m.license.purpose, 'required')}${field('retention_days', 'Buyer retention · days', m.license.retention_days, 'required inputmode="numeric"')}</div>${check('model_training', 'Permit model training', m.license.model_training)}${check('onward_transfer', 'Permit onward transfer', m.license.onward_transfer)}${check('exclusive', 'Exclusive license (requires an enabled, approved template)', m.license.exclusive)}<p class="legal-note">Template approval, deployment feature gates and each contributor’s policy are checked again on the server. These controls do not establish legal rights.</p>
    <hr class="divider"><button type="button" class="text-button" id="draft-review">Review exact draft request →</button><pre id="draft-request-preview" class="json-view" hidden tabindex="0" aria-label="Exact draft request JSON"></pre><p id="draft-save-status" class="legal-note" role="status"></p></form>`;
}

/** Integrates with the existing modal and authenticated API; owns only its own form events. */
export function createMandateEditor({ api, refresh, openDialog, dialog, toast, state }) {
  let active;
  function show(mandate, creating) {
    if (state.role !== 'buyer_admin' || !state.actor?.buyer_id) throw new Error('Choose the owning buyer administrator before editing a mandate.');
    if (!creating && (mandate.buyer_id !== state.actor.buyer_id || mandate.status !== 'draft' || BigInt(mandate.funding?.funded_minor ?? '0') !== 0n || BigInt(mandate.spent_minor ?? '0') !== 0n || mandate.units_sold !== 0)) throw new Error('Only your unfunded, unsold drafts are editable. Committed terms require a new mandate.');
    const flow = { owner: state.actor.id, buyer: state.actor.buyer_id, mandate: structuredClone(mandate), creating, key: null, body: null, result: null };
    active = flow;
    const title = creating ? 'Draft your buyer mandate' : 'Edit unfunded buyer mandate';
    openDialog(title, creating ? 'Define the request first. Funding and activation remain separate.' : `Draft revision ${mandate.draft_revision ?? 1}. Stale edits are rejected rather than overwriting newer terms.`, formHTML(mandate,state.money?.mode==='anvil'), '<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" type="submit" form="mandate-draft-form" id="draft-save">Save unfunded draft ↗</button>');
    const form = document.querySelector('#mandate-draft-form'), save = document.querySelector('#draft-save'), error = document.querySelector('#dialog-error'), status = document.querySelector('#draft-save-status'), preview = document.querySelector('#draft-request-preview');
    const requireOwner = () => { if (active !== flow || state.role !== 'buyer_admin' || state.actor?.id !== flow.owner || state.actor.buyer_id !== flow.buyer) throw new Error('Your buyer account changed. Reopen the editor in the correct workspace.'); };
    const read = () => draftFromForm(new FormData(form), creating ? undefined : mandate.draft_revision ?? 1);
    const showError = message => { error.textContent = message; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); };
    const lock = value => { for (const field of form.querySelectorAll('input,select,textarea')) field.disabled = value; };
    form.querySelector('#draft-review').addEventListener('click', () => {
      try { requireOwner(); preview.textContent = JSON.stringify(flow.body ?? read(), null, 2); preview.hidden = false; error.hidden = true; } catch (cause) { showError(cause.message); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (save.disabled) return;
      try {
        requireOwner(); error.hidden = true;
        if (!flow.body) { flow.body = read(); flow.key = crypto.randomUUID(); }
        lock(true); save.disabled = true; status.textContent = flow.result ? 'Draft saved. Refreshing the workspace…' : 'Saving these exact terms. No funding or activation is requested…';
        if (!flow.result) flow.result = await api(creating ? '/v1/buyer/mandates' : `/v1/buyer/mandates/${encodeURIComponent(mandate.mandate_id)}`, { method: creating ? 'POST' : 'PATCH', body: flow.body, idempotencyKey: flow.key });
        requireOwner(); await refresh(); requireOwner();
        if (document.querySelector('#mandate-draft-form') === form && dialog.open) dialog.close();
        active = null; toast(`Unfunded draft saved, revision ${flow.result.draft_revision ?? 1}. Review before funding.`);
      } catch (cause) {
        if (active !== flow || document.querySelector('#mandate-draft-form') !== form) return;
        const message = cause instanceof Error ? cause.message : 'The draft could not be saved.';
        // A parsed server rejection has no committed command. Transport failures retain the same body/key.
        const rejected = !flow.result && /\((?:INVALID_[A-Z_]+|UNKNOWN_COST_POLICY|LICENSE_[A-Z_]+|ASSAY_[A-Z_]+|SEMANTIC_TOPIC_SEARCH_NOT_CONFIGURED|UNSUPPORTED_[A-Z_]+|SECURITY_MAPPING_REQUIRED|EXCLUSIVITY_DISABLED|AMOUNT_TOO_LARGE|MANDATE_[A-Z_]+|FUNDED_DRAFT_IMMUTABLE|REQUEST_REJECTED|FUNDING_FIELDS_MANAGED)\)/.test(message);
        if (rejected) { flow.body = null; flow.key = null; lock(false); }
        save.textContent = flow.result ? 'Refresh saved draft ↻' : flow.body ? 'Retry this exact save ↻' : 'Save unfunded draft ↗';
        status.textContent = flow.result ? 'The save succeeded; only the workspace refresh remains. Retrying will not save again.' : flow.body ? 'The result is uncertain. Fields are locked; retry reuses the same request and idempotency key. Do not create another draft to retry this save.' : 'No successful save is recorded. Correct the form; if this draft was funded or updated elsewhere, close and refresh before reopening.';
        showError(message);
      } finally { save.disabled = false; }
    });
  }
  return { open: mandate => show(mandate, false), openNew: category => {const m=newDraftInput(category);if(state.money?.mode==='anvil'){m.economics={...m.economics,currency:'USDC',unit_price_minor:'100000000',total_budget_minor:'100000000',max_units:1};m.funding.mode='onchain_escrow';}show(m,true);} };
}
