import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../packages/market/src/bootstrap.ts';
import type { ThotChainConfig } from '../../packages/chain/thot.ts';
import { loadThotChainConfig } from '../../packages/chain/thot-config.ts';
import { ensure } from '../../packages/storage/src/index.ts';

type WorkerApplication = Pick<Awaited<ReturnType<typeof createApplication>>, 'inference' | 'service' | 'thot' | 'close'> & Partial<Pick<Awaited<ReturnType<typeof createApplication>>,'thotAnalytics'>>;
type CycleApplication = {
  inference: { sweep(): Promise<unknown> };
  service: { sweepRetention(): Promise<unknown>; runWorker(limit?: number): Promise<unknown> };
  thot: { sweepRetention(): Promise<unknown>; processSales?(): Promise<unknown> };
  thotAnalytics?: { refresh(): Promise<{complete?:boolean;configured?:boolean}> };
};

/** Shared by the standalone worker and local THOT rehearsal; no overlapping private-data jobs. */
export function startWorkerLoop(app: CycleApplication, options: { intervalMs?: number; onError?: (error: unknown) => void } = {}) {
  const intervalMs = options.intervalMs ?? 1000;
  ensure(Number.isSafeInteger(intervalMs) && intervalMs >= 1 && intervalMs <= 60_000, 'INVALID_WORKER_INTERVAL');
  const onError = options.onError ?? (() => process.stderr.write('THOT worker pending; inspect local reconciliation.\n'));
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, analyticsTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let analyticsPending: Promise<void> = Promise.resolve();
  // Read-only backfill is bounded and independent: an index outage cannot delay a
  // funded delivery or payout. Catch-up is faster than the transaction worker.
  function indexTick() {
    if(stopped||!app.thotAnalytics)return;
    analyticsPending=(async()=>{
      let delay=30_000;
      try{const status=await app.thotAnalytics!.refresh();if(status.configured!==false&&!status.complete)delay=3000;}
      catch{try{onError(new Error('THOT_ANALYTICS_REFRESH_PENDING'));}catch{/* Reporting cannot stop settlement. */}}
      finally{if(!stopped)analyticsTimer=setTimeout(indexTick,delay);}
    })();
  }
  function tick() {
    if (stopped) return;
    pending = (async () => {
      try {
        await app.inference.sweep();
        await app.service.sweepRetention();
        await app.thot.sweepRetention();
        await app.thot.processSales?.();
        await app.service.runWorker(20);
      } catch (error) {
        // A failed retention/chain check prevents later jobs in this cycle and retries later.
        try { onError(error); } catch { stopped = true; }
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    })();
  }
  tick();
  indexTick();
  return { close: async () => { stopped = true; clearTimeout(timer);clearTimeout(analyticsTimer); await Promise.all([pending,analyticsPending]); } };
}

export async function startStandaloneWorker(options: {
  env?: NodeJS.ProcessEnv;
  createApp?: (config: { databaseUrl: string; thot?: ThotChainConfig }) => Promise<WorkerApplication>;
} = {}) {
  const env = options.env ?? process.env;
  ensure(env.DATABASE_URL, 'STANDALONE_WORKER_REQUIRES_POSTGRES');
  const thot = await loadThotChainConfig(env.THOT_CHAIN_CONFIG_FILE);
  const app = await (options.createApp ?? createApplication)({ databaseUrl: env.DATABASE_URL, thot });
  const loop = startWorkerLoop(app);
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => { await loop.close(); await app.close(); })() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const running = await startStandaloneWorker();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void running.close().catch(() => { process.stderr.write('THOT worker shutdown failed.\n'); process.exitCode = 1; });
    });
  } catch {
    // Configuration files and database URLs can include sensitive operational details.
    process.stderr.write('THOT worker startup failed; check database and THOT chain configuration.\n');
    process.exitCode = 1;
  }
}
