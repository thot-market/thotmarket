import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {ensure,type Document} from '../../packages/storage/src/index.ts';
import {readBounded} from '../../packages/operations/src/paths.ts';
const stamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const text=(v:unknown,max=100)=>typeof v==='string'&&v.length<=max&&/^[a-zA-Z0-9 ._:/-]+$/.test(v);
function report(input:Document,fresh:boolean){
 ensure(input&&typeof input==='object'&&!Array.isArray(input)&&stamp(input.observed_at)&&(!fresh||Math.abs(Date.now()-Date.parse(input.observed_at))<120000)&&Array.isArray(input.cvms)&&input.cvms.length<=20,'INVALID_FLEET_REPORT');
 const names=new Set();const cvms=input.cvms.map((r:Document)=>{
  ensure(r&&typeof r==='object'&&!Array.isArray(r)&&text(r.name,64)&&/^[a-f0-9]{40}$/.test(r.app_id)&&!names.has(r.app_id)&&text(r.status,32)&&stamp(r.observed_at),'INVALID_FLEET_REPORT');names.add(r.app_id);
  ensure(r.compose_hash===null||/^[a-f0-9]{64}$/.test(r.compose_hash),'INVALID_FLEET_REPORT');
  const health=r.health;ensure(health&&['ready','unavailable','unconfigured'].includes(health.status)&&stamp(health.observed_at),'INVALID_FLEET_REPORT');
  const allocations=r.allocations;ensure(allocations&&['vcpu','memory_gib','disk_gib'].every(k=>Number.isFinite(allocations[k])&&allocations[k]>=0&&allocations[k]<=100000),'INVALID_FLEET_REPORT');
  const resourceKeys=['total_memory_bytes','available_memory_bytes','used_swap_bytes','uptime_seconds'];
  const resources=r.resources&&resourceKeys.every(k=>Number.isFinite(r.resources[k])&&r.resources[k]>=0)?Object.fromEntries(resourceKeys.map(k=>[k,r.resources[k]])):null;
  return {resources,name:r.name,app_id:r.app_id,status:r.status,compose_hash:r.compose_hash,observed_at:r.observed_at,health:{status:health.status,observed_at:health.observed_at},allocations:{vcpu:allocations.vcpu,memory_gib:allocations.memory_gib,disk_gib:allocations.disk_gib}};
 });
 return {schema_version:'thot.operator-fleet/1',source:'operator-fleet-collector',observed_at:input.observed_at,coverage:'Configured application IDs only; other projects excluded.',cvms};
}
/** Operator-submitted, provider-observed inventory. This is not hardware attestation. */
export class OperatorFleet {
 private path:string;private pending=Promise.resolve();
 constructor(dataDir:string){this.path=join(dataDir,'.operator-fleet.json');}
 async read(){try{const d=report(JSON.parse((await readBounded(this.path,256*1024)).toString('utf8')),false);return {...d,status:Date.now()-Date.parse(d.observed_at)>120000?'stale':'observed',age_seconds:Math.max(0,Math.floor((Date.now()-Date.parse(d.observed_at))/1000)),trust:'Authenticated operator collector; provider status and HTTPS health, not verified attestation.'};}catch{return {status:'unavailable',observed_at:null,cvms:[],reason:'No valid fleet collector report received.'};}}
 async update(input:Document){
 const sanitized=report(input,true);
 const write=this.pending.catch(()=>{}).then(async()=>{await writeFile(this.path+'.tmp',JSON.stringify(sanitized),{mode:0o600});await rename(this.path+'.tmp',this.path);});this.pending=write;await write;return this.read();
 }
}
