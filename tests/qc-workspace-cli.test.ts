import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {main} from '../scripts/qc-workspace.ts';
import {contentDigest} from '../packages/qc/index.ts';

test('QC workspace exports exact content privately, checks offline, and refuses redirects and unsafe credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'qc-workspace-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const content={turns:[{role:'user',content:'Synthetic local review question'},{role:'assistant',content:'Synthetic answer'}]},source={schema_version:'trace-qc-export/v1',selected_source:{scope:'private',content_hash:contentDigest(content)},content};
  let redirect=false,requests=0;
  const server=createServer((req,res)=>{requests++;assert.equal(req.headers.authorization,'Bearer synthetic-session');if(redirect){res.writeHead(302,{Location:'https://example.invalid/'});res.end();return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(source));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert(address&&typeof address==='object');
  const config=join(dir,'config.json'),output=join(dir,'export.json'),report=join(dir,'report.json');
  await writeFile(config,JSON.stringify({origin:'http://127.0.0.1:'+address.port,token:'synthetic-session'}),{mode:0o600});
  await main(['export','--config',config,'--trace','synthetic','--output',output]);assert.equal((await stat(output)).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),source);
  await main(['check','--input',output,'--output',report]);assert.equal(requests,1);assert.equal(JSON.parse(await readFile(report,'utf8')).report.content_digest,source.selected_source.content_hash);
  await assert.rejects(main(['check','--input',output,'--output',report]),/EEXIST/);
  source.content.turns[0]!.content='Changed after export';await writeFile(output,JSON.stringify(source));
  await assert.rejects(main(['check','--input',output,'--output',join(dir,'changed.json')]),/CONTENT_CHANGED/);
  await chmod(config,0o644);await assert.rejects(main(['inventory','--config',config,'--output',join(dir,'inventory.json')]),/CONFIG_PERMISSIONS/);
  await chmod(config,0o600);redirect=true;
  await assert.rejects(main(['inventory','--config',config,'--output',join(dir,'redirect.json')]));
  assert.equal(requests,2);
});

test('downloaded QC connection imports privately and logout revokes before deleting it',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'qc-connect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const download=join(dir,'download.json'),saved=join(dir,'private.json'),token='qc_'+'s'.repeat(43);
  await writeFile(download,JSON.stringify({origin:'https://example.test',token,scope:'local_qc'}),{mode:0o644});
  const original=globalThis.fetch;let revoked=false;
  globalThis.fetch=async(input,options)=>{
    assert.equal((options!.headers as any).Authorization,'Bearer '+token);
    const path=new URL(String(input)).pathname;
    if(path==='/v1/auth/session')return Response.json({actor:{role:'operator_security'},scope:'local_qc',expires_at:'2030-01-01T00:00:00Z'});
    assert.equal(path,'/v1/auth/session/revoke');revoked=true;return Response.json({revoked:true});
  };t.after(()=>{globalThis.fetch=original;});
  await main(['login','--config',download,'--output',saved]);
  assert.equal((await stat(download)).mode&0o777,0o600);assert.equal((await stat(saved)).mode&0o777,0o600);
  await main(['logout','--config',saved]);assert.equal(revoked,true);await assert.rejects(stat(saved),/ENOENT/);
  assert.equal(JSON.parse(await readFile(download,'utf8')).token,token,'only the imported connection is removed');
  await writeFile(saved,await readFile(download),{mode:0o600});
  globalThis.fetch=async()=>Response.json({error:'UNAVAILABLE'},{status:503});
  await assert.rejects(main(['logout','--config',saved]),/HTTP_503/);await stat(saved);
  globalThis.fetch=async()=>Response.json({error:'UNAUTHENTICATED'},{status:401});
  await main(['logout','--config',saved]);await assert.rejects(stat(saved),/ENOENT/);
});

test('batch pull skips private sources and reports revoked permission; judgments bind the exported version',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qc-batch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const content={turns:[{role:'user',content:'Synthetic task'},{role:'assistant',content:'Synthetic response'}]},version='a'.repeat(64),paths:string[]=[];
 const server=createServer((req,res)=>{const path=new URL(req.url!,'http://localhost').pathname;paths.push(path);res.setHeader('Content-Type','application/json');
  if(path==='/v1/operator/trace-explorer'){res.end(JSON.stringify({has_more:false,items:[{qc_sources:[{trace_id:'allowed',source_version:version,review_allowed:true},{trace_id:'private',source_version:version,review_allowed:false},{trace_id:'revoked',source_version:version,review_allowed:true}]}]}));return;}
  if(path.endsWith('/revoked/source')){res.statusCode=403;res.end('{}');return;}
  assert.equal(path,'/v1/operator/local-qc/allowed/source');res.end(JSON.stringify({schema_version:'trace-qc-export/v1',selected_source:{scope:'release',source_version:version,content_hash:contentDigest(content)},content}));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const address=server.address();assert(address&&typeof address==='object');
 const config=join(dir,'config.json'),batch=join(dir,'batch');await writeFile(config,JSON.stringify({origin:'http://127.0.0.1:'+address.port,token:'synthetic'}),{mode:0o600});
 await main(['pull','--config',config,'--directory',batch]);
 const index=JSON.parse(await readFile(join(batch,'index.json'),'utf8'));assert.deepEqual(index.entries.map((e:any)=>e.status),['ready','unavailable']);assert.ok(!paths.some(p=>p.includes('/private/')));
 const verdict=join(dir,'verdict.json');await main(['judge','--input',index.entries[0].source,'--verdict','flag','--usefulness','2','--completeness','3','--evaluator','rubric-v1','--output',verdict]);
 assert.deepEqual(JSON.parse(await readFile(verdict,'utf8')),{source_version:version,verdict:'flag',usefulness:2,completeness:3,evaluator:'rubric-v1'});
});
