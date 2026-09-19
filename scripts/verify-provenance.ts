import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OfflineDcapVerifier, verifyAttestProxyIntegrity, type DcapPlatformPolicy } from '../packages/provenance/src/index.ts';

const usage = 'Usage: node scripts/verify-provenance.ts --bundle <file> [--collateral <file> --python <absolute executable> [--policy <file>]]';
async function boundedJson(path: string, limit: number): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('VERIFICATION_INPUT_LIMIT');
    const buffer = Buffer.alloc(limit + 1); let total = 0;
    while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead; }
    if (total > limit) throw new Error('VERIFICATION_INPUT_LIMIT');
    try { return JSON.parse(buffer.subarray(0, total).toString('utf8')); } catch { throw new Error('INVALID_VERIFICATION_JSON'); }
  } finally { await handle.close(); }
}

/** Read-only diagnostic. Never imports traces, opens sessions, accesses providers, or upgrades tiers. */
export async function verifyProvenanceCli(args: string[]): Promise<Record<string, unknown>> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--bundle', '--collateral', '--python', '--policy'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error('INVALID_VERIFICATION_ARGUMENTS');
    options.set(key, value);
  }
  if (!options.has('--bundle') || options.has('--collateral') !== options.has('--python') || (options.has('--policy') && !options.has('--collateral'))) throw new Error('INVALID_VERIFICATION_ARGUMENTS');
  const bundle = await boundedJson(options.get('--bundle')!, 4_000_000);
  const integrity = verifyAttestProxyIntegrity(bundle);
  let hardware: Awaited<ReturnType<OfflineDcapVerifier['verifyQuote']>> | undefined;
  if (options.has('--collateral')) {
    const collateral = await boundedJson(options.get('--collateral')!, 1_500_000);
    const policy = options.has('--policy') ? await boundedJson(options.get('--policy')!, 4096) as DcapPlatformPolicy : undefined;
    if (options.has('--policy') && (!policy || typeof policy !== 'object' || Array.isArray(policy))) throw new Error('INVALID_DCAP_POLICY');
    const verifier = new OfflineDcapVerifier({ pythonExecutable: options.get('--python')!, ...(policy ? { platformPolicy: policy } : {}) });
    hardware = (await verifier.verifyBundle({ bundle, collateral })).hardware;
  }
  return {
    protocol: 'thot.provenance-diagnostic/1', compatibility_commit: integrity.compatibilityCommit,
    source_bundle_hash: integrity.sourceBundleHash, session_root: integrity.sessionRoot,
    count: integrity.count, shown_count: integrity.shownIndices.length, verified_content_count: integrity.contentVerifiedIndices.length,
    commitment_coverage: integrity.completeness, quote_body_signature: integrity.quote ? 'VERIFIED_ONLY_SELF_CONSISTENCY' : 'ABSENT',
    hardware_authenticity: hardware?.hardwareAuthenticity ?? 'UNVERIFIED',
    ...(hardware ? { dcap_status: hardware.status, collateral_expires_at: new Date(hardware.collateralExpiresAtSeconds * 1000).toISOString(), platform_policy: hardware.platformPolicy } : {}),
    measurement_approval: 'NOT_EVALUATED', measured_source_binding: 'NOT_EVALUATED', time_bound: 'NOT_EXTERNALLY_VERIFIED',
    owner_binding: 'NOT_PRESENT_IN_UPSTREAM_SCHEMA', transcript_normalization: 'NOT_PERFORMED', confidence_tier: 'P0_OPERATOR',
    limitations: integrity.limitations,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
  else {
    try { console.log(JSON.stringify(await verifyProvenanceCli(process.argv.slice(2)), null, 2)); }
    catch (error) {
      // Never emit arbitrary parser/error text: it can contain private source bytes or paths.
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'PROVENANCE_DIAGNOSTIC_FAILED';
      console.error(JSON.stringify({ verified: false, error: code }));
      process.exitCode = 1;
    }
  }
}
