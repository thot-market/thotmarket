import test from 'node:test';
import assert from 'node:assert/strict';
import {createMoneyUI} from '../apps/dashboard/money-ui.js';
const wallet='0x0000000000000000000000000000000000000001';
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(request) {
  const previous=globalThis.window;globalThis.window={ethereum:{request}};
  const state={money:{mode:'anvil'},actor:{id:'owner'},role:'user',generation:1,mandates:[]};
  const calls=[],dialogs=[];
  const quote={quote_id:'quote',domain:{verifyingContract:wallet},types:{Approval:[]},primaryType:'Approval',message:{gross:'100000000',minThot:'1000',deadline:9999999999}};
  const ui=createMoneyUI({state,api:async(path,body)=>{calls.push({path,body});return quote;},openDialog:(...args)=>dialogs.push(args),dialog:{},refresh:async()=>{},escape:String,json:JSON.stringify,toast(){}});
  return {ui,state,calls,dialogs,close(){globalThis.window=previous;}};
}
test('changing account while connecting a wallet never requests a quote under the new identity',async t=>{
  const pending=deferred(),f=fixture(async({method})=>method==='eth_requestAccounts'?pending.promise:'0x7a69');t.after(f.close);
  const action=f.ui.startApproval({candidate_id:'candidate'});f.state.actor={id:'another-owner'};f.state.generation++;
  pending.resolve([wallet]);await assert.rejects(()=>action,{name:'StaleWorkspaceError'});assert.equal(f.calls.length,0);assert.equal(f.dialogs.length,0);
});
test('a wallet signature arriving after account change cannot authorize a sale with the replacement session',async t=>{
  const pending=deferred(),started=deferred();
  const f=fixture(async({method})=>{if(method==='eth_requestAccounts')return [wallet];if(method==='eth_chainId')return '0x7a69';started.resolve();return pending.promise;});t.after(f.close);
  await f.ui.startApproval({candidate_id:'candidate'});
  const action=f.ui.action('money-sign',{dataset:{}});await started.promise;
  f.state.actor={id:'another-owner'};f.state.generation++;pending.resolve('0xsignature');
  await assert.rejects(()=>action,{name:'StaleWorkspaceError'});assert.ok(f.calls.every(c=>!c.path.includes('sale-authorizations')));
});
test('a refreshed generation of the same identity must review a previously opened funding dialog again',async t=>{
  const f=fixture(async()=>{throw new Error('A stale dialog must not open the wallet');});t.after(f.close);
  f.state.role='buyer_admin';f.state.mandates=[{mandate_id:'mandate',draft_revision:1,economics:{total_budget_minor:'100000000',unit_price_minor:'100000000'}}];
  await f.ui.action('fund-mandate-draft',{dataset:{id:'mandate'}});f.state.generation++;
  await assert.rejects(()=>f.ui.action('money-fund',{dataset:{}}),{name:'StaleWorkspaceError'});assert.equal(f.calls.length,0);
});
