import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {S3CiphertextStore} from '../packages/vault/src/s3-store.ts';
import {openRemoteStorage} from '../packages/vault/src/remote-config.ts';
const config={endpoint:'https://storage.example',region:'auto',bucket:'private-fixture',prefix:'vault/',accessKeyId:'fixture-key',secretAccessKey:'fixture-secret'};
const xml=(code:string)=>Buffer.from(`<Error><Code>${code}</Code></Error>`);
function fixture(t:any){
  const objects=new Map<string,Buffer>();let responseOverride:any;
  const requests:any[]=[];
  const handler={async handle(req:any){
    requests.push(req);assert.match(req.headers.authorization,/AWS4-HMAC-SHA256/);
    if(responseOverride)return {response:responseOverride};
    let statusCode=200,body:Buffer=Buffer.alloc(0),headers:Record<string,string>={};
    if(req.method==='PUT'){
      assert.equal(req.headers['if-none-match'],'*');
      const bytes=Buffer.from(req.body);assert.equal(req.headers['content-md5'],createHash('md5').update(bytes).digest('base64'));
      if(objects.has(req.path)){statusCode=412;body=xml('PreconditionFailed');}else objects.set(req.path,bytes);
    }else if(req.method==='GET'){
      if(objects.has(req.path)){body=objects.get(req.path)!;headers={'content-length':String(body.length)};}else{statusCode=404;body=xml('NoSuchKey');}
    }else if(req.method==='DELETE'){objects.delete(req.path);statusCode=204;}
    return {response:{statusCode,headers,body:Readable.from([body])}};
  }};
  const store=new S3CiphertextStore(config,{requestHandler:handler});t.after(()=>store.close());
  return {store,objects,requests,override:(v:any)=>{responseOverride=v;}};
}
test('S3 transport signs immutable writes, enforces read bounds and normalizes absence',async t=>{
  const {store,objects}=fixture(t);
  await store.put('original',Buffer.from('encrypted envelope'));
  await assert.rejects(store.put('original',Buffer.from('overwrite')),/EEXIST/);
  assert.equal((await store.get('original',100)).toString(),'encrypted envelope');
  await assert.rejects(store.get('original',3),/INVALID_VAULT_OBJECT/);
  await store.delete('original');await store.delete('original');assert.equal(objects.size,0);
  await assert.rejects(store.get('original',100),(e:any)=>e.code==='ENOENT');
});
test('streaming read cap works without content length and destroys oversized responses',async t=>{
  const {store,override}=fixture(t);const body=Readable.from([Buffer.alloc(100),Buffer.alloc(100)]);
  override({statusCode:200,headers:{},body});
  await assert.rejects(store.get('oversized',150),/INVALID_VAULT_OBJECT/);assert.equal(body.destroyed,true);
});
test('provider access denial and missing bucket do not masquerade as absent objects',async t=>{
  const {store,override}=fixture(t);
  for(const [statusCode,code] of [[403,'AccessDenied'],[404,'NoSuchBucket']] as const){
    override({statusCode,headers:{},body:Readable.from([xml(code)])});
    await assert.rejects(store.get('original',100),(e:any)=>e.message==='REMOTE_OBJECT_READ_FAILED'&&e.code!=='ENOENT');
  }
});
test('stalled response body is terminated by timeout',async t=>{
  const body=new Readable({read(){}});
  const store=new S3CiphertextStore({...config,timeoutMs:100},{requestHandler:{async handle(){return {response:{statusCode:200,headers:{},body}};}}});t.after(()=>store.close());
  const keepAlive=setInterval(()=>{},200);t.after(()=>clearInterval(keepAlive));
  await assert.rejects(store.get('stalled',100),/REMOTE_OBJECT_READ_FAILED/);assert.equal(body.destroyed,true);
});
test('configuration refuses plaintext transport and fails closed before missing quota credentials',async()=>{
  assert.throws(()=>new S3CiphertextStore({...config,endpoint:'http://storage.example'}),/INVALID_S3_CONFIGURATION/);
  assert.throws(()=>new S3CiphertextStore({...config,prefix:'../'}),/INVALID_S3_CONFIGURATION/);
  assert.equal(await openRemoteStorage({}),undefined);
  await assert.rejects(openRemoteStorage({THOT_OBJECT_STORAGE:'s3'}),/REMOTE_STORAGE_CONFIGURATION_REQUIRED/);
});
