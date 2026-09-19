import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DataDirectoryLease, LEASE_FILE, SHARED_LEASE_FILE} from '../packages/operations/src/lease.ts';
import {validateThotHost} from '../packages/runtime/src/thot-host.ts';
import {PrivacyIntegrations} from '../packages/market/src/integrations.ts';
import {startServer} from '../apps/api/server.ts';

test('missing chain configuration never enables a public development role selector', () => {
  for(const config of [
    {bind:'0.0.0.0'}, {bind:'::'}, {bind:'127.0.0.1',publicOrigin:'https://trial.example'},
  ]) for(const authConfigured of [false,true]) {
    assert.throws(()=>validateThotHost({...config,authConfigured}),/HOSTED_THOT_CONFIGURATION_REQUIRED/);
  }
  assert.throws(()=>validateThotHost({bind:'127.0.0.1',authConfigured:false,publicOrigin:'not-a-url'}),/INVALID_PUBLIC_ORIGIN/);
  assert.deepEqual(validateThotHost({bind:'127.0.0.1',authConfigured:false}),{hosted:false});
});

test('startup without a chain rejects public exposure before storage or KMS access', async t => {
  const root=await mkdtemp(join(tmpdir(),'security-host-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const values:Record<string,string|undefined>={THOT_CHAIN_CONFIG_FILE:undefined,THOT_TESTNET_OPERATOR_KEY_FILE:undefined,THOT_AUTH_MEMBERSHIPS_FILE:undefined,THOT_PRIVATE_ANVIL:undefined,THOT_BIND:'0.0.0.0',THOT_PUBLIC_ORIGIN:'https://trial.example',THOT_MASTER_KEY_SOURCE:'dstack',DSTACK_SOCKET:join(root,'does-not-exist.sock')};
  const prior=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  try{
    for(const [key,value]of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await assert.rejects(startServer({port:0,dataDir:join(root,'data')}),/HOSTED_THOT_CONFIGURATION_REQUIRED/);
    assert.deepEqual(await readdir(root),[]);
  }finally{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

test('foreign storage and unmarked state are preserved before a lease or key is written', async t => {
  const root=await mkdtemp(join(tmpdir(),'security-storage-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const marker=join(root,'.previous-storage.json');await writeFile(marker,'synthetic persisted state');
  await assert.rejects(DataDirectoryLease.acquire(root,{mode:'application'}),/INCOMPATIBLE_STORAGE_NAMESPACE/);
  assert.deepEqual(await readdir(root),['.previous-storage.json']);
  assert.equal(await readFile(marker,'utf8'),'synthetic persisted state');
  await rm(marker);await writeFile(join(root,'local-vault.key'),Buffer.alloc(32,7));
  await assert.rejects(DataDirectoryLease.acquire(root,{mode:'maintenance'}),/UNMARKED_STORAGE_REQUIRES_REVIEW/);
  assert.deepEqual(await readdir(root),['local-vault.key']);
});

test('shared and legacy leases both exclude writers and are released together', async t => {
  const root=await mkdtemp(join(tmpdir(),'security-lease-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const first=await DataDirectoryLease.acquire(root,{mode:'application'});
  try{
    assert.deepEqual((await readdir(root)).sort(),[LEASE_FILE,SHARED_LEASE_FILE].sort());
    await assert.rejects(DataDirectoryLease.acquire(root,{mode:'maintenance'}),/LEASE_HELD/);
    await first.assertHeld();
  }finally{await first.release();}
  await writeFile(join(root,LEASE_FILE),'legacy live writer');
  await assert.rejects(DataDirectoryLease.acquire(root,{mode:'application'}),/LEASE_HELD/);
  assert.deepEqual(await readdir(root),[LEASE_FILE]);
  assert.equal(await readFile(join(root,LEASE_FILE),'utf8'),'legacy live writer');
});

test('release assessment never sends trace text to an external privacy vendor, even with a legacy key', async t => {
  const root=await mkdtemp(join(tmpdir(),'security-privacy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('External network forbidden');};
  try{
    const privacy=new PrivacyIntegrations({development:true,vaultRoot:root,masterKey:Buffer.alloc(32,7),nearPrivacyKey:'synthetic-legacy-key'});
    for(const rights_confirmed of [false,true]){
      const result=await privacy.assess('synthetic-trace',{turns:[{role:'user',content:'Confidential strategy for a fictional acquisition.'}]},'general',{rights_confirmed,model_output_licensed:false});
      if(rights_confirmed){assert('privacy_filter' in result.scrub);assert.equal(result.scrub.privacy_filter.provider,'local');assert.equal(result.scrub.privacy_filter.status,'baseline_only');}
    }
    assert.equal(calls,0);
  }finally{globalThis.fetch=previous;}
});
