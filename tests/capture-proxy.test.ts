import test from 'node:test';
import assert from 'node:assert/strict';
import { clientInvocation, startCaptureProxy } from '../packages/capture/src/index.ts';

const bytes = (...values:number[]) => new Uint8Array(values);

test('proxy forwards exact request bytes and keeps authorization out of the capture bundle', async () => {
  const input=bytes(0,255,13,10,123,34,120,34,58,49,125);
  let received:any;
  const proxy=await startCaptureProxy({client:'claude',captureId:'capture-1',transport:async(url,init)=>{
    received={url,headers:new Headers(init?.headers),body:Buffer.from(init?.body as Uint8Array)};
    return new Response(bytes(9,8,7),{status:200,headers:{'Content-Type':'application/octet-stream'}});
  }});
  const response=await fetch(proxy.baseUrl+'/v1/messages?beta=1',{method:'POST',headers:{Authorization:'Bearer upstream-secret','anthropic-beta':'feature-x','Content-Type':'application/octet-stream'},body:input});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from([9,8,7]));
  const bundle=await proxy.finish();
  assert.equal(received.url,'https://api.anthropic.com/v1/messages?beta=1');
  assert.deepEqual(received.body,Buffer.from(input));
  assert.equal(received.headers.get('authorization'),'Bearer upstream-secret');
  assert.equal(received.headers.get('anthropic-beta'),'feature-x');
  assert.equal(received.headers.get('accept-encoding'),'identity');
  assert.equal(Buffer.from(bundle.exchanges[0].request_body_b64,'base64').compare(Buffer.from(input)),0);
  assert.equal(JSON.stringify(bundle).includes('upstream-secret'),false);
  assert.equal(Object.hasOwn(bundle.exchanges[0] as object,'headers'),false);
});

test('proxy streams the first SSE chunk before the upstream response ends', async () => {
  let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const stream=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(Buffer.from('data: first\n\n'));await barrier;controller.enqueue(Buffer.from('data: last\n\n'));controller.close();}});
  const proxy=await startCaptureProxy({client:'codex',captureId:'capture-stream',transport:async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}})});
  const response=await fetch(proxy.baseUrl+'/responses',{method:'POST',body:'{}'});
  const reader=response.body!.getReader();
  const first=await reader.read();
  assert.equal(Buffer.from(first.value!).toString(),'data: first\n\n');
  assert.equal(first.done,false);
  release();
  const second=await reader.read();
  assert.equal(Buffer.from(second.value!).toString(),'data: last\n\n');
  await reader.read();
  const bundle=await proxy.finish();
  assert.equal(Buffer.from(bundle.exchanges[0].response_body_b64,'base64').toString(),'data: first\n\ndata: last\n\n');
  assert.equal(bundle.exchanges[0].complete,true);
});

test('proxy preserves an upstream 401 response and records it', async () => {
  const proxy=await startCaptureProxy({client:'claude',captureId:'capture-401',transport:async()=>new Response('{"error":"expired"}',{status:401,headers:{'Content-Type':'application/json','WWW-Authenticate':'Bearer'}})});
  const response=await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body:'{}'});
  assert.equal(response.status,401);
  assert.equal(response.headers.get('www-authenticate'),'Bearer');
  assert.equal(await response.text(),'{"error":"expired"}');
  const bundle=await proxy.finish();
  assert.equal(bundle.exchanges[0].status,401);
  assert.equal(bundle.exchanges[0].complete,true);
});

test('browser-origin and unknown-path requests are rejected without reaching upstream', async () => {
  let upstreamCalls=0;
  const proxy=await startCaptureProxy({client:'claude',captureId:'capture-deny',transport:async()=>{upstreamCalls++;return new Response('unexpected');}});
  const browser=await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',headers:{Origin:'https://thot.example'},body:'{}'});
  const unknown=await fetch(proxy.baseUrl+'/v1/unknown',{method:'POST',body:'{}'});
  assert.equal(browser.status,403);
  assert.equal(unknown.status,404);
  assert.equal(upstreamCalls,0);
  const bundle=await proxy.finish();
  assert.deepEqual(bundle.exchanges,[]);
});

