import test from 'node:test';
import assert from 'node:assert/strict';
import { TransactionTimingCollector, type TransactionTiming } from '../packages/storage/src/index.ts';

const record: TransactionTiming = { backend: 'pglite', outcome: 'success', admission_ms: 1, lock_wait_ms: 10, hold_ms: 5001, total_ms: 5012 };
test('timing collector retains only bounded operation series, buckets and detached snapshots', () => {
  const collector = new TransactionTimingCollector();
  for (const backend of ['pglite', 'postgres'] as const) for (const outcome of ['success', 'failure'] as const) {
    for (const operation of [undefined,'import','part','capture','projection','cleanup'] as const)
      for (let i = 0; i < 1000; i++) collector.observe({ ...record, backend, outcome, operation });
  }
  const snapshot = collector.snapshot();
  assert.equal(snapshot.series.length, 24);
  for (const summary of snapshot.series) {
    assert.equal(summary.count, 1000);
    assert.equal(summary.admission_ms.sum_ms, 1000);
    assert.equal(summary.admission_ms.max_ms, 1);
    assert.equal(summary.admission_ms.buckets[0], 1000);
    assert.equal(summary.lock_wait_ms.buckets[2], 1000);
    assert.equal(summary.hold_ms.buckets.at(-1), 1000);
    assert.equal(summary.total_ms.buckets.length, snapshot.upper_bounds_ms.length + 1);
    assert.equal(summary.total_ms.buckets.reduce((a, b) => a + b, 0), summary.count);
    assert.deepEqual(Object.keys(summary).sort(), ['admission_ms', 'backend', 'count', 'hold_ms', 'lock_wait_ms', 'operation', 'outcome', 'total_ms']);
  }
  snapshot.series[0]!.admission_ms.buckets[0] = -1;
  snapshot.upper_bounds_ms[0] = -1;
  assert.equal(collector.snapshot().series[0]!.admission_ms.buckets[0], 1000);
  assert.equal(collector.snapshot().upper_bounds_ms[0], 1);
  collector.observe({ ...record, backend: 'arbitrary-user-label' as any });
  collector.observe({ ...record, total_ms: NaN });
  collector.observe({ ...record, hold_ms: -1 });
  collector.observe({ ...record, operation: 'private-user-label' as any });
  const other=collector.snapshot().series.find(summary=>summary.backend==='pglite'&&summary.outcome==='success'&&summary.operation==='other')!;
  assert.equal(other.count,1001);
  assert.equal(collector.snapshot().series.length,24);
  collector.reset();
  assert.deepEqual(collector.snapshot().series, []);
});
