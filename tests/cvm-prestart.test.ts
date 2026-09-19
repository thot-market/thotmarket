import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createCvmPreMigrationSnapshot } from '../scripts/cvm-prestart.ts';

for (const version of ['003', '004', '005']) {
  test(`CVM prestart snapshots schema ${version} before 006 and restores ciphertext under the same external key`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-'));
    const dataDir = join(root, 'data'), restored = join(root, 'restored');
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const masterKey = Buffer.alloc(32, 7);
      app = await createApplication({ dataDir, masterKey });
      const sealed = await app.privacy.seal('demo-user', { text: 'snapshot ciphertext' });
      // Remove all newer DDL and version rows so the fixture has a genuine old schema.
      await app.db.query('DROP TABLE storage_write_attempts,storage_command_claims');
      await app.db.query('ALTER TABLE outbox_events DROP COLUMN claim_token');
      await app.db.query("ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_status_check");
      await app.db.query("ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check CHECK(status IN ('pending','done','failed'))");
      await app.db.query("DELETE FROM schema_versions WHERE version='006'");
      if(version!=='005'){await app.db.query('DROP TABLE thot_records');await app.db.query("DELETE FROM schema_versions WHERE version='005'");}
      const capture = { status: 'SAVED', source_ref: sealed, capture_id: 'snapshot-capture' };
      if (version === '003') {
        await app.db.query('DROP TABLE agent_captures');
        await app.db.query("DELETE FROM schema_versions WHERE version='004'");
      } else {
        await app.db.transaction(tx => tx.insert('agent_captures', 'snapshot-capture', 'demo-user', capture));
      }
      await app.close(); app = undefined;
      const made = await createCvmPreMigrationSnapshot(dataDir);
      assert.equal(made.status, 'created'); const path = (made as any).path;
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
      assert.equal(manifest.before_migration, '006');
      assert.equal(manifest.key_custody, 'external');
      assert.deepEqual(manifest.schema_versions, version === '003' ? ['001', '002', '003'] : version==='004'?['001', '002', '003', '004']:['001','002','003','004','005']);
      assert(manifest.entries.some((entry: any) => entry.path === `objects/${sealed.objectId}.sealed`));
      assert(!manifest.entries.some((entry: any) => entry.path === 'local-vault.key'));
      assert.deepEqual(await readdir(join(path, 'payload', 'objects')), [sealed.objectId + '.sealed']);
      assert.equal((await createCvmPreMigrationSnapshot(dataDir)).status, 'existing');
      await cp(join(path, 'payload'), restored, { recursive: true }); await chmod(restored, 0o700);
      const raw = await PGlite.create(join(restored, 'postgres'));
      try {
        assert.equal((await raw.query<{ name: string | null }>("SELECT to_regclass('public.thot_records') AS name")).rows[0]!.name, version==='005'?'thot_records':null);
      } finally { await raw.close(); }
      app = await createApplication({ dataDir: restored, masterKey });
      assert.deepEqual((await app.db.query('SELECT version FROM schema_versions ORDER BY version')).rows.map((row: any) => row.version), ['001', '002', '003', '004', '005', '006']);
      assert.deepEqual(await app.privacy.open('demo-user', sealed), { text: 'snapshot ciphertext' });
      if (version !== '003') {
        const saved = await app.db.transaction(tx => tx.get('agent_captures', 'snapshot-capture', 'demo-user'));
        assert.deepEqual(saved.source_ref, sealed); assert.equal(saved.status, 'SAVED');
      }
      assert.deepEqual((await app.db.query('SELECT * FROM thot_records')).rows, []);
    } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('CVM prestart skips a database that already has migration 006', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-current-')), dataDir = join(root, 'data');
  try {
    const app = await createApplication({ dataDir, masterKey: Buffer.alloc(32, 9) }); await app.close();
    assert.deepEqual(await createCvmPreMigrationSnapshot(dataDir), { status: 'not-needed', reason: 'MIGRATION_006_ALREADY_APPLIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CVM prestart rejects a newer or incomplete migration history without making a snapshot', async () => {
  for (const kind of ['newer', 'missing-prefix']) {
    const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-unsupported-')), dataDir = join(root, 'data');
    try {
      const app = await createApplication({ dataDir, masterKey: Buffer.alloc(32, 9) });
      if (kind === 'newer') await app.db.query("INSERT INTO schema_versions(version,sha256) VALUES('007','future')");
      else await app.db.query("DELETE FROM schema_versions WHERE version='002'");
      await app.close();
      await assert.rejects(createCvmPreMigrationSnapshot(dataDir), /UNSUPPORTED_PRESTART_SCHEMA/);
      assert(!(await readdir(dataDir)).includes('.pre-migration-snapshots'));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('CVM prestart permits a fresh empty volume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-empty-'));
  try { assert.deepEqual(await createCvmPreMigrationSnapshot(join(root, 'data')), { status: 'not-needed', reason: 'FRESH_STORAGE' }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('database snapshot copying supports files above the trace limit without relaxing the default', async()=>{
 const {open,stat}=await import('node:fs/promises');
 const {digestFile,FILE_LIMIT}=await import('../packages/operations/src/paths.ts');
 const root=await mkdtemp(join(tmpdir(),'thot-large-db-'));
 try {
  const source=join(root,'database-segment'),target=join(root,'copied-segment');
  const f=await open(source,'wx',0o600);await f.truncate(FILE_LIMIT+1);await f.close();
  await assert.rejects(digestFile(source),/UNSAFE_STORAGE_FILE/);
  const result=await digestFile(source,target,1024*1024*1024);
  assert.equal(result.size,FILE_LIMIT+1);assert.equal((await stat(target)).size,FILE_LIMIT+1);
 }finally{await rm(root,{recursive:true,force:true});}
});
