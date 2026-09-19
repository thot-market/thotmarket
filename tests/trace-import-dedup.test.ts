import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { createDevelopmentBundle, type TraceContent } from '../packages/provenance/src/index.ts';
import { demoUser } from '../packages/market/src/fixtures.ts';
import type { Actor } from '../packages/market/src/service.ts';

const content:TraceContent={turns:[{role:'user',content:'Debug this tenant-scoped cache key and show the test.'},{role:'assistant',content:'Include the tenant ID in the key. The isolation test passed.'}]};
const other:Actor={id:'other-user',role:'user'};
const upload=(actor:Actor,trace=content,observedAt='2026-09-05T12:00:00Z')=>({
  bundle:createDevelopmentBundle({userId:actor.id,traceId:randomUUID(),trace,observedAt}),
  category:'general',rights_confirmed:true,model_output_licensed:true,
});

test('verified imports deduplicate exact conversations across changed valid wrappers, concurrency and consent',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-dedup-'));
  const app=await createApplication({memory:true,dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const firstInput=upload(demoUser),secondInput=upload(demoUser,content,'2026-09-05T13:00:00Z');
  const results=await Promise.all([
    app.service.importTrace(demoUser,randomUUID(),firstInput),
    app.service.importTrace(demoUser,randomUUID(),secondInput),
  ]);
  assert.equal(results[0].trace_id,results[1].trace_id);
  assert.equal(results.filter(r=>r.duplicate===true).length,1);
  assert.equal((await app.service.traces(demoUser)).length,1);
  const rows=await app.db.transaction(tx=>tx.list('trace_bundles',demoUser.id));
  assert.equal(rows.length,1,'duplicate imports must not seal another source copy');
  const before=await app.db.transaction(tx=>tx.get('traces',results[0].trace_id,demoUser.id));
  for(const input of [firstInput,upload(demoUser)]){
    await assert.rejects(app.service.importTrace(demoUser,randomUUID(),{...input,model_output_licensed:false}),/IMPORT_CONSENT_CONFLICT/);
    await assert.rejects(app.service.importTrace(demoUser,randomUUID(),{...input,exclusion_terms:['tenant']}),/IMPORT_CONSENT_CONFLICT/);
  }
  const after=await app.db.transaction(tx=>tx.get('traces',results[0].trace_id,demoUser.id));
  assert.deepEqual(after,before,'a replay cannot replace the first rights/provenance decision');
});

test('deduplication is owner scoped and does not equate content with rights ownership',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-dedup-owners-'));
  const app=await createApplication({memory:true,dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const a=await app.service.importTrace(demoUser,randomUUID(),upload(demoUser));
  const b=await app.service.importTrace(other,randomUUID(),upload(other));
  assert.notEqual(a.trace_id,b.trace_id);assert.notEqual(b.duplicate,true);
  assert(!JSON.stringify(b).includes(a.trace_id));
  await assert.rejects(app.service.trace(other,a.trace_id),/NOT_FOUND/);
  const replay=await app.service.importTrace(other,randomUUID(),upload(other));
  assert.equal(replay.trace_id,b.trace_id);assert.equal(replay.duplicate,true);
});

test('legacy receipt commitments deduplicate wrappers and deleted imports cannot be resurrected',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-dedup-legacy-'));
  const app=await createApplication({memory:true,dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const a=await app.service.importTrace(demoUser,randomUUID(),upload(demoUser));
  await app.db.transaction(async tx=>{
    const row=await tx.get('traces',a.trace_id,demoUser.id);
    delete row.import_verified_content_hash;delete row.import_consent_hash;
    await tx.update('traces',row.trace_id,row);
  });
  const replay=await app.service.importTrace(demoUser,randomUUID(),upload(demoUser));
  assert.equal(replay.trace_id,a.trace_id);assert.equal(replay.duplicate,true);
  await app.service.deleteTrace(demoUser,randomUUID(),a.trace_id);
  await assert.rejects(app.service.importTrace(demoUser,randomUUID(),upload(demoUser)),/TRACE_DELETED/);
});

test('exact-content protection does not silently merge changed research or claim semantic fraud detection',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-dedup-changes-'));
  const app=await createApplication({memory:true,dataDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const a=await app.service.importTrace(demoUser,randomUUID(),upload(demoUser));
  const changed=structuredClone(content);changed.turns[1]!.content+=' A second test found a race condition.';
  const b=await app.service.importTrace(demoUser,randomUUID(),upload(demoUser,changed));
  assert.notEqual(a.trace_id,b.trace_id);assert.notEqual(b.duplicate,true);
});
