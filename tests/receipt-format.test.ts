import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicKey, verify} from 'node:crypto';
import {cp, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {canonicalHash, canonicalJson} from '../packages/protocol/src/canonical.ts';
import {validateProvenanceReceipt} from '../packages/protocol/src/validation.ts';
import {createExample} from '../packages/provenance/examples/generate-receipt-format.ts';
// @ts-expect-error Standalone exported JavaScript intentionally has no repo dependencies.
import {verifyDirectory, verifyExample} from '../packages/provenance/examples/receipt-format-v1/verify.mjs';
// @ts-expect-error Standalone exported JavaScript intentionally has no repo dependencies.
import {canonicalHash as standaloneHash, canonicalJson as standaloneJson} from '../packages/provenance/examples/receipt-format-v1/canonical.mjs';

const directory = fileURLToPath(new URL('../packages/provenance/examples/receipt-format-v1/', import.meta.url));
const readJson = async (name:string) => JSON.parse(await readFile(join(directory,name),'utf8'));
// Independent fixed roots for the legacy/private and first branded domains.
const goldenRoot = createExample().example.bundle.format === 'thot.proxy-capture/2'
  ? 'b48a788e44c058eecb0b8132937f7107e7b0d8ec4e58a129eb57a76487564013'
  : '2add24d5ce1562afd2518f74bf85045ba35d84b17e2898e8735d7713c7a9127c';
const check = (fixture = createExample()) => verifyExample(fixture.example, (descriptor:{sequence:number}) => fixture.parts[descriptor.sequence-1]);

test('published golden files reproduce the current canonical /2 commitment and signature rules', async () => {
  const generated = createExample();
  assert.deepEqual(await readJson('example.json'),generated.example);
  assert.deepEqual(await readJson('locations.json'),generated.locations);
  for(const part of generated.parts) assert.deepEqual(await readJson(`parts/${part.sequence}.json`),part);
  assert.equal(generated.example.bundle.root,goldenRoot);
  const {root,...manifest} = generated.example.bundle;
  assert.equal(canonicalHash(manifest),root);
  for(const {commitment,...record} of generated.parts)assert.equal(canonicalHash(record),commitment);
  const {statement,signature,attestation} = generated.example.evidence;
  assert.equal(verify(null,Buffer.from(canonicalJson(statement)),createPublicKey({key:Buffer.from(attestation.statement.signing_key,'base64'),format:'der',type:'spki'}),Buffer.from(signature,'base64')),true);
  validateProvenanceReceipt(generated.example.capture_receipt);
  assert.equal(Object.hasOwn(attestation,'quote'),false);
  assert.doesNotMatch(JSON.stringify(generated),/PRIVATE KEY|private_key|upload_token/);
  const result=await verifyDirectory(directory);
  assert.equal(result.verified_parts,2);
  assert.equal(result.hardware_evidence,'ABSENT_UNVERIFIED');
  assert.equal(result.recorder_identity,'UNAUTHENTICATED');
});

test('standalone canonicalization matches production including ordering and rejected values', () => {
  for(const value of [{z:1,a:{β:'é',a:'\n"'}},[1,true,null,-0,1.5,1e-7],{large:123n},createExample().example]){
    assert.equal(standaloneJson(value),canonicalJson(value));
    assert.equal(standaloneHash(value),canonicalHash(value));
  }
  const cyclic:any={};cyclic.self=cyclic;
  for(const value of [undefined,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,new Date(),cyclic,Array(1),{[Symbol('x')]:1},Object.defineProperty({},'a',{enumerable:true,get(){throw Error('must not run');}})]){
    assert.throws(()=>canonicalJson(value));assert.throws(()=>standaloneJson(value));
  }
});

test('changed original bytes, missing parts, reordered descriptors, seal and signature fail', async () => {
  const changed=createExample();changed.parts[0].response_body_b64=Buffer.from('tampered').toString('base64');
  await assert.rejects(check(changed),/PART_COMMITMENT_MISMATCH/);
  const missing=createExample();missing.parts.pop();await assert.rejects(check(missing),/PART_MISSING/);
  const reordered=createExample();reordered.example.bundle.parts.reverse();
  await assert.rejects(check(reordered),/MANIFEST_ROOT_MISMATCH/);
  const {root,...manifest}=reordered.example.bundle;reordered.example.bundle.root=canonicalHash(manifest);
  await assert.rejects(check(reordered),/INVALID_PART_SEQUENCE/);
  const signature=createExample();signature.example.evidence.signature=Buffer.alloc(64).toString('base64');
  await assert.rejects(check(signature),/SEAL_SIGNATURE_INVALID/);
  const seal=createExample();seal.example.evidence.statement.bundle_hash='0'.repeat(64);
  await assert.rejects(check(seal),/SEAL_BINDING_MISMATCH/);
  const consent=createExample();consent.example.consent.save_privately=false;
  await assert.rejects(check(consent),/CONSENT_BINDING_MISMATCH/);
});

test('recomputing all unsigned hashes cannot repair a changed signed manifest', async () => {
  const fixture=createExample(),part=fixture.parts[0];part.response_body_b64=Buffer.from('tampered').toString('base64');
  const {commitment,...record}=part;part.commitment=canonicalHash(record);
  fixture.example.bundle.parts[0].commitment=part.commitment;
  const {root,...manifest}=fixture.example.bundle;fixture.example.bundle.root=canonicalHash(manifest);
  fixture.example.evidence.statement.session_root=fixture.example.bundle.root;
  fixture.example.evidence.statement.bundle_hash=canonicalHash(fixture.example.bundle);
  await assert.rejects(check(fixture),/SEAL_SIGNATURE_INVALID/);
});

test('unsigned summaries do not become authenticated and supplied quotes remain unverified', async () => {
  const fixture=createExample();fixture.example.capture_summary.exchanges=999;
  fixture.example.capture_receipt.claims=['An unsupported claim'];
  (fixture.example.evidence.attestation as any).quote='not-a-hardware-quote';
  const result=await check(fixture);
  assert.equal(result.integrity,'valid');
  assert.equal(result.unsigned_vault_receipt_and_summary,'NOT_AUTHENTICATED');
  assert.equal(result.hardware_evidence,'present_but_UNVERIFIED');
});

test('storage adapter relocation preserves identity; detached CLI needs only the exported directory', async t => {
  const temp=await mkdtemp(join(tmpdir(),'thot-receipt-format-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  await cp(directory,temp,{recursive:true});
  const before=await verifyDirectory(temp),locations=await readJson('locations.json');
  await rename(join(temp,'parts'),join(temp,'relocated'));
  for(const digest of Object.keys(locations))locations[digest]=locations[digest].replace('parts/','relocated/');
  await writeFile(join(temp,'locations.json'),JSON.stringify(locations));
  assert.deepEqual(await verifyDirectory(temp),before);
  const run=spawnSync(process.execPath,[join(temp,'verify.mjs'),temp],{cwd:tmpdir(),encoding:'utf8',env:{PATH:''}});
  assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),before);
  const fixture=createExample(),objects=new Map(fixture.parts.map(p=>['object-store/key-'+p.sequence,p]));
  const throughAdapter=await verifyExample(fixture.example,(p:{sequence:number})=>objects.get('object-store/key-'+p.sequence));
  assert.equal(throughAdapter.session_root,before.session_root);
  await rm(join(temp,'relocated','2.json'));
  await assert.rejects(verifyDirectory(temp),/PART_MISSING/);
  const failed=spawnSync(process.execPath,[join(temp,'verify.mjs'),temp],{encoding:'utf8'});
  assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stderr).integrity,'FAILED');
});
