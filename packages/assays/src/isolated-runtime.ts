import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type ReviewedWorker = 'safe-features-v1' | 'test-timeout' | 'test-crash' | 'test-invalid-output'
  | 'test-excess-output' | 'test-excess-stderr' | 'test-memory' | 'test-environment';
const testScenarios = new Set(['test-timeout', 'test-crash', 'test-invalid-output', 'test-excess-output', 'test-excess-stderr', 'test-memory', 'test-environment']);
export interface RuntimeLimits { timeoutMs: number; heapMb: number; maxOutputBytes: number; maxStderrBytes: number; }
export interface RuntimeResult { output?: unknown; failure?: string; sourceHash: string; killed: boolean; }

function workerUrl(module: ReviewedWorker): URL {
  if (module === 'safe-features-v1') return new URL('./safe-features-worker.mjs', import.meta.url);
  if (testScenarios.has(module)) return new URL('../test-fixtures/fault-worker.mjs', import.meta.url);
  throw new Error('UNREVIEWED_ASSAY_WORKER');
}

/** Private process supervisor. Paths are a fixed registry, never buyer-supplied code or URLs. */
export async function superviseReviewedWorker(module: ReviewedWorker, request: string, limits: RuntimeLimits): Promise<RuntimeResult> {
  const url = workerUrl(module); const path = fileURLToPath(url);
  const sourceHash = createHash('sha256').update(await readFile(url)).digest('hex');
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${limits.heapMb}`, '--max-semi-space-size=2', '--stack-size=512',
      '--permission', `--allow-fs-read=${path}`, '--disable-proto=throw', '--no-addons', path,
      ...(module === 'safe-features-v1' ? [] : [module]),
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { LANG: 'C', TZ: 'UTC' } });
    const output: Buffer[] = []; let outputBytes = 0, stderrBytes = 0;
    let failure: string | undefined, killed = false, finished = false;
    const stop = (code: string) => {
      if (finished || failure) return;
      failure = code; killed = child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('ASSAY_TIMEOUT'), limits.timeoutMs);
    const finish = (code: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (failure || code !== 0) { resolve({ failure: failure ?? 'ASSAY_WORKER_FAILED', sourceHash, killed }); return; }
      try { resolve({ output: JSON.parse(Buffer.concat(output).toString('utf8')), sourceHash, killed }); }
      catch { resolve({ failure: 'INVALID_ASSAY_OUTPUT', sourceHash, killed }); }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) stop('ASSAY_OUTPUT_LIMIT');
      else if (!failure) output.push(chunk);
    });
    // Never log or retain child stderr: even a reviewed module's error may contain input.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length; if (stderrBytes > limits.maxStderrBytes) stop('ASSAY_STDERR_LIMIT');
    });
    child.stdin.on('error', () => stop('ASSAY_INPUT_FAILURE'));
    child.stdout.on('error', () => stop('ASSAY_OUTPUT_FAILURE'));
    child.stderr.on('error', () => stop('ASSAY_STDERR_FAILURE'));
    child.on('error', () => { failure ??= 'ASSAY_WORKER_UNAVAILABLE'; if (!child.pid) finish(null); else stop(failure); });
    // Resolve only after process exit/pipe closure, including timeout and quota termination.
    child.on('close', finish);
    child.stdin.end(request);
  });
}
