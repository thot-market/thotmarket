import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createDemoMandate, demoBuyer, demoOperator, demoUser, importDemo, policyInput } from '../packages/market/src/fixtures.ts';
import { canonicalJson } from '../packages/protocol/src/index.ts';
import { DataDirectoryLease, createOfflineBackup, inventoryOrphans, restoreOfflineBackup, restoreQuarantinedObjects, verifyOfflineBackup } from '../packages/operations/src/index.ts';
import { LEASE_FILE } from '../packages/operations/src/lease.ts';
import { LocalMasterKeyProvider, VaultStore } from '../packages/vault/src/index.ts';

const clock = () => new Date('2026-09-05T12:00:00Z');
async function temporary() { return realpath(await mkdtemp(join(tmpdir(), 'thot-storage-operations-'))); }
async function sold(dataDir: string) {
  const a = await createApplication({ dataDir, config: { clock } });
  await a.service.createPolicy(demoUser, 'storage-policy', policyInput(a.service));
  const imported = await importDemo(a.service, demoUser, 'coding', 'storage-import');
  await createDemoMandate(a.service, 'general', 'storage-mandate'); await a.service.runWorker();
  const candidate = (await a.service.candidates(demoUser))[0]!;
  const { release, ...preview } = await a.service.preview(demoUser, candidate.candidate_id);
  const sale = await a.service.authorize(demoUser, 'storage-authorize', { ...preview, payout_preference: 'inference_credit' });
  await a.service.runWorker();
  return { ...a, imported, sale };
}

