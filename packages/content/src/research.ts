import {createHash} from 'node:crypto';
import {canonicalHash,canonicalJson} from '../../protocol/src/canonical.ts';
import {ensure} from '../../storage/src/errors.ts';
type Document=Record<string,any>;

export const RESEARCH_FORMAT='thot.research-package/1';
// Text files stay small and readable; other files travel base64-encoded inside the sealed package.
// shortcut: whole items live in one vault object (<8 MB sealed), so 4 MB per file / 5 MB per item; chunked storage lifts this (#123).
export const RESEARCH_LIMITS=Object.freeze({max_files:64,max_file_bytes:200_000,max_binary_file_bytes:4_000_000,max_total_bytes:5_000_000,max_json_bytes:7_200_000,max_relationships:128,max_description_chars:2000});
export const isResearch=(value:unknown):value is ResearchPackage=>!!value&&typeof value==='object'&&(value as Document).schema_version===RESEARCH_FORMAT;
export interface ResearchFile {path:string;media_type:string;role:'report'|'code'|'data'|'evidence';sha256:string;bytes:number;text?:string;base64?:string}
export interface ResearchPackage {schema_version:typeof RESEARCH_FORMAT;kind:'research';title:string;description?:string;entrypoint:string;files:ResearchFile[];relationships:Array<{from:string;relation:'generated_by'|'supports'|'references';to:string}>;provenance:{mode:'imported_declaration'}}
const plain=(v:unknown):v is Document=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Document,allowed:string[])=>ensure(Object.keys(v).every(k=>allowed.includes(k)),'UNSUPPORTED_PACKAGE_FIELD');
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
// Declared types must match the bytes; executables are never accepted as data.
const MAGIC:Record<string,(b:Buffer)=>boolean>={
  'image/png':b=>b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
  'image/jpeg':b=>b[0]===0xff&&b[1]===0xd8&&b[2]===0xff,
  'image/gif':b=>/^GIF8[79]a/.test(b.subarray(0,6).toString('latin1')),
  'image/webp':b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP',
  'application/pdf':b=>b.subarray(0,5).toString('latin1')==='%PDF-',
  'application/zip':b=>b[0]===0x50&&b[1]===0x4b,
  'application/gzip':b=>b[0]===0x1f&&b[1]===0x8b,
  'application/vnd.apache.parquet':b=>b.subarray(0,4).toString('latin1')==='PAR1'&&b.subarray(-4).toString('latin1')==='PAR1',
  'audio/wav':b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WAVE',
  'audio/mpeg':b=>b.subarray(0,3).toString('latin1')==='ID3'||(b[0]===0xff&&(b[1]!&0xe0)===0xe0),
  'video/mp4':b=>b.subarray(4,8).toString('latin1')==='ftyp',
};
export const isExecutable=(b:Buffer)=>b.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))||b.subarray(0,2).toString('latin1')==='MZ'
  ||[0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe].includes(b.length>=4?b.readUInt32BE(0):0)||b.subarray(0,2).toString('latin1')==='#!';
