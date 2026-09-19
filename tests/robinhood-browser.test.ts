import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RobinhoodBrowserCoordinator, type RobinhoodBrowserConfig } from '../packages/market/src/robinhood-browser.ts';
import type { Actor } from '../packages/market/src/service.ts';
import type { Document } from '../packages/storage/src/index.ts';

const user:Actor={id:'user-1',role:'user'},other:Actor={id:'user-2',role:'user'};
const waitFor=async(check:()=>boolean,ms=3_000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(check(),'condition was not reached');};
class FakeLinks {
  publicKey='PUBLIC PEM';owner='user-1';jobId='job-1';status='pending';stage='awaiting_local_capture';stages:string[]=[];completed?:Document;cancelled=false;
  check(actor:Actor,id:string){if(actor.id!==this.owner||id!==this.jobId)throw new Error('NOT_FOUND');}
  async pendingTicket(actor:Actor,id:string){this.check(actor,id);if(this.status!=='pending')throw new Error('LINK_NOT_PENDING');return {link_ticket:'private-ticket',witness_url:'https://witness.test',appraiser_url:'https://appraiser.test',expires_at:new Date(Date.now()+60_000).toISOString()};}
  async setBrowserStage(actor:Actor,id:string,stage:string,error?:string){this.check(actor,id);this.stage=stage;this.stages.push(error?`${stage}:${error}`:stage);if(stage==='failed')this.status='failed';return this.get(actor,id);}
  async complete(actor:Actor,_key:string,id:string,evidence:Document){this.check(actor,id);this.completed=evidence;this.status='linked';this.stage='verified';return this.get(actor,id);}
  async get(actor:Actor,id:string){this.check(actor,id);return {job_id:id,status:this.status,stage:this.stage};}
  async cancel(actor:Actor,_key:string,id:string){this.check(actor,id);this.cancelled=true;this.status='cancelled';this.stage='cancelled';return this.get(actor,id);}
}
async function fixture(t:TestContext,source:string,overrides:Partial<RobinhoodBrowserConfig>={}){
  const dir=await mkdtemp(join(tmpdir(),'thot-browser-coordinator-')),script=join(dir,'companion.mjs');await writeFile(script,source,{mode:0o600});
  const config:RobinhoodBrowserConfig={nodeExecutable:process.execPath,scriptPath:script,pythonExecutable:'/usr/bin/python3',bridgePath:'/trusted/bridge.py',browserExecutable:'/usr/bin/chromium',profileDir:join(dir,'profile'),measurementsPath:'/trusted/measurements.json',qvlPath:'/usr/bin/dcap-qvl',timeoutMs:5_000,maxOutputBytes:64_000,...overrides};
  t.after(()=>rm(dir,{recursive:true,force:true}));return config;
}

test('browser coordinator sends only fixed private launch fields and completes public evidence',async t=>{
  const config=await fixture(t,`let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const q=JSON.parse(data);const expected=['appraiser_url','bridge_path','browser_executable','dcap_qvl','link_ticket','measurements','profile_dir','python_executable','thot_public_key_pem','witness_url'];if(JSON.stringify(Object.keys(q).sort())!==JSON.stringify(expected)||JSON.stringify(q).includes('access_token'))process.exit(9);console.log(JSON.stringify({stage:'capturing'}));console.log(JSON.stringify({stage:'verifying'}));console.log(JSON.stringify({evidence:{credential:{schema_version:'public/1'},witness_receipts:[]}}));});`);
  const links=new FakeLinks(),coordinator=new RobinhoodBrowserCoordinator(links as any,config);t.after(()=>coordinator.close());
  await coordinator.start(user,'browser-start',links.jobId);await waitFor(()=>links.status==='linked');
  assert.deepEqual(links.stages,['awaiting_browser_login','capturing','verifying']);assert.deepEqual(links.completed,{credential:{schema_version:'public/1'},witness_receipts:[]});
});

test('only one browser runs globally and wrong owner cannot cancel it',async t=>{
  const config=await fixture(t,`process.stdin.resume();setInterval(()=>{},1000);`),links=new FakeLinks(),coordinator=new RobinhoodBrowserCoordinator(links as any,config);t.after(()=>coordinator.close());
  await coordinator.start(user,'browser-owner',links.jobId);
  await assert.rejects(coordinator.cancel(other,'wrong-owner',links.jobId),/NOT_FOUND/);assert.equal(links.cancelled,false);
  links.jobId='job-2';await assert.rejects(coordinator.start(user,'second-browser','job-2'),/ROBINHOOD_BROWSER_BUSY/);links.jobId='job-1';
  const result=await coordinator.cancel(user,'owner-cancel','job-1');assert.equal(result.status,'cancelled');assert.equal(links.cancelled,true);
});

test('invalid or oversized companion output fails closed without completing',async t=>{
  const config=await fixture(t,`process.stdin.resume();process.stdin.on('end',()=>console.log('x'.repeat(2048)));`,{maxOutputBytes:1024}),links=new FakeLinks(),coordinator=new RobinhoodBrowserCoordinator(links as any,config);t.after(()=>coordinator.close());
  await coordinator.start(user,'bounded-output',links.jobId);await waitFor(()=>links.status==='failed');assert.equal(links.completed,undefined);assert.ok(links.stages.includes('failed:ROBINHOOD_BROWSER_OUTPUT_LIMIT'));
});

test('coordinator timeout is fail closed and bounded below ticket expiry',async t=>{
  const config=await fixture(t,`process.stdin.resume();setInterval(()=>{},1000);`,{timeoutMs:1_000}),links=new FakeLinks(),coordinator=new RobinhoodBrowserCoordinator(links as any,config);t.after(()=>coordinator.close());
  await coordinator.start(user,'browser-timeout',links.jobId);await waitFor(()=>links.status==='failed',2_500);assert.equal(links.completed,undefined);assert.ok(links.stages.includes('failed:ROBINHOOD_BROWSER_TIMEOUT'));
});

test('shutdown kills the process group and marks a pending job failed',async t=>{
  const config=await fixture(t,`process.stdin.resume();setInterval(()=>{},1000);`),links=new FakeLinks(),coordinator=new RobinhoodBrowserCoordinator(links as any,config);
  await coordinator.start(user,'browser-shutdown',links.jobId);await coordinator.close();
  assert.equal(links.status,'failed');assert.ok(links.stages.includes('failed:ROBINHOOD_BROWSER_STOPPED'));
});
