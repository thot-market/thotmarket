import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCloudflarePages,publicFiles} from '../scripts/build-cloudflare-pages.ts';
import {readPublicAsset} from '../apps/api/public-site.ts';

// Check the distributed source itself, not the fuller private checkout's inventory.
test('every declared public-site build input exists and served assets resolve', async () => {
  for (const [output,input] of Object.entries(publicFiles)) {
    const bytes=await readFile(new URL('../apps/site/'+input,import.meta.url));
    assert(bytes.length>0,input);
    const response=await readPublicAsset('/'+output);
    if(response)assert(response.body.length>0,output);
  }
  for(const path of ['/','/read','/tutorial','/whitepaper','/mechanism','/affiliates','/favicon.png']){
    const response=await readPublicAsset(path);assert(response?.body.length,path);
  }
});

test('source capture helper resolves an inert fallback without private descriptors', async () => {
  const {recorderPolicyFile}=await import('../packages/capture/src/tee/policy-file.ts');
  const {fileURLToPath}=await import('node:url');
  assert.equal(await recorderPolicyFile('https://unknown.example.invalid',{}),
    fileURLToPath(new URL('../deploy/tee-recorder-policy.json',import.meta.url)));
  assert.equal(await recorderPolicyFile('https://unknown.example.invalid',{THOT_RECORDER_POLICY_FILE:'/explicit/policy.json'}),'/explicit/policy.json');
});

test('static production and configured private bundles give every ordinary CTA its correct app origin', async t => {
  const outputParent=await mkdtemp(join(tmpdir(),'thot-public-entry-'));
  t.after(()=>rm(outputParent,{recursive:true,force:true}));
  for(const appUrl of [undefined,'https://configured.example/app']){
    const build=await buildCloudflarePages({outputParent,appUrl,zip:false});
    const target=appUrl??'https://app.thot.market/app';
    const config=JSON.parse(await readFile(join(build.directory,'v1/public/site-config.json'),'utf8'));
    assert.equal(config.appUrl,target);
    for(const name of ['index','read','tutorial','mechanism','whitepaper','affiliates']){
      const html=await readFile(join(build.directory,name+'.html'),'utf8');
      const links=html.match(/<a\b[^>]*\bdata-workspace-link\b[^>]*>/g);assert.ok(links?.length,name);
      for(const link of links)assert.ok(link.includes('href="'+target+'"')||link.includes('href="'+target+'#'),link);
    }
  }
});
