import {createHash} from 'node:crypto';
import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,type S3ClientConfig} from '@aws-sdk/client-s3';
import {CiphertextNotFoundError,type CiphertextStore} from './ciphertext-store.ts';

export interface S3StoreConfig {endpoint:string;region:string;bucket:string;prefix:string;accessKeyId:string;secretAccessKey:string;timeoutMs?:number;}
export class S3CiphertextStore implements CiphertextStore {
  private client:S3Client;private config:S3StoreConfig;private timeoutMs:number;
  constructor(config:S3StoreConfig,transport:Pick<S3ClientConfig,'requestHandler'>={}){
    const url=new URL(config.endpoint);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!config.region||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)||!/^([A-Za-z0-9_-]+\/)+$/.test(config.prefix)||config.prefix.length>200||!config.accessKeyId||!config.secretAccessKey)throw Error('INVALID_S3_CONFIGURATION');
    this.config={...config};this.timeoutMs=config.timeoutMs??30000;
    if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<100||this.timeoutMs>120000)throw Error('INVALID_S3_CONFIGURATION');
    this.client=new S3Client({...transport,endpoint:config.endpoint,region:config.region,forcePathStyle:true,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey}});
  }
  private key(id:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw Error('INVALID_VAULT_REFERENCE');return this.config.prefix+id+'.sealed';}
  async put(id:string,bytes:Buffer){
    try{await this.client.send(new PutObjectCommand({Bucket:this.config.bucket,Key:this.key(id),Body:bytes,ContentLength:bytes.length,ContentType:'application/octet-stream',ContentMD5:createHash('md5').update(bytes).digest('base64'),IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(this.timeoutMs)});}
    catch(e){if((e as any)?.$metadata?.httpStatusCode===412)throw Object.assign(Error('EEXIST'),{code:'EEXIST'});throw Error('REMOTE_OBJECT_WRITE_FAILED',{cause:e});}
  }
  async get(id:string,maxBytes:number){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('INVALID_VAULT_LIMIT');
    const signal=AbortSignal.timeout(this.timeoutMs);
    let body:any;const abort=()=>body?.destroy?.(Error('REMOTE_OBJECT_READ_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});
    try{
      const result=await this.client.send(new GetObjectCommand({Bucket:this.config.bucket,Key:this.key(id)}),{abortSignal:signal});body=result.Body;
      if(!body||result.ContentLength!==undefined&&result.ContentLength>maxBytes)throw Error('INVALID_VAULT_OBJECT');
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of body){signal.throwIfAborted();const b=Buffer.from(chunk);size+=b.length;if(size>maxBytes)throw Error('INVALID_VAULT_OBJECT');chunks.push(b);}
      return Buffer.concat(chunks,size);
    }catch(e){if((e as any)?.name==='NoSuchKey')throw new CiphertextNotFoundError();if((e as Error).message==='INVALID_VAULT_OBJECT')throw e;throw Error('REMOTE_OBJECT_READ_FAILED',{cause:e});}
    finally{signal.removeEventListener('abort',abort);body?.destroy?.();}
  }
  async delete(id:string){try{await this.client.send(new DeleteObjectCommand({Bucket:this.config.bucket,Key:this.key(id)}),{abortSignal:AbortSignal.timeout(this.timeoutMs)});}catch(e){throw Error('REMOTE_OBJECT_DELETE_FAILED',{cause:e});}}
  close(){this.client.destroy();}
}
