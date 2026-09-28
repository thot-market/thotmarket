import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';

// Logs are operational only. Drive content-bearing and failing requests with unique markers and
// fail if any marker, session token or licensed content reaches stdout, stderr or console.
test('content, credentials and request data never reach process output',async t=>{
  const captured:string[]=[],originals={out:process.stdout.write,err:process.stderr.write};
  const keep=(original:typeof process.stdout.write)=>function(this:NodeJS.WriteStream,chunk:string|Uint8Array,...rest:unknown[]){captured.push(Buffer.from(chunk).toString());return original.call(this,chunk,...(rest as []));} as typeof process.stdout.write;
  process.stdout.write=keep(originals.out);process.stderr.write=keep(originals.err);
  t.after(()=>{process.stdout.write=originals.out;process.stderr.write=originals.err;});
  const app=await createApplication({memory:true,dataDir:await mkdtemp(join(tmpdir(),'thot-log-hygiene-'))});
  const server=createHttpServer(app,{log:entry=>process.stdout.write(JSON.stringify(entry)+'\n')});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=async(path:string,{token='',body,raw,headers={}}:{token?:string;body?:unknown;raw?:string;headers?:Record<string,string>}={})=>{
    const response=await fetch(base+path,{method:body||raw?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body||raw?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{}),...headers},...(body||raw?{body:raw??JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.text()};
  };
  const marker=(name:string)=>`LOGCANARY-${name}-${randomUUID()}`;
  const said=marker('prompt'),answered=marker('answer'),filename=marker('file'),path=marker('path'),query=marker('query'),badToken=marker('token'),malformed=marker('malformed'),cookie=marker('cookie');
  const session=async(role:string)=>JSON.parse((await call('/v1/dev/session',{body:{role}})).body).token as string;
  const user=await session('user'),buyer=await session('buyer_admin');
  const text=[
    JSON.stringify({type:'user',sessionId:'s',timestamp:'2026-09-28T10:00:00Z',cwd:'/work',message:{role:'user',content:said}}),
    JSON.stringify({type:'assistant',sessionId:'s',timestamp:'2026-09-28T10:01:00Z',message:{role:'assistant',content:[{type:'text',text:answered}]}}),
  ].join('\n');
  const preview=await call('/v1/contributor/import/preview',{token:user,body:{filename,text}});assert.equal(preview.status,200,preview.body);
  const commitment=JSON.parse(preview.body).content_commitment;
  const input={filename,text,content_commitment:commitment,category:'research_flow',rights_confirmed:true,model_output_licensed:true};
  assert.equal((await call('/v1/contributor/import/confirm',{token:user,body:input})).status,200);
  assert.ok((await call('/v1/traces',{token:user})).body.includes('trace_id'));
  assert.ok((await call('/v1/contributor/import/confirm',{token:user,body:{...input,content_commitment:'0'.repeat(64)}})).status>=400);
  assert.equal((await call('/v1/contributor/import/preview',{token:user,raw:`{"text":"${malformed}"`})).status,400);
  assert.ok((await call(`/v1/${path}?q=${query}`,{token:user})).status>=400);
  assert.equal((await call('/v1/traces',{token:badToken})).status,401);
  assert.ok((await call('/v1/traces',{headers:{Cookie:`session=${cookie}`}})).status>=400);
  assert.equal((await call('/v1/dev/policy',{token:user,body:{}})).status,200);
  assert.equal((await call('/v1/dev/trace',{token:user,body:{scenario:'professional'}})).status,200);
  assert.equal((await call('/v1/dev/mandate',{token:buyer,body:{category:'professional_flow'}})).status,200);
  await call('/v1/dev/run-worker',{token:user,body:{}});
  const candidate=JSON.parse((await call('/v1/candidates',{token:user})).body)[0];
  const {release,...fields}=JSON.parse((await call(`/v1/candidates/${candidate.candidate_id}/preview`,{token:user})).body);
  const sale=JSON.parse((await call('/v1/sale-authorizations',{token:user,body:{...fields,payout_preference:'inference_credit'}})).body);
  await call('/v1/dev/run-worker',{token:user,body:{}});
  assert.equal((await call(`/v1/buyer/deliveries/${sale.license_id}`,{token:buyer})).status,200);
  const output=captured.join('');
  assert.ok(output.includes('"request_id"'),'request log sink was exercised');
  for(const secret of [said,answered,filename,path,query,badToken,malformed,cookie,user,buyer,commitment,'sample contract clause',JSON.stringify(release).slice(1,40)])
    assert.ok(!output.includes(secret),'process output leaked '+secret.slice(0,30));
});

test('startup failures report codes and stack frames, never wrapped data',async t=>{
  const {reportStartupFailure}=await import('../apps/api/server.ts');
  const written:string[]=[],original=process.stderr.write,exitCode=process.exitCode;
  process.stderr.write=((chunk:string)=>{written.push(String(chunk));return true;}) as typeof process.stderr.write;
  t.after(()=>{process.stderr.write=original;process.exitCode=exitCode;});
  const leak='deadbeefcafebabe-LOGCANARY';
  try{JSON.parse(`{"key":${leak}`);}catch(error){reportStartupFailure(error);}
  reportStartupFailure(Object.assign(new Error('THOT_CHAIN_CONFIG_INVALID'),{code:'ERR_X',info:{responseBody:leak}}));
  process.stderr.write=original;
  const [parsed,coded]=written.map(line=>JSON.parse(line));
  assert.equal(parsed.name,'SyntaxError');assert.equal(parsed.message,null);assert.ok(parsed.frames.length>0);
  assert.equal(coded.message,'THOT_CHAIN_CONFIG_INVALID');assert.equal(coded.code,'ERR_X');
  assert.ok(!written.join('').includes('deadbeef'));assert.equal(process.exitCode,1);
});
