import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAttestProxyIntegrity, verifyTdxQuoteBodyIntegrity, type AttestProxyIntegrityResult, type TdxBodyIntegrity } from './upstream.ts';

export interface DcapVerification {
  quoteHash: string; verificationTimeSeconds: number; status: 'UpToDate'; advisoryIds: string[];
  collateralExpiresAtSeconds: number; reportDataHex: string; measurements: TdxBodyIntegrity['measurements'];
  hardwareAuthenticity: 'INTEL_DCAP_VERIFIED'; measurementApproval: 'NOT_EVALUATED'; sourceBinding: 'NOT_EVALUATED';
  platformPolicy: DcapPlatformPolicy;
}
export interface DcapPlatformPolicy { allow_dynamic_platform: boolean; allow_cached_keys: boolean; allow_smt: boolean }

/** Pinned maintained-library adapter. Offline only; caller supplies signed collateral separately. */
export class OfflineDcapVerifier {
  private pythonExecutable: string; private clock: () => Date; private timeoutMs: number; private platformPolicy: DcapPlatformPolicy;
  constructor(config: { pythonExecutable: string; clock?: () => Date; timeoutMs?: number; platformPolicy?: DcapPlatformPolicy }) {
    if (!isAbsolute(config.pythonExecutable)) throw new Error('ABSOLUTE_PYTHON_PATH_REQUIRED');
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000)) throw new Error('INVALID_DCAP_TIMEOUT');
    this.platformPolicy = structuredClone(config.platformPolicy ?? { allow_dynamic_platform: false, allow_cached_keys: false, allow_smt: false });
    if (Object.keys(this.platformPolicy).length !== 3 || ['allow_dynamic_platform', 'allow_cached_keys', 'allow_smt'].some(k => typeof (this.platformPolicy as any)[k] !== 'boolean')) throw new Error('INVALID_DCAP_POLICY');
    this.pythonExecutable = config.pythonExecutable; this.clock = config.clock ?? (() => new Date()); this.timeoutMs = config.timeoutMs ?? 15_000;
  }
  async verifyQuote(input: { quoteHex: string; collateral: unknown }): Promise<DcapVerification> {
    const arithmetic = verifyTdxQuoteBodyIntegrity(input.quoteHex);
    const time = Math.floor(this.clock().getTime() / 1000);
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('INVALID_DCAP_CLOCK');
    const request = JSON.stringify({ protocol: 'thot.dcap-offline/1', quote_hex: input.quoteHex, collateral: input.collateral, verification_time_seconds: time, platform_policy: this.platformPolicy });
    if (Buffer.byteLength(request) > 2_000_000) throw new Error('DCAP_INPUT_LIMIT');
    const response = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.pythonExecutable, ['-B', fileURLToPath(new URL('../scripts/verify_dcap.py', import.meta.url))], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', PYTHONPATH: fileURLToPath(new URL('../.python-deps', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' },
      });
      const chunks: Buffer[] = []; let size = 0; let settled = false;
      const finish = (error?: string, output?: string) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(new Error(error)); } else resolve(output!); };
      const timer = setTimeout(() => finish('DCAP_VERIFIER_TIMEOUT'), this.timeoutMs);
      child.on('error', () => finish('DCAP_VERIFIER_UNAVAILABLE'));
      child.stdin.on('error', () => finish('DCAP_VERIFIER_INPUT_FAILED'));
      child.stderr.on('data', () => {});
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16_384) finish('DCAP_VERIFIER_OUTPUT_LIMIT'); else chunks.push(chunk); });
      child.on('close', (code) => finish(code === 0 ? undefined : 'DCAP_VERIFICATION_FAILED', Buffer.concat(chunks).toString('utf8')));
      child.stdin.end(request);
    });
    let r: any; try { r = JSON.parse(response); } catch { throw new Error('INVALID_DCAP_RESPONSE'); }
    if (r?.protocol !== 'thot.dcap-offline/1' || r.verified !== true || r.library_version !== '0.6.1' || r.quote_hash !== arithmetic.quoteHash || r.verification_time_seconds !== time ||
        r.status !== 'UpToDate' || !Array.isArray(r.advisory_ids) || r.advisory_ids.length > 256 || r.advisory_ids.some((x: unknown) => typeof x !== 'string' || x.length > 256) ||
        !Number.isSafeInteger(r.earliest_expiration_seconds) || r.earliest_expiration_seconds < time || r.report_data !== arithmetic.reportDataHex ||
        Object.entries(this.platformPolicy).some(([k, v]) => r.platform_policy?.[k] !== v) || Object.entries(arithmetic.measurements).some(([k, v]) => r.measurements?.[k] !== v)) throw new Error('INVALID_DCAP_RESPONSE');
    return { quoteHash: r.quote_hash, verificationTimeSeconds: time, status: r.status, advisoryIds: r.advisory_ids, collateralExpiresAtSeconds: r.earliest_expiration_seconds,
      reportDataHex: r.report_data, measurements: r.measurements, hardwareAuthenticity: 'INTEL_DCAP_VERIFIED', measurementApproval: 'NOT_EVALUATED', sourceBinding: 'NOT_EVALUATED', platformPolicy: structuredClone(this.platformPolicy) };
  }
  async verifyBundle(input: { bundle: unknown; collateral: unknown }): Promise<{ integrity: AttestProxyIntegrityResult; hardware: DcapVerification; confidenceTier: 'P0_OPERATOR' }> {
    const integrity = verifyAttestProxyIntegrity(input.bundle);
    if (!integrity.quote) throw new Error('ATTEST_PROXY_QUOTE_REQUIRED');
    const hardware = await this.verifyQuote({ quoteHex: (input.bundle as any).quote.quote, collateral: input.collateral });
    // Full hardware authenticity is still not measured-source approval for this application.
    return { integrity, hardware, confidenceTier: 'P0_OPERATOR' };
  }
}
