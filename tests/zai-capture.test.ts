import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {canonicalHash} from '../packages/protocol/src/index.ts';
import {clientInvocation,startCaptureProxy} from '../packages/capture/src/index.ts';
import {readiness} from '../packages/capture/src/setup.ts';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {normalizeProxyExchange,projectProxyExchange,proxyModelIdentity} from '../packages/market/src/proxy-normalization.ts';
import {parseClaudeCodeJsonl,parseCodingSessionJsonl} from '../packages/market/src/history-import.ts';

// Bodies of one real GLM exchange, recorded through the zai capture proxy.
const fixture=JSON.parse(await readFile(new URL('./fixtures/zai-glm-exchange.json',import.meta.url),'utf8')) as {request:unknown;response:string};
const requestBytes=Buffer.from(JSON.stringify(fixture.request));
const responseBytes=Buffer.from(fixture.response);

test('zai invocation runs claude against the local bridge with a required environment token',()=>{
  const proxyUrl='http://127.0.0.1:4567/r/nonce';
  const base={PATH:'/bin',HOME:'/tmp',ANTHROPIC_AUTH_TOKEN:'zai-key-fixture'};
  const snapshot={...base};
  const invocation=clientInvocation('zai',proxyUrl,['-p','hello'],base);
  assert.deepEqual(base,snapshot);
  assert.equal(invocation.command,'claude');
  assert.equal(invocation.env.ANTHROPIC_BASE_URL,proxyUrl);
  assert.equal(invocation.env.ANTHROPIC_AUTH_TOKEN,'zai-key-fixture');
  // Z.AI is a third-party gateway: the first-party assumption is never set and
  // never inherited from the caller.
  assert.equal('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL' in invocation.env,false);
  const inherited=clientInvocation('zai',proxyUrl,[],{...base,_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL:'1'});
  assert.equal('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL' in inherited.env,false);
  // A launch-time settings override pins the route and the token so user
  // settings cannot redirect this child or swap in another gateway credential.
  const settings=JSON.parse(invocation.privateSettings!.content) as {env:Record<string,string>};
  assert.deepEqual(settings.env,{ANTHROPIC_BASE_URL:proxyUrl,ANTHROPIC_AUTH_TOKEN:'zai-key-fixture'});
  assert.equal(invocation.args.includes('zai-key-fixture'),false);
  assert.equal(invocation.args.join(' ').includes('zai-key-fixture'),false);
  assert.equal(invocation.args[invocation.privateSettings!.argumentIndex],'THOT_PRIVATE_SETTINGS_FILE');
  assert.deepEqual(clientInvocation('zai',proxyUrl,['-p','hi','--','literal'],base).args.slice(-2),['--','literal']);
  const merged=clientInvocation('zai',proxyUrl,['--settings','{"disableAllHooks":true}','-p','hello'],base);
  assert.equal((JSON.parse(merged.privateSettings!.content) as {disableAllHooks?:boolean}).disableAllHooks,true);
  // The token must come from this child's environment, not from settings or an API key.
  assert.throws(()=>clientInvocation('zai',proxyUrl,[],{PATH:'/bin'}),/ZAI_AUTH_TOKEN_REQUIRED/);
  assert.throws(()=>clientInvocation('zai',proxyUrl,[],{PATH:'/bin',ANTHROPIC_AUTH_TOKEN:'t',ANTHROPIC_API_KEY:'k'}),/ZAI_API_KEY_NOT_SUPPORTED/);
  assert.throws(()=>clientInvocation('zai',proxyUrl,['--settings','{"env":{"ANTHROPIC_AUTH_TOKEN":"other"}}'],base),/ZAI_AUTH_TOKEN_FROM_ENVIRONMENT_ONLY/);
  // The subscription client still refuses ambient credentials.
  assert.throws(()=>clientInvocation('claude',proxyUrl,[],{PATH:'/bin',ANTHROPIC_API_KEY:'k'}),/USE_SUBSCRIPTION_LOGIN_REMOVE_API_OVERRIDE/);
  assert.throws(()=>clientInvocation('claude',proxyUrl,[],{PATH:'/bin',ANTHROPIC_AUTH_TOKEN:'t'}),/USE_SUBSCRIPTION_LOGIN_REMOVE_API_OVERRIDE/);
});

