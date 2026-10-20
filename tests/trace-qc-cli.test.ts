import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('standalone QC produces private JSON and self-contained HTML without source text',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-qc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'input.json'),output=join(dir,'report.json'),html=join(dir,'report.html');
  const marker='PRIVATE_SOURCE_CANARY_'+crypto.randomUUID();
  await writeFile(input,JSON.stringify({turns:[{role:'user',content:marker+' Please compare two sorting algorithms.'},{role:'assistant',content:'Merge sort and heap sort both offer predictable worst-case comparisons.'}]}));
  const run=(args:string[])=>spawnSync(process.execPath,[resolve('scripts/trace-qc.ts'),...args],{encoding:'utf8',timeout:15000});
  let result=run(['--input',input,'--output',output]);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
  const bytes=await readFile(output,'utf8'),report=JSON.parse(bytes);assert(report.content_digest);assert.equal(report.semantic.status,'not_run');assert(!bytes.includes(marker));assert.equal((await stat(output)).mode&0o777,0o600);
  result=run(['--input',input,'--format','html','--output',html]);assert.equal(result.status,0,result.stderr);const page=await readFile(html,'utf8');assert.match(page,/AI review not run/);assert.match(page,/Content-Security-Policy/);assert(!page.includes(marker));
  result=run(['--input',input,'--output',output]);assert.equal(result.status,2);assert.match(result.stderr,/QC_CLI_IO_ERROR/);assert.equal(await readFile(output,'utf8'),bytes);
});

test('invalid and oversized CLI input produce fixed errors without echoing data or filenames',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-qc-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'private-name.json');await writeFile(input,'PRIVATE_INVALID_INPUT');
  const run=()=>spawnSync(process.execPath,[resolve('scripts/trace-qc.ts'),'--input',input],{encoding:'utf8',timeout:15000});
  let result=run();assert.equal(result.status,2);assert.match(result.stderr,/QC_CLI_INVALID_JSON/);assert.doesNotMatch(result.stderr,/PRIVATE_INVALID_INPUT|private-name/);
  await writeFile(input,'x'.repeat(2_000_001));result=run();assert.equal(result.status,2);assert.match(result.stderr,/QC_CLI_INPUT_LIMIT/);
});

test('a FIFO is refused without waiting for a writer',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'thot-qc-fifo-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const fifo=join(dir,'input-pipe');
  assert.equal(spawnSync('mkfifo',[fifo],{encoding:'utf8'}).status,0);
  const result=spawnSync(process.execPath,[resolve('scripts/trace-qc.ts'),'--input',fifo],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.status,2);assert.match(result.stderr,/QC_CLI_INPUT_LIMIT/);
});
