import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  canonicalJson, canonicalHash, parseMoney, formatMoney, parseDecimalMoney, uuidv7,
  signReceipt, verifyReceipt, signCanonical, verifyCanonical,
  decodeProtocolObject, validateProtocolObject, validateBuyerMandate, validateProvenanceReceipt,
  validateCredentialReceipt, validateOutcomeReceipt, supportedSchemaVersions,
  type BuyerMandate, type ProvenanceReceipt, type CredentialReceipt, type OutcomeReceipt,
} from '../packages/protocol/src/index.ts';

const instant = '2026-09-05T00:00:00.000Z';
const later = '2026-09-06T00:00:00.000Z';
const digest = 'a'.repeat(64);
const provenance: ProvenanceReceipt = {
  schema_version: 'trace.provenance/1', receipt_id: 'receipt-1', trace_id: 'trace-1',
  path: 'legacy_import', confidence_tier: 'P0_OPERATOR',
  temporal: { observed_start: instant, observed_end: later }, commitments: { source_bundle_hash: digest },
  claims: ['Operator observed imported bytes'], limitations: ['No upstream attestation'],
  verifier: { implementation: 'fixture', version: '1', verified_at: later },
};
const credential: CredentialReceipt = {
  schema_version: 'trace.credential/1', receipt_id: 'credential-1', owner_user_id: 'user-1',
  pseudonymous_subject_id: 'subject-1', provider: 'fixture', provider_method: 'signed_predicate',
  predicate_type: 'workplace_cohort', predicate_value: 'cohort:eligible-v1', verified_at: instant,
  valid_until: later, issuer_key_id: 'key-1', signature: 'fixture-signature', claims: ['Workplace cohort'], limitations: ['Not a rights claim'],
};
const outcome: OutcomeReceipt = {
  schema_version: 'trace.outcome/1', receipt_id: 'outcome-1', owner_user_id: 'user-1', provider: 'fixture',
  pseudonymous_subject_id: 'subject-1', predicate: { type: 'security_action', security_id: 'US:AAPL', action: 'buy', window_start: instant, window_end: later },
  evidence_time: later, source_evidence_hash: digest, disclosure_scope_id: 'scope-1', issuer_key_id: 'key-1',
  signature: 'fixture-signature', claims: ['Qualifying action'], limitations: ['No claim of causality'],
};
const mandate: BuyerMandate = {
  schema_version: 'trace.mandate/1', mandate_id: 'mandate-1', buyer_id: 'buyer-1', status: 'draft',
  criteria: { provenance_tiers: ['P0_OPERATOR'], workflow_types: ['coding'], rights_required: ['eligible'] },
  assay: { assay_id: 'bounded-v1', version: '1', threshold: 0.5, input_scope: 'scrubbed', output_schema: 'bounded/1' },
  economics: { currency: 'USDC', max_units: 2, unit_price_minor: 9007199254740993n, total_budget_minor: 18014398509481986n, direct_cost_policy_id: 'costs/1' },
  funding: { mode: 'offchain_escrow', funded_minor: 0n },
  license: { purpose: 'research', model_training: false, onward_transfer: false, exclusive: false, retention_days: 30 }, expires_at: later,
};
const fixtureKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
const fixturePublicKey = createPublicKey(fixtureKey);

test('spec 1: canonical JSON/hash are stable under nested key order', () => {
  const a = { z: 7n, a: { c: [1, 'two'], b: true } };
  const b = { a: { b: true, c: [1, 'two'] }, z: 7n };
  assert.equal(canonicalJson(a), '{"a":{"b":true,"c":[1,"two"]},"z":"7"}');
  assert.equal(canonicalHash(a), canonicalHash(b));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
});

