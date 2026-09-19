import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { PrivacyIntegrations } from '../packages/market/src/integrations.ts';
import { demoUser, demoBuyer, importDemo, createDemoMandate, policyInput, mandateInput } from '../packages/market/src/fixtures.ts';
import { canonicalHash, verifyCanonical } from '../packages/protocol/src/index.ts';
import { MockOutcomeProvider } from '../packages/outcomes/src/index.ts';

const clock = () => new Date('2026-09-05T12:00:00.000Z');
const otherUser = { id: 'other-user', role: 'user' as const };
async function app() { return createApplication({ memory: true, dataDir: await mkdtemp(join(tmpdir(), 'thot-integration-privacy-')), config: { clock } }); }
async function ready(scenario: 'coding' | 'research' | 'professional' = 'coding') {
  const application = await app(); const { service } = application;
  await service.createPolicy(demoUser, 'integration-policy', policyInput(service));
  const imported = await importDemo(service, demoUser, scenario, 'integration-import-' + scenario);
  await createDemoMandate(service, scenario === 'research' ? 'research_flow' : scenario === 'professional' ? 'professional_flow' : 'general', 'integration-mandate-' + scenario);
  await service.runWorker();
  const candidates = await service.candidates(demoUser); assert.equal(candidates.length, 1);
  const preview = await service.preview(demoUser, candidates[0]!.candidate_id);
  return { ...application, imported, preview };
}
const authorization = (preview: Record<string, any>) => ({ ...preview, payout_preference: 'inference_credit' });

test('integration privacy: contextual spans follow original turns when unlicensed assistant output is removed', async () => {
  const integrations = new PrivacyIntegrations({ development: true, vaultRoot: await mkdtemp(join(tmpdir(), 'thot-facade-test-')), masterKey: Buffer.alloc(32, 9), clock });
  const content = { turns: [{ role: 'user', content: 'Public opening text' }, { role: 'assistant', content: 'Unlicensed assistant output' }, { role: 'user', content: 'Alice has public exercise notes' }] };
  const result = await integrations.assess('trace-privacy', content, 'professional_flow', { rights_confirmed: true, model_output_licensed: false, entity_spans: { 2: [{ start: 0, end: 5, replacement: '[PERSON]' }] } });
  assert.equal(result.content.turns.length, 2);
  assert.equal(result.content.turns[1].content, '[PERSON] has public exercise notes');
  assert.equal(result.scrub.output_hash, canonicalHash(result.content));
});

test('integration privacy: buyer receives newly signed minimal credential disclosure with no internal identity', async t => {
  const application = await ready('professional'); t.after(application.close); const { service, privacy, preview } = application;
  await assert.rejects(service.preview(otherUser, preview.candidate_id), /NOT_FOUND/);
  await assert.rejects(service.delivery(demoBuyer, preview.release.license_id), /NOT_FOUND/);
  const receipt = preview.release.credentials[0];
  for (const field of ['owner_user_id', 'pseudonymous_subject_id', 'source_evidence_hash', 'receipt_id', 'provider_method']) assert.ok(!(field in receipt), field);
  const { signature, ...unsigned } = receipt;
  assert.equal(verifyCanonical(unsigned, signature, createPublicKey(privacy.disclosurePublicKey)), true);
  assert.match(receipt.limitations.join(' '), /not a zero-knowledge proof/);
  const authorized = await service.authorize(demoUser, 'integration-authorize-professional', authorization(preview));
  const delivery = await service.delivery(demoBuyer, authorized.license_id);
  assert.equal(delivery.delivery.bundle_hash, preview.release_artifact_hash);
  assert.ok(!JSON.stringify(delivery).includes('mock-subject-demo-user'));
  await assert.rejects(service.delivery({ id: 'wrong-buyer', role: 'buyer_admin', buyer_id: 'another-buyer' }, authorized.license_id));
});

test('integration privacy: revoking required evidence after preview prevents authorization and license creation', async t => {
  const application = await ready('professional'); t.after(application.close); const { service, preview, db } = application;
  await service.revokeReceipt(demoUser, 'integration-revoke-evidence', preview.credential_receipt_ids[0]);
  await assert.rejects(service.authorize(demoUser, 'integration-authorize-revoked', authorization(preview)), /CREDENTIAL_FILTER|EVIDENCE_INVALIDATED/);
  assert.equal((await db.query('SELECT count(*)::text AS count FROM licenses')).rows[0].count, '0');
  assert.equal((await db.query('SELECT count(*)::text AS count FROM sale_authorizations')).rows[0].count, '0');
});

