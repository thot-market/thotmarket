import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser-native dashboard module has no declaration artifact.
import { createAgentCaptureUI, parseAgentCaptureFragment, validCallback, prepareCaptureSalePolicy } from '../apps/dashboard/agent-capture-ui.js';

function encode(value:unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

test('coding sale enrollment checks connected wallet, market and identity before handoff',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),state:any={thot:{wallet,capabilities:{stream_sales:true,chain_id:46630,market}}};
 let signed=0,current=true;
 const provider={request:async({method}:any)=>{if(method==='eth_accounts')return[wallet];if(method==='eth_chainId')return'0xb626';signed++;return'0x'+'3'.repeat(130);}};
 const typed={domain:{chainId:46630,verifyingContract:market},message:{seller:wallet}};
 const options={state,getProvider:()=>provider,current:()=>{if(!current)throw Error('identity changed');},price:'100',treasuryOptIn:false,api:async()=>({id:'stream:one',typed_data:typed})};
 const result=await prepareCaptureSalePolicy(options);assert.equal(result.sale_policy_id,'stream:one');assert.equal(result.rights_confirmed,true);assert.equal(signed,1);
 await assert.rejects(prepareCaptureSalePolicy({...options,api:async()=>({id:'stream:wrong',typed_data:{...typed,domain:{...typed.domain,verifyingContract:wallet}}})}),/does not match/);assert.equal(signed,1);
 await assert.rejects(prepareCaptureSalePolicy({...options,api:async()=>{current=false;return{id:'stream:changed',typed_data:typed};}}),/identity changed/);assert.equal(signed,1);
});

test('remembered coding connection signs once then reuses handoff after local callback failure',async()=>{
 const wallet='0x'+'1'.repeat(40),market='0x'+'2'.repeat(40),state:any={actor:{id:'user-1'},role:'user',loaded:true,generation:1,thot:{wallet,capabilities:{stream_sales:true,chain_id:46630,market}}};
 let signed=0,created=0,sends=0;const controls:any={'#capture-auto-sales':{checked:true},'#capture-sale-price':{value:'100'},'#capture-treasury-consent':{checked:false}};
 const provider={request:async({method}:any)=>{if(method==='eth_accounts')return[wallet];if(method==='eth_chainId')return'0xb626';signed++;return'0x'+'3'.repeat(130);}};
 const ui=createAgentCaptureUI({state,dialog:{open:true,close(){},querySelector:(key:string)=>controls[key]},escape:String,toast(){},refresh:async()=>{},openDialog(){},getProvider:()=>provider,
  pairing:{version:2,client:'codex',device_name:'synthetic computer',callback:'http://127.0.0.1:4000/pair/'+'A'.repeat(32)},
  api:async(path:string,options:any)=>{if(path.endsWith('/prepare'))return{id:'stream:one',typed_data:{domain:{chainId:46630,verifyingContract:market},message:{seller:wallet}}};if(path.endsWith('/capture-devices')){created++;assert.equal(options.body.save_privately,false);assert.equal(options.body.sale_policy_id,'stream:one');assert.equal(options.body.model_output_licensed,true);return{device_id:'d',device_token:'t',account_id:'user-1',automatic_sales:true};}return{status:'PENDING'};},
  fetch:async()=>{sends++;return{ok:sends>1,json:async()=>({capture_id:'capture-123456789',automatic_sales:true})};}} as any);
 ui.authReady();await assert.rejects(ui.handle('confirm-agent-capture',{}),/local recorder/);await ui.handle('confirm-agent-capture',{});
 assert.equal(signed,1);assert.equal(created,1);assert.equal(sends,2);ui.clear();
});

test('capture fragment accepts only a loopback nonce callback and clears it immediately', () => {
  const callback='http://127.0.0.1:43127/pair/'+'aB9'.repeat(11);
  const location:any={hash:'#thot='+encode({callback,client:'codex'}),pathname:'/vault',search:'?from=cli'};
  const calls:any[]=[];
  assert.deepEqual(parseAgentCaptureFragment(location,{state:{x:1},replaceState(...args:any[]){calls.push(args);location.hash='';}} as any),{callback,client:'codex'});
  assert.deepEqual(calls,[[{x:1},'','/vault?from=cli']]);
});

