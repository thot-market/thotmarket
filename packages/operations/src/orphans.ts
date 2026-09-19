import { PGlite } from '@electric-sql/pglite';
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '../../protocol/src/index.ts';
import { LocalMasterKeyProvider, VaultStore } from '../../vault/src/index.ts';
import { DataDirectoryLease } from './lease.ts';
import { requireLocalLayout } from './backup.ts';
import { assert, checkedDirectory, digestFile, ENTRY_LIMIT, readBounded, writeNew } from './paths.ts';

const knownTables = new Set(('schema_versions service_lock users user_wallets buyers buyer_members trace_bundles traces trace_objects provenance_receipts credential_receipts outcome_receipts rights_assessments scrub_receipts trace_features user_policies sale_authorizations mandates mandate_funding mandate_candidates assay_receipts release_artifacts licenses deliveries contributor_entitlements inference_credit_reservations market_purchase_orders token_transfers burn_allocations chain_transactions chain_event_cursor sale_settlements ledger_accounts ledger_transactions ledger_entries audit_events outbox_events idempotency_keys inference_requests inference_billing_evidence inference_billing_reviews auth_access operational_controls agent_captures thot_records storage_command_claims storage_write_attempts').split(' '));
const objectIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const specialColumns: Record<string, string[]> = {
  schema_versions: ['version', 'sha256', 'applied_at'], service_lock: ['id'],
  sale_settlements: ['id', 'owner_id', 'license_id', 'gross', 'direct_costs', 'contributor', 'burn', 'operator', 'document', 'created_at'],
  ledger_accounts: ['id', 'currency', 'kind', 'owner_id'], ledger_transactions: ['id', 'reference', 'currency', 'fingerprint', 'creation_transaction_id', 'created_at'],
  ledger_entries: ['id', 'transaction_id', 'account_id', 'amount'], audit_events: ['id', 'owner_id', 'event_type', 'payload', 'created_at'],
  outbox_events: ['id', 'owner_id', 'event_type', 'payload', 'attempts', 'status', 'available_at', 'last_error_code', 'created_at','claim_token'],
  storage_command_claims: ['actor_id','key','request_hash','attempt_id'],
  storage_write_attempts: ['id','owner_id','status','expires_at','objects','created_at'],
  idempotency_keys: ['actor_id', 'key', 'request_hash', 'response', 'created_at'],
};
interface References { ids: Set<string>; ambiguous: boolean; columnsScanned: number }

