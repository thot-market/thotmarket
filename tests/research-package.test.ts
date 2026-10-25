import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateResearchPackage,researchPreview,RESEARCH_FORMAT,type ResearchPackage} from '../packages/content/src/research.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {runTraceQc} from '../packages/qc/index.ts';
// @ts-expect-error Browser module is exercised directly without a build step.
import {researchFilesHTML} from '../apps/dashboard/library-ui.js';

const owner={id:'demo-user',role:'user' as const},other={id:'other-user',role:'user' as const};
const file=(path:string,text:string,media_type:string,role:string)=>({path,text,media_type,role,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
function fixture():ResearchPackage {return {schema_version:RESEARCH_FORMAT,kind:'research',title:'Synthetic research report',entrypoint:'report.md',files:[file('report.md','# Report\r\nSynthetic result: 4.\n','text/markdown','report'),file('calculate.py','raise RuntimeError("must never execute")\n','text/x-python','code'),file('results.json','{"synthetic":true,"result":4}\n','application/json','data')] as ResearchPackage['files'],relationships:[{from:'results.json',relation:'generated_by',to:'calculate.py'}],provenance:{mode:'imported_declaration'}};}
async function setup(t:any){const dir=await mkdtemp(join(tmpdir(),'research-package-')),app=await createApplication({dataDir:dir,memory:true});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});return app;}
async function imported(app:Awaited<ReturnType<typeof createApplication>>,p=fixture(),key=randomUUID()){
 const input={kind:'research',filename:'package.json',text:JSON.stringify(p)},preview=app.portfolio.preview(owner,input);
 return app.portfolio.import(owner,key,{...input,content_commitment:preview.content_commitment,save_privately:true});
}

