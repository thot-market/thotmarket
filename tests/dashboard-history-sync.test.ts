// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHistorySyncFragment,createHistorySyncUI} from '../apps/dashboard/history-sync-ui.js';

const request={version:1,client:'claude',source_ids:['a'.repeat(32)],backfill:false,daily_time_utc:'02:00',callback:'http://127.0.0.1:43210/pair/'+'b'.repeat(48)};
function fragment(value){let removed=false;const result=parseHistorySyncFragment({hash:'#thot-history='+Buffer.from(JSON.stringify(value)).toString('base64url'),pathname:'/app',search:''},{replaceState(){removed=true;}});assert.equal(removed,true);return result;}
test('history pairing is bounded, loopback-only and rejects malformed scope without keeping URL consent data',()=>{
  assert.equal(fragment(request).client,'claude');for(const changes of [{version:2},{client:'zai'},{callback:'https://untrusted.invalid/pair/'+'b'.repeat(48)},{source_ids:[]},{source_ids:['a'.repeat(32),'a'.repeat(32)]},{backfill:'yes'},{daily_time_utc:'25:00'}])assert.ok(fragment({...request,...changes}).error);
});
test('initial anonymous state preserves pending pairing; consent is required and account changes fence handoff',async()=>{
  const state={actor:null,role:null,loaded:false,generation:1},dialogs=[],calls=[];let checked=false;
  const dialog={querySelector:()=>({checked}),close(){}};
  const ui=createHistorySyncUI({state,dialog,pairing:fragment(request),escape:String,toast(){},refresh(){},openDialog(...args){dialogs.push(args);},fetch:async()=>{throw Error('must not hand off');},api:async(path,options)=>{calls.push([path,options]);state.actor={id:'different-account'};state.generation++;return {device_id:'synthetic',device_token:'must-not-send'};}});
  ui.authLost();state.loaded=true;state.actor={id:'first-account'};state.role='user';ui.authReady();assert.equal(dialogs[0][0],'Allow private history uploads?');
  await assert.rejects(ui.handle('history-sync-confirm',{}),/Confirm private history/);assert.equal(calls.length,0);
  checked=true;await assert.rejects(ui.handle('history-sync-confirm',{}),/account changed/);assert.equal(calls.length,1);assert.equal(calls[0][1].body.consent,'private-history-upload-v1');assert.equal(calls[0][1].body.backfill,false);assert.ok(!('rights_confirmed' in calls[0][1].body));
});

function historyFixture(devices=[]){
  const state={actor:{id:'synthetic-contributor'},role:'user',generation:1,loaded:true},dialogs=[],calls=[];
  const ui=createHistorySyncUI({state,pairing:null,dialog:{querySelector(){return null;},close(){}},escape:String,toast(){},refresh(){},fetch:async()=>{throw Error('No callback expected');},openDialog(...args){dialogs.push(args);},api:async(path,options)=>{calls.push([path,options]);return {devices};}});
  return {ui,state,dialogs,calls};
}
test('daily-upload empty state opens each real setup choice without creating a grant or schedule',async t=>{
  const prior=globalThis.window;globalThis.window={location:{origin:'https://thot.example.test'}};t.after(()=>globalThis.window=prior);
  const a=historyFixture();await a.ui.handle('history-sync-manage');
  assert.match(a.dialogs.at(-1)[2],/data-action="history-sync-open" data-client="claude"/);
  assert.match(a.dialogs.at(-1)[2],/data-action="history-sync-open" data-client="codex"/);
  for(const client of ['claude','codex']){
    assert.equal(await a.ui.handle('history-sync-open',{dataset:{client}}),true);
    const [title,,html]=a.dialogs.at(-1);assert.match(title,client==='codex'?/Codex/:/Claude Code/);
    assert.match(html,new RegExp('connect --client '+client));assert.match(html,/Node\.js 24/);assert.match(html,/Continue after the help text appears/);
    assert.match(html,/only new JSONL paths/i);assert.match(html,/uploading grants no sale permission/);
    assert.ok(html.indexOf(' run --id CONNECTION_ID')<html.indexOf(' enable --id CONNECTION_ID'));
  }
  assert.deepEqual(a.calls.map(([path,options])=>[path,options]),[['/v1/contributor/history-devices',undefined]]);
});
test('server-connected uploader is presented as permission rather than a confirmed local schedule',async()=>{
  const a=historyFixture([{client:'claude',device_id:'synthetic',status:'CONNECTED',source_count:1,daily_time_utc:'02:00',backfill:false,last_saved_at:null,expires_at:'2026-12-01T00:00:00Z'}]);
  await a.ui.handle('history-sync-manage');const html=a.dialogs.at(-1)[2];
  assert.match(html,/Upload permission active/);assert.match(html,/does not confirm that your computer has a daily schedule/);assert.match(html,/Return to the helper and run once/);assert.match(html,/history-sync-pause/);assert.match(html,/history-sync-disconnect/);
});