/** Conservative traversal of every known public JSONB document, response and outbox payload. */
async function collectReferences(db: PGlite): Promise<References> {
  const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows;
  let ambiguous = tables.some(row => !knownTables.has(row.table_name));
  if (!tables.some(row => row.table_name === 'schema_versions')) ambiguous = true;
  else if ((await db.query<{ version: string }>('SELECT version FROM schema_versions')).rows.some(row => !['001', '002', '003', '004', '005', '006'].includes(row.version))) ambiguous = true;
  const schema = (await db.query<{ table_name: string; column_name: string; data_type: string }>("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public'")).rows;
  for (const table of tables) {
    if (!knownTables.has(table.table_name)) continue;
    const actual = schema.filter(column => column.table_name === table.table_name);
    const expected = specialColumns[table.table_name] ?? ['id', 'owner_id', 'document', 'created_at'];
    if (actual.map(column => column.column_name).sort().join(',') !== [...expected].sort().join(',') || actual.some(column => ['document', 'payload', 'response', 'objects'].includes(column.column_name) && column.data_type !== 'jsonb')) ambiguous = true;
  }
  const columns = (await db.query<{ table_name: string; column_name: string }>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='jsonb' ORDER BY table_name,column_name")).rows;
  assert(columns.length <= 100, 'REFERENCE_SCHEMA_LIMIT'); const ids = new Set<string>(); let nodes = 0; let bytes = 0;
  function visit(value: any, depth = 0) {
    assert(++nodes <= 1_000_000 && depth <= 40, 'REFERENCE_SCAN_LIMIT');
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if ('objectId' in value) {
      if (typeof value.objectId === 'string' && objectIdPattern.test(value.objectId)) ids.add(value.objectId);
      else ambiguous = true;
      if (typeof value.ownerUserId !== 'string' || !value.ownerUserId || value.ownerUserId.length > 200) ambiguous = true;
    }
    for (const [key, child] of Object.entries(value)) {
      if (/(?:^|_)(?:object|raw|scrub|source|release|prompt|response|output)_ref$/.test(key) && child != null && (typeof child !== 'object' || !('objectId' in child))) ambiguous = true;
      visit(child, depth + 1);
    }
  }
  for (const column of columns) {
    assert(/^[a-z_][a-z0-9_]*$/.test(column.table_name) && /^[a-z_][a-z0-9_]*$/.test(column.column_name), 'UNSAFE_REFERENCE_SCHEMA');
    if (!knownTables.has(column.table_name) || !['document', 'payload', 'response', 'objects'].includes(column.column_name)) ambiguous = true;
    const rows = (await db.query<{ value: unknown }>(`SELECT "${column.column_name}" AS value FROM "${column.table_name}" LIMIT 100001`)).rows;
    assert(rows.length <= 100_000, 'REFERENCE_ROW_LIMIT');
    for (const row of rows) { bytes += Buffer.byteLength(JSON.stringify(row.value)); assert(bytes <= 64_000_000, 'REFERENCE_BYTES_LIMIT'); visit(row.value); }
  }
  return { ids, ambiguous, columnsScanned: columns.length };
}

/** Restore encrypted quarantine copies under the same lease; retain originals and refuse overwrite. */
export async function restoreQuarantinedObjects(input: { dataDir: string; quarantineId: string }): Promise<{ restored: string[] }> {
  assert(/^[a-f0-9-]{36}$/.test(input.quarantineId), 'INVALID_QUARANTINE_ID');
  const lease = await DataDirectoryLease.acquire(input.dataDir, { mode: 'maintenance' }); let key: Buffer | undefined;
  try {
    await requireLocalLayout(lease);
    const run = await checkedDirectory(join(lease.dataDir, 'quarantine', input.quarantineId));
    const manifest = JSON.parse((await readBounded(join(run, 'manifest.json'), 8_000_000)).toString('utf8'));
    assert(manifest?.format === 'thot.orphan-quarantine/1' && Array.isArray(manifest.objects) && manifest.objects.length <= ENTRY_LIMIT, 'INVALID_QUARANTINE_MANIFEST');
    const seen = new Set<string>();
    key = await readBounded(join(lease.dataDir, 'local-vault.key'), 32);
    const vault = new VaultStore(join(run, 'objects'), new LocalMasterKeyProvider(key), { maxBytes: 64_000_000 });
    await checkedDirectory(join(lease.dataDir, 'objects'), true);
    // Verify every available object and every destination before copying any file.
    for (const entry of manifest.objects) {
      assert(entry && objectIdPattern.test(entry.objectId) && !seen.has(entry.objectId) && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.size), 'INVALID_QUARANTINE_ENTRY'); seen.add(entry.objectId);
      const source = join(run, 'objects', entry.objectId + '.sealed'); const info = await digestFile(source);
      assert(info.sha256 === entry.sha256 && info.size === entry.size, 'QUARANTINE_CONTENT_MISMATCH');
      const envelope = JSON.parse((await readBounded(source, 90_000_000)).toString('utf8'));
      const content = await vault.get({ ownerUserId: envelope.owner_user_id, objectId: entry.objectId, role: 'pipeline' }); content.fill(0);
      try { await lstat(join(lease.dataDir, 'objects', entry.objectId + '.sealed')); throw new Error('QUARANTINE_RESTORE_DESTINATION_EXISTS'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    const restored: string[] = [];
    for (const entry of manifest.objects) {
      await lease.assertHeld();
      const info = await digestFile(join(run, 'objects', entry.objectId + '.sealed'), join(lease.dataDir, 'objects', entry.objectId + '.sealed'));
      assert(info.sha256 === entry.sha256 && info.size === entry.size, 'QUARANTINE_CONTENT_MISMATCH'); restored.push(entry.objectId);
    }
    return { restored };
  } finally { key?.fill(0); await lease.release(); }
}

export interface OrphanInventory {
  mode: 'dry-run' | 'quarantine'; referencedObjectCount: number; referenceColumnsScanned: number;
  referencedPresent: number; missingReferenced: string[];
  candidates: Array<{ objectId: string; size: number; sha256: string }>;
  review: Array<{ name: string; reason: string }>;
  quarantineBlocked: boolean; quarantined: string[]; quarantineId?: string;
}

/** Never deletes permanently. Any ambiguous schema/reference disables all quarantine moves. */
export async function inventoryOrphans(input: { dataDir: string; quarantine?: boolean }): Promise<OrphanInventory> {
  const lease = await DataDirectoryLease.acquire(input.dataDir, { mode: 'maintenance' }); let db: PGlite | undefined; let key: Buffer | undefined;
  try {
    await requireLocalLayout(lease);
    // No application startup or migrate call: this inspects the schema already on disk.
    db = await PGlite.create(join(lease.dataDir, 'postgres'));
    const references = await collectReferences(db);
    const result: OrphanInventory = { mode: input.quarantine ? 'quarantine' : 'dry-run', referencedObjectCount: references.ids.size, referenceColumnsScanned: references.columnsScanned,
      referencedPresent: 0, missingReferenced: [], candidates: [], review: [], quarantineBlocked: references.ambiguous, quarantined: [] };
    const objectsPath = join(lease.dataDir, 'objects');
    try { await checkedDirectory(objectsPath); } catch (error: any) { if (error.code === 'ENOENT') { result.missingReferenced = [...references.ids].sort(); return result; } throw error; }
    const names = (await readdir(objectsPath)).sort(); assert(names.length <= ENTRY_LIMIT, 'OBJECT_INVENTORY_LIMIT');
    key = await readBounded(join(lease.dataDir, 'local-vault.key'), 32);
    const vault = new VaultStore(objectsPath, new LocalMasterKeyProvider(key), { maxBytes: 64_000_000 });
    const present = new Set<string>();
    for (const name of names) {
      const path = join(objectsPath, name); const stat = await lstat(path);
      const id = name.endsWith('.sealed') ? name.slice(0, -7) : '';
      if (!objectIdPattern.test(id) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) { result.review.push({ name, reason: 'UNKNOWN_OR_UNSAFE_OBJECT_ENTRY' }); continue; }
      present.add(id);
      if (references.ids.has(id)) { result.referencedPresent++; continue; }
      try {
        const envelope = JSON.parse((await readBounded(path, 90_000_000)).toString('utf8'));
        assert(envelope && Object.keys(envelope).sort().join(',') === 'ciphertext,key_id,nonce,object_id,owner_user_id,tag,version' && envelope.object_id === id && envelope.key_id === 'local-master-v1', 'UNKNOWN_VAULT_ENVELOPE');
        const content = await vault.get({ ownerUserId: envelope.owner_user_id, objectId: id, role: 'pipeline' }); content.fill(0);
        result.candidates.push({ objectId: id, ...await digestFile(path) });
      } catch { result.review.push({ name, reason: 'MALFORMED_OR_UNAUTHENTICATED_OBJECT_PRESERVED' }); }
    }
    result.missingReferenced = [...references.ids].filter(id => !present.has(id)).sort();
    if (!input.quarantine || references.ambiguous || !result.candidates.length) return result;
    await lease.assertHeld();
    // A second full scan is required even though the cooperating writer is excluded.
    const rechecked = await collectReferences(db);
    if (rechecked.ambiguous) { result.quarantineBlocked = true; return result; }
    result.candidates = result.candidates.filter(candidate => !rechecked.ids.has(candidate.objectId));
    if (!result.candidates.length) return result;
    const quarantineRoot = await checkedDirectory(join(lease.dataDir, 'quarantine'), true);
    const quarantineId = randomUUID(); const run = join(quarantineRoot, quarantineId);
    await mkdir(run, { mode: 0o700 }); await mkdir(join(run, 'objects'), { mode: 0o700 });
    await writeNew(join(run, 'manifest.json'), canonicalJson({ format: 'thot.orphan-quarantine/1', createdAt: new Date().toISOString(), objects: result.candidates }));
    result.quarantineId = quarantineId;
    for (const candidate of result.candidates) {
      await lease.assertHeld(); const source = join(objectsPath, candidate.objectId + '.sealed');
      const checked = await digestFile(source);
      assert(checked.size === candidate.size && checked.sha256 === candidate.sha256, 'ORPHAN_CHANGED_DURING_QUARANTINE');
      // The destination is in our exclusively created 0700 run directory. No user data
      // is overwritten, and the complete encrypted file remains available for recovery.
      await rename(source, join(run, 'objects', candidate.objectId + '.sealed'));
      result.quarantined.push(candidate.objectId);
    }
    await writeNew(join(run, 'complete.json'), canonicalJson({ format: 'thot.orphan-quarantine-complete/1', objectIds: result.quarantined }));
    return result;
  } finally { key?.fill(0); if (db) await db.close(); await lease.release(); }
}
