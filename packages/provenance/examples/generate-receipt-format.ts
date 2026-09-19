// PUBLIC, TEST-ONLY seeds. Anyone can reproduce these signatures. Never trust
// this key for recorder identity, production signing, or hardware assurance.
import {createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {canonicalHash, canonicalJson} from '../../protocol/src/canonical.ts';

export function createExample() {
  const signing = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), Buffer.alloc(32, 7)]), format:'der', type:'pkcs8'});
  const channel = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'), Buffer.alloc(32, 8)]), format:'der', type:'pkcs8'});
  const publicDer = (key: typeof signing) => createPublicKey(key).export({format:'der',type:'spki'}).toString('base64');
  const capture_id = '00000000-0000-4000-8000-000000000001';
  const started_at = '2026-09-12T12:00:00.000Z', finished_at = '2026-09-12T12:00:03.000Z';
  const consent = {save_privately:true, rights_confirmed:false, model_output_licensed:false};
  const b64 = (value: string) => Buffer.from(value).toString('base64');
  const parts = ['What is two plus two?', 'What is three plus three?'].map((prompt, index) => {
    const record = {sequence:index+1, upstream:'https://api.anthropic.com', path:'/v1/messages', request_method:'POST', request_encoding:'identity',
      request_body_b64:b64(JSON.stringify({model:'synthetic-format-example',messages:[{role:'user',content:prompt}],stream:true})),
      response_body_b64:b64('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:index===0?'Four.':'Six.'}})+'\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'),
      status:200, content_type:'text/event-stream', started_at:index===0?started_at:'2026-09-12T12:00:02.000Z', finished_at:index===0?'2026-09-12T12:00:01.000Z':finished_at, complete:true};
    return {...record,commitment:canonicalHash(record)};
  });
  const manifest = {format:'thot.proxy-capture/2',capture_id,client:'claude',started_at,finished_at,parts:parts.map(({sequence,commitment})=>({sequence,commitment}))};
  const bundle = {...manifest,root:canonicalHash(manifest)};
  const statement = {purpose:'thot.tee-capture-seal/1',capture_id,client:bundle.client,consent_hash:canonicalHash(consent),bundle_hash:canonicalHash(bundle),session_root:bundle.root};
  const evidence = {statement,signature:sign(null,Buffer.from(canonicalJson(statement)),signing).toString('base64'),attestation:{statement:{purpose:'thot.tee-recorder-key/1',signing_key:publicDer(signing),channel_key:publicDer(channel)}}};
  const sourceHash = canonicalHash({...bundle,tee_evidence:evidence});
  const capture_receipt = {schema_version:'trace.provenance/1',receipt_id:'00000000-0000-4000-8000-000000000002',trace_id:'00000000-0000-4000-8000-000000000003',path:'operator_capture',confidence_tier:'P0_OPERATOR',temporal:{observed_start:started_at,observed_end:finished_at},commitments:{raw_trace_hash:sourceHash,source_bundle_hash:sourceHash,session_root:bundle.root},
    claims:['Synthetic format example: the referenced bytes match their commitments.'],limitations:['Unsigned example summary; not an actual vault acknowledgement.','No TEE quote, hardware assurance, real provider call, authenticated recorder identity, or market authorization is present.','The public test-only seed can reproduce the signature.'],verifier:{implementation:'thot-receipt-format-example',version:'1',verified_at:finished_at}};
  const capture_summary = {exchanges:2,completed:2,interrupted:0,normalized:0,model_exchanges:2,incremental:true,request_bytes:parts.reduce((n,p)=>n+Buffer.byteLength(p.request_body_b64,'base64'),0),response_bytes:parts.reduce((n,p)=>n+Buffer.byteLength(p.response_body_b64,'base64'),0),largest_request_bytes:Math.max(...parts.map(p=>Buffer.byteLength(p.request_body_b64,'base64')))};
  return {example:{example_format:'thot.receipt-format-example/1',warning:'SYNTHETIC FORMAT EXAMPLE. NO HARDWARE ASSURANCE. UNSIGNED VAULT SUMMARY.',consent,bundle,evidence,capture_receipt,capture_summary},parts,locations:Object.fromEntries(parts.map(p=>[p.commitment,`parts/${p.sequence}.json`]))};
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), 'receipt-format-v1');
  const {example, parts, locations} = createExample();
  await mkdir(resolve(directory,'parts'),{recursive:true});
  for(const [name,value] of [['example.json',example],['locations.json',locations],...parts.map(p=>[`parts/${p.sequence}.json`,p])] as const) {
    await writeFile(resolve(directory,name as string),JSON.stringify(value,null,2)+'\n');
  }
}
