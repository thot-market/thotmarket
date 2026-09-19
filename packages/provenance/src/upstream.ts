/** Byte-exact verifier for the pinned public attest-proxy format. No witness runs here. */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonicalHash, canonicalJson } from '../../protocol/src/index.ts';

export const UPSTREAM_ATTEST_PROXY_PIN = '5a4b1fe34cd5256b36755da75a7aabdbc173526e';
const MAX_LEAVES = 256;
const MAX_BUNDLE_BYTES = 4_000_000;
const sha = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const utf8 = (s: string) => Buffer.from(s, 'utf8');
const fail = (reason: string): never => { throw new Error(reason); };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_UPSTREAM_OBJECT');
  return value as Record<string, any>;
}
function hex(value: unknown, bytes: number): Buffer {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)) fail('INVALID_UPSTREAM_HEX');
  return Buffer.from(value as string, 'hex');
}
function base64(value: unknown, limit = MAX_BUNDLE_BYTES): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_UPSTREAM_BASE64');
  const bytes = Buffer.from(value as string, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) fail('INVALID_UPSTREAM_BASE64');
  return bytes;
}
function latin1(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > MAX_BUNDLE_BYTES || /[^\x00-\xff]/.test(value)) fail('INVALID_UPSTREAM_LATIN1');
  return Buffer.from(value as string, 'latin1');
}
const split = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };
function root(leaves: Buffer[]): Buffer {
  if (!leaves.length) return sha();
  if (leaves.length === 1) return sha(Buffer.from([0]), leaves[0]!);
  const k = split(leaves.length);
  return sha(Buffer.from([1]), root(leaves.slice(0, k)), root(leaves.slice(k)));
}
function proofRoot(commitment: Buffer, index: number, count: number, proof: Buffer[]): Buffer {
  let consumed = 0;
  const walk = (i: number, n: number): Buffer => {
    if (n === 1) return sha(Buffer.from([0]), commitment);
    const k = split(n); const child = walk(i < k ? i : i - k, i < k ? k : n - k);
    const sibling = proof[consumed++];
    if (!sibling) fail('UPSTREAM_PROOF_TOO_SHORT');
    return i < k ? sha(Buffer.from([1]), child, sibling) : sha(Buffer.from([1]), sibling, child);
  };
  const result = walk(index, count);
  if (consumed !== proof.length) fail('UPSTREAM_PROOF_TOO_LONG');
  return result;
}
function anchorTag(value: unknown): Buffer {
  const b = object(value);
  if (typeof b.source !== 'string' || !b.source || b.source.length > 256 || b.source.includes('\0') || !Number.isSafeInteger(b.round) || b.round < 1) fail('INVALID_UPSTREAM_BEACON');
  hex(b.randomness, 32);
  return utf8(`${b.source}:${b.round}:${b.randomness}`);
}

export interface TdxBodyIntegrity {
  quoteHash: string; reportDataHex: string;
  unsignedTrailingZeroBytes: number;
  measurements: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string };
  bodySignatureVerified: true; attestationKeyBindingVerified: true;
  /** A self-issued quote can pass these checks. This is NOT Intel-chain verification. */
  hardwareAuthenticity: 'UNVERIFIED';
}

/** TDX v4 ECDSA quote arithmetic only; never a substitute for Intel DCAP/QE/TCB checks. */
export function verifyTdxQuoteBodyIntegrity(quoteHex: string, expectedReportDataHex?: string): TdxBodyIntegrity {
  if (typeof quoteHex !== 'string' || quoteHex.length < 1272 || quoteHex.length > 200_000 || !/^(?:[a-f0-9]{2})+$/.test(quoteHex)) fail('INVALID_TDX_QUOTE');
  const q = Buffer.from(quoteHex, 'hex');
  if (q.readUInt16LE(0) !== 4 || q.readUInt16LE(2) !== 2 || q.readUInt32LE(4) !== 0x81) fail('UNSUPPORTED_TDX_QUOTE');
  const signatureEnd = 636 + q.readUInt32LE(632);
  // The authentic public DCAP sample includes a 70-byte zero-filled transport tail.
  // It is not signed. Accept bounded zero padding explicitly; no semantics attach to it.
  const trailing = q.subarray(signatureEnd);
  if (signatureEnd > q.length || trailing.length > 256 || !trailing.every(byte => byte === 0)) fail('INVALID_TDX_QUOTE_LENGTH');
  const sec = q.subarray(636, signatureEnd);
  if (sec.length < 134 || sec.readUInt16LE(128) !== 6 || sec.readUInt32LE(130) !== sec.length - 134) fail('UNSUPPORTED_TDX_CERTIFICATION_DATA');
  const inner = sec.subarray(134);
  if (inner.length < 456) fail('INVALID_TDX_QE_REPORT');
  const authLength = inner.readUInt16LE(448);
  const certificateOffset = 450 + authLength;
  if (certificateOffset + 6 > inner.length || inner.readUInt16LE(certificateOffset) !== 5 || inner.readUInt32LE(certificateOffset + 2) !== inner.length - certificateOffset - 6) fail('INVALID_TDX_QE_REPORT');
  const attestPublicKey = sec.subarray(64, 128);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: attestPublicKey.subarray(0, 32).toString('base64url'), y: attestPublicKey.subarray(32).toString('base64url') } });
  if (!verifySignature('sha256', q.subarray(0, 632), { key, dsaEncoding: 'ieee-p1363' }, sec.subarray(0, 64))) fail('INVALID_TDX_BODY_SIGNATURE');
  if (!sha(attestPublicKey, inner.subarray(450, certificateOffset)).equals(inner.subarray(320, 352))) fail('INVALID_TDX_ATTESTATION_KEY_BINDING');
  if (expectedReportDataHex !== undefined && !q.subarray(568, 600).equals(hex(expectedReportDataHex, 32))) fail('TDX_SESSION_BINDING_MISMATCH');
  return {
    quoteHash: sha(q).toString('hex'), reportDataHex: q.subarray(568, 632).toString('hex'), unsignedTrailingZeroBytes: trailing.length,
    measurements: { mrtd: q.subarray(184, 232).toString('hex'), rtmr0: q.subarray(376, 424).toString('hex'), rtmr1: q.subarray(424, 472).toString('hex'), rtmr2: q.subarray(472, 520).toString('hex'), rtmr3: q.subarray(520, 568).toString('hex') },
    bodySignatureVerified: true, attestationKeyBindingVerified: true, hardwareAuthenticity: 'UNVERIFIED',
  };
}

