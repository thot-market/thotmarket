import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { similaritySketch, similarityBasisPoints } from '../packages/similarity/src/index.ts';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoUser, demoBuyer } from '../packages/market/src/fixtures.ts';
const text='A long synthetic example of original debugging work explains tenant scoped caches and repeatable tests for a service without giving any real personal data.';
const content=(value=text,role='user')=>({turns:[{role,content:value}]});
test('similarity is deterministic, Unicode normalized, bounded and role aware',()=>{
  const a=similaritySketch(content())!;
  assert.equal(similarityBasisPoints(a,similaritySketch(content(text.toUpperCase()))!),10000);
  assert.equal(similarityBasisPoints(a,similaritySketch(content(text.replaceAll(' ','  ')))!),10000);
  assert.ok(similarityBasisPoints(a,similaritySketch(content(text+' Additional detail here.'))!)>=8000);
  assert.ok(similarityBasisPoints(a,similaritySketch(content(text,'assistant'))!)<10000);
  assert.equal(similarityBasisPoints(similaritySketch(content('Ａ '+text))!,similaritySketch(content('A '+text))!),10000);
  for(const v of [null,content('tiny'),content('x '.repeat(100000)),{turns:[{role:'unknown',content:text}]}])assert.equal(similaritySketch(v),null);
});
test('similarity reports only the owner eligible inventory, no text or fingerprints, and never changes sale state',async t=>{
  const path=await mkdtemp(join(tmpdir(),'thot-similarity-test-'));
  const app=await createApplication({memory:true,dataDir:path});t.after(async()=>{await app.close();await rm(path,{recursive:true,force:true});});
  async function add(owner:any,value:string,key:string){return app.service.importTrace(owner,key,{bundle:app.privacy.createDemoBundle(content(value),owner.id),category:'general',rights_confirmed:true,licensed_model_output:false});}
  const one=await add(demoUser,text,'similarity-import-first');
  const two=await add(demoUser,text+' Additional detail here.','similarity-import-second');
  await add({id:'other-user',role:'user'},text+' Other owner.','similarity-import-foreign');
  const before=await app.service.traces(demoUser),report=await app.service.similarity(demoUser,one.trace_id);
  assert.equal(report.available,true);assert.equal(report.compared,1);assert.equal(report.matches.length,1);
  assert.equal(report.matches[0].trace_id,two.trace_id);assert.equal(report.review_only,true);
  for(const v of [text,'shingles','normalized_hash','other-user','raw_ref'])assert.ok(!JSON.stringify(report).includes(v));
  assert.deepEqual(await app.service.traces(demoUser),before);
  await assert.rejects(app.service.similarity(demoBuyer,one.trace_id),/FORBIDDEN/);
  await assert.rejects(app.service.similarity({id:'other-user',role:'user'},one.trace_id),/NOT_FOUND/);
  await app.service.deleteTrace(demoUser,'similarity-delete-other',two.trace_id);
  assert.equal((await app.service.similarity(demoUser,one.trace_id)).compared,0);
  await assert.rejects(app.service.similarity(demoUser,two.trace_id),/TRACE_INELIGIBLE/);
});
