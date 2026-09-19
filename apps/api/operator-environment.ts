import { totalmem, freemem, cpus, loadavg, uptime } from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Document } from '../../packages/storage/src/index.ts';
import { observeChain } from './chain-observation.ts';
import { observeRecorder } from './recorder-observation.ts';

type Application = {
  dataDir: string;
  privacy: { vault: { usage: () => Promise<{user:{bytes:number;objects:number};journal:{bytes:number;objects:number};limits:Record<string,number>}> } };
  service: { config: { development: boolean } };
  thot: { capabilities: () => Document };
  inference: { capabilities: () => Document };
  openrouter: { capabilities: () => Document };
  plaid: { capabilities: () => Document };
  robinhood: { capabilities: () => Document };
  agentCapture: { recorderPolicy?: Parameters<typeof observeRecorder>[0] };
};

const observed = () => new Date().toISOString();
const unavailable = (reason: string) => ({ observed_at: observed(), reason });
const finite = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function service(id: string, configured: boolean, reason: string) {
  return { id, status: configured ? 'configured' : 'unconfigured', observed_at: observed(), ...(configured ? {} : { reason }) };
}

function storageFormat(value: unknown) {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const backend = record?.backend;
  const keyCustody = record?.keyCustody;
  const objectStorage = record?.objectStorage;
  const objectKeyCustody = record?.objectKeyCustody;
  if (!record || record.version !== 1 || !['pglite', 'memory', 'postgres'].includes(String(backend)) || !['local-file', 'external'].includes(String(keyCustody)) || (objectStorage !== undefined && objectStorage !== 'external') || (objectKeyCustody !== undefined && objectKeyCustody !== 'external')) return null;
  return { backend, key_custody: keyCustody, object_storage: objectStorage ?? 'local-file', object_key_custody: objectKeyCustody ?? keyCustody };
}

/**
 * Read-only, deliberately coarse process and storage observations. This does
 * not inspect request data, credentials, paths, or endpoint URLs. System stats
 * describe the OS namespace visible to this process, not container limits.
 */
export async function operatorEnvironment(app: Application, input: { authMode: string; environmentName?: string }): Promise<Document> {
  const chain = app.thot.capabilities();
  const chainMode = typeof chain.mode === 'string' ? chain.mode : 'unavailable';
  const name = input.environmentName && /^[a-z][a-z0-9_-]{0,63}$/.test(input.environmentName)
    ? input.environmentName : chainMode === 'thot-anvil' ? 'private-anvil' : input.authMode === 'development' ? 'development' : 'unlabelled';
  const cpu = process.cpuUsage(), memory = process.memoryUsage(), runtimeObservedAt = observed();
  const chainObservation = observeChain(chain);
  const recorder = observeRecorder(app.agentCapture.recorderPolicy);
  let format: Document | null = null, formatReason: string | undefined;
  try { format = storageFormat(JSON.parse(await readFile(join(app.dataDir, '.thot-storage.json'), 'utf8'))); if (!format) formatReason = 'STORAGE_FORMAT_UNAVAILABLE'; }
  catch { formatReason = 'STORAGE_FORMAT_UNAVAILABLE'; }
  let filesystem: Document;
  try {
    const stats = await statfs(app.dataDir, { bigint: true });
    const bytes = stats.bavail * stats.bsize;
    filesystem = { available_bytes: bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes), observed_at: observed() };
  } catch { filesystem = { available_bytes: null, ...unavailable('FILESYSTEM_CAPACITY_UNAVAILABLE') }; }
  let vault: Document;
  try {
    const usage = await app.privacy.vault.usage();
    vault = { user_bytes: finite(usage.user.bytes), user_objects: finite(usage.user.objects), journal_bytes: finite(usage.journal.bytes), journal_objects: finite(usage.journal.objects), limits: usage.limits, observed_at: observed() };
  } catch { vault = { user_bytes: null, user_objects: null, journal_bytes: null, journal_objects: null, limits: null, ...unavailable('VAULT_USAGE_UNAVAILABLE') }; }
  const inference = app.inference.capabilities(), openrouter = app.openrouter.capabilities(), plaid = app.plaid.capabilities(), robinhood = app.robinhood.capabilities();
  return {
    schema_version: 'thot.operator-environment/1', observed_at: observed(),
    environment: { name, auth_mode: input.authMode, chain_mode: chainMode },
    runtime: {
      process: { uptime_seconds: process.uptime(), rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, cpu_user_microseconds: cpu.user, cpu_system_microseconds: cpu.system, observed_at: runtimeObservedAt },
      host: { source: 'os-visible-system', observed_at: runtimeObservedAt, total_memory_bytes: totalmem(), free_memory_bytes: freemem(), cpu_count: cpus().length, load_average_1m: loadavg()[0], uptime_seconds: uptime() },
    },
    storage: { format, ...(formatReason ? { format_reason: formatReason } : {}), filesystem, vault },
    services: [
      service('database', !!format, 'DATABASE_CONFIGURATION_UNAVAILABLE'),
      await chainObservation,
      service('inference', inference.enabled === true, 'INFERENCE_NOT_CONFIGURED'),
      service('openrouter_relay', openrouter.enabled === true, 'OPENROUTER_RELAY_NOT_CONFIGURED'),
      service('plaid', plaid.plaid_linking === true, 'PLAID_NOT_CONFIGURED'),
      service('robinhood', robinhood.robinhood_linking === true, 'ROBINHOOD_NOT_CONFIGURED'),
      await recorder,
    ],
  };
}
