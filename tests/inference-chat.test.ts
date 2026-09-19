import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIChatProvider, maximumReservation } from '../packages/inference/src/index.ts';

const now=Date.parse('2026-09-09T20:00:00Z');
const card={version:'zai/2026-09-09',model:'glm-4.7',service_tier:'default' as const,currency:'USD' as const,input_micro_usd_per_million:'600000',cached_micro_usd_per_million:'110000',
  cache_write_micro_usd_per_million:null,output_micro_usd_per_million:'2200000',max_input_tokens:4000,max_output_tokens:256,verified_at:'2026-09-09T19:00:00Z',expires_at:'2026-09-15T19:00:00Z',verified:true as const,example_only:false as const};
function provider(reply:unknown){
  const calls:Array<{url:string;body:any;headers:any}>=[];
  const transport=(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(init.body),headers:init.headers});
    return new Response(JSON.stringify(reply),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  return {calls,adapter:new OpenAIChatProvider({apiKey:'offline-test-secret',baseUrl:'https://api.z.ai/api/paas/v4/',rateCard:card,clock:()=>new Date(now)},transport)};
}
const reply={id:'chatcmpl-20260909-abc',model:'glm-4.7',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'attested gateway works'}}],
  usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:2}}};

test('chat provider posts to the configured base URL and meters usage at the rate card',async()=>{
  const {calls,adapter}=provider(reply);
  assert.equal(adapter.provider,'api.z.ai');
  assert.equal(await adapter.count('a prompt of some bytes','r'),Buffer.byteLength('a prompt of some bytes'));
  const result=await adapter.generate('reply with exactly: attested gateway works','req-1');
  assert.equal(calls[0]!.url,'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(calls[0]!.headers.Authorization,'Bearer offline-test-secret');
  assert.deepEqual(calls[0]!.body,{model:'glm-4.7',messages:[{role:'user',content:'reply with exactly: attested gateway works'}],max_tokens:256,stream:false});
  assert.equal(result.status,'COMPLETED');assert.equal(result.text,'attested gateway works');
  assert.deepEqual(result.usage,{input_tokens:12,cached_tokens:2,cache_write_tokens:0,output_tokens:4,total_tokens:16});
  assert.equal(result.actual_minor,'1');  // 10*0.6 + 2*0.11 + 4*2.2 micro-USD-per-million tokens rounds up to one cent
  assert.equal(maximumReservation(card),'1');  // 4000 input tokens at $0.60/M plus 256 output at $2.20/M is under one cent
});

test('chat provider rejects a different model, tool calls, and oversized prompts',async()=>{
  await assert.rejects(provider({...reply,model:'glm-4.5'}).adapter.generate('x','r'),/INFERENCE_MODEL_OR_TIER_MISMATCH/);
  await assert.rejects(provider({...reply,choices:[{...reply.choices[0],message:{...reply.choices[0]!.message,tool_calls:[{}]}}]}).adapter.generate('x','r'),/UNEXPECTED_INFERENCE_TOOL_OUTPUT/);
  await assert.rejects(provider(reply).adapter.count('x'.repeat(4001),'r'),/INFERENCE_INPUT_TOO_LARGE/);
  assert.throws(()=>new OpenAIChatProvider({apiKey:'offline-test-secret',baseUrl:'http://api.z.ai/api/paas/v4',rateCard:card,clock:()=>new Date(now)}),/INVALID_INFERENCE_BASE_URL/);
});
