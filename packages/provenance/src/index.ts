import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { canonicalHash, canonicalJson, signCanonical, verifyCanonical } from '../../protocol/src/index.ts';

export const ATTEST_PROXY_COMPATIBILITY = Object.freeze({ repository: 'https://github.com/amiller/attest-proxy', commit: '5a4b1fe34cd5256b36755da75a7aabdbc173526e' });
export type TraceContent = { turns: Array<{ role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function'; content: string }> };
export type ProvenanceTier = 'P0_OPERATOR' | 'P1_WITNESSED' | 'P2_TEE' | 'P3_UPSTREAM';
export interface ProvenanceReceipt {
  schema_version: 'trace.provenance/1'; receipt_id: string; trace_id: string;
  path: 'attested_proxy' | 'attested_sandbox' | 'browser' | 'mobile' | 'legacy_import';
  confidence_tier: ProvenanceTier;
  upstream?: { host?: string; model_claim?: string; provider_claim?: string };
  temporal: { not_before?: string; observed_start?: string; observed_end?: string; not_after?: string };
  commitments: { raw_trace_hash?: string; session_root?: string; source_bundle_hash: string };
  attestation?: { tee_type?: 'intel_tdx' | 'nitro' | 'confidential_space' | 'other'; measurement_set_id?: string; quote_hash?: string; quote_verification_status?: 'valid' | 'invalid' | 'unknown' };
  claims: string[]; limitations: string[];
  verifier: { implementation: string; version: string; verified_at: string };
}

/** Publicly known development signing material. Never evidence of a real witness. */
export function developmentSigningKeys(domain = 'thot-development'): { privateKey: KeyObject; publicKey: KeyObject } {
  const seed = Buffer.from(canonicalHash({ domain, WARNING: 'PUBLIC DEVELOPMENT FIXTURE KEY' }), 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export interface DevelopmentBundle {
  format: 'thot.development-bundle/1'; owner_user_id: string; trace_id: string; observed_at: string;
  trace: TraceContent; leaf_hashes: string[]; leaf_count: number; merkle_root: string;
  issuer_key_id: 'thot-public-development-key'; signature: string;
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return canonicalHash([]);
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(canonicalHash([level[i], level[i + 1] ?? level[i]]));
    level = next;
  }
  return level[0]!;
}

export function assertTraceContent(value: unknown): asserts value is TraceContent {
  const trace = value as TraceContent;
  if (!trace || Object.keys(trace).some(key => key !== 'turns') || !Array.isArray(trace.turns) || trace.turns.length === 0 || trace.turns.length > 1000 ||
      trace.turns.some(turn => !turn || Object.keys(turn).some(key => !['role', 'content'].includes(key)) || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(turn.role) || typeof turn.content !== 'string' || turn.content.length > 100_000) ||
      Buffer.byteLength(canonicalJson(trace)) > 2_000_000) throw new Error('INVALID_TRACE');
}

export function createDevelopmentBundle(input: { userId: string; traceId: string; trace: TraceContent; observedAt?: string }): DevelopmentBundle {
  assertTraceContent(input.trace);
  if (!input.userId || !input.traceId) throw new Error('MISSING_SUBJECT_BINDING');
  const observedAt = input.observedAt ?? '2026-01-01T00:00:00.000Z';
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('INVALID_TIMESTAMP');
  const leafHashes = input.trace.turns.map((turn, index) => canonicalHash({ index, turn }));
  const unsigned = {
    format: 'thot.development-bundle/1' as const, owner_user_id: input.userId, trace_id: input.traceId,
    observed_at: observedAt, trace: structuredClone(input.trace), leaf_hashes: leafHashes,
    leaf_count: leafHashes.length, merkle_root: merkleRoot(leafHashes), issuer_key_id: 'thot-public-development-key' as const,
  };
  return { ...unsigned, signature: signCanonical(unsigned, developmentSigningKeys().privateKey) };
}

export function verifyDevelopmentBundle(bundle: DevelopmentBundle, input: { userId: string; traceId?: string; allowDevelopment: boolean; now?: string }): { normalizedReceipt: ProvenanceReceipt; trace: TraceContent; sourceBundle: DevelopmentBundle } {
  if (!input.allowDevelopment) throw new Error('DEVELOPMENT_PROVENANCE_DISABLED');
  if (bundle?.format !== 'thot.development-bundle/1' || bundle.issuer_key_id !== 'thot-public-development-key') throw new Error('UNSUPPORTED_PROVENANCE_FORMAT');
  if (Object.keys(bundle).some(key => !['format', 'owner_user_id', 'trace_id', 'observed_at', 'trace', 'leaf_hashes', 'leaf_count', 'merkle_root', 'issuer_key_id', 'signature'].includes(key))) throw new Error('INVALID_PROVENANCE_BUNDLE');
  if (bundle.owner_user_id !== input.userId || (input.traceId && bundle.trace_id !== input.traceId)) throw new Error('PROVENANCE_SUBJECT_MISMATCH');
  const { signature, ...unsigned } = bundle;
  if (!verifyCanonical(unsigned, signature, developmentSigningKeys().publicKey)) throw new Error('INVALID_PROVENANCE_SIGNATURE');
  assertTraceContent(bundle.trace);
  const leaves = bundle.trace.turns.map((turn, index) => canonicalHash({ index, turn }));
  if (bundle.leaf_count !== leaves.length || canonicalHash(leaves) !== canonicalHash(bundle.leaf_hashes) || merkleRoot(leaves) !== bundle.merkle_root) throw new Error('PROVENANCE_INTEGRITY_FAILURE');
  const bundleHash = canonicalHash(bundle);
  return {
    normalizedReceipt: {
      schema_version: 'trace.provenance/1', receipt_id: `dev_${bundleHash}`, trace_id: bundle.trace_id,
      path: 'legacy_import', confidence_tier: 'P0_OPERATOR', temporal: { observed_start: bundle.observed_at, observed_end: bundle.observed_at },
      commitments: { raw_trace_hash: canonicalHash(bundle.trace), session_root: bundle.merkle_root, source_bundle_hash: bundleHash },
      claims: ['Development fixture signature and complete ordered leaf commitments verified.'],
      limitations: ['PUBLIC DEVELOPMENT KEY: anyone can create this fixture.', 'No external witness, TEE quote, provider authentication, or trusted timestamp.', 'No claim of truth, rights, human authorship, or completeness outside this fixture.'],
      verifier: { implementation: 'thot-development-fixture', version: '1', verified_at: input.now ?? new Date().toISOString() },
    }, trace: structuredClone(bundle.trace), sourceBundle: structuredClone(bundle),
  };
}

export interface ExternalVerifierConfig {
  executable: string; args?: string[]; compatibilityCommit: string; timeoutMs?: number; maxOutputBytes?: number;
  /** Versioned policy configured by the operator, never supplied by bundle authors. */
  measurementAllowlist: { version: string; measurementSetIds: string[] };
}

/** Trusted external verifier protocol: JSON request on stdin, one JSON response on stdout. No shell. */
export class ExternalProvenanceVerifier {
  readonly format = 'attest-proxy';
  private config: ExternalVerifierConfig;
  constructor(config: ExternalVerifierConfig) {
    if (!isAbsolute(config.executable) || config.compatibilityCommit !== ATTEST_PROXY_COMPATIBILITY.commit) throw new Error('UNPINNED_PROVENANCE_VERIFIER');
    if (!config.measurementAllowlist.version || !Array.isArray(config.measurementAllowlist.measurementSetIds)) throw new Error('MISSING_MEASUREMENT_POLICY');
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000)) throw new Error('INVALID_VERIFIER_TIMEOUT');
    if (config.maxOutputBytes !== undefined && (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1 || config.maxOutputBytes > 4_000_000)) throw new Error('INVALID_VERIFIER_OUTPUT_LIMIT');
    this.config = structuredClone(config);
  }
  async verify(input: { bundle: unknown; userId: string; traceId: string }): Promise<{ normalizedReceipt: ProvenanceReceipt; trace: TraceContent; sourceBundle: unknown }> {
    const sourceBundle = structuredClone(input.bundle);
    const sourceHash = canonicalHash(sourceBundle);
    const request = canonicalJson({ protocol: 'thot.attest-proxy-verifier/1', compatibility: ATTEST_PROXY_COMPATIBILITY, source_bundle: sourceBundle, expected_owner_user_id: input.userId, expected_trace_id: input.traceId, measurement_allowlist: this.config.measurementAllowlist });
    if (Buffer.byteLength(request) > 4_000_000) throw new Error('PROVENANCE_BUNDLE_TOO_LARGE');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.config.executable, this.config.args ?? [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
      let settled = false; let bytes = 0; const chunks: Buffer[] = [];
      const finish = (error?: Error, result?: string) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else resolve(result!); };
      const timer = setTimeout(() => finish(new Error('PROVENANCE_VERIFIER_TIMEOUT')), this.config.timeoutMs ?? 10_000);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > Math.min(this.config.maxOutputBytes ?? 4_000_000, 4_000_000)) finish(new Error('PROVENANCE_VERIFIER_OUTPUT_LIMIT')); else chunks.push(chunk); });
      // stderr can contain evidence; intentionally discard it rather than logging raw data.
      child.stderr.on('data', () => {});
      child.on('error', () => finish(new Error('PROVENANCE_VERIFIER_UNAVAILABLE')));
      child.stdin.on('error', () => finish(new Error('PROVENANCE_VERIFIER_INPUT_FAILURE')));
      child.on('close', code => code === 0 ? finish(undefined, Buffer.concat(chunks).toString('utf8')) : finish(new Error('PROVENANCE_VERIFICATION_FAILED')));
      child.stdin.end(request);
    });
    let result: any;
    try { result = JSON.parse(output); } catch { throw new Error('INVALID_PROVENANCE_VERIFIER_RESPONSE'); }
    const receipt = result?.normalizedReceipt as ProvenanceReceipt;
    if (!result || Object.keys(result).some(key => !['protocol', 'verified', 'compatibility_commit', 'owner_user_id', 'normalizedReceipt', 'trace'].includes(key)) ||
        result?.protocol !== 'thot.attest-proxy-verifier/1' || result?.verified !== true || result?.compatibility_commit !== ATTEST_PROXY_COMPATIBILITY.commit ||
        result?.owner_user_id !== input.userId || receipt?.schema_version !== 'trace.provenance/1' || receipt.trace_id !== input.traceId ||
        Object.keys(receipt).some(key => !['schema_version', 'receipt_id', 'trace_id', 'path', 'confidence_tier', 'upstream', 'temporal', 'commitments', 'attestation', 'claims', 'limitations', 'verifier'].includes(key)) ||
        receipt.path !== 'attested_proxy' || !['P0_OPERATOR', 'P1_WITNESSED', 'P2_TEE', 'P3_UPSTREAM'].includes(receipt.confidence_tier) ||
        receipt.commitments?.source_bundle_hash !== sourceHash || !Array.isArray(receipt.claims) || !Array.isArray(receipt.limitations) ||
        !receipt.claims.length || !receipt.limitations.length || [...receipt.claims, ...receipt.limitations].some(value => typeof value !== 'string' || value.length > 2000) ||
        !receipt.receipt_id || !receipt.verifier?.implementation || !receipt.verifier?.version || !Number.isFinite(Date.parse(receipt.verifier?.verified_at))) throw new Error('INVALID_PROVENANCE_VERIFIER_RESPONSE');
    assertTraceContent(result.trace);
    if (receipt.commitments.raw_trace_hash !== canonicalHash(result.trace)) throw new Error('PROVENANCE_CONTENT_MISMATCH');
    if (receipt.attestation?.quote_verification_status === 'invalid') throw new Error('INVALID_ATTESTATION_QUOTE');
    if (receipt.confidence_tier === 'P2_TEE') {
      if (receipt.attestation?.quote_verification_status !== 'valid' || !receipt.attestation.quote_hash || !receipt.attestation.measurement_set_id || !this.config.measurementAllowlist.measurementSetIds.includes(receipt.attestation.measurement_set_id)) throw new Error('UNAPPROVED_TEE_MEASUREMENT');
    }
    if (receipt.attestation?.quote_verification_status !== 'valid') receipt.limitations = [...receipt.limitations, 'No verified TEE quote is present in this verification result.'];
    return { normalizedReceipt: receipt, trace: result.trace, sourceBundle };
  }
}
export { ExternalProvenanceVerifier as AttestProxyVerifier };
export { verifyAttestProxyIntegrity, verifyTdxQuoteBodyIntegrity, UPSTREAM_ATTEST_PROXY_PIN } from './upstream.ts';
export type { AttestProxyIntegrityResult, TdxBodyIntegrity } from './upstream.ts';
export { OfflineDcapVerifier } from './dcap.ts';
export type { DcapVerification, DcapPlatformPolicy } from './dcap.ts';
