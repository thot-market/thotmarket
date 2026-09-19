import test from 'node:test';
import assert from 'node:assert/strict';
import {captureProofOracle} from '../scripts/lib/capture-proof-oracle.mjs';
import {canonicalHash} from '../packages/protocol/src/canonical.ts';

test('ordinary-work assertions reject echoed prompts, failed responses and old answers',async()=>{
 const marker='FIXTURE_ONLY_IN_PROMPT';
 const rows=[
  {sequence:1,status:200,complete:true,request_body_b64:Buffer.from(JSON.stringify({prompt:marker})).toString('base64'),response_body_b64:Buffer.from('data: '+JSON.stringify({type:'response.output_text.delta',delta:'An unrelated answer'})+'\n').toString('base64')},
  {sequence:2,status:500,complete:true,request_body_b64:'',response_body_b64:Buffer.from('data: '+JSON.stringify({type:'response.output_text.delta',delta:marker})+'\n').toString('base64')},
 ];
 const seal=row=>({...row,commitment:canonicalHash(row)});
 const fake={get:async path=>path.endsWith('/status')?{result:{trace_id:'synthetic'}}:path.endsWith('/proof')?{bundle:{parts:rows.map(p=>({sequence:p.sequence,commitment:seal(p).commitment}))}}:{part:seal(rows.find(p=>p.sequence===Number(path.split('/').at(-1))))}};
 const oracle=captureProofOracle(fake,'synthetic');assert.equal(await oracle.answered([marker]),false);
 rows.push({sequence:3,status:200,complete:true,request_body_b64:'',response_body_b64:Buffer.from('data: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:marker}})+'\n').toString('base64')});
 assert.equal(await oracle.answered([marker],2),true);
 assert.equal(await oracle.answered([marker],3),false,'An earlier successful answer cannot satisfy the next step');
});

test('local wrapped parts must match the acknowledged vault commitment',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {storePrivate}=await import('../packages/capture/src/local-state.ts');
 const root=await mkdtemp(join(tmpdir(),'thot-oracle-'));
 const row={sequence:1,status:200,complete:true,request_body_b64:'',response_body_b64:Buffer.from('data: '+JSON.stringify({type:'response.output_text.delta',delta:'NEW_LOCAL_ANSWER'})+'\n').toString('base64')};
 const part={...row,commitment:canonicalHash(row)};
 const fake={get:async path=>path.endsWith('/status')?{result:{trace_id:'synthetic'}}:{bundle:{parts:[{sequence:1,commitment:part.commitment}]}}};
 try{
  await storePrivate(join(root,'1'),{part});assert.equal(await captureProofOracle(fake,'synthetic',[],root).answered(['NEW_LOCAL_ANSWER']),true);
  await storePrivate(join(root,'1'),{part:{...part,response_body_b64:Buffer.from('changed').toString('base64')}});
  await assert.rejects(()=>captureProofOracle(fake,'synthetic',[],root).answered(['NEW_LOCAL_ANSWER']),/Actual answer bytes/);
 }finally{await rm(root,{recursive:true,force:true});}
});