export function validateResearchPackage(value:unknown):ResearchPackage {
  ensure(plain(value),'INVALID_RESEARCH_PACKAGE');keys(value,['schema_version','kind','title','description','entrypoint','files','relationships','provenance']);
  ensure(value.schema_version===RESEARCH_FORMAT&&value.kind==='research','UNSUPPORTED_PACKAGE_PROFILE');
  ensure(typeof value.title==='string'&&value.title.trim().length>=3&&value.title.length<=160&&!/[\u0000-\u001f\u007f]/.test(value.title),'INVALID_PACKAGE_TITLE');
  ensure(value.description===undefined||typeof value.description==='string'&&value.description.length<=RESEARCH_LIMITS.max_description_chars,'INVALID_PACKAGE_DESCRIPTION');
  ensure(plain(value.provenance)&&value.provenance.mode==='imported_declaration'&&Object.keys(value.provenance).length===1,'INVALID_PACKAGE_PROVENANCE');
  ensure(Array.isArray(value.files)&&value.files.length>=1&&value.files.length<=RESEARCH_LIMITS.max_files,'PACKAGE_FILE_LIMIT',413);
  const paths=new Set<string>();let total=0;
  for(const f of value.files){
    ensure(plain(f),'INVALID_PACKAGE_FILE');keys(f,['path','media_type','role','sha256','bytes','text','base64']);
    ensure((f.text===undefined)!==(f.base64===undefined),'INVALID_PACKAGE_FILE');
    ensure(typeof f.path==='string'&&f.path.length<=180&&/^[A-Za-z0-9_-][A-Za-z0-9_.\/-]*$/.test(f.path)&&f.path.split('/').every((s:string)=>s!==''&&s!=='.'&&s!=='..'&&!s.endsWith('.')),'INVALID_PACKAGE_PATH');
    const normalized=f.path.toLowerCase();ensure(!paths.has(normalized),'DUPLICATE_PACKAGE_PATH');ensure([...paths].every(path=>!path.startsWith(normalized+'/')&&!normalized.startsWith(path+'/')),'PACKAGE_PATH_CONFLICT');paths.add(normalized);
    ensure(['report','code','data','evidence'].includes(f.role),'INVALID_PACKAGE_ROLE');
    if(f.base64!==undefined){
      ensure(typeof f.media_type==='string'&&f.media_type.length<=100&&/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(f.media_type),'UNSUPPORTED_PACKAGE_MEDIA');
      ensure(typeof f.base64==='string'&&f.base64.length<=Math.ceil(RESEARCH_LIMITS.max_binary_file_bytes/3)*4,'PACKAGE_FILE_TOO_LARGE',413);
      const raw=Buffer.from(f.base64,'base64');ensure(raw.toString('base64')===f.base64&&raw.length>0,'INVALID_PACKAGE_BASE64');
      ensure(raw.length<=RESEARCH_LIMITS.max_binary_file_bytes,'PACKAGE_FILE_TOO_LARGE',413);total+=raw.length;
      ensure(!isExecutable(raw),'EXECUTABLE_FILE_REFUSED');
      ensure(!Object.hasOwn(MAGIC,f.media_type.toLowerCase())||MAGIC[f.media_type.toLowerCase()]!(raw),'PACKAGE_MEDIA_MISMATCH');
      ensure(Number.isSafeInteger(f.bytes)&&f.bytes===raw.length&&typeof f.sha256==='string'&&/^[a-f0-9]{64}$/.test(f.sha256)&&digest(raw)===f.sha256,'PACKAGE_FILE_COMMITMENT_MISMATCH');
      continue;
    }
    const types:Record<string,RegExp>={'text/markdown':/\.md$/i,'text/plain':/\.txt$/i,'application/json':/\.json$/i,'text/csv':/\.csv$/i,'text/x-python':/\.py$/i,'text/javascript':/\.(?:js|mjs)$/i};
    ensure(typeof f.media_type==='string'&&Object.hasOwn(types,f.media_type)&&types[f.media_type]!.test(f.path),'UNSUPPORTED_PACKAGE_MEDIA');
    ensure(typeof f.text==='string'&&Buffer.from(f.text,'utf8').toString('utf8')===f.text&&!f.text.includes('\0'),'INVALID_PACKAGE_UTF8');
    const bytes=Buffer.byteLength(f.text);ensure(bytes<=RESEARCH_LIMITS.max_file_bytes,'PACKAGE_FILE_TOO_LARGE',413);total+=bytes;
    ensure(Number.isSafeInteger(f.bytes)&&f.bytes===bytes&&typeof f.sha256==='string'&&/^[a-f0-9]{64}$/.test(f.sha256)&&digest(f.text)===f.sha256,'PACKAGE_FILE_COMMITMENT_MISMATCH');
    if(f.media_type==='application/json'){try{JSON.parse(f.text);}catch{ensure(false,'INVALID_PACKAGE_JSON');}}
  }
  ensure(total<=RESEARCH_LIMITS.max_total_bytes,'PACKAGE_TOO_LARGE',413);
  // A main report is optional: '' means a plain data package.
  ensure(value.entrypoint===''||typeof value.entrypoint==='string'&&value.files.some((f:ResearchFile)=>f.path===value.entrypoint&&f.role==='report'&&['text/markdown','text/plain'].includes(f.media_type)),'INVALID_PACKAGE_ENTRYPOINT');
  ensure(Array.isArray(value.relationships)&&value.relationships.length<=RESEARCH_LIMITS.max_relationships,'PACKAGE_RELATIONSHIP_LIMIT');
  const exact=new Set(value.files.map((f:ResearchFile)=>f.path)),relations=new Set<string>();
  for(const r of value.relationships){ensure(plain(r),'INVALID_PACKAGE_RELATIONSHIP');keys(r,['from','to','relation']);ensure(exact.has(r.from)&&exact.has(r.to)&&r.from!==r.to&&['generated_by','supports','references'].includes(r.relation),'INVALID_PACKAGE_RELATIONSHIP');const key=canonicalJson(r);ensure(!relations.has(key),'DUPLICATE_PACKAGE_RELATIONSHIP');relations.add(key);}
  ensure(Buffer.byteLength(canonicalJson(value))<=RESEARCH_LIMITS.max_json_bytes,'PACKAGE_TOO_LARGE',413);
  return structuredClone(value) as ResearchPackage;
}
export function researchPreview(value:unknown){const p=validateResearchPackage(value);return {content_kind:'research',title:p.title,format:RESEARCH_FORMAT,source_label:'Research package (user supplied)',size_bytes:p.files.reduce((n,f)=>n+f.bytes,0),file_count:p.files.length,content_commitment:canonicalHash(p),entrypoint:p.entrypoint,files:p.files.map(({text,base64,...inventory})=>inventory),relationships:p.relationships,provenance:p.provenance,privacy_flags:[],warnings:['Imported files and source assertions are unverified. Code is not executed; references are not fetched. Review rights and private information in every file.']};}
export function selectResearchFiles(content:ResearchPackage,excluded:string[]):ResearchPackage {
  const p=validateResearchPackage(content);ensure(Array.isArray(excluded)&&excluded.length>0&&new Set(excluded).size===excluded.length&&excluded.every(path=>p.files.some(f=>f.path===path))&&!excluded.includes(p.entrypoint),'INVALID_PACKAGE_EXCLUSION');
  const omit=new Set(excluded);return validateResearchPackage({...p,files:p.files.filter(f=>!omit.has(f.path)),relationships:p.relationships.filter(r=>!omit.has(r.from)&&!omit.has(r.to))});
}
