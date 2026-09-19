import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJson} from '../packages/provenance/portable/canonical.mjs';
import {chunkLimits,packChunks,unpackChunks} from '../packages/provenance/portable/chunked.mjs';
import {packDirectory,unpackDirectory} from '../packages/provenance/portable/chunk-directory.mjs';
import {verifyDirectory} from '../packages/provenance/portable/verify.mjs';

const key=Buffer.from('11'.repeat(32),'hex');
const salt='22'.repeat(16);

async function fixture(){
 const example=JSON.parse(await readFile(new URL('../packages/provenance/examples/receipt-format-v1/example.json',import.meta.url),'utf8'));
 const parts=await Promise.all([1,2].map(async n=>JSON.parse(await readFile(new URL(`../packages/provenance/examples/receipt-format-v1/parts/${n}.json`,import.meta.url),'utf8'))));
 return {value:{format:'thot.capture-export/1',bundle:example.bundle,evidence:example.evidence},parts,consent:example.consent};
}
function memoryStore(){
 const objects=new Map();
 return {objects,get:async id=>objects.get(id),put:async(id,bytes)=>{assert.equal(objects.has(id),false,'put must remain create-only');objects.set(id,Buffer.from(bytes));}};
}
async function packed(options={}){
 const f=await fixture(),store=memoryStore();
 const result=await packChunks({value:f.value,readPart:async d=>f.parts[d.sequence-1],key,salt,get:store.get,put:store.put,...options});
 return {...f,store,result};
}
async function directories(t){
 const root=await mkdtemp(join(tmpdir(),'thot-chunks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),archive=join(root,'archive'),output=join(root,'output'),keyFile=join(root,'archive.key'),f=await fixture();
 await mkdir(join(source,'parts'),{recursive:true});
 await writeFile(join(source,'export.json'),canonicalJson(f.value)+'\n');
 await Promise.all(f.parts.map(p=>writeFile(join(source,'parts',p.sequence+'.json'),canonicalJson(p)+'\n')));
 await writeFile(keyFile,key);
 return {root,source,archive,output,keyFile,...f};
}

test('signed Ed25519/X25519 fixture round trips exactly through encrypted chunks',async()=>{
 const {value,parts,store,result}=await packed(),seen=[];
 assert.equal(result.verification.integrity,'VALID');
 assert.equal(result.verification.verified_parts,2);
 assert.equal(result.stats.objects_written,result.stats.chunk_references);
 const restored=await unpackChunks({envelope:result.envelope,key,get:store.get,onPart:async(d,raw)=>seen.push([d.sequence,Buffer.from(raw)])});
 assert.deepEqual(restored.value,value);
 assert.deepEqual(seen.map(([sequence,raw])=>[sequence,raw.toString()]),parts.map(p=>[p.sequence,canonicalJson(p)+'\n']));
 assert.equal(restored.verification.integrity,'VALID');
 assert.equal(restored.stats.raw_bytes,result.stats.raw_bytes);
});

test('packing the same archive again reuses every existing chunk',async()=>{
 const {value,parts,store,result:first}=await packed();
 const second=await packChunks({value,readPart:async d=>parts[d.sequence-1],key,salt,get:store.get,put:store.put});
 assert.deepEqual(second.envelope.salt,first.envelope.salt);
 assert.equal(second.stats.objects_written,0);
 assert.equal(second.stats.objects_reused,first.stats.chunk_references);
 assert.equal(store.objects.size,first.stats.objects_written);
});

test('an interrupted pack resumes with the same salt and reuses completed objects',async()=>{
 const {value,parts}=await fixture(),store=memoryStore();let writes=0;
 await assert.rejects(packChunks({value,readPart:async d=>parts[d.sequence-1],key,salt,get:store.get,put:async(id,bytes)=>{if(++writes===2)throw Error('INTERRUPTED');await store.put(id,bytes);}}),/INTERRUPTED/);
 assert.equal(store.objects.size,1);
 const resumed=await packChunks({value,readPart:async d=>parts[d.sequence-1],key,salt,get:store.get,put:store.put});
 assert.equal(resumed.stats.objects_reused,1);
 assert.equal(resumed.stats.objects_written,resumed.stats.chunk_references-1);
 assert.equal((await unpackChunks({envelope:resumed.envelope,key,get:store.get})).verification.integrity,'VALID');
});

test('unpack rejects missing, corrupt, oversized, and wrong-archive chunk objects',async()=>{
 const a=await packed(),ids=[...a.store.objects.keys()];
 const missing=new Map(a.store.objects);missing.delete(ids[0]);
 await assert.rejects(unpackChunks({envelope:a.result.envelope,key,get:async id=>missing.get(id)}),/CHUNK_MISSING/);
 const corrupt=new Map(a.store.objects),damaged=Buffer.from(corrupt.get(ids[0]));damaged[damaged.length-1]^=1;corrupt.set(ids[0],damaged);
 await assert.rejects(unpackChunks({envelope:a.result.envelope,key,get:async id=>corrupt.get(id)}));
 const oversized=new Map(a.store.objects);oversized.set(ids[0],Buffer.alloc(chunkLimits.object+1));
 await assert.rejects(unpackChunks({envelope:a.result.envelope,key,get:async id=>oversized.get(id)}),/CHUNK_OBJECT_LIMIT/);
 const b=await packed({salt:'33'.repeat(16)}),foreign=[...b.store.objects.values()][0];
 await assert.rejects(unpackChunks({envelope:a.result.envelope,key,get:async()=>foreign}));
});

test('unpack rejects the wrong key and tampered or malformed manifests',async()=>{
 const {store,result}=await packed();
 await assert.rejects(unpackChunks({envelope:result.envelope,key:Buffer.from('44'.repeat(32),'hex'),get:store.get}));
 const bytes=Buffer.from(result.envelope.manifest,'base64');bytes[Math.floor(bytes.length/2)]^=1;
 await assert.rejects(unpackChunks({envelope:{...result.envelope,manifest:bytes.toString('base64')},key,get:store.get}));
 await assert.rejects(unpackChunks({envelope:{...result.envelope,extra:true},key,get:store.get}),/INVALID_CHUNK_ENVELOPE/);
 await assert.rejects(unpackChunks({envelope:{...result.envelope,manifest:'A==='},key,get:store.get}),/INVALID_MANIFEST_BASE64/);
 const tooLarge='A'.repeat(Math.ceil((chunkLimits.manifest+28)/3)*4+1);
 await assert.rejects(unpackChunks({envelope:{...result.envelope,manifest:tooLarge},key,get:store.get}),/CHUNK_MANIFEST_LIMIT/);
});

test('pack enforces key, salt, and metadata limits before publishing an envelope',async()=>{
 const {value,parts}=await fixture(),store=memoryStore();
 await assert.rejects(packChunks({value,readPart:async d=>parts[d.sequence-1],key:Buffer.alloc(31),salt,get:store.get,put:store.put}),/CHUNK_KEY_REQUIRED/);
 await assert.rejects(packChunks({value,readPart:async d=>parts[d.sequence-1],key,salt:'bad',get:store.get,put:store.put}),/INVALID_ARCHIVE_SALT/);
 const huge={...value,consent:{padding:'x'.repeat(2_000_000)}};
 await assert.rejects(packChunks({value:huge,readPart:async d=>parts[d.sequence-1],key,salt,get:store.get,put:store.put}),/EXPORT_METADATA_LIMIT/);
});

test('pre-aborted chunk operations stop before reading source or archive objects',async()=>{
 const {value,parts,store,result}=await packed(),controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(packChunks({value,key,salt,signal:controller.signal,readPart:async()=>{calls++;return parts[0];},get:async()=>{calls++;},put:async()=>{calls++;}}),{name:'AbortError'});
 await assert.rejects(unpackChunks({envelope:result.envelope,key,signal:controller.signal,get:async()=>{calls++;}}),{name:'AbortError'});
 assert.equal(calls,0);
});

test('aborting after the first chunk write or read prevents completion',async()=>{
 const {value,parts}=await fixture(),packing=memoryStore(),packAbort=new AbortController();let puts=0;
 await assert.rejects(packChunks({value,key,salt,signal:packAbort.signal,readPart:async d=>parts[d.sequence-1],get:packing.get,put:async(id,bytes)=>{await packing.put(id,bytes);puts++;packAbort.abort();}}),{name:'AbortError'});
 assert.equal(puts,1);
 assert.equal(packing.objects.size,1);

 const complete=await packed(),unpackAbort=new AbortController();let gets=0,writtenParts=0;
 await assert.rejects(unpackChunks({envelope:complete.result.envelope,key,signal:unpackAbort.signal,get:async id=>{gets++;const blob=await complete.store.get(id);unpackAbort.abort();return blob;},onPart:async()=>{writtenParts++;}}),{name:'AbortError'});
 assert.equal(gets,1);
 assert.equal(writtenParts,1);
});

test('directory adapter round trips a signed fixture into a portable verified export',async t=>{
 const {source,archive,output,keyFile,value,parts}=await directories(t);
 const packed=await packDirectory(source,archive,keyFile);
 assert.equal(packed.verification.integrity,'VALID');
 assert.equal(packed.stats.objects_written,packed.stats.chunk_references);
 const unpacked=await unpackDirectory(archive,output,keyFile);
 assert.equal(unpacked.verification.integrity,'VALID');
 assert.deepEqual(JSON.parse(await readFile(join(output,'export.json'),'utf8')),value);
 for(const part of parts)assert.equal(await readFile(join(output,'parts',part.sequence+'.json'),'utf8'),canonicalJson(part)+'\n');
 const verified=await verifyDirectory(output);
 assert.equal(verified.integrity,'VALID');
 assert.equal(verified.verified_parts,parts.length);
 assert.equal((await stat(output)).mode&0o777,0o700);
 assert.equal((await stat(join(output,'parts'))).mode&0o777,0o700);
 for(const part of parts)assert.equal((await stat(join(output,'parts',part.sequence+'.json'))).mode&0o777,0o600);
});

test('directory adapter rejects overlapping pack and unpack paths',async t=>{
 const {root,source,archive,keyFile}=await directories(t);
 await assert.rejects(packDirectory(source,source,keyFile),/ARCHIVE_PATH_OVERLAP/);
 await assert.rejects(packDirectory(source,join(source,'archive'),keyFile),/ARCHIVE_PATH_OVERLAP/);
 await assert.rejects(packDirectory(source,root,keyFile),/ARCHIVE_PATH_OVERLAP/);
 await packDirectory(source,archive,keyFile);
 await assert.rejects(unpackDirectory(archive,archive,keyFile),/ARCHIVE_PATH_OVERLAP/);
 await assert.rejects(unpackDirectory(archive,join(archive,'output'),keyFile),/ARCHIVE_PATH_OVERLAP/);
 await assert.rejects(unpackDirectory(archive,root,keyFile),/ARCHIVE_PATH_OVERLAP/);
});

test('repeated directory pack resumes its draft and creates no duplicate objects',async t=>{
 const {source,archive,keyFile}=await directories(t),first=await packDirectory(source,archive,keyFile);
 const before=(await readdir(join(archive,'objects'))).sort(),draft=await readFile(join(archive,'draft.json'),'utf8');
 const second=await packDirectory(source,archive,keyFile),after=(await readdir(join(archive,'objects'))).sort();
 assert.deepEqual(after,before);
 assert.equal(await readFile(join(archive,'draft.json'),'utf8'),draft);
 assert.equal(second.stats.objects_written,0);
 assert.equal(second.stats.objects_reused,first.stats.chunk_references);
});

test('directory resume rejects changed source metadata',async t=>{
 const {source,archive,keyFile,value,consent}=await directories(t);await packDirectory(source,archive,keyFile);
 const objects=(await readdir(join(archive,'objects'))).sort(),envelope=await readFile(join(archive,'envelope.json'),'utf8');
 await writeFile(join(source,'export.json'),canonicalJson({...value,consent})+'\n');
 await assert.rejects(packDirectory(source,archive,keyFile),/RESUME_SOURCE_MISMATCH/);
 assert.deepEqual((await readdir(join(archive,'objects'))).sort(),objects);
 assert.equal(await readFile(join(archive,'envelope.json'),'utf8'),envelope);
 await assert.rejects(readFile(join(archive,'.writer-lock')),{code:'ENOENT'});
});

test('wrong-key directory import fails without publishing export.json',async t=>{
 const {root,source,archive,output,keyFile}=await directories(t);await packDirectory(source,archive,keyFile);
 const wrong=join(root,'wrong.key');await writeFile(wrong,Buffer.from('55'.repeat(32),'hex'));
 await assert.rejects(unpackDirectory(archive,output,wrong));
 await assert.rejects(readFile(join(output,'export.json')),{code:'ENOENT'});
 assert.equal((await stat(output)).mode&0o777,0o700);
 assert.equal((await stat(join(output,'parts'))).mode&0o777,0o700);
});

test('directory pack rejects an existing writer lock without disturbing it',async t=>{
 const {source,archive,keyFile}=await directories(t);await mkdir(archive);await writeFile(join(archive,'.writer-lock'),'another-writer');
 await assert.rejects(packDirectory(source,archive,keyFile),{code:'EEXIST'});
 assert.equal(await readFile(join(archive,'.writer-lock'),'utf8'),'another-writer');
 await assert.rejects(readFile(join(archive,'envelope.json')),{code:'ENOENT'});
});

test('directory pack rejects an objects-directory symlink escape',async t=>{
 const {root,source,archive,keyFile}=await directories(t),outside=join(root,'outside-objects');
 await mkdir(archive);await mkdir(outside);await symlink(outside,join(archive,'objects'));
 await assert.rejects(packDirectory(source,archive,keyFile),/ARCHIVE_OBJECT_PATH_ESCAPE/);
 assert.deepEqual(await readdir(outside),[]);
 await assert.rejects(readFile(join(archive,'envelope.json')),{code:'ENOENT'});
});
