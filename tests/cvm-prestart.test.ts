import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createCvmPreMigrationSnapshot, CVM_DATABASE_SNAPSHOT_LIMITS, snapshotCapacityBudget, assertSnapshotCapacity, type SnapshotFilesystemCapacity } from '../scripts/cvm-prestart.ts';
import { listTree, type SnapshotEntry } from '../packages/operations/src/paths.ts';

const supportedVersions=['001','002','003','004','005','006','007'];
for (const version of ['003', '004', '005', '006']) {
  test(`CVM prestart snapshots schema ${version} before 007 and restores ciphertext under the same external key`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-'));
    const dataDir = join(root, 'data'), restored = join(root, 'restored');
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const masterKey = Buffer.alloc(32, 7);
      app = await createApplication({ dataDir, masterKey });
      const sealed = await app.privacy.seal('demo-user', { text: 'snapshot ciphertext' });
      // Remove all newer DDL and version rows so the fixture has a genuine old schema.
      await app.db.query('DROP TABLE trace_qc_runs,trace_qc_reviews');
      await app.db.query("DELETE FROM schema_versions WHERE version='007'");
      if(version!=='006'){
        await app.db.query('DROP TABLE storage_write_attempts,storage_command_claims');
        await app.db.query('ALTER TABLE outbox_events DROP COLUMN claim_token');
        await app.db.query("ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_status_check");
        await app.db.query("ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check CHECK(status IN ('pending','done','failed'))");
        await app.db.query("DELETE FROM schema_versions WHERE version='006'");
      }
      if(Number(version)<5){await app.db.query('DROP TABLE thot_records');await app.db.query("DELETE FROM schema_versions WHERE version='005'");}
      const capture = { status: 'SAVED', source_ref: sealed, capture_id: 'snapshot-capture' };
      if (version === '003') {
        await app.db.query('DROP TABLE agent_captures');
        await app.db.query("DELETE FROM schema_versions WHERE version='004'");
      } else {
        await app.db.transaction(tx => tx.insert('agent_captures', 'snapshot-capture', 'demo-user', capture));
      }
      await app.close(); app = undefined;
      if(version==='006'){
        await mkdir(join(dataDir,'.pre-migration-snapshots','before-006'),{recursive:true,mode:0o700});
        await writeFile(join(dataDir,'.pre-migration-snapshots','before-006','retained-marker'),'earlier snapshot remains intact',{mode:0o600});
        const ciphertext=await readFile(join(dataDir,'objects',sealed.objectId+'.sealed'));
        for(const [capacity,code]of [
          [async()=>({bsize:131072n,bavail:0n,ffree:100000n}),'PRESTART_SNAPSHOT_HEADROOM'],
          [async()=>({bsize:131072n,bavail:1000000n,ffree:0n}),'PRESTART_SNAPSHOT_INODE_HEADROOM'],
          [async()=>{throw Error('synthetic inaccessible statfs');},'PRESTART_CAPACITY_UNAVAILABLE'],
        ]as const){
          await assert.rejects(createCvmPreMigrationSnapshot(dataDir,{filesystemCapacity:async path=>{
            const entries=await readdir(path),temporary=entries.find(name=>name.startsWith('.before-007-'))!;
            assert(temporary);assert.deepEqual(await readdir(join(path,temporary)),[],'No payload is written before the capacity check.');
            return capacity();
          }}),new RegExp(code));
          assert.deepEqual(await readdir(join(dataDir,'.pre-migration-snapshots')),['before-006']);
          assert(!(await readdir(dataDir)).some(name=>['.thot-directory-lease','.trace-directory-lease'].includes(name)));
          assert.deepEqual(await readFile(join(dataDir,'objects',sealed.objectId+'.sealed')),ciphertext);
        }
        const beforeUpgrade=await PGlite.create(join(dataDir,'postgres'));
        try{assert.deepEqual((await beforeUpgrade.query<{version:string}>('SELECT version FROM schema_versions ORDER BY version')).rows.map(row=>row.version),supportedVersions.slice(0,6));}
        finally{await beforeUpgrade.close();}
      }
      const made = await createCvmPreMigrationSnapshot(dataDir);
      assert.equal(made.status, 'created'); const path = (made as any).path;
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
      assert.equal(manifest.before_migration, '007');
      assert.equal(manifest.key_custody, 'external');
      assert.deepEqual(manifest.schema_versions,supportedVersions.slice(0,Number(version)));
      assert(manifest.entries.some((entry: any) => entry.path === `objects/${sealed.objectId}.sealed`));
      assert(!manifest.entries.some((entry: any) => entry.path === 'local-vault.key'));
      assert.deepEqual(await readdir(join(path, 'payload', 'objects')), [sealed.objectId + '.sealed']);
      assert.equal((await createCvmPreMigrationSnapshot(dataDir,{filesystemCapacity:async()=>{throw Error('Existing snapshot must not request another copy budget');}})).status, 'existing');
      if(version==='006'){
        const digest=await readFile(join(path,'manifest.sha256'));
        await writeFile(join(path,'manifest.sha256'),'0'.repeat(64)+'\n');
        await assert.rejects(createCvmPreMigrationSnapshot(dataDir),/PRESTART_SNAPSHOT_MANIFEST_INVALID/);
        assert.deepEqual(await readFile(join(path,'manifest.sha256')),Buffer.from('0'.repeat(64)+'\n'),'Invalid snapshot is retained, not overwritten.');
        await writeFile(join(path,'manifest.sha256'),digest);
      }
      if(version==='006')assert.equal(await readFile(join(dataDir,'.pre-migration-snapshots','before-006','retained-marker'),'utf8'),'earlier snapshot remains intact');
      await cp(join(path, 'payload'), restored, { recursive: true }); await chmod(restored, 0o700);
      const raw = await PGlite.create(join(restored, 'postgres'));
      try {
        assert.equal((await raw.query<{ name: string | null }>("SELECT to_regclass('public.thot_records') AS name")).rows[0]!.name, Number(version)>=5?'thot_records':null);
        assert.equal((await raw.query<{ name: string | null }>("SELECT to_regclass('public.storage_write_attempts') AS name")).rows[0]!.name, version==='006'?'storage_write_attempts':null);
        for(const table of ['trace_qc_runs','trace_qc_reviews'])assert.equal((await raw.query<{ name: string | null }>('SELECT to_regclass($1) AS name',['public.'+table])).rows[0]!.name,null,'QC schema must not appear before the upgrade.');
      } finally { await raw.close(); }
      app = await createApplication({ dataDir: restored, masterKey });
      assert.deepEqual((await app.db.query('SELECT version FROM schema_versions ORDER BY version')).rows.map((row: any) => row.version),supportedVersions);
      assert.deepEqual(await app.privacy.open('demo-user', sealed), { text: 'snapshot ciphertext' });
      if (version !== '003') {
        const saved = await app.db.transaction(tx => tx.get('agent_captures', 'snapshot-capture', 'demo-user'));
        assert.deepEqual(saved.source_ref, sealed); assert.equal(saved.status, 'SAVED');
      }
      assert.deepEqual((await app.db.query('SELECT * FROM thot_records')).rows, []);
      for(const table of ['trace_qc_runs','trace_qc_reviews'])assert.deepEqual((await app.db.query('SELECT * FROM '+table)).rows,[],'Upgrade adds empty QC metadata tables.');
    } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('CVM prestart skips a database that already has migration 007', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-current-')), dataDir = join(root, 'data');
  try {
    const app = await createApplication({ dataDir, masterKey: Buffer.alloc(32, 9) }); await app.close();
    assert.deepEqual(await createCvmPreMigrationSnapshot(dataDir), { status: 'not-needed', reason: 'MIGRATION_007_ALREADY_APPLIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CVM prestart rejects a newer or incomplete migration history without making a snapshot', async () => {
  for (const kind of ['newer', 'missing-prefix']) {
    const root = await mkdtemp(join(tmpdir(), 'thot-cvm-prestart-unsupported-')), dataDir = join(root, 'data');
    try {
      const app = await createApplication({ dataDir, masterKey: Buffer.alloc(32, 9) });
      if (kind === 'newer') await app.db.query("INSERT INTO schema_versions(version,sha256) VALUES('008','future')");
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

test('snapshot budget uses all logical bytes, real block rounding, and vault plus inode reserves',()=>{
 const entries:SnapshotEntry[]=[
  {path:'postgres',type:'directory'},{path:'objects',type:'directory'},{path:'quarantine',type:'directory'},
  ...Array.from({length:4},(_,i)=>({path:'postgres/segment'+i,type:'file' as const,size:1024**3})),
  {path:'postgres/tail',type:'file',size:6*1024**2},{path:'objects/ciphertext',type:'file',size:256},
  {path:'quarantine/item',type:'file',size:1},{path:'.thot-storage.json',type:'file',size:128},
 ];
 const budget=snapshotCapacityBudget(entries,1000,131072n);
 assert.equal(budget.logicalBytes,4n*1024n**3n+6n*1024n**2n+256n+1n+128n);
 assert.equal(budget.copyBytes,4n*1073741824n+(48n+3n+5n+2n)*131072n);
 assert.equal(budget.reserveBytes,2214592512n);assert.equal(budget.requiredInodes,1039n);
 const byteBudget=snapshotCapacityBudget(entries,1000,1n);
 const exact={bsize:1n,bavail:byteBudget.requiredBytes,ffree:byteBudget.requiredInodes};
 assert.deepEqual(assertSnapshotCapacity(entries,1000,exact),byteBudget);
 assert.throws(()=>assertSnapshotCapacity(entries,1000,{...exact,bavail:exact.bavail-1n}),/PRESTART_SNAPSHOT_HEADROOM/);
 assert.throws(()=>assertSnapshotCapacity(entries,1000,{...exact,ffree:exact.ffree-1n}),/PRESTART_SNAPSHOT_INODE_HEADROOM/);
 for(const invalid of [null,{...exact,bsize:0n},{...exact,bsize:131072},{...exact,bavail:-1n},{...exact,ffree:-1n}])assert.throws(()=>assertSnapshotCapacity(entries,1000,invalid as unknown as SnapshotFilesystemCapacity),/PRESTART_CAPACITY_UNAVAILABLE/);
});

test('aggregate boundaries remain finite and independent of individual file limits',async()=>{
 const root=await mkdtemp(join(tmpdir(),'thot-small-snapshot-boundary-'));
 try{
  for(const name of ['a','b','c'])await writeFile(join(root,name),'1234');
  assert.equal((await listTree(root,{fileLimit:4,totalLimit:12})).length,3);
  await assert.rejects(listTree(root,{fileLimit:4,totalLimit:11}),/STORAGE_TOTAL_LIMIT/);
  await assert.rejects(listTree(root,{fileLimit:3,totalLimit:12}),/UNSAFE_STORAGE_FILE/);
  assert.deepEqual(CVM_DATABASE_SNAPSHOT_LIMITS,{fileLimit:1024**3,totalLimit:8*1024**3});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('database snapshot traversal accepts sparse aggregate one byte above the old 4 GiB cap',async()=>{
 const root=await mkdtemp(join(tmpdir(),'thot-persistent-snapshot-boundary-'));
 try{
  for(let i=0;i<5;i++){
   const file=await open(join(root,'segment'+i),'wx',0o600);
   try{await file.truncate(i===4?1:1024**3);}finally{await file.close();}
  }
  await assert.rejects(listTree(root,{fileLimit:1024**3,totalLimit:4*1024**3}),/STORAGE_TOTAL_LIMIT/);
  const entries=await listTree(root,CVM_DATABASE_SNAPSHOT_LIMITS);
  assert.equal(entries.reduce((sum,entry)=>sum+(entry.size??0),0),4*1024**3+1);
  let allocated=0n;for(let i=0;i<5;i++)allocated+=(await stat(join(root,'segment'+i),{bigint:true})).blocks*512n;
  const budget=snapshotCapacityBudget(entries,1000,131072n);
  assert(budget.copyBytes>allocated);assert(budget.logicalBytes===4294967297n);
  await assert.rejects(listTree(root),/UNSAFE_STORAGE_FILE/,'Generic upload/file limits are unchanged.');
  assert.throws(()=>assertSnapshotCapacity(entries,1000,{bsize:1n,bavail:allocated+budget.reserveBytes,ffree:100000n}),/PRESTART_SNAPSHOT_HEADROOM/);
 }finally{await rm(root,{recursive:true,force:true});}
});
