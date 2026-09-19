import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { OperatorActivity } from '../apps/api/operator-activity.ts';
import { OperatorFleet } from '../apps/api/operator-fleet.ts';
import { createEncryptedBackup, restoreEncryptedBackup } from '../packages/operations/src/encrypted-backup.ts';
import { createOfflineBackup, restoreOfflineBackup } from '../packages/operations/src/backup.ts';

for (const custody of ['external', 'local-file'] as const) {
  test(`cold ${custody} backup restores persisted operator metadata and rejects unreviewed files`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'thot-operator-recovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source'), restored = join(root, 'restored');
    const masterKey = custody === 'external' ? Buffer.alloc(32, 0x49) : undefined;
    const app = await createApplication({ dataDir: source, masterKey });
    const activity = await OperatorActivity.create({ dataDir: source, db: app.db, resourceIntervalMs: 0, persistIntervalMs: 0 });
    try {
      activity.record({ method: 'GET', route: '/v1/orders/private-order?token=private-token', status: 200, duration_ms: 17 });
      const now = new Date().toISOString();
      await new OperatorFleet(source).update({ observed_at: now, cvms: [{
        name: 'synthetic-recovery', app_id: 'a'.repeat(40), status: 'running', compose_hash: 'b'.repeat(64), observed_at: now,
        health: { status: 'ready', observed_at: now }, allocations: { vcpu: 1, memory_gib: 2, disk_gib: 20 },
      }] });
    } finally {
      // Match the service's shutdown order: finish telemetry before releasing the data lease.
      await activity.close();
      await app.close();
    }
    const names = ['operator-activity.v1.json', '.operator-fleet.json'];
    const expected = await Promise.all(names.map(name => readFile(join(source, name), 'utf8')));
    assert.doesNotMatch(expected[0]!, /private-order|private-token/);

    const backup = (label: string) => custody === 'external'
      ? createEncryptedBackup({ dataDir: source, archivePath: join(root, label + '.thot'), masterKey: masterKey!, appId: 'synthetic-operator-recovery' })
      : createOfflineBackup({ dataDir: source, backupDir: join(root, label) });
    for (const name of ['private-operator.env', ...(custody === 'local-file' ? ['operator-activity.v1.json.tmp', '.operator-fleet.json.tmp'] : [])]) {
      await writeFile(join(source, name), 'synthetic excluded material', { mode: 0o600 });
      await assert.rejects(backup('rejected-' + name), /UNKNOWN_.*ENTRY_REQUIRES_REVIEW/);
      await rm(join(source, name));
    }

    const saved = await backup('accepted');
    if ('archivePath' in saved) {
      await restoreEncryptedBackup({ archivePath: saved.archivePath, dataDir: restored, scratchDir: join(root, 'scratch'), masterKey: masterKey!, appId: 'synthetic-operator-recovery', expectedArchiveSha256: saved.archiveSha256 });
    } else {
      await restoreOfflineBackup({ backupDir: saved.backupDir, dataDir: restored, expectedManifestHash: saved.manifestHash });
    }
    for (const [index, name] of names.entries()) assert.equal(await readFile(join(restored, name), 'utf8'), expected[index]);
    const reopened = await createApplication({ dataDir: restored, masterKey });
    const restoredActivity = await OperatorActivity.create({ dataDir: restored, db: reopened.db, resourceIntervalMs: 0, persistIntervalMs: 0 });
    try {
      const snapshot = await restoredActivity.snapshot() as any;
      assert.equal(snapshot.traffic.retained_24h.totals.requests, 1);
      assert.equal(snapshot.traffic.cumulative_since_process_start.totals.requests, 0);
      assert.equal(snapshot.logs.entries[0].route_group, 'api');
      assert.equal((await new OperatorFleet(restored).read()).cvms[0].name, 'synthetic-recovery');
    } finally {
      await restoredActivity.close();
      await reopened.close();
    }

    // Reviewing a metadata filename must not allow an arbitrary subtree under that name.
    await rm(join(source, names[0]!));
    await mkdir(join(source, names[0]!), { mode: 0o700 });
    await writeFile(join(source, names[0]!, 'private-key'), 'synthetic excluded material', { mode: 0o600 });
    await assert.rejects(backup('metadata-directory'), /INVALID_OPERATOR_METADATA_ENTRY/);
  });
}
