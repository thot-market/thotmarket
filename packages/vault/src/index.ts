import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { mkdir, lstat, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { canonicalJson, uuidv7 } from '../../protocol/src/index.ts';
import {VaultAccounting,isJournalOwner,type VaultQuotaOptions} from './quotas.ts';
export {DEFAULT_VAULT_QUOTAS,type VaultQuotas,type VaultQuotaOptions} from './quotas.ts';
import {FileCiphertextStore,type CiphertextStore} from './ciphertext-store.ts';
import type {RemoteAccounting} from './remote-accounting.ts';
export {FileCiphertextStore,CiphertextNotFoundError,type CiphertextStore} from './ciphertext-store.ts';

export interface KeyProvider { keyId: string; getObjectKey(input: { ownerUserId: string; objectId: string }): Promise<Buffer>; }
/** Local development custody. Production supplies a tenant-authorized KMS KeyProvider. */
export class LocalMasterKeyProvider implements KeyProvider {
  readonly keyId: string; private masterKey: Buffer;
  constructor(masterKey: Buffer, keyId = 'local-master-v1') {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32 || !keyId) throw new Error('INVALID_VAULT_MASTER_KEY');
    this.masterKey = Buffer.from(masterKey); this.keyId = keyId;
  }
  async getObjectKey(input: { ownerUserId: string; objectId: string }): Promise<Buffer> {
    return Buffer.from(hkdfSync('sha256', this.masterKey, Buffer.from('THOT-VAULT-v1'), Buffer.from(canonicalJson(input)), 32));
  }
}
export class MemoryKeyProvider extends LocalMasterKeyProvider { constructor() { super(randomBytes(32), 'ephemeral-development-v1'); } }

interface VaultEnvelope { version: 1; object_id: string; owner_user_id: string; key_id: string; storage_class?:'operator-journal'; nonce: string; tag: string; ciphertext: string; }
export interface VaultObjectRef { objectId: string; ownerUserId: string; }
function accountingRoot(root:string){
  let parent=root;const missing:string[]=[];
  for(;;){try{return join(realpathSync(parent),...missing);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT'||dirname(parent)===parent)throw error;
    missing.unshift(basename(parent));parent=dirname(parent);
  }}
}

