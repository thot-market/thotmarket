import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser-native JavaScript module.
import {createRobinhoodSetupUI,parseRobinhoodFragment} from '../apps/dashboard/robinhood-setup-ui.js';

test('Robinhood links reject arbitrary callbacks and consume their fragment',()=>{
  for(const callback of ['https://evil.example/pair/'+'A'.repeat(48),'http://localhost:88/pair/'+'A'.repeat(48),'http://127.0.0.1:88/pair/short']){
    let consumed=false;const result=parseRobinhoodFragment({hash:'#thot-robinhood='+Buffer.from(JSON.stringify({callback})).toString('base64url'),pathname:'/',search:''},{state:null,replaceState(){consumed=true;}});
    assert.ok(result.error);assert.equal(consumed,true);
  }
});
test('account changes during job creation cannot send the old ticket to the helper',async()=>{
  const state:any={actor:{id:'owner'},role:'user',loaded:true,contributorPortfolio:{capabilities:{link_issuer_public_key_pem:'PUBLIC'}}};
  let finish!:(value:unknown)=>void,started!:(value?:unknown)=>void;const began=new Promise(r=>started=r);const pending=new Promise(r=>finish=r);const sent:string[]=[];
  const ui=createRobinhoodSetupUI({state,pairing:{callback:'http://127.0.0.1:99/pair/'+'A'.repeat(48)},api:async()=>{started();return pending;},fetch:async(url:string,opts:any)=>{if(opts.method==='POST')sent.push(url);return {ok:true,json:async()=>({stage:'helper_ready'})};},openDialog(){},dialog:{close(){}},refresh:async()=>{},toast(){},escape:String});
  ui.authReady();const operation=ui.handle('confirm-robinhood-setup');await began;ui.authLost();state.actor={id:'other'};
  finish({job_id:'old-job',link_ticket:'private-ticket'});await operation;
  assert.equal(sent.filter(url=>!url.endsWith('/cancel')).length,0);ui.clear();
});
test('a lost pairing response can resume the same job instead of claiming again',async()=>{
  const state:any={actor:{id:'owner'},role:'user',loaded:true,contributorPortfolio:{capabilities:{link_issuer_public_key_pem:'PUBLIC'}}};
  let started=false,posts=0,begins=0;
  const ui=createRobinhoodSetupUI({state,pairing:{callback:'http://127.0.0.1:99/pair/'+'A'.repeat(48)},api:async()=>{begins++;return {job_id:'same-job',link_ticket:'ticket'};},fetch:async(url:string,options:any)=>{
    if(options.method==='POST'){posts++;started=true;throw new TypeError('lost ack');}
    return {ok:true,json:async()=>({stage:started?'awaiting_extension':'helper_ready'})};
  },openDialog(){},dialog:{close(){}},refresh:async()=>{},toast(){},escape:String});
  ui.authReady();await ui.handle('confirm-robinhood-setup');await ui.handle('retry-robinhood-setup');assert.equal(posts,1);assert.equal(begins,1);ui.clear();
});

test('late helper JSON is discarded after a new account starts another setup',async t=>{
  const prior=(globalThis as any).window;t.after(()=>{(globalThis as any).window=prior;});
  const callback='http://127.0.0.1:99/pair/'+'B'.repeat(48);
  const location={hash:'#thot-robinhood='+Buffer.from(JSON.stringify({callback})).toString('base64url'),pathname:'/',search:''};
  (globalThis as any).window={location,history:{state:null,replaceState(){location.hash='';}}};
  const state:any={actor:{id:'owner'},role:'user',loaded:true,contributorPortfolio:{capabilities:{}}};let begins=0,finish!:(value:unknown)=>void,reading!:()=>void;
  const readStarted=new Promise<void>(r=>reading=r),json=new Promise(r=>finish=r);
  const ui=createRobinhoodSetupUI({state,pairing:{callback:'http://127.0.0.1:99/pair/'+'A'.repeat(48)},api:async()=>{begins++;return {};},fetch:async(_url:string,options:any)=>({ok:true,json:()=>{if(options.method==='POST')return Promise.resolve({});reading();return json;}}),openDialog(){},dialog:{close(){}},refresh:async()=>{},toast(){},escape:String});
  ui.authReady();const operation=ui.handle('confirm-robinhood-setup');await readStarted;ui.authLost();state.actor={id:'other'};ui.acceptFragment();finish({stage:'helper_ready'});await operation;
  assert.equal(begins,0);ui.clear();
});

test('trade pairing requests the selected trace and saves bounded proof without account-control endpoints',async()=>{
 const trade={trace_id:'trace-123',symbol:'AAPL',window_days:7},evidence={credential:{synthetic:true},witness_receipts:[]};
 const state:any={actor:{id:'owner'},role:'user',loaded:true,contributorPortfolio:{capabilities:{link_issuer_public_key_pem:'PUBLIC'}}};
 const calls:any[]=[],sent:any[]=[],dialogs:any[]=[];let paired=false;
 const ui=createRobinhoodSetupUI({state,pairing:{callback:'http://127.0.0.1:99/pair/'+'A'.repeat(48),trade_request:trade},
 api:async(path:string,options:any)=>{calls.push({path,body:options.body});return path.endsWith('/begin')?{job_id:'trade-job',link_ticket:'ticket',witness_url:'https://w.test',appraiser_url:'https://a.test',request:{symbol:'AAPL',window_days:7,trace_ts:'2026-09-15T00:00:00Z'}}:{id:'trade-evidence:1',available_after:'2026-09-15T00:10:00Z'};},
 fetch:async(url:string,options:any)=>{if(options.method==='POST'){sent.push({url,body:JSON.parse(options.body)});paired=true;}return {ok:true,json:async()=>paired?{stage:'proof_ready',evidence}:{stage:'helper_ready'}};},openDialog:(...args:any[])=>dialogs.push(args),dialog:{close(){}},refresh:async()=>{},toast(){},escape:String});
 ui.authReady();await ui.handle('confirm-robinhood-setup');
 assert.deepEqual(calls.map(c=>c.path),['/v1/thot/trade-evidence/begin','/v1/thot/trade-evidence/complete']);
 assert.deepEqual(calls[0].body,trade);assert.deepEqual(calls[1].body,{job_id:'trade-job',evidence});
 assert.equal(sent[0].body.purpose,'traded');assert.equal(sent[0].body.request.symbol,'AAPL');assert.equal('token' in sent[0].body,false);
 assert.equal(dialogs.at(-1)[0],'Trade proof verified');ui.clear();
});