test('zai proxy relays to the Z.AI Anthropic endpoint and records the api.z.ai upstream',async()=>{
  let forwarded:any;
  const proxy=await startCaptureProxy({client:'zai',captureId:'capture-zai',transport:async(url,init)=>{
    forwarded={url,method:init?.method,authorization:new Headers(init?.headers).get('authorization')};
    return new Response('data: {"type":"message_stop"}\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
  }});
  const response=await fetch(proxy.baseUrl+'/v1/messages?beta=true',{method:'POST',headers:{Authorization:'Bearer zai-key-fixture','Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);
  // The Anthropic-protocol route set is shared with claude; codex routes stay closed.
  const rejected=await fetch(proxy.baseUrl+'/backend-api/codex/responses',{method:'POST',body:'{}'});
  assert.equal(rejected.status,404);
  const bundle=await proxy.finish();
  assert.equal(forwarded.url,'https://api.z.ai/api/anthropic/v1/messages?beta=true');
  assert.equal(forwarded.method,'POST');
  assert.equal(forwarded.authorization,'Bearer zai-key-fixture');
  assert.equal(bundle.client,'zai');
  assert.equal(bundle.exchanges.length,1);
  assert.equal(bundle.exchanges[0].upstream,'https://api.z.ai');
  assert.equal(bundle.exchanges[0].path,'/v1/messages?beta=true');
  assert.equal(JSON.stringify(bundle).includes('zai-key-fixture'),false);
});

test('claude proxy still targets api.anthropic.com without a path prefix',async()=>{
  let url:string|undefined;
  const proxy=await startCaptureProxy({client:'claude',captureId:'capture-claude-prefix',transport:async(target)=>{url=String(target);return new Response('{}');}});
  await (await fetch(proxy.baseUrl+'/v1/messages',{method:'POST',body:'{}'})).text();
  await proxy.finish();
  assert.equal(url,'https://api.anthropic.com/v1/messages');
});

test('zai readiness checks the Claude CLI and a token in the child environment only',async t=>{
  const root=await mkdtemp(join(tmpdir(),'thot-zai-readiness-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin');await mkdir(bin,{recursive:true});
  await writeFile(join(bin,'claude'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const base={...process.env,PATH:bin,THOT_USER_HOME:root,ANTHROPIC_AUTH_TOKEN:''};
  const environmentKeys=['PATH','THOT_USER_HOME','ANTHROPIC_AUTH_TOKEN'] as const;
  const savedEnvironment=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
  t.after(()=>{
    for(const key of environmentKeys){
      const value=savedEnvironment[key];
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  });
  // Direct probe: no login or configuration file is read; only PATH and env decide.
  process.env.PATH=bin;
  process.env.THOT_USER_HOME=root;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const missing=await readiness('zai');
  assert.equal(missing.checks.find(c=>c.id==='client')!.label,'Claude Code installed');
  assert.equal(missing.checks.find(c=>c.id==='client')!.ok,true);
  assert.equal(missing.checks.find(c=>c.id==='zai-token')!.ok,false);
  assert.equal(missing.ready,false);
  process.env.ANTHROPIC_AUTH_TOKEN='zai-key-fixture';
  const present=await readiness('zai');
  assert.equal(present.checks.find(c=>c.id==='zai-token')!.ok,true);
  assert.equal(present.ready,true);
  // The setup command reports the same gap with actionable guidance.
  const script=await new Promise<{code:number|null;output:string}>(resolve=>{
    const child=spawn(process.execPath,['scripts/thot-setup.ts','zai'],{env:{...base},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    child.on('close',code=>resolve({code,output}));
  });
  assert.equal(script.code,1);
  assert.match(script.output,/Z\.AI token in ANTHROPIC_AUTH_TOKEN/);
  assert.match(script.output,/ANTHROPIC_AUTH_TOKEN/);
});

test('a real GLM exchange normalizes through the claude parser with GLM model ids',()=>{
  const normalized=normalizeProxyExchange('zai',requestBytes,responseBytes);
  assert.deepEqual(normalized.turns,[
    {role:'user',content:'Reply with exactly: zai capture fixture'},
    {role:'assistant',content:'zai capture fixture'},
  ]);
  const view=projectProxyExchange('zai',requestBytes,responseBytes);
  assert.deepEqual(view.issues,[]);
  assert.equal(view.context_turn_count,1);
  const identity=proxyModelIdentity('zai',requestBytes,responseBytes);
  assert.equal(identity.source,'zai');
  assert.equal(identity.requested_model,'glm-5.3-flash');
  assert.equal(identity.returned_model,'glm-5.3-flash');
  // Non-streamed GLM replies and other GLM model ids take the same path.
  const json=projectProxyExchange('zai',Buffer.from(JSON.stringify({model:'glm-5.3',messages:[{role:'user',content:'Read the GLM release notes.'}]})),Buffer.from(JSON.stringify({type:'message',model:'glm-5.3',content:[{type:'thinking',thinking:'hidden',signature:'opaque'},{type:'text',text:'Noted.'}],stop_reason:'end_turn'})));
  assert.deepEqual(json.turns,[{role:'user',content:'Read the GLM release notes.'},{role:'assistant',content:'Noted.'}]);
  assert.equal(proxyModelIdentity('zai',requestBytes,Buffer.from(JSON.stringify({model:'glm-5.3-flash'}))).returned_model,'glm-5.3-flash');
});

async function application(t:any){
  const app=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-zai-capture-'))});
  t.after(async()=>app.close());
  return app;
}
function zaiBundle(captureId:string,upstream='https://api.z.ai'){
  const now=new Date().toISOString();
  const record={sequence:1,upstream,path:'/v1/messages?beta=true',request_body_b64:requestBytes.toString('base64'),response_body_b64:responseBytes.toString('base64'),status:200,content_type:'text/event-stream; charset=utf-8',started_at:now,finished_at:now,complete:true};
  const exchange={...record,commitment:canonicalHash(record)};
  const value={format:'thot.proxy-capture/1' as const,capture_id:captureId,client:'zai' as const,started_at:now,finished_at:now,exchanges:[exchange]};
  return {...value,root:canonicalHash({format:value.format,capture_id:captureId,client:value.client,started_at:value.started_at,finished_at:value.finished_at,commitments:[exchange.commitment]})};
}

test('market validation accepts a zai capture and counts its model exchange',async t=>{
  const app=await application(t);
  const begun=await app.agentCapture.begin({id:'demo-user',role:'user'},{client:'zai',save_privately:true});
  const saved=await app.agentCapture.complete(begun.capture_id,begun.upload_token,'zai-complete',{bundle:zaiBundle(begun.capture_id)});
  assert.equal(saved.status,'SAVED');
  assert.equal(saved.capture_summary.model_exchanges,1);
  assert.equal(saved.capture_summary.exchanges,1);
  const trace=(await app.db.query('SELECT document FROM traces WHERE id=$1',[saved.trace_id])).rows[0]!.document;
  assert.equal(trace.capture_model.source,'zai');
  assert.equal(trace.capture_model.returned_model,'glm-5.3-flash');
  assert.equal(trace.capture_preview.source,'Claude Code (Z.AI)');
  assert.equal(trace.native_session_keys.length,1);
  assert.equal(trace.projection.status,'READY');
  assert.equal(trace.capture_summary.display_issues,0);
  // A zai trace is distinguishable from an Anthropic one: the upstream is bound to the client.
  const other=await app.agentCapture.begin({id:'demo-user',role:'user'},{client:'zai',save_privately:true});
  await assert.rejects(app.agentCapture.complete(other.capture_id,other.upload_token,'zai-wrong-upstream',{bundle:zaiBundle(other.capture_id,'https://api.anthropic.com')}),/INVALID_CAPTURE_UPSTREAM/);
  await assert.rejects(app.agentCapture.begin({id:'demo-user',role:'user'},{client:'openrouter',save_privately:true} as any),/INVALID_AGENT_CAPTURE_CLIENT/);
});

test('a Claude Code session on Z.AI imports with its upstream and model recorded',()=>{
  const line=(value:unknown)=>JSON.stringify(value);
  // Records of one real GLM session (glm-5.3) from this VM's Claude Code history.
  const glmSession=[
    line({type:'user',sessionId:'s-zai',timestamp:'2026-09-23T20:00:00Z',cwd:'/home/agent',message:{role:'user',content:'Reply with exactly the model id you are running as, nothing else.'}}),
    line({type:'assistant',sessionId:'s-zai',timestamp:'2026-09-23T20:00:37Z',message:{role:'assistant',model:'glm-5.3',content:[{type:'thinking',thinking:'The user asked which model id I run as.',signature:'opaque'}]}}),
    line({type:'assistant',sessionId:'s-zai',timestamp:'2026-09-23T20:00:39Z',message:{role:'assistant',model:'glm-5.3',content:[{type:'text',text:'glm-5.3[1m]'}]}}),
  ].join('\n');
  const result=parseClaudeCodeJsonl(glmSession);
  assert.equal(result.source.upstream,'https://api.z.ai');
  assert.equal(result.preview.source_label,'Claude Code (Z.AI) (user supplied)');
  assert.equal(result.preview.title,'Claude Code (Z.AI): agent');
  assert.deepEqual(result.model_history.map(m=>m.claimed_model),['glm-5.3']);
  assert.match(result.limitations.join(' '),/inferred from those GLM model names/);
  // Claude Code may append the [1m] context-window suffix to a GLM model id.
  const longContext=parseClaudeCodeJsonl(line({type:'assistant',sessionId:'s-zai-1m',message:{role:'assistant',model:'glm-5.3[1m]',content:'wide window'}}));
  assert.equal(longContext.source.upstream,'https://api.z.ai');
  assert.equal(longContext.model_history[0]!.claimed_model,'glm-5.3[1m]');
  // The inference is specific to Claude Code sessions; codex-jsonl stays unlabeled.
  const codexGlm=parseCodingSessionJsonl([
    line({type:'session_meta',payload:{id:'00000000-0000-0000-0000-000000000000'}}),
    line({type:'turn_context',payload:{model:'glm-5.3'}}),
    line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'hello'}]}}),
  ].join('\n'));
  assert.equal('upstream' in codexGlm.source,false);
  // An Anthropic-model session stays unlabeled; a mixed-provider session is rejected clearly.
  const anthropic=parseClaudeCodeJsonl(line({type:'user',sessionId:'s-claude',message:{role:'user',content:'Research AAPL'}})+ '\n' + line({type:'assistant',sessionId:'s-claude',message:{role:'assistant',model:'claude-sonnet-4-5',content:'Done.'}}));
  assert.equal('upstream' in anthropic.source,false);
  assert.throws(()=>parseClaudeCodeJsonl(glmSession+'\n'+line({type:'assistant',sessionId:'s-zai',message:{role:'assistant',model:'claude-sonnet-4-5',content:'switched'}})),/MIXED_UPSTREAM/);
});

test('the recorded fixture carries no credentials',async()=>{
  const raw=await readFile(new URL('./fixtures/zai-glm-exchange.json',import.meta.url),'utf8');
  assert.equal(raw.includes('Bearer'),false);
  assert.equal(raw.includes('authorization'),false);
  assert.equal(/[0-9a-f]{16,}\.[0-9a-zA-Z]{8,}/.test(raw),false);
});

test('the TEE recorder accepts a zai session and relays it to the Z.AI Anthropic endpoint',async t=>{
  const {createTeeRecorder}=await import('../packages/capture/src/tee/server.ts');
  const {startTeeCapture}=await import('../packages/capture/src/tee/client.ts');
  const relayed:string[]=[];
  const recorder=await createTeeRecorder({
    // Unit fixture only. Live release checks must verify actual DCAP evidence.
    quote:async statement=>({statement,quote:'00'}),
    authorize:async v=>({capture_id:v.capture_id,client:v.client,status:'AWAITING_UPLOAD',consent_hash:'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString()}),
    transport:async(url)=>{relayed.push(String(url));return new Response('data: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});}
  });
  await new Promise<void>(resolve=>recorder.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{recorder.closeAllConnections();await new Promise<void>(resolve=>recorder.close(()=>resolve()));});
  const port=(recorder.address() as any).port;
  const parts:any[]=[];
  const proxy=await startTeeCapture({client:'zai',captureId:'unit-capture-zai-123456',uploadToken:'test-only',policy:{url:'https://recorder.unit',instances:{}},onPart:async p=>{parts.push(p);}},
    async()=>({verified:true,app_id:'unit',compose_hash:'unit',quote_hash:'unit'}),
    async(url,init)=>fetch('http://127.0.0.1:'+port+new URL(String(url)).pathname,init));
  const response=await fetch(proxy.baseUrl+'/v1/messages?beta=true',{method:'POST',body:'{}'});
  assert.equal(response.status,200);
  const {bundle}=await proxy.finish();
  assert.deepEqual(relayed,['https://api.z.ai/api/anthropic/v1/messages?beta=true']);
  assert.equal(bundle.client,'zai');
  assert.equal(parts.length,1);
  assert.equal(parts[0].upstream,'https://api.z.ai');
});
