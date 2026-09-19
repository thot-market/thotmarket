/** Encrypted availability format. Existing capture receipts remain authoritative. */
import {createHash,createHmac,hkdfSync,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {canonicalJson} from './canonical.mjs';
import {verifyEvidence,check,limits} from './verify.mjs';
const zip=promisify(gzip),unzip=promisify(gunzip);
export const chunkLimits={chunk:262144,object:300000,manifest:16*1024*1024,references:70000};
const format='thot.encrypted-chunks/1',hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,fields)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...fields].sort().join(','),'INVALID_CHUNK_FIELDS');
const hash=b=>createHash('sha256').update(b).digest('hex');
const gear=Array.from({length:256},(_,i)=>createHash('sha256').update('thot-chunk-experiment:'+i).digest().readUInt32LE());
function keys(key,salt){check(Buffer.isBuffer(key)&&key.length===32,'CHUNK_KEY_REQUIRED');check(typeof salt==='string'&&/^[a-f0-9]{32}$/.test(salt),'INVALID_ARCHIVE_SALT');const k=Buffer.from(hkdfSync('sha256',key,Buffer.from(salt,'hex'),format,64));return {enc:k.subarray(0,32),id:k.subarray(32)};}
function seal(raw,key,aad){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));return Buffer.concat([iv,c.update(raw),c.final(),c.getAuthTag()]);}
function open(raw,key,aad,max){check(Buffer.isBuffer(raw)&&raw.length>=28&&raw.length<=max,'CHUNK_OBJECT_LIMIT');const c=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));c.setAAD(Buffer.from(aad));c.setAuthTag(raw.subarray(-16));return Buffer.concat([c.update(raw.subarray(12,-16)),c.final()]);}
function* split(raw){let start=0,f=0;for(let i=0;i<raw.length;i++){f=((f<<1)+gear[raw[i]])>>>0;const n=i+1-start;if(i+1===raw.length||n>=chunkLimits.chunk||(n>=16384&&(f&65535)===0)){yield raw.subarray(start,i+1);start=i+1;f=0;}}}
const identity=(k,digest)=>createHmac('sha256',k.id).update(digest).digest('hex');
const aad=(salt,id)=>format+':'+salt+':'+id;
async function decodeChunk(blob,k,salt,id){const compressed=open(blob,k.enc,aad(salt,id),chunkLimits.object);const raw=await unzip(compressed,{maxOutputLength:chunkLimits.chunk});check(identity(k,hash(raw))===id,'CHUNK_ID_MISMATCH');return raw;}

/** get returns undefined only for an absent object; put must be atomic/create-only.
 * Reusing key+salt resumes a single archive. A fresh archive gets a fresh salt.
 * The returned envelope is the commit marker: do not publish it before completion. */
export async function packChunks({value,readPart,key,salt=randomBytes(16).toString('hex'),get,put,signal}){
 signal?.throwIfAborted();
 const k=keys(key,salt),parts=[];let total=0,refs=0,written=0,reused=0;
 check(Buffer.byteLength(canonicalJson(value))<=limits.metadata,'EXPORT_METADATA_LIMIT');
 const verification=await verifyEvidence(value,async d=>{
  const part=await readPart(d),raw=Buffer.from(canonicalJson(part)+'\n');total+=raw.length;
  check(raw.length<=limits.part&&total<=limits.total,'EXPORT_SIZE_LIMIT');const chunks=[];
  for(const bytes of split(raw)){
   signal?.throwIfAborted();
   check(++refs<=chunkLimits.references,'CHUNK_REFERENCE_LIMIT');const id=identity(k,hash(bytes));
   const prior=await get(id);
   if(prior!==undefined){const restored=await decodeChunk(prior,k,salt,id);check(restored.equals(bytes),'CHUNK_CONTENT_MISMATCH');reused++;}
   else{await put(id,seal(await zip(bytes,{level:1}),k.enc,aad(salt,id)));written++;}
   chunks.push({id,size:bytes.length});
  }
  parts.push({sequence:d.sequence,size:raw.length,sha256:hash(raw),chunks});return part;
 });
 signal?.throwIfAborted();
 const manifest=Buffer.from(canonicalJson({format:'thot.chunk-manifest/1',value,parts}));check(manifest.length<=chunkLimits.manifest,'CHUNK_MANIFEST_LIMIT');
 return {envelope:{format,salt,manifest:seal(manifest,k.enc,aad(salt,'manifest')).toString('base64')},verification,stats:{raw_bytes:total,chunk_references:refs,objects_written:written,objects_reused:reused}};
}