export class VaultStore {
  private root?: string; private store: CiphertextStore; private keyProvider: KeyProvider; private maxBytes: number;
  private accounting:VaultAccounting;
  private remoteAccounting?:RemoteAccounting;
  constructor(storage: string | CiphertextStore, keyProvider: KeyProvider, options: { maxBytes?: number; remoteAccounting?:RemoteAccounting } & VaultQuotaOptions = {}) {
    if(typeof storage!=='string'&&!(storage instanceof FileCiphertextStore)&&!options.remoteAccounting)throw Error('VAULT_ACCOUNTING_UNSUPPORTED');
    if(options.remoteAccounting&&(typeof storage==='string'||storage instanceof FileCiphertextStore))throw Error('REMOTE_ACCOUNTING_REQUIRES_REMOTE_STORAGE');
    this.remoteAccounting=options.remoteAccounting;
    this.store = typeof storage==='string'?new FileCiphertextStore(storage):storage;
    this.root = typeof storage==='string'?resolve(storage):storage instanceof FileCiphertextStore?storage.accountingRoot():undefined;
    this.keyProvider = keyProvider; this.maxBytes = options.maxBytes ?? 8_000_000;
    this.accounting=new VaultAccounting(options,this.root?accountingRoot(this.root):undefined);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 64_000_000) throw new Error('INVALID_VAULT_LIMIT');
  }
  private validate(ownerUserId: string, objectId: string) {
    if (typeof ownerUserId !== 'string' || !ownerUserId || ownerUserId.length > 200 || typeof objectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(objectId)) throw new Error('INVALID_VAULT_REFERENCE');
  }
  private async rootPath(){
    if(!this.root)throw Error('VAULT_ACCOUNTING_UNSUPPORTED');
    await mkdir(this.root,{recursive:true,mode:0o700});
    if((await lstat(this.root)).isSymbolicLink())throw Error('VAULT_SYMLINK_FORBIDDEN');
    return realpath(this.root);
  }
  async put(input: { ownerUserId: string; content: Buffer | string; objectId?: string }): Promise<VaultObjectRef> {
    if(typeof input.ownerUserId==='string'&&input.ownerUserId.startsWith('thot-operator:'))throw Error('VAULT_RESERVED_OWNER');
    return this.putInternal(input,false);
  }
  /** A server-only capability bound to the exact chain/market/operator journal identity.
   * Public intake has no selector for this class; retain the returned closure in the journal adapter. */
  operatorJournalWriter(ownerUserId:string):(content:Buffer|string)=>Promise<VaultObjectRef>{
    if(!isJournalOwner(ownerUserId))throw Error('INVALID_VAULT_JOURNAL_OWNER');
    return content=>this.putInternal({ownerUserId,content},true);
  }
  async usage(ownerUserId?:string){if(this.remoteAccounting)return this.remoteAccounting.usage(ownerUserId);const root=await this.rootPath();return this.accounting.serialized(root,async view=>view.usage(ownerUserId));}
  private async putInternal(input:{ownerUserId:string;content:Buffer|string;objectId?:string},journal:boolean):Promise<VaultObjectRef>{
    const objectId = input.objectId ?? uuidv7(); this.validate(input.ownerUserId, objectId);
    const plain = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
    if (plain.length > this.maxBytes) throw new Error('VAULT_OBJECT_TOO_LARGE');
    if(this.remoteAccounting)return this.putRemote(input.ownerUserId,objectId,plain,journal);
    const root=await this.rootPath();
    return this.accounting.serialized(root,async view=>{
    const name=objectId+'.sealed';
    if(view.has(name)){const error=Object.assign(Error('EEXIST'),{code:'EEXIST'});throw error;}
    const key = Buffer.from(await this.keyProvider.getObjectKey({ ownerUserId: input.ownerUserId, objectId }));
    try{
    if (key.length !== 32) throw new Error('INVALID_OBJECT_KEY');
    const aad = { version: 1 as const, object_id: objectId, owner_user_id: input.ownerUserId, key_id: this.keyProvider.keyId,...(journal?{storage_class:'operator-journal' as const}:{}) };
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(aad)));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope: VaultEnvelope = { ...aad, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    const serialized=canonicalJson(envelope),bytes=Buffer.byteLength(serialized);
    await view.admit(input.ownerUserId,bytes,journal);
    const file = await open(join(root,name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    catch(error){view.invalidate();throw error;}
    finally { await file.close(); }
    await view.created(name,{owner:input.ownerUserId,bytes,journal});
    return { objectId, ownerUserId: input.ownerUserId };
    }finally{key.fill(0);}
    });
  }
  private async putRemote(ownerUserId:string,objectId:string,plain:Buffer,journal:boolean):Promise<VaultObjectRef>{
    const aad={version:1 as const,object_id:objectId,owner_user_id:ownerUserId,key_id:this.keyProvider.keyId,...(journal?{storage_class:'operator-journal' as const}:{})};
    // GCM ciphertext length equals plaintext length. Compute exact envelope size
    // without encrypting, so quota rejection does not spend encryption work.
    const nonce=randomBytes(12);
    const header=canonicalJson({...aad,nonce:nonce.toString('base64'),tag:Buffer.alloc(16).toString('base64'),ciphertext:''});
    const bytes=Buffer.byteLength(header)+4*Math.ceil(plain.length/3);
    await this.remoteAccounting!.reserve(objectId,ownerUserId,bytes,journal);
    const key=Buffer.from(await this.keyProvider.getObjectKey({ownerUserId,objectId}));
    try{
      if(key.length!==32)throw Error('INVALID_OBJECT_KEY');
      const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(canonicalJson(aad)));
      const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
      const serialized=Buffer.from(canonicalJson({...aad,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
      if(serialized.length!==bytes)throw Error('REMOTE_RESERVATION_SIZE_MISMATCH');
      await this.store.put(objectId,serialized);
      await this.remoteAccounting!.stored(objectId,ownerUserId,bytes);
      return {objectId,ownerUserId};
    }finally{key.fill(0);}
    // Failed/ambiguous writes retain their reservation. Never release capacity
    // based on a timeout: the provider may already have accepted the object.
  }
  async get(input: { ownerUserId: string; objectId: string; role?: string }): Promise<Buffer> {
    this.validate(input.ownerUserId, input.objectId);
    if (input.role && !['owner', 'pipeline'].includes(input.role)) throw new Error('VAULT_ACCESS_DENIED');
    const maxBytes=Math.ceil(this.maxBytes*1.4+4096),stored=await this.store.get(input.objectId,maxBytes);
    if(!Buffer.isBuffer(stored)||stored.length>maxBytes)throw Error('INVALID_VAULT_OBJECT');
    const envelope:VaultEnvelope=JSON.parse(stored.toString('utf8'));
    if (envelope.version !== 1 || envelope.owner_user_id !== input.ownerUserId || envelope.object_id !== input.objectId || envelope.key_id !== this.keyProvider.keyId) throw new Error('VAULT_ACCESS_DENIED');
    if(envelope.storage_class!==undefined&&(envelope.storage_class!=='operator-journal'||!isJournalOwner(envelope.owner_user_id)))throw Error('VAULT_INTEGRITY_FAILURE');
    const nonce = Buffer.from(envelope.nonce, 'base64'); const tag = Buffer.from(envelope.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('VAULT_INTEGRITY_FAILURE');
    const key = Buffer.from(await this.keyProvider.getObjectKey({ ownerUserId: input.ownerUserId, objectId: input.objectId }));
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(canonicalJson({ version: envelope.version, object_id: envelope.object_id, owner_user_id: envelope.owner_user_id, key_id: envelope.key_id,...(envelope.storage_class?{storage_class:envelope.storage_class}:{}) })));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    } catch { throw new Error('VAULT_INTEGRITY_FAILURE'); } finally { key.fill(0); }
  }
  async delete(input: { ownerUserId: string; objectId: string }): Promise<void> {
    // Authenticate the object before deleting; no caller-provided paths are accepted.
    if(this.remoteAccounting){
      this.validate(input.ownerUserId,input.objectId);
      await this.remoteAccounting.authorizeDelete(input.objectId,input.ownerUserId);
      try{const plaintext=await this.get(input);plaintext.fill(0);}catch(e){if((e as any).code!=='ENOENT')throw e;}
      await this.store.delete(input.objectId);
      await this.remoteAccounting.removed(input.objectId,input.ownerUserId);
      return;
    }
    const root=await this.rootPath();
    await this.accounting.serialized(root,async view=>{
    const plaintext = await this.get(input); plaintext.fill(0);
    await this.store.delete(input.objectId);
    await view.removed(input.objectId+'.sealed');
    });
  }
}
