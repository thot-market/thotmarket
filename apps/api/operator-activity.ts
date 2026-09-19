import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBounded } from '../../packages/operations/src/paths.ts';

export type ActivityDatabase = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
export type ActivitySource = 'application' | 'monitoring' | 'load-test';
export type ActivityRecord = { method: string | undefined; route: string | undefined; status: number | undefined; duration_ms: number | undefined; source?: ActivitySource };
export type OperatorActivityOptions = {
  dataDir: string;
  db?: ActivityDatabase;
  clock?: () => number;
  resourceIntervalMs?: number;
  persistIntervalMs?: number;
};

type Counts = { requests: number; errors: number; statuses: Record<string, number>; latency: { count: number; total_ms: number; max_ms: number; buckets: Record<string, number> } };
type TrafficBucket = Counts & { observed_at: string; method: string; route_group: string; source: ActivitySource };
type ResourceSample = { observed_at: string; rss_bytes: number; cpu_user_delta_microseconds: number; cpu_system_delta_microseconds: number; elapsed_milliseconds: number; cpu_core_ratio: number };
type ActivityLog = { observed_at: string; method: string; route_group: string; source: ActivitySource; status: number; status_group: string; duration_ms: number };
type Stored = { schema_version: 1; initialized_at: string; traffic: TrafficBucket[]; resources: ResourceSample[]; logs: ActivityLog[] };

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_LOGS = 1000;
const MAX_TRAFFIC_BUCKETS = 24 * 60 * 16; // Fixed groups can share a minute; tolerate a busy minute without unbounded disk.
const MAX_RESOURCE_SAMPLES = 24 * 60 * 2 + 2;
const fileName = 'operator-activity.v1.json';
const routeGroups = new Set(['other','wallet_verify','wallet_challenge','authentication','operator','thot','inference','capture','api','health','asset','application','public']);
const nowIso = (clock: () => number) => new Date(clock()).toISOString();
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function routeGroup(route: string | undefined): string {
  if (!route || typeof route !== 'string') return 'other';
  // Callers normally provide URL.pathname. Strip a query defensively before
  // classification and discard it immediately, so it can never enter telemetry.
  route = route.split(/[?#]/, 1)[0]!;
  if (route === '/v1/auth/wallet/verify') return 'wallet_verify';
  if (route === '/v1/auth/wallet/challenge') return 'wallet_challenge';
  if (route.startsWith('/v1/auth/') || route === '/v1/dev/session') return 'authentication';
  if (route.startsWith('/v1/operator/')) return 'operator';
  if (route.startsWith('/v1/thot/')) return 'thot';
  if (route.startsWith('/v1/inference/') || route.startsWith('/v1/openrouter/')) return 'inference';
  if (route.startsWith('/v1/capture') || route.startsWith('/v1/agent-captures/')) return 'capture';
  if (route.startsWith('/v1/')) return 'api';
  if (route === '/healthz') return 'health';
  if (route.startsWith('/assets/') || /\.(?:js|css|png|svg|woff2?)$/.test(route)) return 'asset';
  if (route === '/' || route === '/app' || route === '/app/' || route === '/ops' || route === '/ops/') return 'application';
  return 'public';
}
function methodGroup(method: string | undefined): string { return ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method ?? '') ? method! : 'OTHER'; }
function sourceGroup(source: unknown): ActivitySource { return source === 'load-test' || source === 'monitoring' ? source : 'application'; }
function statusValue(status: number | undefined): number { return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : 0; }
function statusGroup(status: number): string { return status === 0 ? 'unknown' : `${Math.floor(status / 100)}xx`; }
function latencyBucket(ms: number): string { return ms < 100 ? 'under_100ms' : ms < 500 ? '100_to_499ms' : ms < 1000 ? '500_to_999ms' : ms < 5000 ? '1_to_4_999ms' : '5s_or_more'; }
function emptyCounts(): Counts { return { requests: 0, errors: 0, statuses: {}, latency: { count: 0, total_ms: 0, max_ms: 0, buckets: {} } }; }
function addCount(target: Counts, status: number, duration: number): void {
  target.requests++; if (status >= 400 || status === 0) target.errors++;
  const group = statusGroup(status); target.statuses[group] = (target.statuses[group] ?? 0) + 1;
  target.latency.count++; target.latency.total_ms += duration; target.latency.max_ms = Math.max(target.latency.max_ms, duration);
  const bucket = latencyBucket(duration); target.latency.buckets[bucket] = (target.latency.buckets[bucket] ?? 0) + 1;
}
function validStored(value: unknown): Stored | undefined {
  const x = value as Partial<Stored>;
  if (!x || x.schema_version !== 1 || typeof x.initialized_at !== 'string' || !Number.isFinite(Date.parse(x.initialized_at)) || !Array.isArray(x.traffic) || !Array.isArray(x.resources) || !Array.isArray(x.logs)) return undefined;
  const counts = (row: any): boolean => row && Number.isSafeInteger(row.requests) && row.requests >= 0 && Number.isSafeInteger(row.errors) && row.errors >= 0 && row.statuses && typeof row.statuses === 'object' && row.latency && Number.isSafeInteger(row.latency.count) && finite(row.latency.total_ms) && finite(row.latency.max_ms) && row.latency.buckets && typeof row.latency.buckets === 'object';
  const copyCounts = (row: any): Counts => ({ requests: row.requests, errors: row.errors, statuses: Object.fromEntries(Object.entries(row.statuses).filter(([key, count]) => ['1xx', '2xx', '3xx', '4xx', '5xx', 'unknown'].includes(key) && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) as Record<string, number>, latency: { count: row.latency.count, total_ms: row.latency.total_ms, max_ms: row.latency.max_ms, buckets: Object.fromEntries(Object.entries(row.latency.buckets).filter(([key, count]) => ['under_100ms', '100_to_499ms', '500_to_999ms', '1_to_4_999ms', '5s_or_more'].includes(key) && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) as Record<string, number> } });
  const traffic: TrafficBucket[] = x.traffic.filter((row: any) => counts(row) && typeof row.observed_at === 'string' && Number.isFinite(Date.parse(row.observed_at)) && methodGroup(row.method) === row.method && routeGroups.has(row.route_group) && sourceGroup(row.source) === row.source).slice(-MAX_TRAFFIC_BUCKETS).map((row: any) => ({ observed_at: row.observed_at, method: row.method, route_group: row.route_group, source: sourceGroup(row.source), ...copyCounts(row) }));
  const resources: ResourceSample[] = x.resources.filter((row: any) => row && typeof row.observed_at === 'string' && Number.isFinite(Date.parse(row.observed_at)) && finite(row.rss_bytes) && finite(row.cpu_user_delta_microseconds) && finite(row.cpu_system_delta_microseconds) && finite(row.elapsed_milliseconds) && finite(row.cpu_core_ratio)).slice(-MAX_RESOURCE_SAMPLES).map((row: any) => ({ observed_at: row.observed_at, rss_bytes: row.rss_bytes, cpu_user_delta_microseconds: row.cpu_user_delta_microseconds, cpu_system_delta_microseconds: row.cpu_system_delta_microseconds, elapsed_milliseconds: row.elapsed_milliseconds, cpu_core_ratio: row.cpu_core_ratio }));
  const logs: ActivityLog[] = x.logs.filter((row: any) => row && typeof row.observed_at === 'string' && Number.isFinite(Date.parse(row.observed_at)) && methodGroup(row.method) === row.method && routeGroups.has(row.route_group) && sourceGroup(row.source) === row.source && statusValue(row.status) === row.status && statusGroup(row.status) === row.status_group && finite(row.duration_ms)).slice(-MAX_LOGS).map((row: any) => ({ observed_at: row.observed_at, method: row.method, route_group: row.route_group, source: sourceGroup(row.source), status: row.status, status_group: row.status_group, duration_ms: row.duration_ms }));
  return { schema_version: 1, initialized_at: x.initialized_at, traffic, resources, logs };
}

/**
 * Privacy-safe operator telemetry. It stores fixed route groups and counters only:
 * no URL paths, query strings, request bodies, headers, identifiers, or error text.
 */
export class OperatorActivity {
  private readonly file: string; private readonly clock: () => number; private readonly db?: ActivityDatabase;
  private readonly startedAt: string; private initializedAt: string; private traffic: TrafficBucket[] = []; private processTraffic: TrafficBucket[] = []; private resources: ResourceSample[] = []; private logs: ActivityLog[] = []; private persistence: { result: 'not_attempted' | 'ok' | 'unavailable'; observed_at?: string } = { result: 'not_attempted' };
  private cpu = process.cpuUsage(); private resourceObservedAt: number; private readonly resourceIntervalMs: number; private resourceTimer?: ReturnType<typeof setInterval>; private persistTimer?: ReturnType<typeof setInterval>; private closed = false; private writing?: Promise<void>;

  private constructor(options: OperatorActivityOptions) {
    this.file = join(options.dataDir, fileName); this.clock = options.clock ?? Date.now; this.db = options.db; this.startedAt = nowIso(this.clock); this.initializedAt = this.startedAt; this.resourceObservedAt = this.clock();
    const resourceEvery = options.resourceIntervalMs ?? 30_000, persistEvery = options.persistIntervalMs ?? 30_000; this.resourceIntervalMs = resourceEvery;
    if (resourceEvery > 0) { this.resourceTimer = setInterval(() => this.sampleResources(), resourceEvery); this.resourceTimer.unref(); }
    if (persistEvery > 0) { this.persistTimer = setInterval(() => { void this.persist(); }, persistEvery); this.persistTimer.unref(); }
    this.sampleResources();
  }

  static async create(options: OperatorActivityOptions): Promise<OperatorActivity> {
    const activity = new OperatorActivity(options);
    try {
      const stored = validStored(JSON.parse((await readBounded(activity.file,16*1024*1024)).toString('utf8')));
      if (stored) { activity.initializedAt = stored.initialized_at; activity.traffic = stored.traffic; activity.resources = stored.resources; activity.logs = stored.logs; activity.trim(); }
    } catch { /* A missing or damaged optional telemetry file never blocks service startup. */ }
    return activity;
  }

  record(input: ActivityRecord): void {
    if (this.closed) return;
    const method = methodGroup(input.method), group = routeGroup(input.route), source = sourceGroup(input.source), status = statusValue(input.status);
    const duration = finite(input.duration_ms) ? Math.min(Math.round(input.duration_ms!), 3_600_000) : 0;
    const observedAt = nowIso(this.clock), minute = observedAt.slice(0, 16) + ':00.000Z';
    let bucket = this.traffic.find(row => row.observed_at === minute && row.method === method && row.route_group === group && row.source === source); if (!bucket) { bucket = { observed_at: minute, method, route_group: group, source, ...emptyCounts() }; this.traffic.push(bucket); } addCount(bucket, status, duration);
    let processBucket = this.processTraffic.find(row => row.method === method && row.route_group === group && row.source === source); if (!processBucket) { processBucket = { observed_at: this.startedAt, method, route_group: group, source, ...emptyCounts() }; this.processTraffic.push(processBucket); } addCount(processBucket, status, duration);
    this.logs.push({ observed_at: observedAt, method, route_group: group, source, status, status_group: statusGroup(status), duration_ms: duration });
    this.trim();
  }

  private sampleResources(): void {
    if (this.closed) return;
    const observed = this.clock(), current = process.cpuUsage(), elapsed = Math.max(1, observed - this.resourceObservedAt), user = Math.max(0, current.user - this.cpu.user), system = Math.max(0, current.system - this.cpu.system); this.cpu = current; this.resourceObservedAt = observed;
    this.resources.push({ observed_at: new Date(observed).toISOString(), rss_bytes: process.memoryUsage().rss, cpu_user_delta_microseconds: user, cpu_system_delta_microseconds: system, elapsed_milliseconds: elapsed, cpu_core_ratio: (user + system) / (elapsed * 1000) }); this.trim();
  }
  private trim(): void {
    const cutoff = this.clock() - RETENTION_MS;
    this.traffic = this.traffic.filter(row => Date.parse(row.observed_at) >= cutoff).slice(-MAX_TRAFFIC_BUCKETS);
    this.resources = this.resources.filter(row => Date.parse(row.observed_at) >= cutoff).slice(-MAX_RESOURCE_SAMPLES);
    this.logs = this.logs.filter(row => Date.parse(row.observed_at) >= cutoff).slice(-MAX_LOGS);
  }
  private stored(): Stored { this.trim(); return { schema_version: 1, initialized_at: this.initializedAt, traffic: this.traffic, resources: this.resources, logs: this.logs }; }
  private async persist(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = (async () => { try { await mkdir(join(this.file, '..'), { recursive: true }); const temporary = this.file + '.tmp'; await writeFile(temporary, JSON.stringify(this.stored()), { mode: 0o600 }); await rename(temporary, this.file); this.persistence = { result: 'ok', observed_at: nowIso(this.clock) }; } catch { this.persistence = { result: 'unavailable', observed_at: nowIso(this.clock) }; } finally { this.writing = undefined; } })();
    return this.writing;
  }
  private async accessCounts(): Promise<Record<string, unknown>> {
    if (!this.db) return { available: false, reason: 'AUTH_ACCESS_DATABASE_UNAVAILABLE' };
    try {
      const now = Math.floor(this.clock() / 1000);
      const result = await this.db.query(`SELECT
        count(*) FILTER (WHERE document->>'kind'='membership' AND document->>'enabled'='true')::text AS registered_accounts,
        count(*) FILTER (WHERE document->>'kind'='wallet_session' AND (document->>'expires_at') ~ '^[0-9]+$' AND (document->>'expires_at')::numeric > $1)::text AS active_sessions,
        count(DISTINCT document->>'subject') FILTER (WHERE document->>'kind'='wallet_session' AND (document->>'expires_at') ~ '^[0-9]+$' AND (document->>'expires_at')::numeric > $1)::text AS active_session_identities
        FROM auth_access`, [now]);
      const row = result.rows[0] ?? {}, number = (key: string) => Number.isSafeInteger(Number(row[key])) ? Number(row[key]) : 0;
      return { available: true, registered_accounts: number('registered_accounts'), active_sessions: number('active_sessions'), active_session_identities: number('active_session_identities'), active_sessions_are_credentials_not_people: true };
    } catch { return { available: false, reason: 'AUTH_ACCESS_DATABASE_UNAVAILABLE' }; }
  }
  async snapshot(input: { q?: string; group?: string; status?: string | number } = {}): Promise<Record<string, unknown>> {
    const q = typeof input.q === 'string' ? input.q.trim().toLowerCase().slice(0, 64) : '';
    const terms = q.split(/[^a-z0-9_]+/).filter(Boolean).slice(0, 4);
    const requestedGroup = typeof input.group === 'string' && /^[a-z_]{1,32}$/.test(input.group) ? input.group : undefined, requestedStatus = typeof input.status === 'number' || typeof input.status === 'string' ? String(input.status).toLowerCase() : undefined;
    const matches = (log: ActivityLog) => (!terms.length || terms.every(term => [log.method.toLowerCase(), log.route_group, log.source, String(log.status), log.status_group].some(value => value.includes(term)))) && (!requestedGroup || log.route_group === requestedGroup) && (!requestedStatus || String(log.status) === requestedStatus || log.status_group === requestedStatus);
    const summarize = (buckets: TrafficBucket[]) => { const totals = emptyCounts(), byRoute: Record<string, Counts> = {}, bySource: Record<string, Counts> = {}; for (const bucket of buckets) { for (const target of [totals, byRoute[bucket.route_group] ??= emptyCounts(), bySource[bucket.source] ??= emptyCounts()]) { target.requests += bucket.requests; target.errors += bucket.errors; for (const [key, value] of Object.entries(bucket.statuses)) target.statuses[key] = (target.statuses[key] ?? 0) + value; target.latency.count += bucket.latency.count; target.latency.total_ms += bucket.latency.total_ms; target.latency.max_ms = Math.max(target.latency.max_ms, bucket.latency.max_ms); for (const [key, value] of Object.entries(bucket.latency.buckets)) target.latency.buckets[key] = (target.latency.buckets[key] ?? 0) + value; } } return { totals, by_route_group: byRoute, by_source: bySource }; };
    const cumulative = summarize(this.processTraffic), history = summarize(this.traffic);
    const wallet = this.traffic.filter(row => row.route_group === 'wallet_verify').reduce((a, row) => { a.success += row.statuses['2xx'] ?? 0; a.failed += row.errors; return a; }, { success: 0, failed: 0 });
    return { schema_version: 'thot.operator-activity/1', observed_at: nowIso(this.clock), started_at: this.startedAt, history: { initialized_at: this.initializedAt, reset_at: this.initializedAt, retained_from: new Date(Math.max(this.clock() - RETENTION_MS, Date.parse(this.initializedAt))).toISOString(), retention_hours: 24, traffic_observed_only: true, persistence: this.persistence }, traffic: { counter_reset_at: this.startedAt, cumulative_since_process_start: cumulative, retained_24h: { ...history, minute_buckets: this.traffic } }, wallet_login_verification: wallet, resources: { interval_seconds: this.resourceIntervalMs / 1000, samples: this.resources }, auth_access: await this.accessCounts(), logs: { maximum_entries: MAX_LOGS, query_applied: terms.length > 0 || !!requestedGroup || !!requestedStatus, entries: this.logs.filter(matches).slice().reverse() } };
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; clearInterval(this.resourceTimer); clearInterval(this.persistTimer); await this.persist(); }
}
