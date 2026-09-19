import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {channelKey,publicDer,encrypt,decrypt} from '../packages/capture/src/tee/channel.ts';
import {verifySeal} from '../packages/capture/src/tee/attestation.ts';
import {canonicalHash,canonicalJson} from '../packages/protocol/src/canonical.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {AgentCaptureIngestion} from '../packages/market/src/agent-capture.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('attested channel authenticates direction, request and frame order, excluding other peers',()=>{
 const a=generateKeyPairSync('x25519'),b=generateKeyPairSync('x25519'),c=generateKeyPairSync('x25519');
 const ka=channelKey(a.privateKey,publicDer(b.publicKey)),kb=channelKey(b.privateKey,publicDer(a.publicKey));assert.deepEqual(ka,kb);
 const data=encrypt(ka,{credential:'synthetic-secret'},'response:session:request:0');
 assert.deepEqual(decrypt(kb,data,'response:session:request:0'),{credential:'synthetic-secret'});
 for(const aad of ['response:session:request:1','relay:session:request:0','response:other:request:0'])assert.throws(()=>decrypt(kb,data,aad));
 assert.throws(()=>decrypt(channelKey(c.privateKey,publicDer(b.publicKey)),data,'response:session:request:0'));
 const altered=Buffer.from(data,'base64');altered[30]^=1;assert.throws(()=>decrypt(kb,altered.toString('base64'),'response:session:request:0'));
});
test('recorder seal rejects invented content, ownership, consent and signing keys',()=>{
 const k=generateKeyPairSync('ed25519'),bundle={client:'codex',root:'a'.repeat(64),capture_id:'test',exchanges:[]};
 const statement={purpose:'thot.tee-capture-seal/1',capture_id:'test',client:'codex',bundle_hash:canonicalHash(bundle),session_root:bundle.root,consent_hash:'consent'};
 const evidence={statement,signature:sign(null,Buffer.from(canonicalJson(statement)),k.privateKey).toString('base64'),attestation:{quote:'00',statement:{signing_key:publicDer(k.publicKey)}}};
 verifySeal(bundle,evidence,'test','consent');
 assert.throws(()=>verifySeal({...bundle,exchanges:['fabricated']},evidence,'test','consent'));
 assert.throws(()=>verifySeal(bundle,evidence,'other','consent'));
 assert.throws(()=>verifySeal(bundle,evidence,'test','changed'));
 assert.throws(()=>verifySeal(bundle,{...evidence,statement:{...statement,session_root:'changed'}},'test','consent'));
 const fake={...evidence,attestation:{quote:'00',statement:{signing_key:publicDer(generateKeyPairSync('ed25519').publicKey)}}};assert.throws(()=>verifySeal(bundle,fake,'test','consent'));
});
test('TEE capture is owner authorized and cannot downgrade to a valid unsigned local bundle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-tee-test-'));const app=await createApplication({dataDir:dir});
 try{
 const policy={url:'https://recorder.example',instances:{}};const ingest=new AgentCaptureIngestion(app.service,policy);
 const actor={id:'user_demo',role:'user' as const};const connection=await ingest.begin(actor,{client:'claude',rights_confirmed:true,model_output_licensed:false});
 const authorized=await ingest.authorize(connection.capture_id,connection.upload_token);assert.equal(authorized.status,'AWAITING_UPLOAD');
 await assert.rejects(ingest.authorize(connection.capture_id,'x'.repeat(43)),/INVALID_CAPTURE_TOKEN/);
 const now=new Date().toISOString();const record={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:'e30=',response_body_b64:'e30=',status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true};
 const exchange={...record,commitment:canonicalHash(record)};const base={format:'thot.proxy-capture/1',capture_id:connection.capture_id,client:'claude',started_at:now,finished_at:now};const bundle={...base,exchanges:[exchange],root:canonicalHash({...base,commitments:[exchange.commitment]})};
 await assert.rejects(ingest.complete(connection.capture_id,connection.upload_token,'tee-test-complete',{bundle}),/TEE_CAPTURE_EVIDENCE_REQUIRED/);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
