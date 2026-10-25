import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {brotliCompressSync,constants} from 'node:zlib';
import {buildPrivyAuth} from '../scripts/build-privy-auth.mjs';

test('the split auth build is deterministic, fully manifested, and has a bounded initial dependency closure',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-privy-build-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=join(root,'first'),second=join(root,'second');
  const result=await buildPrivyAuth({outdir:first});await buildPrivyAuth({outdir:second});
  const bytes=await readFile(join(first,'privy-auth.assets.json'));
  assert.deepEqual(bytes,await readFile(join(second,'privy-auth.assets.json')));
  const manifest=JSON.parse(bytes);assert.equal(manifest.format,'thot.privy-assets/1');
  assert.ok(manifest.assets.length>1&&manifest.assets.length<=512);
  const files=new Map(manifest.assets.map(asset=>[asset.path,asset]));
  let total=0;
  for(const asset of manifest.assets){
    assert.match(asset.path,/^(?:app\.bundle\.js|privy-auth\.bundle\.js|privy-auth-chunks\/[A-Z0-9]{8}\.js)$/);
    const body=await readFile(join(first,asset.path));assert.equal(body.length,asset.bytes);
    assert.equal(createHash('sha256').update(body).digest('hex'),asset.sha256);
    assert.deepEqual(body,await readFile(join(second,asset.path)));total+=asset.bytes;
  }
  assert.ok(total<=32*1024*1024);
  assert.equal((await readdir(join(first,'privy-auth-chunks'))).length,manifest.assets.length-2); // minus the two entry bundles
  const outputs=result.metafile.outputs,entry=Object.keys(outputs).find(path=>resolve(path)===join(first,'privy-auth.bundle.js'));
  assert.ok(entry);const upfront=new Set();
  function visit(path){if(upfront.has(path))return;upfront.add(path);for(const item of outputs[path].imports)if(item.kind==='import-statement')visit(item.path);}
  visit(entry);
  let raw=0,br=0,dynamic=0;
  for(const [path,value] of Object.entries(outputs)){
    for(const item of value.imports){
      if(item.external){assert.equal(item.kind,'dynamic-import');assert.equal(item.path,'@farcaster/mini-app-solana','only the existing optional unsupported Solana mini-app import may stay external');continue;}
      assert.ok(outputs[item.path],`all local imports must be packaged: ${item.path}`);if(item.kind==='dynamic-import')dynamic++;
    }
    if(!upfront.has(path))continue;
    const body=await readFile(resolve(path));raw+=body.length;br+=brotliCompressSync(body,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}).length;
    assert.ok(files.has(relative(first,resolve(path)).split('\\').join('/')));
  }
  assert.ok(upfront.size>1,'measure the complete static closure, not just the entry');assert.ok(dynamic>0,'optional SDK interfaces remain lazy');
  assert.ok(raw<3_200_000,`initial decoded bytes ${raw}`);assert.ok(br<950_000,`initial Brotli bytes ${br}`);
  t.diagnostic(JSON.stringify({static_initial_files:upfront.size,static_initial_decoded_bytes:raw,static_initial_brotli_bytes:br,total_files:files.size,total_decoded_bytes:total,note:'Actual modal dynamic imports must also be measured in real browser acceptance.'}));
});