test('application lifecycle holds exclusive directory lease; failed startup and normal close release it', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const a = await createApplication({ memory: true, dataDir });
    await assert.rejects(createApplication({ memory: true, dataDir }), /LEASE_HELD/);
    await assert.rejects(createOfflineBackup({ dataDir, backupDir: join(root, 'backup') }), /LEASE_HELD/);
    await a.close(); await a.close();
    await assert.rejects(createApplication({ memory: true, dataDir, config: { development: false } }), /PRODUCTION_READINESS/);
    const again = await createApplication({ memory: true, dataDir }); await again.close();
    assert(!(await readdir(dataDir)).includes(LEASE_FILE));
    await assert.rejects(createOfflineBackup({ dataDir, backupDir: join(root, 'backup') }), /OFFLINE_LOCAL_PGLITE_KEY_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline backup+restore preserve PGlite journals, licenses, THOT records, exact licensed delivery, and vault decryption', async () => {
  const root = await temporary(); const dataDir = join(root, 'data'); const restoredDir = join(root, 'restored');
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const a = await sold(dataDir); app = a;
    const delivery = await a.service.delivery(demoBuyer, a.sale.license_id);
    const journals = (await a.db.query('SELECT * FROM ledger_entries ORDER BY transaction_id,account_id')).rows;
    const licenses = (await a.db.query('SELECT * FROM licenses ORDER BY id')).rows;
    const rawRef = (await a.db.transaction(tx => tx.get('traces', a.imported.trace_id))).raw_ref;
    const original = await a.privacy.open(demoUser.id, rawRef);
    const thotRelease = { text: 'THOT licensed release survives backup independently of its source trace' };
    const thotRef = await a.privacy.seal(demoUser.id, thotRelease);
    await a.db.transaction(async tx => {
      await tx.insert('thot_records', 'backup-listing', demoUser.id, { kind: 'listing', active: false, release_ref: thotRef });
      await tx.insert('thot_records', 'backup-intent', demoBuyer.id, { kind: 'intent', listing_id: 'backup-listing', price_atoms: '12345678901234567890' });
      await tx.insert('thot_records', 'backup-delivery', demoBuyer.id, { kind: 'delivery_job', listing_id: 'backup-listing', status: 'confirmed' });
    });
    const thotRecords = (await a.db.query('SELECT * FROM thot_records ORDER BY id')).rows;
    await a.close(); app = undefined;
    const backup = await createOfflineBackup({ dataDir, backupDir: join(root, 'backup') });
    const verified = await verifyOfflineBackup({ backupDir: backup.backupDir, expectedManifestHash: backup.manifestHash });
    assert(backup.files > 0); assert(verified.manifest.entries.every(entry => entry.path !== LEASE_FILE));
    assert(verified.manifest.entries.some(entry => entry.path === `objects/${thotRef.objectId}.sealed`));
    assert.equal((await lstat(join(backup.backupDir, 'payload/local-vault.key'))).mode & 0o777, 0o600);
    await restoreOfflineBackup({ backupDir: backup.backupDir, dataDir: restoredDir, expectedManifestHash: backup.manifestHash });
    assert.deepEqual(await readFile(join(restoredDir, 'local-vault.key')), await readFile(join(dataDir, 'local-vault.key')));
    app = await createApplication({ dataDir: restoredDir, config: { clock } });
    assert.deepEqual((await app.db.query('SELECT * FROM ledger_entries ORDER BY transaction_id,account_id')).rows, journals);
    assert.deepEqual((await app.db.query('SELECT * FROM licenses ORDER BY id')).rows, licenses);
    assert.deepEqual((await app.db.query('SELECT * FROM thot_records ORDER BY id')).rows, thotRecords);
    assert.deepEqual(await app.privacy.open(demoUser.id, thotRef), thotRelease);
    assert.deepEqual(await app.privacy.open(demoUser.id, rawRef), original);
    assert.deepEqual(await app.service.delivery(demoBuyer, a.sale.license_id), delivery);
    assert.equal((await app.service.reconciliation(demoOperator)).balanced, true);
    await app.close(); app = undefined;
    await assert.rejects(restoreOfflineBackup({ backupDir: backup.backupDir, dataDir: restoredDir, expectedManifestHash: backup.manifestHash }), /EEXIST/);
    await assert.rejects(createOfflineBackup({ dataDir, backupDir: join(dataDir, 'nested-backup') }), /NESTED/);
  } finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('backup tampering and manifest path traversal reject before creating a restore destination', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const a = await createApplication({ dataDir }); await a.close();
    const backup = await createOfflineBackup({ dataDir, backupDir: join(root, 'backup') });
    await assert.rejects(verifyOfflineBackup({ backupDir: backup.backupDir, expectedManifestHash: '0'.repeat(64) }), /MANIFEST_HASH/);
    const keyPath = join(backup.backupDir, 'payload/local-vault.key'); const key = await readFile(keyPath);
    await writeFile(keyPath, Buffer.alloc(32, 7));
    const target = join(root, 'must-not-exist');
    await assert.rejects(restoreOfflineBackup({ backupDir: backup.backupDir, dataDir: target, expectedManifestHash: backup.manifestHash }), /CONTENT_MISMATCH/);
    await assert.rejects(lstat(target), /ENOENT/); await writeFile(keyPath, key);
    const manifestPath = join(backup.backupDir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.entries[0].path = '../escape'; const changed = canonicalJson(manifest); await writeFile(manifestPath, changed);
    await assert.rejects(restoreOfflineBackup({ backupDir: backup.backupDir, dataDir: target, expectedManifestHash: createHash('sha256').update(changed).digest('hex') }), /MANIFEST_PATH/);
    await assert.rejects(lstat(target), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symlinks, hardlinks, loose backup permissions, and unknown data entries fail safe without deletion', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const a = await createApplication({ dataDir }); const ref = await a.privacy.seal(demoUser.id, { text: 'synthetic' }); await a.close();
    const object = join(dataDir, 'objects', ref.objectId + '.sealed'); const alias = join(dataDir, 'objects', 'alias.sealed');
    await symlink(object, alias);
    await assert.rejects(createOfflineBackup({ dataDir, backupDir: join(root, 'symlink-backup') }), /SYMLINK/); await rm(alias);
    await link(object, alias);
    await assert.rejects(createOfflineBackup({ dataDir, backupDir: join(root, 'hardlink-backup') }), /UNSAFE_STORAGE_FILE/); await rm(alias);
    await writeFile(join(dataDir, 'unknown-file'), 'must be preserved', { mode: 0o600 });
    await assert.rejects(createOfflineBackup({ dataDir, backupDir: join(root, 'unknown-backup') }), /UNKNOWN_DATA/);
    assert.equal(await readFile(join(dataDir, 'unknown-file'), 'utf8'), 'must be preserved'); await rm(join(dataDir, 'unknown-file'));
    const backup = await createOfflineBackup({ dataDir, backupDir: join(root, 'backup') });
    await chmod(join(backup.backupDir, 'payload/local-vault.key'), 0o644);
    await assert.rejects(verifyOfflineBackup({ backupDir: backup.backupDir, expectedManifestHash: backup.manifestHash }), /INSECURE_BACKUP_PERMISSIONS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('orphan dry-run preserves all data; outbox/idempotency/inference/capture/THOT refs protect objects; quarantine is recoverable', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const a = await createApplication({ dataDir });
    const orphan = await a.privacy.seal(demoUser.id, { text: 'UNREFERENCED SYNTHETIC OBJECT' });
    const outbox = await a.privacy.seal(demoUser.id, { text: 'outbox only' });
    const idempotency = await a.privacy.seal(demoUser.id, { text: 'idempotency only' });
    const inference = await a.privacy.seal(demoUser.id, { text: 'inference only' });
    const capture = await a.privacy.seal(demoUser.id, { text: 'capture maintenance reference only' });
    const thot = await a.privacy.seal(demoUser.id, { text: 'THOT release retained for existing offers after unlisting' });
    await a.db.query('INSERT INTO outbox_events(id,owner_id,event_type,payload) VALUES($1,$2,$3,$4)', ['storage-outbox', demoUser.id, 'storage-test', { nested: { object_ref: outbox } }]);
    await a.db.query('INSERT INTO idempotency_keys(actor_id,key,request_hash,response) VALUES($1,$2,$3,$4)', [demoUser.id, 'storage-idempotency', 'hash', { nested: [idempotency] }]);
    await a.db.query('INSERT INTO inference_requests(id,owner_id,document) VALUES($1,$2,$3)', ['storage-inference', demoUser.id, { status: 'COMPLETED', prompt_ref: inference, output_ref: inference }]);
    await a.db.query('INSERT INTO agent_captures(id,owner_id,document) VALUES($1,$2,$3)', ['storage-capture', demoUser.id, { capture_id: 'storage-capture', status: 'AWAITING_UPLOAD', maintenance_fixture_ref: capture }]);
    await a.db.query('INSERT INTO thot_records(id,owner_id,document) VALUES($1,$2,$3)', ['storage-thot', demoUser.id, { kind: 'listing', active: false, release_ref: thot }]);
    await assert.rejects(inventoryOrphans({ dataDir }), /LEASE_HELD/); await a.close();
    await writeFile(join(dataDir, 'objects', 'malformed.sealed'), '{broken', { mode: 0o600 });
    await writeFile(join(dataDir, 'objects', 'unknown.file'), 'unknown data', { mode: 0o600 });
    const before = await readdir(join(dataDir, 'objects')); const inventory = await inventoryOrphans({ dataDir });
    assert.equal(inventory.mode, 'dry-run'); assert.deepEqual(await readdir(join(dataDir, 'objects')), before);
    assert.deepEqual(inventory.candidates.map(v => v.objectId), [orphan.objectId]); assert.equal(inventory.referencedPresent, 5); assert.equal(inventory.review.length, 2);assert.equal(inventory.quarantineBlocked,false);
    const quarantine = await inventoryOrphans({ dataDir, quarantine: true });
    assert.deepEqual(quarantine.quarantined, [orphan.objectId]); assert(quarantine.quarantineId);
    assert.equal(await readFile(join(dataDir, 'objects', 'unknown.file'), 'utf8'), 'unknown data');
    await assert.rejects(lstat(join(dataDir, 'objects', orphan.objectId + '.sealed')), /ENOENT/);
    const quarantinedFile = join(dataDir, 'quarantine', quarantine.quarantineId!, 'objects', orphan.objectId + '.sealed'); assert((await lstat(quarantinedFile)).isFile());
    assert.deepEqual((await restoreQuarantinedObjects({ dataDir, quarantineId: quarantine.quarantineId! })).restored, [orphan.objectId]);
    assert((await lstat(quarantinedFile)).isFile());
    await assert.rejects(restoreQuarantinedObjects({ dataDir, quarantineId: quarantine.quarantineId! }), /DESTINATION_EXISTS/);
    const vault = new VaultStore(join(dataDir, 'objects'), new LocalMasterKeyProvider(await readFile(join(dataDir, 'local-vault.key'))));
    assert.match((await vault.get({ ownerUserId: demoUser.id, objectId: orphan.objectId })).toString('utf8'), /UNREFERENCED SYNTHETIC/);
    assert.match((await vault.get({ ownerUserId: demoUser.id, objectId: thot.objectId })).toString('utf8'), /THOT release retained/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed THOT release references alone block all quarantine moves', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const a = await createApplication({ dataDir });
    const orphan = await a.privacy.seal(demoUser.id, { text: 'preserve while THOT references cannot be interpreted' });
    await a.db.query('INSERT INTO thot_records(id,owner_id,document) VALUES($1,$2,$3)',
      ['malformed-thot', demoUser.id, { kind: 'listing', release_ref: 'unknown-vault-format' }]);
    await a.close();
    const result = await inventoryOrphans({ dataDir, quarantine: true });
    assert.equal(result.quarantineBlocked, true); assert.deepEqual(result.quarantined, []);
    assert((await lstat(join(dataDir, 'objects', orphan.objectId + '.sealed'))).isFile());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown reference schema and malformed references disable quarantine globally', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const a = await createApplication({ dataDir }); const orphan = await a.privacy.seal(demoUser.id, { text: 'preserve' });
    await a.db.query('CREATE TABLE unknown_storage_references(id TEXT, secret_storage_path TEXT)');
    await a.db.query('INSERT INTO outbox_events(id,owner_id,event_type,payload) VALUES($1,$2,$3,$4)', ['bad-reference', demoUser.id, 'test', { prompt_ref: 'unrecognized-reference-format' }]);
    await a.close();
    const result = await inventoryOrphans({ dataDir, quarantine: true });
    assert.equal(result.quarantineBlocked, true); assert.deepEqual(result.quarantined, []);
    assert((await lstat(join(dataDir, 'objects', orphan.objectId + '.sealed'))).isFile());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lease token cannot be silently stolen and user symlink ancestors are rejected', async () => {
  const root = await temporary(); const dataDir = join(root, 'data');
  try {
    const lease = await DataDirectoryLease.acquire(dataDir, { mode: 'maintenance', create: true });
    await assert.rejects(DataDirectoryLease.acquire(dataDir, { mode: 'maintenance' }), /LEASE_HELD/);
    await lease.release();
    await symlink(dataDir, join(root, 'alias'));
    await assert.rejects(DataDirectoryLease.acquire(join(root, 'alias'), { mode: 'maintenance' }), /SYMLINK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
