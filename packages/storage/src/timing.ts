import type { TransactionTiming } from './index.ts';

export const TRANSACTION_TIMING_BOUNDS_MS = Object.freeze([1, 5, 10, 50, 100, 500, 1000, 5000]);
const durations = ['admission_ms', 'lock_wait_ms', 'hold_ms', 'total_ms'] as const;
type Duration = typeof durations[number];
export interface TimingAggregate {
  sum_ms: number;
  max_ms: number;
  /** Non-cumulative buckets, plus a final overflow bucket. */
  buckets: number[];
}
export type TransactionTimingSummary = {
  backend: TransactionTiming['backend'];
  outcome: TransactionTiming['outcome'];
  operation: NonNullable<TransactionTiming['operation']> | 'other';
  count: number;
} & Record<Duration, TimingAggregate>;

/** At most 24 series, independent of transaction/owner/content count. */
export class TransactionTimingCollector {
  private series = new Map<string, TransactionTimingSummary>();
  readonly observe = (timing: Readonly<TransactionTiming>): void => {
    if (!['pglite', 'postgres'].includes(timing.backend) || !['success', 'failure'].includes(timing.outcome)) return;
    if (durations.some(field => !Number.isFinite(timing[field]) || timing[field] < 0)) return;
    const operation = ['import', 'part', 'capture', 'projection', 'cleanup'].includes(timing.operation??'') ? timing.operation! : 'other';
    const key = `${timing.backend}:${timing.outcome}:${operation}`;
    let summary = this.series.get(key);
    if (!summary) {
      const empty = (): TimingAggregate => ({ sum_ms: 0, max_ms: 0, buckets: Array(TRANSACTION_TIMING_BOUNDS_MS.length + 1).fill(0) });
      summary = { backend: timing.backend, outcome: timing.outcome, operation, count: 0, admission_ms: empty(), lock_wait_ms: empty(), hold_ms: empty(), total_ms: empty() };
      this.series.set(key, summary);
    }
    summary.count++;
    for (const field of durations) {
      const value = timing[field], aggregate = summary[field];
      aggregate.sum_ms += value;
      aggregate.max_ms = Math.max(aggregate.max_ms, value);
      const index = TRANSACTION_TIMING_BOUNDS_MS.findIndex(bound => value <= bound);
      aggregate.buckets[index === -1 ? TRANSACTION_TIMING_BOUNDS_MS.length : index]++;
    }
  };
  snapshot(): { upper_bounds_ms: number[]; series: TransactionTimingSummary[] } {
    return {
      upper_bounds_ms: [...TRANSACTION_TIMING_BOUNDS_MS],
      series: [...this.series.values()].sort((a, b) => `${a.backend}:${a.outcome}:${a.operation}`.localeCompare(`${b.backend}:${b.outcome}:${b.operation}`)).map(summary => ({
        ...summary,
        ...Object.fromEntries(durations.map(field => [field, { ...summary[field], buckets: [...summary[field].buckets] }])),
      })),
    };
  }
  reset(): void { this.series.clear(); }
}