test('capture callback validation rejects alternate hosts and URL decorations', () => {
  const nonce='A'.repeat(32);
  assert.equal(validCallback(`http://127.0.0.1:1/pair/${nonce}`),true);
  for (const value of [
    `https://127.0.0.1:4/pair/${nonce}`,
    `http://localhost:4/pair/${nonce}`,
    `http://127.0.0.1:4/pair/${nonce}?x=1`,
    `http://127.0.0.1:4/pair/${nonce}#x`,
    `http://user@127.0.0.1:4/pair/${nonce}`,
    `http://127.0.0.1:4/pair/short`,
  ]) assert.equal(validCallback(value),false,value);
});

test('malformed capture payload is consumed without retaining its fragment', () => {
  const calls:any[]=[];
  const result=parseAgentCaptureFragment({hash:'#thot=not-json',pathname:'/',search:''} as any,{state:null,replaceState(...args:any[]){calls.push(args);}} as any);
  assert.deepEqual(result,{error:'This capture link is invalid or incomplete.'});
  assert.equal(calls.length,1);
});

test('callback retry reuses one begun capture and ordinary refresh generations retain ownership', async t => {
  const prior=(globalThis as any).document;
  const controls:any={'#capture-rights':{checked:true},'#capture-license':{checked:false},'#confirm-agent-capture':{disabled:false}};
  (globalThis as any).document={querySelector:(selector:string)=>controls[selector]??null};
  t.after(()=>{(globalThis as any).document=prior;});
  const state:any={actor:{id:'user-1'},role:'user',loaded:true,generation:1,view:'vault'};
  let begins=0,sends=0,markup='';
  const ui=createAgentCaptureUI({state,dialog:{open:true,close(){}},escape:String,toast(){},refresh:async()=>{},openDialog(...args:string[]){markup=args.join(' ');},
    pairing:{client:'codex',callback:'http://127.0.0.1:4000/pair/'+'A'.repeat(32)},
    api:async(path:string,options:any)=>{if(path.endsWith('/begin')){assert.deepEqual(options.body,{client:'codex',save_privately:true});begins++;return {capture_id:'capture-123456789',upload_token:'T'.repeat(32),expires_at:'2090-01-01T00:00:00Z'};}return {status:'PENDING'};},
    fetch:async()=>{sends++;return {ok:sends>1};}} as any);
  ui.authReady();
  assert.match(markup,/Start private capture/);assert.doesNotMatch(markup,/type="checkbox"|capture-rights|capture-license/);
  state.generation++;
  await assert.rejects(()=>ui.handle('confirm-agent-capture',{}),/local recorder/);
  await ui.handle('confirm-agent-capture',{});
  assert.equal(begins,1);
  assert.equal(sends,2);
  ui.clear();
});


test('sign-out during capture creation prevents a late local credential handoff',async t=>{
  const prior=(globalThis as any).document;
  (globalThis as any).document={querySelector:()=>({checked:true})};
  t.after(()=>{(globalThis as any).document=prior;});
  let finish!:(value:unknown)=>void,sends=0;
  const pending=new Promise(resolve=>{finish=resolve;});
  const state:any={actor:{id:'user-1'},role:'user',loaded:true,generation:1};
  const ui=createAgentCaptureUI({state,dialog:{close(){}},escape:String,toast(){},refresh:async()=>{},openDialog(){},
    pairing:{client:'codex',callback:'http://127.0.0.1:4000/pair/'+'A'.repeat(32)},api:()=>pending,fetch:async()=>{sends++;return {ok:true};}} as any);
  ui.authReady();const confirmation=ui.handle('confirm-agent-capture',{});
  ui.authLost(); // A later return to the same actor must not revive this approval.
  finish({capture_id:'capture-123456789',upload_token:'T'.repeat(32),expires_at:'2090-01-01T00:00:00Z'});
  await assert.rejects(()=>confirmation,/account changed/);assert.equal(sends,0);ui.clear();
});

test('a new helper link can replace a stale browser capture without authorizing either automatically',async()=>{
  const state:any={actor:{id:'user-1'},role:'user',loaded:true,generation:1};let title='',begins=0;
  const ui=createAgentCaptureUI({state,dialog:{close(){}},escape:String,toast(){},refresh:async()=>{},openDialog(t:string){title=t;},
    pairing:{client:'claude',callback:'http://127.0.0.1:4000/pair/'+'A'.repeat(32)},api:async()=>{begins++;},fetch:async()=>({ok:true})} as any);
  ui.authReady();assert.equal(title,'Connect Claude Code');
  ui.acceptFragment({client:'codex',callback:'http://127.0.0.1:4001/pair/'+'B'.repeat(32)});
  assert.equal(title,'Connect Codex');assert.equal(begins,0);ui.clear();
});