test('canonical JSON refuses lossy numbers and non-JSON values', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const bad of [NaN, Infinity, 9007199254740992, undefined, new Date(), cycle, { secret: undefined }, [1, , 3]]) assert.throws(() => canonicalJson(bad));
  assert.throws(() => canonicalJson({ get value() { throw new Error('must not execute'); } }), /accessors/);
  assert.equal(canonicalJson({ decimalScore: 0.65 }), '{"decimalScore":0.65}');
});

test('spec 2: monetary inputs are exact integer strings and reject floats or coercion', () => {
  assert.equal(parseMoney('9007199254740993'), 9007199254740993n);
  assert.equal(formatMoney(9007199254740993n), '9007199254740993');
  for (const bad of [1.1, 1, 1n, '1.1', '-1', '01', '+1', '1e3', ' 1', '', null]) assert.throws(() => parseMoney(bad));
  assert.equal(parseDecimalMoney('1.000001'), 1000001n);
  assert.throws(() => parseDecimalMoney('1.0000001'));
  assert.throws(() => formatMoney(-1n));
});

test('spec 3: unknown schema versions and extraneous raw evidence fields fail closed', () => {
  assert.throws(() => validateProtocolObject({ ...provenance, schema_version: 'trace.provenance/999' }), /unknown protocol schema/);
  assert.throws(() => validateCredentialReceipt({ ...credential, raw_email: 'secret@example.com' }), /unknown field/);
  assert.throws(() => validateOutcomeReceipt({ ...outcome, predicate: { ...outcome.predicate, position_size: '100' } }), /unknown field/);
});

test('spec 4: changing a signed receipt, key ID or algorithm invalidates its signature', () => {
  const signed = signReceipt(credential, 'key-1', fixtureKey);
  assert.equal(verifyReceipt(signed, fixturePublicKey), true);
  assert.equal(verifyReceipt({ ...signed, payload: { ...credential, predicate_value: 'forged' } }, fixturePublicKey), false);
  assert.equal(verifyReceipt({ ...signed, key_id: 'key-2' }, fixturePublicKey), false);
  assert.equal(verifyReceipt({ ...signed, signature: signed.signature + '=' }, fixturePublicKey), false);
  assert.equal(verifyReceipt({ ...signed, algorithm: 'RSA' as 'Ed25519' }, fixturePublicKey), false);
  const rawSignature = signCanonical(credential, fixtureKey);
  assert.equal(verifyCanonical(credential, rawSignature, fixturePublicKey), true);
  assert.equal(verifyCanonical({ ...credential, owner_user_id: 'other-user' }, rawSignature, fixturePublicKey), false);
});

test('spec 5: release commitment changes with authorized predicate disclosure', () => {
  const release = { trace: 'research', credentials: [], outcomes: [outcome.predicate] };
  assert.notEqual(canonicalHash(release), canonicalHash({ ...release, outcomes: [] }));
  assert.notEqual(canonicalHash(release), canonicalHash({ ...release, outcomes: [{ ...outcome.predicate, action: 'sell' }] }));
});

test('canonical wire encoding round-trips bigint money without precision loss', () => {
  validateBuyerMandate(mandate);
  const encoded = canonicalJson(mandate);
  const decoded = decodeProtocolObject(encoded);
  assert.deepEqual(decoded, mandate);
  assert.equal(canonicalJson(decoded), encoded);
  const floats = JSON.parse(encoded); floats.economics.unit_price_minor = 1.5;
  assert.throws(() => decodeProtocolObject(floats), /Money/);
  assert.throws(() => validateBuyerMandate(JSON.parse(encoded)), /bigint/);
});

