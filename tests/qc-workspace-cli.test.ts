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
