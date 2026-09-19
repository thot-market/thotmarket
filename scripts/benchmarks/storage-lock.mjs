// Disposable service-level comparison. Accepts a local source tree, never a hosted URL.
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const percentile=(values,f)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*f)-1]??null;
const [sourceArg,outputArg,delayArg='100']=process.argv.slice(2);
assert.ok(sourceArg&&outputArg,'Usage: node scripts/benchmarks/storage-lock.mjs SOURCE OUTPUT.json [OBJECT_DELAY_MS]');
assert.ok(!process.env.THOT_RECORDER_POLICY_FILE&&!process.env.THOT_ENABLE_OPENROUTER_RELAY,'Unset live recorder/relay configuration');
const source=resolve(sourceArg),delay=Number(delayArg);assert.ok(delay>=0&&delay<=1000);
const load=path=>import(pathToFileURL(join(source,path)).href);
const {createApplication}=await load('packages/market/src/bootstrap.ts');
const {SqlRemoteAccounting}=await load('packages/vault/src/remote-accounting.ts');
const {canonicalHash}=await load('packages/protocol/src/index.ts');
const {PGlite}=await import('@electric-sql/pglite');
const root=await mkdtemp(join(tmpdir(),'thot-lock-benchmark-')),sql=await PGlite.create();
const objects=new Map(),io=[];let active=0,peak=0;const transactions=[];
const storage={
  async put(id,bytes){active++;peak=Math.max(peak,active);const start=performance.now();try{await pause(delay);assert.ok(!objects.has(id));objects.set(id,Buffer.from(bytes));}finally{active--;io.push({kind:'write',duration_ms:performance.now()-start});}},
  async get(id,max){active++;peak=Math.max(peak,active);const start=performance.now();try{await pause(delay);const bytes=objects.get(id);assert.ok(bytes&&bytes.length<=max);return Buffer.from(bytes);}finally{active--;io.push({kind:'read',duration_ms:performance.now()-start});}},
  async delete(id){await pause(delay);objects.delete(id);}
};
const accounting=await new SqlRemoteAccounting({transaction:work=>sql.transaction(q=>work(q))},'synthetic').initialize();
let app;
const report={schema:'thot.storage-lock-service-benchmark/1',source:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'}).trim(),delay_ms:delay,batches:[],limitations:['Disposable service calls bypass HTTP/auth/admission; synthetic provenance, no model or DCAP calls','Object store is an in-memory latency fixture with real encryption and independent SQL quota accounting; not R2 network performance','Single shared host; short bursts, not sustained capacity or the hosted Haiku save budget']};
try{
  app=await createApplication({dataDir:root,masterKey:Buffer.alloc(32,87),storage:{ciphertext:storage,accounting,identity:'b'.repeat(64)},onTransactionTiming:timing=>transactions.push(timing)});
  for(const kind of ['import','capture'])for(const concurrent of [1,2,4,8]){
    const owners=Array.from({length:concurrent},(_,i)=>({id:`synthetic-${kind}-${concurrent}-${i}`,role:'user'}));
    const work=[];
    for(const [i,actor]of owners.entries()){
      if(kind==='import'){
        const text=[{type:'user',sessionId:actor.id,message:{role:'user',content:`Synthetic question ${actor.id}`}},{type:'assistant',sessionId:actor.id,message:{role:'assistant',content:`Synthetic answer ${actor.id}`}}].map(JSON.stringify).join('\n');
        const input={text,filename:'synthetic.jsonl',save_privately:true};input.content_commitment=app.portfolio.preview(actor,input).content_commitment;
        work.push(async()=>app.service.importTrace(actor,`benchmark-import-${concurrent}-${i}`,{bundle:{format:'thot.claude-code-jsonl/1',text},content_commitment:input.content_commitment,save_privately:true}));
      }else{
        const c=await app.agentCapture.begin(actor,{client:'claude',save_privately:true}),now=new Date().toISOString();
        const record={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from(JSON.stringify({model:'synthetic',messages:[{role:'user',content:`Synthetic question ${actor.id}`}]})).toString('base64'),response_body_b64:Buffer.from(JSON.stringify({type:'message',content:[{type:'text',text:`Synthetic answer ${actor.id}`}],stop_reason:'end_turn'})).toString('base64'),status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true},part={...record,commitment:canonicalHash(record)};
        const m={format:'thot.proxy-capture/2',capture_id:c.capture_id,client:'claude',started_at:now,finished_at:now,parts:[{sequence:1,commitment:part.commitment}]},input={bundle:{...m,root:canonicalHash(m)}};
        work.push(async()=>{await app.agentCapture.part(c.capture_id,c.upload_token,`benchmark-part-${concurrent}-${i}`,{part});return app.agentCapture.complete(c.capture_id,c.upload_token,`benchmark-save-${concurrent}-${i}`,input);});
      }
    }
    transactions.length=0;io.length=0;peak=0;const durations=[],responses=[],start=performance.now();
    await Promise.all(work.map(async task=>{const begin=performance.now(),response=await task();durations.push(performance.now()-begin);responses.push(response);}));
    const batch={kind,concurrent,elapsed_ms:performance.now()-start,p50_ms:percentile(durations,.5),p95_ms:percentile(durations,.95),object_peak_in_flight:peak,object_operations:io.length,transaction_count:transactions.length,hold_p95_ms:percentile(transactions.map(t=>t.hold_ms),.95),hold_max_ms:Math.max(...transactions.map(t=>t.hold_ms)),admission_p95_ms:percentile(transactions.map(t=>t.admission_ms),.95),lock_wait_p95_ms:percentile(transactions.map(t=>t.lock_wait_ms),.95)};
    // Follow-up reads and isolation checks are deliberately outside measured timing.
    for(const response of responses){
      const trace=await app.db.transaction(tx=>tx.get('traces',response.trace_id));
      const actualActor=owners.find(o=>o.id===trace.owner_id);assert.ok(actualActor);
      const content=await app.privacy.open(trace.owner_id,trace.raw_ref);assert.ok(content.turns.some(t=>t.content===`Synthetic answer ${actualActor.id}`));
      await assert.rejects(app.library.item({id:'synthetic-foreign',role:'user'},response.trace_id),/NOT_FOUND/);
    }
    report.batches.push(batch);
  }
  if(app.service.staged)await app.service.staged.cleanup();
  report.quota=await accounting.usage();report.object_count=objects.size;
  assert.equal(report.quota.user.objects,report.object_count,'Every retained ciphertext must have a quota record');
  assert.equal(report.quota.user.bytes,[...objects.values()].reduce((sum,value)=>sum+value.length,0),'Ciphertext bytes and quota bytes must agree');
  assert.equal(report.quota.owner.objects+report.quota.journal.objects,0,'Benchmark creates only user-class ciphertext');
  await writeFile(resolve(outputArg),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output:resolve(outputArg),batches:report.batches}));
}finally{await app?.close();await sql.close();await rm(root,{recursive:true,force:true});}