test('integration privacy: changed policy or changed release cannot authorize the earlier preview', async t => {
  const application = await ready('coding'); t.after(application.close); const { service, preview } = application;
  await assert.rejects(service.authorize(demoUser, 'integration-bad-release', { ...authorization(preview), release_artifact_hash: '0'.repeat(64) }), /AUTHORIZATION_HASH_MISMATCH/);
  await assert.rejects(service.authorize(demoUser, 'integration-bad-license', { ...authorization(preview), license_hash: '0'.repeat(64) }), /AUTHORIZATION_HASH_MISMATCH/);
  await service.createPolicy(demoUser, 'integration-new-policy', { ...policyInput(service), prohibited_buyers: ['demo-buyer'] });
  await assert.rejects(service.authorize(demoUser, 'integration-old-policy-auth', authorization(preview)), /POLICY_CHANGED/);
});

test('integration privacy: separately consented outcome window is required for research-to-action lag matching', async t => {
  const application = await app(); t.after(application.close); const { service, db } = application;
  await service.createPolicy(demoUser, 'integration-timing-policy', policyInput(service));
  const imported = await importDemo(service, demoUser, 'research', 'integration-timing-import');
  const body = mandateInput(service, 'research_flow'); body.criteria.outcome_predicates[0].max_lag_days = 7;
  const mandate = await service.createMandate(demoBuyer, 'integration-timing-mandate', body);
  await service.fundMandate(demoBuyer, 'integration-timing-funding', mandate.mandate_id, {});
  await service.activateMandate(demoBuyer, 'integration-timing-activate', mandate.mandate_id);
  await service.runWorker();
  assert.equal((await service.candidates(demoUser)).length, 0, 'issuance time alone is not proof of a trade window');
  assert.equal((await db.query('SELECT count(*)::text AS count FROM assay_receipts')).rows[0].count, '0', 'failed outcome hard filter never reaches assay');
  const provider = new MockOutcomeProvider({ now: clock, records: [{ ownerUserId: demoUser.id, securityId: 'broker:AAPL@mapping-v1', kind: 'trade', action: 'buy', occurredAt: '2026-09-05T12:00:00.000Z' }] });
  provider.grantConsent(demoUser.id, ['security_traded', 'time_window']);
  const receipt = await provider.attestPredicate({ userId: demoUser.id, traceId: imported.trace_id, predicateRequest: { type: 'security_traded', securityId: 'broker:AAPL@mapping-v1', windowStart: '2026-09-05T12:00:00.000Z', windowEnd: '2026-09-06T12:00:00.000Z', discloseWindow: true } });
  await service.linkEvidence(demoUser, 'integration-timing-link', imported.trace_id, 'outcome', { receipt });
  await service.runWorker();
  const candidates = await service.candidates(demoUser); assert.equal(candidates.length, 1);
  const preview = await service.preview(demoUser, candidates[0]!.candidate_id);
  assert.ok(preview.release.outcomes.some((outcome: any) => outcome.predicate.window_start));
  assert.ok(preview.release.outcomes.every((outcome: any) => !('action' in outcome.predicate)));
});

test('integration privacy: inconsistent promised assay scope/schema are rejected at mandate creation', async t => {
  const application = await app(); t.after(application.close); const { service } = application;
  const body = mandateInput(service);
  await assert.rejects(service.createMandate(demoBuyer, 'integration-wrong-assay-scope', { ...body, assay: { ...body.assay, input_scope: 'raw-brokerage-account' } }));
  await assert.rejects(service.createMandate(demoBuyer, 'integration-wrong-assay-output', { ...body, assay: { ...body.assay, output_schema: 'unbounded-raw-text' } }));
});

test('integration privacy: active buyer mandates discover newly imported traces without reactivation', async t => {
  const application = await app(); t.after(application.close); const { service } = application;
  await service.createPolicy(demoUser, 'integration-buyer-first-policy', policyInput(service));
  await createDemoMandate(service, 'general', 'integration-buyer-first-mandate');
  await service.runWorker(); assert.equal((await service.candidates(demoUser)).length, 0);
  await importDemo(service, demoUser, 'coding', 'integration-buyer-first-import');
  await service.runWorker(); assert.equal((await service.candidates(demoUser)).length, 1);
});