/** Reconstruct one bounded part at a time. onPart writes into an unpublished
 * staging destination; verification can fail after earlier callbacks succeed. */
export async function unpackChunks({envelope,key,get,onPart=async()=>{},signal}){
 signal?.throwIfAborted();
 check(envelope&&Object.keys(envelope).sort().join(',')==='format,manifest,salt'&&envelope.format===format,'INVALID_CHUNK_ENVELOPE');
 check(typeof envelope.manifest==='string'&&envelope.manifest.length<=Math.ceil((chunkLimits.manifest+28)/3)*4,'CHUNK_MANIFEST_LIMIT');
 const encoded=Buffer.from(envelope.manifest,'base64');check(encoded.toString('base64')===envelope.manifest,'INVALID_MANIFEST_BASE64');
 const k=keys(key,envelope.salt),manifest=JSON.parse(open(encoded,k.enc,aad(envelope.salt,'manifest'),chunkLimits.manifest+28));
 exact(manifest,['format','value','parts']);check(Buffer.byteLength(canonicalJson(manifest.value))<=limits.metadata,'EXPORT_METADATA_LIMIT');
 check(manifest.format==='thot.chunk-manifest/1'&&Array.isArray(manifest.parts)&&manifest.parts.length>0&&manifest.parts.length<=limits.parts,'INVALID_CHUNK_MANIFEST');
 let total=0,refs=0;
 for(const [i,p]of manifest.parts.entries()){
  exact(p,['sequence','size','sha256','chunks']);
  check(p.sequence===i+1&&Number.isSafeInteger(p.size)&&p.size>0&&p.size<=limits.part&&hex(p.sha256)&&Array.isArray(p.chunks)&&p.chunks.length>0,'INVALID_CHUNK_PART');
  let bytes=0;for(const c of p.chunks){exact(c,['id','size']);check(hex(c.id)&&Number.isSafeInteger(c.size)&&c.size>0&&c.size<=chunkLimits.chunk,'INVALID_CHUNK_REFERENCE');bytes+=c.size;}
  refs+=p.chunks.length;total+=p.size;check(bytes===p.size&&refs<=chunkLimits.references&&total<=limits.total,'CHUNK_EXPANSION_LIMIT');
 }
 check(manifest.value?.bundle?.parts?.length===manifest.parts.length,'CHUNK_PART_COUNT_MISMATCH');
 const verification=await verifyEvidence(manifest.value,async d=>{
  const p=manifest.parts[d.sequence-1],raw=Buffer.alloc(p.size);let offset=0;
  for(const c of p.chunks){signal?.throwIfAborted();const blob=await get(c.id);check(blob!==undefined,'CHUNK_MISSING');const chunk=await decodeChunk(blob,k,envelope.salt,c.id);check(chunk.length===c.size,'CHUNK_SIZE_MISMATCH');chunk.copy(raw,offset);offset+=chunk.length;}
  check(hash(raw)===p.sha256,'CHUNK_PART_HASH_MISMATCH');const part=JSON.parse(raw);check(raw.toString()===canonicalJson(part)+'\n','NON_CANONICAL_CHUNK_PART');await onPart(d,raw);return part;
 });
 signal?.throwIfAborted();
 return {value:manifest.value,verification,stats:{raw_bytes:total,chunk_references:refs}};
}
