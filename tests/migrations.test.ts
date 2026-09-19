import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { Database, Transaction } from '../packages/storage/src/index.ts';
import { postJournal, reconcile } from '../packages/ledger/src/index.ts';

const firstSql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
const secondSql = await readFile(new URL('../migrations/002_inference.sql', import.meta.url), 'utf8');
const thirdSql = await readFile(new URL('../migrations/003_operations.sql', import.meta.url), 'utf8');
const fourthSql = await readFile(new URL('../migrations/004_agent_capture.sql', import.meta.url), 'utf8');
const fifthSql = await readFile(new URL('../migrations/005_thot.sql', import.meta.url), 'utf8');
const sixthSql = await readFile(new URL('../migrations/006_staged_storage.sql', import.meta.url), 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const versions = [{ version: '001', sha256: hash(firstSql) }, { version: '002', sha256: hash(secondSql) }, { version: '003', sha256: hash(thirdSql) }, { version: '004', sha256: hash(fourthSql) }, { version: '005', sha256: hash(fifthSql) }, { version: '006', sha256: hash(sixthSql) }];
test('published migration bytes remain compatible with existing databases', async () => {
  const names = ['001_initial.sql', '002_inference.sql', '003_operations.sql', '004_agent_capture.sql', '005_thot.sql', '006_staged_storage.sql'];
  const sql = [firstSql, secondSql, thirdSql, fourthSql, fifthSql, sixthSql];
  // The private tree projects THOT identifiers into the published THOT source.
  // The exported tree has already been projected and contains this suite manifest.
  const published = existsSync(new URL('../release/test-suites.json', import.meta.url))
    ? sql
    : (await import(new URL('../scripts/public-source-branding.mjs', import.meta.url).href) as {
      brandPublicFiles: (files: Array<{ path: string; bytes: Buffer }>) => Array<{ bytes: Buffer }>;
    }).brandPublicFiles(
      names.map((name, index) => ({ path: `migrations/${name}`, bytes: Buffer.from(sql[index]!) }))
    ).map(file => Buffer.from(file.bytes).toString('utf8'));
  assert.deepEqual(published.map((text, index) => ({ version: String(index + 1).padStart(3, '0'), sha256: hash(text) })), [
    { version: '001', sha256: '23fe231f15654bc4110482b9c9bef2048d3712f2b559c5d98a8d76f67376e814' },
    { version: '002', sha256: '21beb22b01a582f2d42bc45d6f20c284a3b3fefe544e4b8e696e2f96feb37cfe' },
    { version: '003', sha256: 'c857144905f375a91c01f55e1776cde1906be6377a527432f6c239159dbddc29' },
    { version: '004', sha256: '334a94903c53dae306e287af7ee6b31c6ff1f410fc45398c98673a47170de80c' },
    { version: '005', sha256: '0e82cf32e92b2f2af0dcf916ba1dcb8d944d6499a05f53bbd0f87fe1385f3852' },
    { version: '006', sha256: '2a70ccc5cbe8d68cd494e850a76ac22497e7b5834d3817d2316227ab6bdaa631' },
  ]);
});
async function directory(t: any) {
  const path = await mkdtemp(join(tmpdir(), 'thot-migration-review-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function seedV1(path: string) {
  const db = await PGlite.create(path);
  try {
    await db.exec(firstSql);
    await db.query('INSERT INTO schema_versions(version,sha256) VALUES($1,$2)', ['001', hash(firstSql)]);
    await db.transaction(async connection => {
      const tx = new Transaction(connection);
      await tx.insert('users', 'migration-user', 'migration-user', { display_name: 'Existing private user', version: 1 });
      await postJournal(tx, 'migration-funded-credit', 'USD', [
        { account: 'ASSET:cash', owner: 'network', amount: 12345n },
        { account: 'LIABILITY:contributor_inference_credit', owner: 'migration-credit', amount: -12345n },
      ]);
      await tx.audit('migration-user', 'ExistingAudit', { preserved: true });
      await connection.query('INSERT INTO idempotency_keys(actor_id,key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)',
        ['migration-user', 'existing-command', 'old-hash', JSON.stringify({ existing: true })]);
    });
  } finally { await db.close(); }
}
async function oldRecords(db: Database | PGlite) {
  return {
    user: (await db.query('SELECT id,owner_id,document FROM users ORDER BY id')).rows,
    journals: (await db.query('SELECT id,reference,currency,fingerprint FROM ledger_transactions ORDER BY id')).rows,
    entries: (await db.query('SELECT id,transaction_id,account_id,amount::text FROM ledger_entries ORDER BY id')).rows,
    audit: (await db.query('SELECT id,owner_id,event_type,payload FROM audit_events ORDER BY id')).rows,
    idempotency: (await db.query('SELECT actor_id,key,request_hash,response FROM idempotency_keys ORDER BY actor_id,key')).rows,
  };
}

test('fresh database applies exactly ordered checksummed migrations and restart does not reapply them', async t => {
  const dataDir = await directory(t); let db = await Database.open({ dataDir });
  try {
    assert.deepEqual((await db.query('SELECT version,sha256 FROM schema_versions ORDER BY version')).rows, versions);
    const applied = (await db.query('SELECT version,applied_at FROM schema_versions ORDER BY version')).rows;
    await db.close(); db = await Database.open({ dataDir });
    assert.deepEqual((await db.query('SELECT version,applied_at FROM schema_versions ORDER BY version')).rows, applied);
    assert.equal((await db.query("SELECT to_regclass('public.inference_requests') AS name")).rows[0]!.name, 'inference_requests');
    assert.equal((await db.query("SELECT to_regclass('public.thot_records') AS name")).rows[0]!.name, 'thot_records');
  } finally { await db.close(); }
});

test('004 to 005 preserves existing capture documents and durable records, then persists THOT release references', async t => {
  const dataDir = await directory(t); await seedV1(dataDir);
  const raw = await PGlite.create(dataDir);
  let before: Awaited<ReturnType<typeof oldRecords>>; let captures: unknown[];
  try {
    for (const [version, sql] of [['002', secondSql], ['003', thirdSql], ['004', fourthSql]]) {
      await raw.exec(sql!);
      await raw.query('INSERT INTO schema_versions(version,sha256) VALUES($1,$2)', [version, hash(sql!)]);
    }
    await raw.query('INSERT INTO agent_captures(id,owner_id,document) VALUES($1,$2,$3)',
      ['pre-005-capture', 'migration-user', { status: 'SAVED', capture_id: 'pre-005-capture', source_ref: { objectId: 'historical-object', ownerUserId: 'migration-user' }, nested: { count: 7 } }]);
    assert.equal((await raw.query<{ name: string | null }>("SELECT to_regclass('public.thot_records') AS name")).rows[0]!.name, null);
    before = await oldRecords(raw);
    captures = (await raw.query('SELECT * FROM agent_captures ORDER BY id')).rows;
  } finally { await raw.close(); }
  let db = await Database.open({ dataDir });
  const listing = { kind: 'listing', active: false, release_ref: { ownerUserId: 'migration-user', objectId: 'licensed-copy' } };
  try {
    assert.deepEqual(await oldRecords(db), before);
    assert.deepEqual((await db.query('SELECT * FROM agent_captures ORDER BY id')).rows, captures);
    assert.deepEqual((await db.query('SELECT version,sha256 FROM schema_versions ORDER BY version')).rows, versions);
    await db.transaction(tx => tx.insert('thot_records', 'upgrade-listing', 'migration-user', listing));
    await db.close(); db = await Database.open({ dataDir });
    assert.deepEqual(await oldRecords(db), before);
    assert.deepEqual((await db.query('SELECT * FROM agent_captures ORDER BY id')).rows, captures);
    const saved = await db.transaction(tx => tx.get('thot_records', 'upgrade-listing', 'migration-user'));
    assert.deepEqual(saved.release_ref, listing.release_ref);
    assert.equal(saved.active, false);
    assert.equal((await db.transaction(tx => reconcile(tx))).balanced, true);
  } finally { await db.close(); }
});

test('001 to current incremental durable upgrade preserves users, journals, audit and command replay records byte-for-byte', async t => {
  const dataDir = await directory(t); await seedV1(dataDir);
  const original = await PGlite.create(dataDir); const before = await oldRecords(original); await original.close();
  let db = await Database.open({ dataDir });
  try {
    assert.deepEqual(await oldRecords(db), before);
    assert.deepEqual((await db.query('SELECT version,sha256 FROM schema_versions ORDER BY version')).rows, versions);
    const reconciliation = await db.transaction(tx => reconcile(tx)); assert.equal(reconciliation.balanced, true);
    await db.transaction(tx => tx.insert('inference_requests', 'upgrade-request', 'migration-user',
      { request_id: 'upgrade-request', reservation_id: 'upgrade-reservation', status: 'QUEUED', reserved_minor: '2' }));
    await db.close(); db = await Database.open({ dataDir });
    assert.deepEqual(await oldRecords(db), before);
    assert.equal((await db.transaction(tx => tx.get('inference_requests', 'upgrade-request'))).status, 'QUEUED');
    assert.equal((await db.transaction(tx => reconcile(tx))).commitment, reconciliation.commitment);
  } finally { await db.close(); }
});

test('checksum drift fails closed before pending DDL and can recover after the historical digest is restored', async t => {
  const dataDir = await directory(t); await seedV1(dataDir);
  let raw = await PGlite.create(dataDir); const before = await oldRecords(raw);
  await raw.query("UPDATE schema_versions SET sha256=$1 WHERE version='001'", ['0'.repeat(64)]); await raw.close();
  await assert.rejects(Database.open({ dataDir }), /MIGRATION_DRIFT/);
  raw = await PGlite.create(dataDir);
  try {
    assert.deepEqual(await oldRecords(raw), before);
    assert.equal((await raw.query<{ name: string | null }>("SELECT to_regclass('public.inference_requests') AS name")).rows[0]!.name, null);
    await raw.query("UPDATE schema_versions SET sha256=$1 WHERE version='001'", [hash(firstSql)]);
  } finally { await raw.close(); }
  const recovered = await Database.open({ dataDir });
  try { assert.deepEqual(await oldRecords(recovered), before); } finally { await recovered.close(); }
});

test('missing prefix and a database newer than the application are rejected without schema mutation', async t => {
  for (const kind of ['missing-prefix', 'newer'] as const) {
    const dataDir = join(await directory(t), kind); await seedV1(dataDir); const raw = await PGlite.create(dataDir);
    if (kind === 'missing-prefix') await raw.query("UPDATE schema_versions SET version='002'");
    else {
      await raw.query('INSERT INTO schema_versions(version,sha256) VALUES($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12)', ['002', hash(secondSql), '003', hash(thirdSql), '004', hash(fourthSql), '005', hash(fifthSql), '006', hash(sixthSql), '007', 'future']);
    }
    await raw.close(); await assert.rejects(Database.open({ dataDir }), kind === 'newer' ? /DATABASE_VERSION_NEWER/ : /MIGRATION_DRIFT/);
    const check = await PGlite.create(dataDir);
    try { assert.equal((await check.query<{ name: string | null }>("SELECT to_regclass('public.inference_requests') AS name")).rows[0]!.name, null); }
    finally { await check.close(); }
  }
});

test('partial migration DDL rolls back atomically and retry preserves the pre-upgrade money ledger', async t => {
  const dataDir = await directory(t); await seedV1(dataDir); let raw = await PGlite.create(dataDir);
  const before = await oldRecords(raw);
  // Force statement two to fail, after CREATE TABLE has run inside the migration transaction.
  await raw.exec('CREATE TABLE migration_collision(id TEXT); CREATE INDEX inference_requests_owner_idx ON migration_collision(id);');
  await raw.close(); await assert.rejects(Database.open({ dataDir }), /already exists/);
  raw = await PGlite.create(dataDir);
  try {
    assert.deepEqual(await oldRecords(raw), before);
    assert.deepEqual((await raw.query('SELECT version FROM schema_versions ORDER BY version')).rows, [{ version: '001' }]);
    assert.equal((await raw.query<{ name: string | null }>("SELECT to_regclass('public.inference_requests') AS name")).rows[0]!.name, null);
    await raw.exec('DROP TABLE migration_collision;');
  } finally { await raw.close(); }
  const db = await Database.open({ dataDir });
  try { assert.deepEqual(await oldRecords(db), before); assert.equal((await db.transaction(tx => reconcile(tx))).balanced, true); }
  finally { await db.close(); }
});
