import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogueTimeline,catalogueSummary} from '../apps/site/stats.js';
import worker,{publicCatalogue} from '../apps/site/edge-worker.js';
const asOf='2026-01-10T12:00:00Z';
test('timeline preserves flat days and sums only known nonnegative turns',()=>{
 const items=[{created_at:'2026-01-08T01:00:00Z',turn_count:12},{created_at:'2026-01-10T01:00:00Z',turn_count:3},{created_at:'invalid',turn_count:-8},{created_at:'2026-01-11',turn_count:9}];
 assert.deepEqual(catalogueTimeline(items,asOf).map(p=>p.value),[1,1,2]);
 assert.deepEqual(catalogueTimeline(items,asOf,'turns').map(p=>p.value),[12,12,15]);
 assert.deepEqual(catalogueTimeline([],asOf),[]);
 assert.deepEqual(catalogueTimeline(items,'invalid'),[]);
 assert.equal(catalogueSummary(items,asOf).week,2);
 assert.equal(catalogueSummary([{turn_count:12},{},{turn_count:-2}],asOf).turns,12);
});
test('public catalogue reads fixed public endpoints and returns allowlisted metadata only',async()=>{
 const requests=[];
 const result=await publicCatalogue(async(url,options)=>{
  requests.push({url,options});
  return Response.json(url.endsWith('/stats')?{listings_active:1,sellers_listing:1,independent:null}:{listings:[{title:'Synthetic listing',turn_count:5,created_at:asOf,private_original:'never expose',seller:'not needed',license:'not needed'}]});
 });
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.url.startsWith('https://app.thot.market/v1/public/')&&Object.keys(r.options.headers).join()==='Accept'&&r.options.redirect==='manual'));
 assert.deepEqual(result.listings,[{title:'Synthetic listing',turn_count:5,created_at:asOf}]);
 assert.equal(result.stats.independent,null);
 await assert.rejects(publicCatalogue(async()=>new Response('',{status:503})),/UNAVAILABLE/);
 await assert.rejects(publicCatalogue(async()=>new Response('',{status:302,headers:{Location:'https://elsewhere.example'}})),/UNAVAILABLE/);
 await assert.rejects(publicCatalogue(async()=>Response.json({})),/INVALID/);
});
test('edge route delegates assets and refuses writes without calling the upstream',async()=>{
 let assetRequests=0;
 const env={ASSETS:{fetch:async()=>{assetRequests++;return new Response('asset');}}};
 assert.equal(await(await worker.fetch(new Request('https://site.example/stats'),env,{})).text(),'asset');
 assert.equal(assetRequests,1);
 assert.equal((await worker.fetch(new Request('https://site.example/v1/public/catalogue',{method:'POST'}),env,{})).status,405);
});