test('integration privacy: audit and outbox contain IDs/hashes rather than raw trace or account fixtures', async t => {
  const application = await ready('research'); t.after(application.close); const { service, preview, db } = application;
  await service.authorize(demoUser, 'integration-private-log-sale', authorization(preview)); await service.runWorker();
  const serialized = JSON.stringify({ audit: (await db.query('SELECT payload FROM audit_events')).rows, outbox: (await db.query('SELECT payload FROM outbox_events')).rows });
  for (const value of ['Compare public AAPL earnings history', 'NEVER-DISCLOSE-DEMO-ACCOUNT', 'positionSize', 'source_evidence_hash', 'mock-subject-demo-user']) assert.ok(!serialized.includes(value), value);
  assert.ok(!JSON.stringify(preview.release).includes('NEVER-DISCLOSE-DEMO-ACCOUNT'));
});

test('integration privacy: a new permissive policy produces a fresh preview and invalidates the stale candidate', async t => {
  const application = await ready('coding'); t.after(application.close); const { service, preview } = application;
  await service.createPolicy(demoUser, 'integration-policy-refresh', policyInput(service));
  await service.runWorker();
  const pending = (await service.candidates(demoUser)).filter(candidate => candidate.status === 'USER_AUTH_PENDING');
  assert.equal(pending.length, 1); assert.notEqual(pending[0]!.candidate_id, preview.candidate_id);
  await assert.rejects(service.authorize(demoUser, 'integration-old-preview-again', authorization(preview)));
  const current = await service.preview(demoUser, pending[0]!.candidate_id);
  const authorized = await service.authorize(demoUser, 'integration-new-preview-authorize', authorization(current));
  assert.equal(authorized.status, 'LICENSED');
});

test('integration privacy: deleting an unlicensed trace also removes its pending release copy', async t => {
  const application = await ready('coding'); t.after(application.close); const { service, preview, imported, db, privacy } = application;
  const candidate = await db.transaction(tx => tx.get('mandate_candidates', preview.candidate_id, demoUser.id));
  await service.deleteTrace(demoUser, 'integration-delete-unlicensed', imported.trace_id);
  await assert.rejects(service.preview(demoUser, preview.candidate_id));
  await service.runWorker();
  await assert.rejects(privacy.open(demoUser.id, candidate.release_ref));
  assert.equal((await service.candidates(demoUser)).filter(row => row.status === 'USER_AUTH_PENDING').length, 0);
});

test('integration privacy: missing required credential is filtered before assay and later valid linking rematches', async t => {
  const application = await app(); t.after(application.close); const { service, privacy, db } = application;
  await service.createPolicy(demoUser, 'integration-missing-credential-policy', policyInput(service));
  const bundle = privacy.createDemoBundle({ turns: [{ role: 'user', content: 'I own these synthetic public contract review exercise notes.' }] }, demoUser.id);
  const imported = await service.importTrace(demoUser, 'integration-missing-credential-import', { bundle, category: 'professional_flow', rights_confirmed: true });
  await createDemoMandate(service, 'professional_flow', 'integration-missing-credential-mandate'); await service.runWorker();
  assert.equal((await service.candidates(demoUser)).length, 0);
  assert.equal((await db.query('SELECT count(*)::text AS count FROM assay_receipts')).rows[0].count, '0');
  await service.linkEvidence(demoUser, 'integration-required-credential-link', imported.trace_id, 'credential', { receipt: privacy.demoCredential(demoUser.id) });
  await service.runWorker(); assert.equal((await service.candidates(demoUser)).length, 1);
});

test('integration privacy: attached but undisclosed credentials and outcomes are absent from release', async t => {
  const application = await app(); t.after(application.close); const { service, privacy } = application;
  const selected = policyInput(service); selected.evidence_disclosure.credential_predicate_types = []; selected.evidence_disclosure.outcome_predicate_types = [];
  await service.createPolicy(demoUser, 'integration-narrow-policy', selected);
  const imported = await importDemo(service, demoUser, 'coding', 'integration-narrow-import');
  await service.linkEvidence(demoUser, 'integration-narrow-credential', imported.trace_id, 'credential', { receipt: privacy.demoCredential(demoUser.id) });
  await service.linkEvidence(demoUser, 'integration-narrow-outcome', imported.trace_id, 'outcome', { receipt: await privacy.demoOutcome(demoUser.id, imported.trace_id, 'broker:AAPL@mapping-v1') });
  await createDemoMandate(service, 'general', 'integration-narrow-mandate'); await service.runWorker();
  const preview = await service.preview(demoUser, (await service.candidates(demoUser))[0]!.candidate_id);
  assert.deepEqual(preview.release.credentials, []); assert.deepEqual(preview.release.outcomes, []);
  assert.deepEqual(preview.credential_receipt_ids, []); assert.deepEqual(preview.outcome_receipt_ids, []);
});