export interface AttestProxyIntegrityResult {
  compatibilityCommit: typeof UPSTREAM_ATTEST_PROXY_PIN;
  sourceBundleHash: string; sessionRoot: string; merkleRoot: string | null; reportData: string;
  committedMeta: { profile: string; purpose: string };
  count: number; shownIndices: number[]; contentVerifiedIndices: number[];
  completeness: 'FULL_COMMITMENT_SET' | 'DENSE_COMMITMENT_RANGE' | 'PARTIAL_COMMITMENT_SET';
  completeRange?: [number, number];
  anchor: { boundSamples: number; externallyVerified: false };
  quote?: TdxBodyIntegrity;
  confidenceTier: 'P0_OPERATOR'; limitations: string[];
}

/**
 * Verifies authentic upstream-format structure, not an authentic witness origin.
 * No transcript extraction, owner binding, marker replay, timestamps, or provider claims are inferred.
 * Unknown convenience fields are retained in the caller's source bundle but NEVER consumed as claims.
 */
export function verifyAttestProxyIntegrity(value: unknown): AttestProxyIntegrityResult {
  if (Buffer.byteLength(canonicalJson(value)) > MAX_BUNDLE_BYTES) fail('UPSTREAM_BUNDLE_TOO_LARGE');
  const b = object(value);
  if (b.attester !== 'dstack-cvm') fail('UNSUPPORTED_UPSTREAM_ATTESTER');
  if (!Number.isSafeInteger(b.call_count) || b.call_count < 0 || b.call_count > MAX_LEAVES || !Array.isArray(b.calls) || b.calls.length > b.call_count) fail('INVALID_UPSTREAM_LEAF_COUNT');
  const meta = base64(b.session_meta_b64, 65536);
  if (!meta.length || meta[0]! + 1 > meta.length) fail('INVALID_UPSTREAM_SESSION_META');
  const decoder = new TextDecoder('utf8', { fatal: true });
  let committedMeta: { profile: string; purpose: string };
  try { committedMeta = { profile: decoder.decode(meta.subarray(1, 1 + meta[0]!)), purpose: decoder.decode(meta.subarray(1 + meta[0]!)) }; } catch { fail('INVALID_UPSTREAM_SESSION_META'); }
  const indices: number[] = []; const commitments: Buffer[] = []; const contentIndices: number[] = [];
  const proofs: Array<Buffer[] | undefined> = [];
  for (const entry of b.calls) {
    const c = object(entry);
    const index = c.index ?? (typeof c.n === 'number' ? c.n - 1 : undefined);
    if (!Number.isSafeInteger(index) || index < 0 || index >= b.call_count || (indices.length && index <= indices.at(-1)!) || (c.index !== undefined && c.n !== undefined && c.index !== c.n - 1)) fail('INVALID_UPSTREAM_LEAF_INDEX');
    indices.push(index); const commitment = hex(c.commitment, 32); commitments.push(commitment);
    if (c.request_redacted !== undefined || c.response_b64 !== undefined) {
      if (c.withheld !== undefined || typeof c.host !== 'string' || !c.host || c.host.length > 255 || c.host.includes('\0')) fail('INVALID_UPSTREAM_DISCLOSURE');
      const calculated = sha(utf8('zktls-v1\0'), utf8(c.host), Buffer.from([0]), latin1(c.request_redacted), Buffer.from([0]), base64(c.response_b64));
      if (!calculated.equals(commitment)) fail('UPSTREAM_CONTENT_COMMITMENT_MISMATCH');
      contentIndices.push(index);
    }
    if (c.inclusion_proof !== undefined && (!Array.isArray(c.inclusion_proof) || c.inclusion_proof.length > 8)) fail('INVALID_UPSTREAM_PROOF');
    proofs.push(c.inclusion_proof?.map((h: unknown) => hex(h, 32)));
  }
  const full = indices.length === b.call_count;
  const calculatedTree = full && b.call_count > 0 ? root(commitments) : Buffer.alloc(32);
  const tree = b.merkle_root == null ? calculatedTree : hex(b.merkle_root, 32);
  if (!full && b.call_count > 0 && b.merkle_root == null) fail('MISSING_UPSTREAM_MERKLE_ROOT');
  if (full && !tree.equals(calculatedTree)) fail('UPSTREAM_MERKLE_ROOT_MISMATCH');
  for (let i = 0; i < indices.length; i++) {
    const proof = proofs[i];
    if (proof === undefined) { if (!full || b.merkle_root != null) fail('MISSING_UPSTREAM_PROOF'); }
    else if (!proofRoot(commitments[i]!, indices[i]!, b.call_count, proof).equals(tree)) fail('UPSTREAM_INCLUSION_PROOF_MISMATCH');
  }
  const countBytes = Buffer.alloc(4); countBytes.writeUInt32BE(b.call_count);
  const session = sha(utf8('zktls-root-v2\0'), sha(utf8('zktls-session-v2\0'), meta), tree, countBytes);
  if (!session.equals(hex(b.session_root, 32))) fail('UPSTREAM_SESSION_ROOT_MISMATCH');
  let completeRange: [number, number] | undefined;
  if (b.complete_range !== undefined) {
    const r = b.complete_range;
    if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isSafeInteger) || r[0] < 0 || r[1] < r[0] || r[1] >= b.call_count || indices.length !== r[1] - r[0] + 1 || indices.some((n, i) => n !== r[0] + i)) fail('INVALID_UPSTREAM_COMPLETE_RANGE');
    completeRange = [r[0], r[1]];
  }
  if (b.beacons !== undefined && (!Array.isArray(b.beacons) || b.beacons.length > 4096)) fail('INVALID_UPSTREAM_BEACONS');
  const beacons: unknown[] = b.beacons?.length ? b.beacons : b.beacon ? [b.beacon] : [];
  // Only first/last samples are committed by upstream v2, not arbitrary intermediate JSON.
  const reportData = beacons.length === 0 ? session : beacons.length === 1 ? sha(utf8('zktls-anchor-v1\0'), session, anchorTag(beacons[0])) : sha(utf8('zktls-anchor-v2\0'), session, anchorTag(beacons[0]), Buffer.from([0]), anchorTag(beacons.at(-1)));
  if (b.report_data !== undefined && !reportData.equals(hex(b.report_data, 32))) fail('UPSTREAM_REPORT_DATA_MISMATCH');
  let quote: TdxBodyIntegrity | undefined;
  if (b.quote !== undefined && b.quote !== null) quote = verifyTdxQuoteBodyIntegrity(object(b.quote).quote, reportData.toString('hex'));
  return {
    compatibilityCommit: UPSTREAM_ATTEST_PROXY_PIN, sourceBundleHash: canonicalHash(value), sessionRoot: session.toString('hex'), merkleRoot: b.call_count ? tree.toString('hex') : null,
    reportData: reportData.toString('hex'), committedMeta: committedMeta!, count: b.call_count, shownIndices: indices, contentVerifiedIndices: contentIndices,
    completeness: full ? 'FULL_COMMITMENT_SET' : completeRange ? 'DENSE_COMMITMENT_RANGE' : 'PARTIAL_COMMITMENT_SET', ...(completeRange ? { completeRange } : {}),
    anchor: { boundSamples: Math.min(2, beacons.length), externallyVerified: false }, ...(quote ? { quote } : {}), confidenceTier: 'P0_OPERATOR',
    limitations: [
      'Session commitments are verified; origin authenticity is not established by hash arithmetic or self-consistent signatures.',
      'Intel DCAP, measurement approval and measured-source binding must be verified separately before any TEE provenance tier.',
      'No owner identity, rights, authorship, truth, global completeness, or research-before-trade claim is established.',
      'Top-level purpose/parties/release/doc/usage and per-call timestamps are untrusted convenience metadata, not normalized claims.',
      'Beacon strings are bound but not externally authenticated here; even verified drand anchors establish a lower time bound, not an observed end.',
      'Commitment coverage does not imply disclosed content coverage; turn/credential/checker markers are not semantically replayed by this adapter.',
    ],
  };
}
