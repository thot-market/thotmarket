import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { OfflineDcapVerifier, verifyTdxQuoteBodyIntegrity } from '../packages/provenance/src/index.ts';

// GENUINE PUBLIC DCAP FIXTURE, NOT an attest-proxy bundle or a THOT trace.
// Pinned Phala-Network/dcap-qvl v0.6.1 sample/tdx_quote + signed collateral.
const quoteHex = readFileSync(new URL('../packages/provenance/fixtures/dcap-qvl-v0.6.1-tdx-quote.hex', import.meta.url), 'utf8').trim();
const collateralText = readFileSync(new URL('../packages/provenance/fixtures/dcap-qvl-v0.6.1-tdx-collateral.json', import.meta.url), 'utf8');
const collateral = JSON.parse(collateralText);
const quoteHash = 'c42f9164325024bca2757bc8819b11879a0a369132ea4e2b7c85df4805ea72db';
const historicalTime = 1750329147;
const python = process.env.THOT_DCAP_TEST_PYTHON;
const gate = { skip: !python ? 'Set THOT_DCAP_TEST_PYTHON to an absolute Python path and install packages/provenance/requirements.txt; not a simulated success.' : false };
const fixturePolicy = { allow_dynamic_platform: true, allow_cached_keys: true, allow_smt: true };
const historical = () => new OfflineDcapVerifier({ pythonExecutable: python!, clock: () => new Date(historicalTime * 1000), platformPolicy: fixturePolicy });

test('authentic public fixture hashes pin original quote bytes and original collateral JSON', () => {
  assert.equal(createHash('sha256').update(Buffer.from(quoteHex, 'hex')).digest('hex'), quoteHash);
  // One terminal LF was added when storing this text artifact; signed JSON values are unchanged.
  assert.equal(createHash('sha256').update(collateralText.replace(/\n$/, '')).digest('hex'), 'b0a5f5fd620a8881b1eda45261fdf30dd930b49aff93231556645c81fcb4c0bc');
});
test('genuine published quote body signature + QE-key binding verify, without claiming Intel trust', () => {
  const r = verifyTdxQuoteBodyIntegrity(quoteHex);
  assert.equal(r.quoteHash, quoteHash); assert.equal(r.hardwareAuthenticity, 'UNVERIFIED');
  assert.equal(r.unsignedTrailingZeroBytes, 70);
});
test('real quote report-data splicing and modified body signatures reject', () => {
  for (const offset of [184, 568, 636]) {
    const raw = Buffer.from(quoteHex, 'hex'); raw[offset] ^= 1;
    assert.throws(() => verifyTdxQuoteBodyIntegrity(raw.toString('hex')), /INVALID_TDX_BODY_SIGNATURE/);
  }
  assert.throws(() => verifyTdxQuoteBodyIntegrity(quoteHex, '00'.repeat(32)), /SESSION_BINDING/);
});
test('genuine quote malformed certificate lengths, nonzero transport tails, unsupported versions reject', () => {
  for (const offset of [0, 632, 636 + 130, Buffer.from(quoteHex, 'hex').length - 1]) {
    const raw = Buffer.from(quoteHex, 'hex'); raw[offset] ^= 1;
    assert.throws(() => verifyTdxQuoteBodyIntegrity(raw.toString('hex')));
  }
});
function selfIssuedForgery(): string {
  // This locally generated attacker key does NOT belong to Intel. Re-signing an arbitrary
  // TD report and editing the unverified QE report defeats arithmetic-only authenticity.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const raw = Buffer.from(quoteHex, 'hex'); pub.copy(raw, 636 + 64); raw.fill(7, 568, 600);
  const inner = 636 + 134; const authLength = raw.readUInt16LE(inner + 448);
  createHash('sha256').update(pub).update(raw.subarray(inner + 450, inner + 450 + authLength)).digest().copy(raw, inner + 320);
  sign('sha256', raw.subarray(0, 632), { key: privateKey, dsaEncoding: 'ieee-p1363' }).copy(raw, 636);
  return raw.toString('hex');
}
test('a self-issued attacker quote can pass arithmetic; adapter still says UNVERIFIED', () => {
  assert.equal(verifyTdxQuoteBodyIntegrity(selfIssuedForgery()).hardwareAuthenticity, 'UNVERIFIED');
});
test('offline genuine Intel-chain verification succeeds at pinned historical time, not present freshness', gate, async () => {
  const r = await historical().verifyQuote({ quoteHex, collateral });
  assert.equal(r.hardwareAuthenticity, 'INTEL_DCAP_VERIFIED'); assert.equal(r.status, 'UpToDate'); assert.equal(r.quoteHash, quoteHash);
  assert.equal(r.verificationTimeSeconds, historicalTime); assert.equal(r.collateralExpiresAtSeconds, 1752919235);
  assert.equal(r.measurementApproval, 'NOT_EVALUATED'); assert.equal(r.sourceBinding, 'NOT_EVALUATED');
  for (const excluded of ['ppid', 'platform_instance_id', 'pck_crl', 'certificate']) assert(!JSON.stringify(r).includes(excluded));
});
test('DCAP default restrictive platform policy rejects authentic dynamic/cached/SMT fixture', gate, async () => {
  const strict = new OfflineDcapVerifier({ pythonExecutable: python!, clock: () => new Date(historicalTime * 1000) });
  await assert.rejects(strict.verifyQuote({ quoteHex, collateral }), /DCAP_VERIFICATION_FAILED/);
});
test('DCAP expired collateral rejects at current production-style clock', gate, async () => {
  const current = new OfflineDcapVerifier({ pythonExecutable: python!, platformPolicy: fixturePolicy });
  await assert.rejects(current.verifyQuote({ quoteHex, collateral }), /DCAP_VERIFICATION_FAILED/);
});
test('DCAP independently rejects damaged signed collateral and missing trust material', gate, async () => {
  const corrupt = structuredClone(collateral); corrupt.tcb_info = corrupt.tcb_info.replace('UpToDate', 'OutOfDate');
  await assert.rejects(historical().verifyQuote({ quoteHex, collateral: corrupt }), /DCAP_VERIFICATION_FAILED/);
  const missing = structuredClone(collateral); delete missing.pck_crl;
  await assert.rejects(historical().verifyQuote({ quoteHex, collateral: missing }), /DCAP_VERIFICATION_FAILED/);
});
test('genuine Intel-chain verification rejects the arithmetic-valid attacker re-signing', gate, async () => {
  await assert.rejects(historical().verifyQuote({ quoteHex: selfIssuedForgery(), collateral }), /DCAP_VERIFICATION_FAILED/);
});
test('DCAP configuration is operator-only, bounded and absolute-path constrained', () => {
  assert.throws(() => new OfflineDcapVerifier({ pythonExecutable: 'python3' }), /ABSOLUTE/);
  assert.throws(() => new OfflineDcapVerifier({ pythonExecutable: '/does/not/exist', timeoutMs: 60001 }), /TIMEOUT/);
});