test('all ten protocol schemas validate and round-trip with generic schema identifiers', () => {
  const examples: unknown[] = [provenance, credential, outcome, mandate,
    { schema_version: 'trace.rights/1', assessment_id: 'rights-1', trace_id: 'trace-1', policy_version: '1', status: 'eligible', flags: [], permitted_components: ['trace'], prohibited_components: [], engine_version: '1', generated_at: instant },
    { schema_version: 'trace.features/1', trace_id: 'trace-1', topic_labels: ['coding'], workflow_type: 'coding', counts: { turns: 3 }, signals: {}, available_predicates: { credential_types: [], outcome_types: [] }, rights_status: 'eligible', provenance_tier: 'P0_OPERATOR', feature_model_version: '1' },
    { schema_version: 'trace.user-policy/1', policy_id: 'policy-1', owner_user_id: 'user-1', version: 1, mode: 'manual_approval', allowed_categories: ['coding'], prohibited_categories: [], allowed_purposes: ['research'], prohibited_purposes: [], evidence_disclosure: { trace_body: true, credential_predicate_types: [], outcome_predicate_types: [], identity_disclosure: false }, license_defaults: { exclusive: false, onward_transfer: false, model_training: false }, payout_preference: 'inference_credit', effective_at: instant },
    { schema_version: 'trace.assay/1', assay_receipt_id: 'assay-1', mandate_id: 'mandate-1', trace_id: 'trace-1', assay_id: 'bounded-v1', assay_version: '1', assay_commitment: digest, input_hash: digest, result: 'accepted', bounded_labels: { label_minor: 'safe bounded label' }, output_hash: digest, executed_at: instant, signature: 'signature' },
    { schema_version: 'trace.sale-auth/1', authorization_id: 'auth-1', owner_user_id: 'user-1', trace_id: 'trace-1', mandate_id: 'mandate-1', release_artifact_hash: digest, credential_receipt_ids: [], outcome_receipt_ids: [], license_hash: digest, expected_gross_minor: 100n, expected_direct_costs_max_minor: 0n, payout_preference: 'inference_credit', authorized_at: instant, expires_at: later, auth_method: 'account_session', auth_evidence: 'session-1' },
    { schema_version: 'trace.settlement/1', settlement_id: 'settlement-1', license_id: 'license-1', gross_minor: 101n, direct_costs_minor: 1n, eligible_net_minor: 100n, contributor_minor: 65n, burn_minor: 20n, operator_minor: 15n, split_policy_id: '65-20-15/1', contributor_disposition: 'pending', created_at: instant },
  ];
  assert.equal(examples.length, supportedSchemaVersions.length);
  for (const item of examples) { validateProtocolObject(item); assert.deepEqual(decodeProtocolObject(canonicalJson(item)), item); }
});

test('invalid calendar dates, reversed time windows and non-UTC timestamps are rejected', () => {
  for (const invalid of ['2026-02-30T00:00:00Z', '2026-09-05T00:00:00+00:00', '2026-13-01T00:00:00Z']) assert.throws(() => validateProvenanceReceipt({ ...provenance, verifier: { ...provenance.verifier, verified_at: invalid } }));
  assert.throws(() => validateOutcomeReceipt({ ...outcome, predicate: { ...outcome.predicate, window_start: later, window_end: instant } }), /start must not/);
});

test('settlement schema enforces exact conservation and nonnegative money', () => {
  const settlement = { schema_version: 'trace.settlement/1', settlement_id: 's', license_id: 'l', gross_minor: 100n, direct_costs_minor: 0n, eligible_net_minor: 100n, contributor_minor: 65n, burn_minor: 20n, operator_minor: 15n, split_policy_id: '1', contributor_disposition: 'pending', created_at: instant };
  validateProtocolObject(settlement);
  assert.throws(() => validateProtocolObject({ ...settlement, operator_minor: 16n }), /conservation/);
  assert.throws(() => validateProtocolObject({ ...settlement, direct_costs_minor: -1n }), /nonnegative/);
});

test('UUIDv7 carries the requested timestamp and valid version/variant with unique random suffixes', () => {
  const timestamp = Date.parse(instant);
  const ids = Array.from({ length: 1000 }, () => uuidv7(timestamp));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) { assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.equal(parseInt(id.replaceAll('-', '').slice(0, 12), 16), timestamp); }
  assert.throws(() => uuidv7(-1));
});
