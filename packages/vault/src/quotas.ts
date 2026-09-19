import {constants} from 'node:fs';
import {lstat, open, opendir, statfs} from 'node:fs/promises';
import {join} from 'node:path';

const MiB=1024*1024;
export const DEFAULT_VAULT_QUOTAS=Object.freeze({
  ownerBytes:128*MiB,ownerObjects:10_000,userBytes:2048*MiB,userObjects:100_000,
  journalBytes:64*MiB,journalObjects:50_000,minFreeBytes:2048*MiB,
});
export type VaultQuotas={-readonly[K in keyof typeof DEFAULT_VAULT_QUOTAS]:number};
export interface VaultQuotaOptions {quotas?:Partial<VaultQuotas>;/** Trusted test adapter; never populated from a request. */ availableBytes?:(root:string)=>Promise<number>;}
export interface StoredUsage {owner:string|undefined;bytes:number;journal:boolean;}
interface Total {bytes:number;objects:number;}
interface State {tail:Promise<void>;stamp?:string;entries:Map<string,StoredUsage>;owners:Map<string,Total>;user:Total;journal:Total;limits:VaultQuotas;}
const states=new Map<string,State>();
function register(root:string,limits:VaultQuotas){
 let state=states.get(root);
 if(!state){state={tail:Promise.resolve(),entries:new Map(),owners:new Map(),user:total(),journal:total(),limits:{...limits}};states.set(root,state);}
 for(const key of Object.keys(limits) as (keyof VaultQuotas)[])state.limits[key]=key==='minFreeBytes'?Math.max(state.limits[key],limits[key]):Math.min(state.limits[key],limits[key]);
 return state;
}
// Filesystem contents are authoritative. This mutex coordinates all instances
// in this process; the application's existing data-directory lease excludes
// other writer processes. It is not a distributed quota or filesystem lock.
const total=():Total=>({bytes:0,objects:0});
export const isJournalOwner=(owner:string)=>/^thot-operator:0x[0-9a-f]{64}$/.test(owner);
export function quotas(options:VaultQuotaOptions):VaultQuotas {
  const limits={...DEFAULT_VAULT_QUOTAS,...options.quotas};
  if(options.quotas&&Object.keys(options.quotas).some(k=>!(k in DEFAULT_VAULT_QUOTAS)))throw Error('INVALID_VAULT_QUOTA');
  for(const [key,value] of Object.entries(limits)){
    if(!Number.isSafeInteger(value)||value<1||value>(key==='minFreeBytes'?16*1024*MiB:DEFAULT_VAULT_QUOTAS[key as keyof VaultQuotas]))throw Error('INVALID_VAULT_QUOTA');
  }
  return limits;
}
async function stamp(root:string){
  const st=await lstat(root,{bigint:true});
  // A new directory entry can share the preceding mtime/ctime tick on some
  // filesystems. Include free inodes so an unaccounted partial file cannot
  // reuse a cached quota snapshot during that tick.
  let freeInodes:bigint;
  try{freeInodes=(await statfs(root,{bigint:true})).ffree;}
  catch{return undefined;} // Unknown stamp means rescan, never trust the cache.
  return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${freeInodes}`;
}
function add(state:State,name:string,entry:StoredUsage){
  // Legacy over-quota roots still get accurate totals without an unbounded heap index.
  if(state.entries.size<DEFAULT_VAULT_QUOTAS.userObjects+DEFAULT_VAULT_QUOTAS.journalObjects)state.entries.set(name,entry);
  const group=entry.journal?state.journal:state.user;group.bytes+=entry.bytes;group.objects++;
  if(entry.owner&&!entry.journal&&(state.owners.has(entry.owner)||state.owners.size<DEFAULT_VAULT_QUOTAS.userObjects)){const owner=state.owners.get(entry.owner)??total();owner.bytes+=entry.bytes;owner.objects++;state.owners.set(entry.owner,owner);}
}
async function scan(root:string,state:State){
  state.entries.clear();state.owners.clear();state.user=total();state.journal=total();
  const directory=await opendir(root);
  for await(const dirent of directory){
    const name=dirent.name;const st=await lstat(join(root,name));
    // Never follow links or nested directories. These cannot be produced by VaultStore.
    if(!st.isFile()||st.nlink!==1)throw Error('VAULT_ACCOUNTING_UNAVAILABLE');
    let owner:string|undefined,journal=false;
    if(/^[A-Za-z0-9_-]{1,128}\.sealed$/.test(name)&&st.size<=90_000_000){
      const file=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const current=await file.stat();if(current.ino!==st.ino||current.size!==st.size||!current.isFile())throw Error('VAULT_ACCOUNTING_UNAVAILABLE');
        try{const e=JSON.parse(await file.readFile('utf8'));
          if(e.version===1&&e.object_id+'.sealed'===name&&typeof e.owner_user_id==='string'&&e.owner_user_id.length>0&&e.owner_user_id.length<=200){
            owner=e.owner_user_id;journal=e.storage_class==='operator-journal'&&isJournalOwner(owner!);
          }
        }catch(error){if(error instanceof SyntaxError){/* Partial/corrupt files still consume the global intake quota. */}else throw error;}
      }finally{await file.close();}
    }
    add(state,name,{owner,bytes:st.size,journal});
  }
  state.stamp=await stamp(root);
}
export class VaultAccounting {
  readonly limits:VaultQuotas;
  private options:VaultQuotaOptions;
  constructor(options:VaultQuotaOptions={},root?:string){this.options=options;this.limits=quotas(options);if(root)register(root,this.limits);}
  async serialized<T>(root:string,work:(view:VaultAccountingView)=>Promise<T>):Promise<T>{
    // Register a stricter policy before waiting for another writer. Stores also
    // register their normalized root at construction, before async path reads.
    const state=register(root,this.limits);
    const previous=state.tail;let done!:()=>void;state.tail=new Promise<void>(r=>{done=r;});await previous;
    try{
      // A second instance cannot silently weaken an already-active root's intake policy.
      for(const key of Object.keys(this.limits) as (keyof VaultQuotas)[])state.limits[key]=key==='minFreeBytes'?Math.max(state.limits[key],this.limits[key]):Math.min(state.limits[key],this.limits[key]);
      const currentStamp=await stamp(root);
      if(!currentStamp||state.stamp!==currentStamp)await scan(root,state);
      const view=new VaultAccountingView(root,state,this.options.availableBytes);
      return await work(view);
    }finally{done();}
  }
}
export class VaultAccountingView {
  private root:string;private state:State;private availableBytes?:VaultQuotaOptions['availableBytes'];
  constructor(root:string,state:State,availableBytes?:VaultQuotaOptions['availableBytes']){this.root=root;this.state=state;this.availableBytes=availableBytes;}
  has(name:string){return this.state.entries.has(name);}
  async admit(owner:string,bytes:number,journal:boolean){
    const s=this.state,q=s.limits,o=s.owners.get(owner)??total(),group=journal?s.journal:s.user;
    if(journal){if(group.bytes+bytes>q.journalBytes||group.objects+1>q.journalObjects)throw Error('VAULT_JOURNAL_CAPACITY');}
    else{
      if(o.bytes+bytes>q.ownerBytes||o.objects+1>q.ownerObjects)throw Error('VAULT_OWNER_QUOTA');
      if(group.bytes+bytes>q.userBytes||group.objects+1>q.userObjects)throw Error('VAULT_GLOBAL_QUOTA');
    }
    let free:number;
    try{if(this.availableBytes)free=await this.availableBytes(this.root);else{const fs=await statfs(this.root,{bigint:true});const n=fs.bavail*fs.bsize;free=Number(n>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):n);}}
    catch{throw Error('VAULT_DISK_SPACE_UNAVAILABLE');}
    if(!Number.isSafeInteger(free)||free<0)throw Error('VAULT_DISK_SPACE_UNAVAILABLE');
    const journalHeadroom=journal?0:Math.max(0,q.journalBytes-s.journal.bytes);
    if(free-bytes-4096<q.minFreeBytes+journalHeadroom)throw Error('VAULT_DISK_HEADROOM');
  }
  async created(name:string,entry:StoredUsage){add(this.state,name,entry);this.state.stamp=await stamp(this.root);}
  async removed(name:string){
    const entry=this.state.entries.get(name);if(!entry){this.state.stamp=undefined;return;}
    const group=entry.journal?this.state.journal:this.state.user;group.bytes-=entry.bytes;group.objects--;
    if(entry.owner&&!entry.journal){const owner=this.state.owners.get(entry.owner);if(owner){owner.bytes-=entry.bytes;owner.objects--;if(!owner.objects)this.state.owners.delete(entry.owner);}}
    this.state.entries.delete(name);this.state.stamp=await stamp(this.root);
  }
  invalidate(){this.state.stamp=undefined;}
  usage(owner?:string){return {user:{...this.state.user},journal:{...this.state.journal},owner:{...(owner?this.state.owners.get(owner):undefined)??total()},limits:{...this.state.limits}};}
}
