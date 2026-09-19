import {createHash} from 'node:crypto';
import {S3CiphertextStore} from './s3-store.ts';
import {openPostgresAccounting,type RemoteQuotaLimits} from './remote-accounting.ts';

/** No credentials or secrets are serialized into public capabilities. */
export async function openRemoteStorage(env:NodeJS.ProcessEnv){
  if(!env.THOT_OBJECT_STORAGE)return undefined;
  if(env.THOT_REMOTE_STORAGE_INITIALIZE!==undefined&&env.THOT_REMOTE_STORAGE_INITIALIZE!=='true')throw Error('INVALID_REMOTE_INITIALIZATION');
  if(env.THOT_OBJECT_STORAGE!=='s3')throw Error('INVALID_OBJECT_STORAGE');
  for(const key of ['THOT_S3_ENDPOINT','THOT_S3_BUCKET','THOT_S3_PREFIX','THOT_S3_ACCESS_KEY_ID','THOT_S3_SECRET_ACCESS_KEY','THOT_QUOTA_DATABASE_URL','THOT_STORAGE_NAMESPACE'])if(!env[key])throw Error('REMOTE_STORAGE_CONFIGURATION_REQUIRED');
  let limits:RemoteQuotaLimits|undefined;
  if(env.THOT_REMOTE_QUOTAS){if(env.THOT_REMOTE_QUOTAS.length>4096)throw Error('INVALID_REMOTE_QUOTAS');try{limits=JSON.parse(env.THOT_REMOTE_QUOTAS);}catch{throw Error('INVALID_REMOTE_QUOTAS');}}
  const ciphertext=new S3CiphertextStore({endpoint:env.THOT_S3_ENDPOINT!,bucket:env.THOT_S3_BUCKET!,prefix:env.THOT_S3_PREFIX!,region:env.THOT_S3_REGION??'auto',accessKeyId:env.THOT_S3_ACCESS_KEY_ID!,secretAccessKey:env.THOT_S3_SECRET_ACCESS_KEY!});
  try{
    const quota=await openPostgresAccounting(env.THOT_QUOTA_DATABASE_URL!,env.THOT_STORAGE_NAMESPACE!,limits,JSON.stringify({endpoint:env.THOT_S3_ENDPOINT,bucket:env.THOT_S3_BUCKET,prefix:env.THOT_S3_PREFIX}),env.THOT_REMOTE_STORAGE_INITIALIZE==='true');
    const identity=createHash('sha256').update(JSON.stringify({endpoint:env.THOT_S3_ENDPOINT,bucket:env.THOT_S3_BUCKET,prefix:env.THOT_S3_PREFIX,namespace:env.THOT_STORAGE_NAMESPACE})).digest('hex');
    return {identity,ciphertext,accounting:quota.accounting,close:async()=>{ciphertext.close();await quota.close();}};
  }catch(e){ciphertext.close();throw e;}
}
