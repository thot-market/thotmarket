import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { canonicalJson } from '../packages/protocol/src/index.ts';
import { DataDirectoryLease, readStorageFormat, STORAGE_FORMAT_FILE } from '../packages/operations/src/lease.ts';
import { assert, checkedDirectory, digestFile, listTree, readBounded, writeNew, type SnapshotEntry } from '../packages/operations/src/paths.ts';

const roots=[STORAGE_FORMAT_FILE,'postgres','objects','quarantine'];
// PostgreSQL relation segments may exceed the trace-object file limit.
// Snapshot them in bounded chunks; this does not relax trace upload limits.
const databaseFileLimit=1024*1024*1024;
const databaseTotalLimit=4*1024*1024*1024;
const currentMigration='006';
const supportedVersions=['001','002','003','004','005',currentMigration];
async function exists(path:string){try{await lstat(path);return true;}catch(error:any){if(error.code==='ENOENT')return false;throw error;}}
async function copy(source:string,destination:string,entries:SnapshotEntry[]){for(const entry of entries){const target=join(destination,entry.path),from=join(source,entry.path);if(entry.type==='directory')await mkdir(target,{mode:0o700});else{const copied=await digestFile(from,target,entry.path.startsWith('postgres/')?databaseFileLimit:undefined);assert(copied.size===entry.size&&copied.sha256===entry.sha256,'PRESTART_SOURCE_CHANGED');}}}

/** Cold snapshot for dstack KMS deployments. It copies ciphertext, never obtains or exports the KMS key. */
export async function createCvmPreMigrationSnapshot(dataDir=process.env.THOT_DATA_DIR??'/data'){
  const lease=await DataDirectoryLease.acquire(dataDir,{mode:'maintenance',create:true});
  try{
    if(!await exists(join(lease.dataDir,STORAGE_FORMAT_FILE)))return {status:'not-needed' as const,reason:'FRESH_STORAGE'};
    const format=await readStorageFormat(lease);assert(format.backend==='pglite'&&format.keyCustody==='external','CVM_EXTERNAL_PGLITE_REQUIRED');
    const postgres=await checkedDirectory(join(lease.dataDir,'postgres'));const db=await PGlite.create(postgres);let versions:string[];
    try{const present=(await db.query<{name:string|null}>("SELECT to_regclass('public.schema_versions') AS name")).rows[0]?.name;versions=present?(await db.query<{version:string}>('SELECT version FROM schema_versions ORDER BY version')).rows.map(row=>row.version):[];}finally{await db.close();}
    assert(versions.length>0&&versions.length<=supportedVersions.length&&versions.every((version,index)=>version===supportedVersions[index]),'UNSUPPORTED_PRESTART_SCHEMA');
    if(versions.includes(currentMigration))return {status:'not-needed' as const,reason:'MIGRATION_006_ALREADY_APPLIED'};
    const backupRoot=await checkedDirectory(join(lease.dataDir,'.pre-migration-snapshots'),true),final=join(backupRoot,'before-'+currentMigration);
    if(await exists(final)){await checkedDirectory(final);const encoded=await readBounded(join(final,'manifest.json'),8_000_000),expected=(await readBounded(join(final,'manifest.sha256'),100)).toString('utf8').trim();assert(/^[a-f0-9]{64}$/.test(expected)&&createHash('sha256').update(encoded).digest('hex')===expected,'PRESTART_SNAPSHOT_MANIFEST_INVALID');const prior=JSON.parse(encoded.toString('utf8'));assert(prior?.format==='thot.cvm-pre-migration-snapshot/1'&&prior.before_migration===currentMigration&&prior.key_custody==='external','PRESTART_SNAPSHOT_MANIFEST_INVALID');return {status:'existing' as const,path:final};}
    const temporary=join(backupRoot,'.before-'+currentMigration+'-'+randomUUID());await mkdir(temporary,{mode:0o700});let complete=false;
    try{
      const sourceEntries:SnapshotEntry[]=[];for(const root of roots)if(await exists(join(lease.dataDir,root))){if(root===STORAGE_FORMAT_FILE)sourceEntries.push({path:root,type:'file',...await digestFile(join(lease.dataDir,root))});else sourceEntries.push(...(await listTree(join(lease.dataDir,root),root==='postgres'?{fileLimit:databaseFileLimit,totalLimit:databaseTotalLimit}:{})).map(entry=>({...entry,path:root+'/'+entry.path})),{path:root,type:'directory'});}
      sourceEntries.sort((a,b)=>a.path.split('/').length-b.path.split('/').length||a.path.localeCompare(b.path));assert(sourceEntries.some(entry=>entry.path==='postgres/PG_VERSION'),'PGLITE_DATABASE_REQUIRED');
      await mkdir(join(temporary,'payload'),{mode:0o700});await copy(lease.dataDir,join(temporary,'payload'),sourceEntries);await lease.assertHeld();
      const manifest={format:'thot.cvm-pre-migration-snapshot/1',created_at:new Date().toISOString(),before_migration:currentMigration,key_custody:'external',key_requirement:'Restore under the same dstack app-id/KMS derivation policy; no decryption key is included.',schema_versions:versions,entries:sourceEntries};const encoded=canonicalJson(manifest);await writeNew(join(temporary,'manifest.json'),encoded);await writeNew(join(temporary,'manifest.sha256'),createHash('sha256').update(encoded).digest('hex')+'\n');await rename(temporary,final);complete=true;return {status:'created' as const,path:final,files:sourceEntries.filter(entry=>entry.type==='file').length};
    }finally{if(!complete)await rm(temporary,{recursive:true,force:true});}
  }finally{await lease.release();}
}

if(import.meta.url===`file://${process.argv[1]}`){assert(process.env.THOT_CVM_PRE_MIGRATION_SNAPSHOT==='true','CVM_PRESTART_SNAPSHOT_NOT_ENABLED');const result=await createCvmPreMigrationSnapshot();process.stdout.write(canonicalJson({status:result.status,...('reason'in result?{reason:result.reason}:{}),...('files'in result?{files:result.files}:{})})+'\n');}
