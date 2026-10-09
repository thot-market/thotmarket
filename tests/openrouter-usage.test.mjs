import test from 'node:test';
import assert from 'node:assert/strict';
import {renderOpenRouterUsage} from '../apps/dashboard/openrouter-usage.js';

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const request=(usage={},extra={})=>({status:'COMPLETED',requested_model:'synthetic/requested',returned_model:'synthetic/returned',created_at:'2026-01-01T12:00:00Z',usage,...extra});
const render=rows=>renderOpenRouterUsage(rows,escape);
const summary=html=>html.split('<div class="usage-summary">')[1].split('<p class="usage-scope">')[0];
const cards=html=>html.split('<div class="usage-request-list">')[1]??'';

test('recent summary adds reported costs as decimals and preserves input/output units',()=>{
  const html=render([request({prompt_tokens:1000,completion_tokens:20,cost:0.1}),request({prompt_tokens:2000,completion_tokens:30,cost:0.2})]);
  assert.match(summary(html),/Reported cost \(USD\)<\/span><strong>\$0\.30<\/strong>/);
  assert.match(summary(html),/Input tokens<\/span><strong>3,000<\/strong>/);
  assert.match(summary(html),/Output tokens<\/span><strong>50<\/strong>/);
  assert.match(summary(html),/Recent requests<\/span><strong>2<\/strong>/);
  assert.equal((summary(html).match(/2 of 2 requests reported/g)??[]).length,3);
  assert.doesNotMatch(html,/0\.30000000000000004/);
});

test('unknown and invalid metrics never become zero, including interrupted calls',()=>{
  const html=render([request({}, {status:'INTERRUPTED'}),request({prompt_tokens:-1,completion_tokens:1.5,cost:NaN}),request({prompt_tokens:'4',completion_tokens:Infinity,cost:-1})]);
  assert.equal((summary(html).match(/Not reported/g)??[]).length,3);
  assert.equal((summary(html).match(/0 of 3 requests reported · partial coverage/g)??[]).length,3);
  assert.doesNotMatch(html,/\$0\.00/);
  assert.match(html,/Interrupted/);
  assert.match(html,/Incomplete requests can still incur an OpenRouter charge\. Missing values do not mean zero/);
});

test('known zero cost and token counts are displayed and included in coverage',()=>{
  const html=render([request({prompt_tokens:0,completion_tokens:0,cost:0})]);
  assert.match(summary(html),/Reported cost \(USD\)<\/span><strong>\$0\.00/);
  assert.equal((cards(html).match(/<strong>0<\/strong>/g)??[]).length,2);
  assert.equal((summary(html).match(/1 of 1 requests reported/g)??[]).length,3);
  assert.doesNotMatch(html,/partial coverage|Not reported/);
});

test('tiny positive costs never display as zero, and their sum retains precision',()=>{
  const html=render([request({cost:0.000000005}),request({cost:0.000000005}),request({cost:Number.MIN_VALUE})]);
  assert.match(summary(html),/\$0\.00000001/);
  assert.equal((cards(html).match(/&lt;\$0\.00000001/g)??[]).length,3);
  assert.doesNotMatch(html,/\$0\.00<\/strong>/);
});

test('each metric has independent known coverage and includes known interrupted usage',()=>{
  const html=render([request({prompt_tokens:5,completion_tokens:3,cost:0.004}),request({prompt_tokens:7},{status:'INTERRUPTED'}),request({completion_tokens:9,cost:0})]);
  assert.match(summary(html),/Input tokens<\/span><strong>12<\/strong>/);
  assert.match(summary(html),/Output tokens<\/span><strong>12<\/strong>/);
  assert.match(summary(html),/Reported cost \(USD\)<\/span><strong>\$0\.004<\/strong>/);
  assert.equal((summary(html).match(/2 of 3 requests reported · partial coverage/g)??[]).length,3);
  assert.match(cards(html),/Not reported/);
});

test('unsafe token numbers are unknown and safe individual counts sum without precision loss',()=>{
  const html=render([request({prompt_tokens:Number.MAX_SAFE_INTEGER}),request({prompt_tokens:Number.MAX_SAFE_INTEGER}),request({prompt_tokens:Number.MAX_SAFE_INTEGER+1})]);
  assert.match(summary(html),/18,014,398,509,481,982/);
  assert.match(summary(html),/2 of 3 requests reported · partial coverage/);
  assert.match(cards(html),/Not reported/);
});

test('limits the view and aggregate to the latest 50 supplied owner requests',()=>{
  const html=render(Array.from({length:51},(_,i)=>request({prompt_tokens:1,completion_tokens:2,cost:i===50?999:0.01},{returned_model:i===50?'EXCLUDED MODEL':'synthetic/returned'})));
  assert.equal((html.match(/<article class="usage-request">/g)??[]).length,50);
  assert.match(summary(html),/\$0\.50/);
  assert.match(summary(html),/Input tokens<\/span><strong>50<\/strong>/);
  assert.match(summary(html),/Output tokens<\/span><strong>100<\/strong>/);
  assert.doesNotMatch(html,/EXCLUDED MODEL|999/);
  assert.match(html,/up to 50 recent requests sent through THOT/);
  assert.match(html,/not your complete OpenRouter account bill and exclude calls made elsewhere/);
});

test('only allowlisted metadata renders and every provider string is escaped',()=>{
  const html=render([request({prompt_tokens:2,cost:0},{requested_model:'<img src=x onerror=alert(1)>',returned_model:'<script>bad()</script>',provider_name:'" onclick="bad',status:'<svg onload=bad()>',created_at:'<script>bad date</script>',prompt:'PRIVATE_PROMPT',api_key:'PRIVATE_KEY',response:{content:'PRIVATE_RESPONSE'}})]);
  assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html,/&quot; onclick=&quot;bad/);
  assert.match(html,/Status not reported/);
  assert.match(html,/Time not reported/);
  assert.doesNotMatch(html,/<script|<img|<svg|PRIVATE_PROMPT|PRIVATE_KEY|PRIVATE_RESPONSE|bad date/);
  assert.match(render([request({},{status:'__proto__'})]),/Status not reported/);
});

test('empty history has clear scope and unknown totals rather than a zero bill',()=>{
  for(const rows of [[],undefined,null]){
    const html=render(rows);
    assert.match(html,/No relay requests recorded yet/);
    assert.match(html,/OpenRouter bills your OpenRouter account/);
    assert.match(html,/THOT does not debit you for these model calls/);
    assert.match(html,/Recent requests<\/span><strong>0<\/strong>/);
    assert.equal((summary(html).match(/Not reported/g)??[]).length,3);
    assert.doesNotMatch(html,/\$0\.00|partial coverage/);
  }
});
