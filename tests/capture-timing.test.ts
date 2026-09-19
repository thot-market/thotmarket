import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureTiming} from '../packages/capture/src/timing.ts';

test('benchmark telemetry persists numeric timings without content or identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-timing-test-')),path=join(dir,'timing.jsonl'),previous=process.env.THOT_CAPTURE_TIMING_FILE;
 try{process.env.THOT_CAPTURE_TIMING_FILE=path;const t=captureTiming();t.emit('request_buffered',{bytes:42,authorization:'secret',prompt:'private text',account:'private id',invalid:NaN} as any);await t.flush();const row=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(Object.keys(row).sort(),['at_ms','bytes','event']);assert.equal(row.bytes,42);assert.equal((await stat(path)).mode&0o777,0o600);}
 finally{if(previous===undefined)delete process.env.THOT_CAPTURE_TIMING_FILE;else process.env.THOT_CAPTURE_TIMING_FILE=previous;await rm(dir,{recursive:true,force:true});}
});
test('telemetry refuses to overwrite or append to an existing destination',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-timing-test-')),path=join(dir,'existing'),previous=process.env.THOT_CAPTURE_TIMING_FILE;
 try{await writeFile(path,'untouched');process.env.THOT_CAPTURE_TIMING_FILE=path;const t=captureTiming();t.emit('helper_started');t.emit('helper_finished');await assert.rejects(()=>t.flush(),/TIMING_WRITE_FAILED/);assert.equal(await readFile(path,'utf8'),'untouched');}
 finally{if(previous===undefined)delete process.env.THOT_CAPTURE_TIMING_FILE;else process.env.THOT_CAPTURE_TIMING_FILE=previous;await rm(dir,{recursive:true,force:true});}
});
