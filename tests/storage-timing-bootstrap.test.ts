import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { TransactionTimingCollector } from '../packages/storage/src/index.ts';

test('application forwards opt-in observer and benchmark phases can reset startup metrics', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'thot-timing-bootstrap-'));
  const collector = new TransactionTimingCollector();
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication({ dataDir, memory: true, onTransactionTiming: collector.observe });
    assert(collector.snapshot().series.some(summary => summary.count > 0), 'startup seeding uses observer');
    collector.reset();
    await app.db.transaction(async () => 'synthetic benchmark operation');
    const summary = collector.snapshot().series;
    assert.equal(summary.length, 1);
    assert.equal(summary[0]!.backend, 'pglite');
    assert.equal(summary[0]!.outcome, 'success');
    assert.equal(summary[0]!.operation, 'other');
    assert.equal(summary[0]!.count, 1);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