test('clientInvocation preserves the caller environment and never mutates it', () => {
  const original={PATH:'/custom/bin',CODEX_HOME:'/tmp/codex-login',OPENAI_API_KEY:'preserved-login-value'};
  const snapshot={...original};
  const invocation=clientInvocation('codex','http://127.0.0.1:4567/r/nonce/backend-api/codex',['exec','hello'],original);
  assert.deepEqual(original,snapshot);
  assert.notEqual(invocation.env,original);
  assert.deepEqual(invocation.env,{...snapshot,NO_PROXY:'127.0.0.1,localhost,::1',no_proxy:'127.0.0.1,localhost,::1'});
  assert.deepEqual(invocation.args.slice(0,2),['exec','hello']);
  assert.ok(invocation.args.some(value=>value.includes('requires_openai_auth=true')));

  const claudeEnv={PATH:'/bin',CLAUDE_CONFIG_DIR:'/tmp/claude-login'};
  const claude=clientInvocation('claude','http://127.0.0.1:4567/r/nonce',['--print'],claudeEnv);
  assert.deepEqual(claudeEnv,{PATH:'/bin',CLAUDE_CONFIG_DIR:'/tmp/claude-login'});
  assert.equal(claude.env.CLAUDE_CONFIG_DIR,'/tmp/claude-login');
  assert.equal(claude.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:4567/r/nonce');
});

test('native capture bypasses the local bridge without changing upstream proxy settings',()=>{
  for(const client of ['codex','claude'] as const){
    const original={HTTPS_PROXY:'http://127.0.0.1:7890',HTTP_PROXY:'http://127.0.0.1:7890',NO_PROXY:'internal.example, localhost',no_proxy:'example.test,127.0.0.1'};
    const snapshot={...original};
    const invocation=clientInvocation(client,'http://127.0.0.1:4567/r/nonce',[],original);
    assert.deepEqual(original,snapshot);
    assert.equal(invocation.env.HTTP_PROXY,original.HTTP_PROXY);
    assert.equal(invocation.env.HTTPS_PROXY,original.HTTPS_PROXY);
    assert.equal(invocation.env.NO_PROXY,'internal.example,localhost,example.test,127.0.0.1,::1');
    assert.equal(invocation.env.no_proxy,invocation.env.NO_PROXY);
  }
  const original={NO_PROXY:'internal.example',no_proxy:'example.test'};
  assert.deepEqual(clientInvocation('codex','https://upstream.example/responses',[],original).env,original);
});


test('Codex compressed bytes and model discovery preserve the subscription route',async()=>{
  const input=Buffer.from([40,181,47,253,1,2,3]);let forwarded:any;
  const proxy=await startCaptureProxy({client:'codex',captureId:'capture-compressed',transport:async(url,init)=>{forwarded={url,method:init?.method,encoding:new Headers(init?.headers).get('content-encoding'),body:init?.body};return new Response('{}',{headers:{'content-type':'application/json'}});}});
  await (await fetch(proxy.baseUrl+'/responses',{method:'POST',headers:{'Content-Encoding':'zstd'},body:input})).text();
  assert.equal(forwarded.encoding,'zstd');assert.deepEqual(Buffer.from(forwarded.body),input);
  await (await fetch(proxy.baseUrl+'/models?client_version=test')).text();assert.equal(forwarded.method,'GET');
  const bundle=await proxy.finish();assert.equal(bundle.exchanges[0].request_encoding,'zstd');assert.equal(bundle.exchanges[1].request_method,'GET');
});

test('browser independently verifies a proxy bundle and rejects changed committed bytes',async()=>{
  // @ts-expect-error Browser-native dashboard module has no declaration artifact.
  const {verifyProxyCapture}=await import('../apps/dashboard/agent-capture-ui.js');
  const proxy=await startCaptureProxy({client:'claude',captureId:'capture-verification',transport:async()=>new Response('{}')});
  await (await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body:'{}'})).text();const bundle=await proxy.finish();
  assert.equal((await verifyProxyCapture(bundle)).exchanges,1);
  const changed=structuredClone(bundle);changed.exchanges[0].response_body_b64=Buffer.from('{"changed":true}').toString('base64');
  await assert.rejects(()=>verifyProxyCapture(changed),/integrity check failed/);
});


test('client closing after a terminal SSE event does not discard upstream EOF',async()=>{
  let finish!:()=>void;
  const barrier=new Promise<void>(resolve=>{finish=resolve;});
  const stream=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(Buffer.from('data: {"type":"response.completed"}\n\n'));await barrier;controller.close();}});
  const proxy=await startCaptureProxy({client:'codex',captureId:'capture-terminal-close',transport:async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}})});
  const response=await fetch(proxy.baseUrl+'/responses',{method:'POST',body:'{}'}),reader=response.body!.getReader();
  assert.match(Buffer.from((await reader.read()).value!).toString(),/response.completed/);
  await reader.cancel();
  // Match clients that disconnect once their protocol event is complete, before HTTP EOF.
  await new Promise(resolve=>setTimeout(resolve,30));finish();
  const bundle=await proxy.finish();assert.equal(bundle.exchanges[0].complete,true);
});


test('Codex resume routing follows subcommand config and precedes literal prompts',()=>{
  const args=['resume','fixture-id','-c','model_provider="openai"','--','literal -c prompt'];
  const invocation=clientInvocation('codex','http://127.0.0.1:4567/r/test/backend-api/codex',args,{});
  assert.deepEqual(args,['resume','fixture-id','-c','model_provider="openai"','--','literal -c prompt']);
  assert.ok(invocation.args.indexOf('model_provider="thot_capture"')>invocation.args.indexOf('model_provider="openai"'));
  assert.deepEqual(invocation.args.slice(-2),['--','literal -c prompt']);
});
