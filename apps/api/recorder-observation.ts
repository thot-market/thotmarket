import type { RecorderPolicy } from '../../packages/capture/src/tee/attestation.ts';

const counters = ['active_sessions', 'pending_opens', 'active_requests', 'buffered_request_bytes', 'completed_results', 'completed_result_bytes'] as const;
const limitNames = ['maxActiveSessions', 'maxCompletedResults', 'maxActiveRequests', 'maxBufferedRequestBytes', 'maxCompletedResultBytes', 'completedResultTtlMs'] as const;
export interface RecorderObservation {
  id: 'model-recorder';
  status: 'ready' | 'draining' | 'unavailable' | 'unconfigured';
  observed_at: string;
  reason?: string;
  source: 'configured-recorder-health';
  attestation_verified: false;
  metrics?: Record<typeof counters[number], number> & { limits: Record<typeof limitNames[number], number> };
}

/** Health is operational telemetry, not a verified quote or historical receipt count. */
export function createRecorderObserver(fetcher: typeof fetch = fetch) {
  let cachedUrl: string | undefined;
  let expires = 0;
  let pending: Promise<RecorderObservation> | undefined;
  return (policy: RecorderPolicy | undefined): Promise<RecorderObservation> => {
    const base = { id: 'model-recorder' as const, observed_at: new Date().toISOString(), source: 'configured-recorder-health' as const, attestation_verified: false as const };
    if (!policy) return Promise.resolve({ ...base, status: 'unconfigured', reason: 'No recorder policy configured.' });
    let url: URL;
    try {
      url = new URL(policy.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error();
      url.pathname = '/health';
    } catch { return Promise.resolve({ ...base, status: 'unavailable', reason: 'Recorder health URL is not a supported HTTPS origin.' }); }
    if (pending && cachedUrl === url.href && Date.now() < expires) return pending;
    cachedUrl = url.href;
    expires = Date.now() + 10_000;
    pending = (async (): Promise<RecorderObservation> => {
      try {
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(2500), headers: { Accept: 'application/json' } });
        if (![200, 503].includes(response.status) || !response.body) {
          await response.body?.cancel();
          return { ...base, status: 'unavailable', reason: 'Recorder health request was not accepted.' };
        }
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 16_384) throw Error('RESPONSE_LIMIT');
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (value?.mode !== 'tee-recorder' || typeof value.ready !== 'boolean' || typeof value.draining !== 'boolean') throw Error();
        const metrics = {} as NonNullable<RecorderObservation['metrics']>;
        for (const name of counters) {
          if (!Number.isSafeInteger(value[name]) || value[name] < 0) throw Error();
          metrics[name] = value[name];
        }
        metrics.limits = {} as NonNullable<RecorderObservation['metrics']>['limits'];
        for (const name of limitNames) {
          if (!Number.isSafeInteger(value.limits?.[name]) || value.limits[name] <= 0) throw Error();
          metrics.limits[name] = value.limits[name];
        }
        if (value.ready !== (response.status === 200) || value.ready && value.draining) throw Error();
        return { ...base, status: value.draining ? 'draining' : value.ready ? 'ready' : 'unavailable', ...(!value.ready && !value.draining ? { reason: 'Recorder reports that it is not accepting work.' } : {}), metrics };
      } catch {
        return { ...base, status: 'unavailable', reason: 'Recorder health timed out or returned invalid telemetry.' };
      }
    })();
    return pending;
  };
}
export const observeRecorder = createRecorderObserver();