test('research profile preserves exact UTF-8 files and relationships without invented turns',()=>{
 const p=fixture(),result=validateResearchPackage(p);assert.deepEqual(result,p);assert.equal('turns' in result,false);assert.equal(researchPreview(p).file_count,3);
 for(const f of result.files)assert.equal(createHash('sha256').update(f.text).digest('hex'),f.sha256);
});
test('research validation rejects traversal, normalized collisions, unsupported media and forged file commitments',()=>{
 const changes=[(p:any)=>p.files[0].path='../report.md',(p:any)=>p.files[1].path='REPORT.MD',(p:any)=>p.files[0].sha256='a'.repeat(64),(p:any)=>p.files[0].bytes++,(p:any)=>p.files[0].text+='changed',(p:any)=>p.files[1].media_type='text/html',(p:any)=>p.files[0].text='\ud800',(p:any)=>p.files[0].path='/absolute.md',(p:any)=>p.files[0].path='dir\\report.md',(p:any)=>p.owner_id=other.id,(p:any)=>p.provenance.mode='attested',(p:any)=>p.relationships[0].to='missing.py',(p:any)=>p.files[1].path='report.md/calculate.py',(p:any)=>p.entrypoint='calculate.py',(p:any)=>p.files.push(...p.files),(p:any)=>p.files[0].text='x'.repeat(200_001)];
 for(const mutate of changes){const p=fixture();mutate(p);assert.throws(()=>validateResearchPackage(p));}
});
test('private import is owner-isolated, atomic, deduplicated and has exact file readback',async t=>{
 const app=await setup(t),p=fixture(),saved=await imported(app,p),again=await imported(app,p);
 assert.equal(saved.status,'PRIVATE');assert.equal(again.trace_id,saved.trace_id);assert.equal(again.duplicate,true);
 const item=await app.library.item(owner,saved.trace_id);assert.deepEqual(item.content,p);assert.equal(item.content_kind,'research');assert.equal(item.file_count,3);assert.equal(item.evidence,'IMPORTED_UNVERIFIED');assert.equal(item.receipt.confidence_tier,'P0_OPERATOR');assert.equal(item.private_import.can_prepare_sale,true);
 await assert.rejects(app.library.item(other,saved.trace_id),/NOT_FOUND/);
 assert.equal((await app.library.list(other)).items.length,0);
 const invalid=fixture();invalid.files[1]!.sha256='0'.repeat(64);await assert.rejects(imported(app,invalid));assert.equal((await app.library.list(owner)).items.length,1);
 const input={kind:'research',filename:'package.json',text:JSON.stringify(p),content_commitment:canonicalHash(p)};
 await assert.rejects(app.portfolio.import(owner,randomUUID(),{...input,rights_confirmed:true,model_output_licensed:true}),/RESEARCH_PRIVATE_IMPORT_REQUIRED/);
 await assert.rejects(app.portfolio.import(owner,randomUUID(),{...input,save_privately:true,content_commitment:'0'.repeat(64)}),/IMPORT_PREVIEW_CHANGED/);
});
test('package QC lists inspected files and does not claim research completeness or execute code',()=>{
 const report=runTraceQc(fixture(),{scope:'private'});assert.equal(report.status,'pass');assert.equal(report.content_kind,'research');assert.equal(report.coverage.total_files,3);assert.equal(report.coverage.evaluated_files,3);assert.equal(report.coverage.total_turns,0);assert.match(report.summary,/not established/);assert.equal(report.checks.find(c=>c.id==='code_execution')!.status,'not_run');
 const p=fixture();p.files[0]=file('report.md','api_key='+ 'x'.repeat(35),'text/markdown','report') as any;
 const privateReport=runTraceQc(p,{scope:'private'}),releaseReport=runTraceQc(p,{scope:'release'});assert.equal(privateReport.status,'flag');assert.equal(releaseReport.status,'reject');assert.deepEqual(releaseReport.findings[0]!.file_paths,['report.md']);assert.equal(JSON.stringify(releaseReport).includes('x'.repeat(35)),false);
});
test('research preparation and file exclusion preserve raw originals and revise exact release commitments',async t=>{
 const app=await setup(t),p=fixture(),saved=await imported(app,p);
 await app.portfolio.prepareSale(owner,randomUUID(),saved.trace_id,{content_commitment:canonicalHash(p),rights_confirmed:true,model_output_licensed:false});
 const before=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});assert.equal(before.content_kind,'research');assert.equal(before.sale_eligibility.can_list,true);assert.equal(before.exclusion.supported,true);assert.deepEqual(before.content,p);
 const input={trace_id:saved.trace_id,content_hash:before.content_hash,excluded_files:['calculate.py'],rights_confirmed:true,model_output_licensed:false};
 const after=await app.releasePreview.exclude(owner,randomUUID(),input);assert.equal(after.content.files.length,2);assert.deepEqual(after.content.relationships,[]);assert.notEqual(after.content_hash,before.content_hash);assert.equal(after.release_revision,1);assert.deepEqual((await app.library.item(owner,saved.trace_id)).content,p);
 await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),input),/RELEASE_CHANGED/);
 await assert.rejects(app.releasePreview.exclude(owner,randomUUID(),{...input,content_hash:after.content_hash,excluded_files:['report.md']}),/INVALID_PACKAGE_EXCLUSION/);
 await assert.rejects(app.releasePreview.preview(other,{trace_id:saved.trace_id}),/NOT_FOUND/);
 const qc=await app.qc.run(owner,randomUUID(),saved.trace_id,{scope:'release'});assert.ok(qc.report);assert.equal(qc.report.content_kind,'research');assert.equal(qc.report.coverage.total_files,2);
});
test('research release assessment blocks credential-bearing files without changing private bytes',async t=>{
 const app=await setup(t),p=fixture();p.files[0]=file('report.md','api_key='+ 'x'.repeat(35),'text/markdown','report') as any;
 const saved=await imported(app,p);await app.portfolio.prepareSale(owner,randomUUID(),saved.trace_id,{content_commitment:canonicalHash(p),rights_confirmed:true,model_output_licensed:true});
 const preview=await app.releasePreview.preview(owner,{trace_id:saved.trace_id});assert.equal(preview.sale_eligibility.can_list,false);assert.equal(preview.rights_status,'rejected');assert.deepEqual((await app.library.item(owner,saved.trace_id)).content,p);
});
test('research rendering treats markup and code as inert text and preserves inventory',()=>{
 const p=fixture();p.files[0]!.text='<script>globalThis.executed=true</script>';const escape=(s:any)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const html=researchFilesHTML(p,escape,{editable:true});assert.equal(html.includes('<script>'),false);assert.match(html,/&lt;script&gt;/);assert.match(html,/calculate.py/);assert.match(html,/name="excluded_file"/);assert.match(html,/code is not executed/);
});


test('interrupted research writes publish no partial package and retry recovers one inventory item',async t=>{
 const app=await setup(t),p=fixture(),key=randomUUID(),seal=app.privacy.seal.bind(app.privacy);let writes=0;
 app.privacy.seal=async(...args:Parameters<typeof seal>)=>{if(++writes===2)throw Error('INJECTED_RESEARCH_WRITE_FAILURE');return seal(...args);};
 await assert.rejects(imported(app,p,key),/INJECTED_RESEARCH_WRITE_FAILURE/);assert.equal((await app.library.list(owner)).items.length,0);
 app.privacy.seal=seal;const saved=await imported(app,p,key);assert.equal((await app.library.list(owner)).items.length,1);assert.deepEqual((await app.library.item(owner,saved.trace_id)).content,p);
 assert.equal((await app.service.staged.cleanup()).failed,0);assert.equal((await imported(app,p,key)).trace_id,saved.trace_id);
});

test('concurrent research imports have one owner-bound identity and no duplicate inventory',async t=>{
 const app=await setup(t),p=fixture();const [first,second]=await Promise.all([imported(app,p),imported(app,p)]);assert.equal(first.trace_id,second.trace_id);assert.equal((await app.library.list(owner)).items.length,1);assert.equal((await app.service.staged.cleanup()).failed,0);
});
