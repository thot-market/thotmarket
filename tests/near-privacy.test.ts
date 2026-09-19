import test from 'node:test';
import assert from 'node:assert/strict';
import {NearPrivacyFilter} from '../packages/scrubber/src/near-privacy.ts';
const trace={turns:[{role:'user' as const,content:'🙂 Contact Jane Doe at jane@example.com.'}]};
test('validates code-point spans and preserves whitespace without mutating originals',async()=>{
 const client=new NearPrivacyFilter('synthetic',async()=>new Response(JSON.stringify({model:'openai/privacy-filter',data:[{index:0,spans:[{category:'private_person',start:9,end:18,text:' Jane Doe'}]}]})));
 const result=await client.filter(trace);assert.equal(result.trace.turns[0].content,'🙂 Contact [REDACTED] at jane@example.com.');assert.equal(result.status,'near_complete');assert.equal(trace.turns[0].content,'🙂 Contact Jane Doe at jane@example.com.');
});
test('credit exhaustion falls back and opens the circuit',async()=>{let count=0;const client=new NearPrivacyFilter('synthetic',async()=>{count++;return new Response('',{status:402});});assert.equal((await client.filter(trace)).status,'fallback_provider_unavailable');assert.equal((await client.filter(trace)).trace,trace);assert.equal(count,1);});
test('invalid span and oversized input fall back without replacing baseline content',async()=>{
 const client=new NearPrivacyFilter('synthetic',async()=>new Response(JSON.stringify({model:'openai/privacy-filter',data:[{index:0,spans:[{category:'private_person',start:9,end:18,text:'wrong'}]}]})));
 assert.equal((await client.filter(trace)).trace,trace);
 const large={turns:[{role:'user' as const,content:'a'.repeat(7000)}]};assert.equal((await new NearPrivacyFilter('x',async()=>{throw Error('must not call');}).filter(large)).status,'fallback_size_limit');
});
