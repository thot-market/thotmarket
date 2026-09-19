import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../packages/market/src/bootstrap.ts';
import { demoUser, demoBuyer } from '../packages/market/src/fixtures.ts';
import type { PlaidTransport } from '../packages/market/src/plaid-link.ts';

const start=Date.parse('2026-09-09T16:00:00Z');
const ACCESS='access-sandbox-11111111-2222-3333-4444-555555555555';
function fakePlaid(accounts:Array<Record<string,string>>){
  const calls:Array<{path:string;body:Record<string,unknown>}>=[];
  const transport:PlaidTransport=async(path,body)=>{
    calls.push({path,body});
    assert.equal(body.client_id,'client-id');assert.equal(body.secret,'sandbox-secret');
    if(path==='/link/token/create')return {link_token:'link-sandbox-abc',expiration:new Date(start+4*3600_000).toISOString(),request_id:'r1'};
    if(path==='/item/public_token/exchange'){assert.equal(body.public_token,'public-sandbox-good');return {access_token:ACCESS,item_id:'item-1',request_id:'r2'};}
    assert.equal(body.access_token,ACCESS);
    if(path==='/accounts/get')return {accounts,item:{institution_id:'ins_127287'},request_id:'r3'};
    if(path==='/investments/holdings/get')return {holdings:[{account_id:'acc-b',security_id:'s1',quantity:10,institution_value:900},{account_id:'acc-b',security_id:'s2',quantity:1,institution_value:100},{account_id:'acc-b',security_id:'cash',quantity:5,institution_value:5}],
      securities:[{security_id:'s1',ticker_symbol:'SBSI',type:'equity'},{security_id:'s2',ticker_symbol:'EWZ',type:'etf'},{security_id:'cash',ticker_symbol:null,type:'cash'}],request_id:'r5'};
    if(path==='/investments/transactions/get'){assert.equal(body.start_date,'2026-06-11');assert.equal(body.end_date,'2026-09-09');
      const all=[{account_id:'acc-b',security_id:'s1',type:'buy',amount:500},{account_id:'acc-b',security_id:'s2',type:'sell',amount:-200},{account_id:'acc-b',security_id:'s1',type:'cash',amount:-3},{account_id:'acc-a',security_id:'s1',type:'buy',amount:999}];
      const offset=Number((body.options as any).offset);return {investment_transactions:all.slice(offset,offset+2),total_investment_transactions:all.length,securities:[],request_id:'r6'};}
    if(path==='/item/remove')return {removed:true,request_id:'r4'};
    throw new Error('unexpected '+path);
  };
  return {calls,transport};
}
async function setup(t:any,transport?:PlaidTransport){
  const dir=await mkdtemp(join(tmpdir(),'thot-plaid-test-'));let time=start;
  const app=await createApplication({dataDir:dir,memory:true,config:{clock:()=>new Date(time)},...(transport?{plaid:{clientId:'client-id',secret:'sandbox-secret',environment:'sandbox',transport}}:{})});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,advance:(ms:number)=>{time+=ms;}};
}
const brokerage=[{account_id:'acc-b',type:'investment',subtype:'brokerage',balances:{current:1005}} as any,{account_id:'acc-a',type:'depository',subtype:'checking'}];

test('Plaid linking is unavailable without configuration and forbidden to buyers',async t=>{
  const {app}=await setup(t);
  assert.equal(app.plaid.capabilities().plaid_linking,false);
  await assert.rejects(app.plaid.begin(demoUser,'plaid-no-config'),/PLAID_LINKING_UNAVAILABLE/);
  const configured=await setup(t,fakePlaid(brokerage).transport);
  await assert.rejects(configured.app.plaid.begin(demoBuyer,'plaid-buyer'),/FORBIDDEN/);
});

test('a Plaid Link session becomes a sandbox-labeled brokerage credential without exposing the access token',async t=>{
  const plaid=fakePlaid(brokerage);const {app}=await setup(t,plaid.transport);
  const job=await app.plaid.begin(demoUser,'plaid-begin-1');
  assert.equal(job.status,'pending');assert.equal(job.stage,'awaiting_plaid_link');assert.equal(job.link_token,'link-sandbox-abc');assert.equal(job.environment,'sandbox');
  assert.deepEqual(plaid.calls[0]!.body.products,['investments']);
  await assert.rejects(app.plaid.begin(demoUser,'plaid-begin-2'),/LINK_ALREADY_PENDING/);
  await assert.rejects(app.plaid.complete(demoUser,'plaid-complete-0',job.job_id,'public-production-good'),/INVALID_PUBLIC_TOKEN/);
  const linked=await app.plaid.complete(demoUser,'plaid-complete-1',job.job_id,'public-sandbox-good');
  assert.equal(linked.status,'linked');assert.ok(linked.credential_id);
  assert.deepEqual(plaid.calls.map(c=>c.path),['/link/token/create','/item/public_token/exchange','/accounts/get','/investments/holdings/get','/investments/transactions/get','/investments/transactions/get']);
  const status:any=await app.robinhood.status(demoUser);
  assert.equal(status.status,'linked');assert.equal(status.receipt.provider,'plaid');assert.equal(status.receipt.provider_method,'plaid_sandbox_api');
  assert.equal(status.receipt.predicate_value,'controls_brokerage:true');assert.match(status.receipt.claims[0],/sandbox/);
  const row=await app.db.transaction(tx=>tx.get('credential_receipts',linked.credential_id,demoUser.id));
  const stored=JSON.stringify(row)+JSON.stringify(await app.db.transaction(tx=>tx.get('users',demoUser.id,demoUser.id)));
  assert.equal(stored.includes(ACCESS),false);assert.equal(stored.includes('acc-b'),false);assert.equal(stored.includes('link-sandbox-abc'),false);
  assert.equal(row.original_evidence.investment_accounts,1);assert.deepEqual(row.original_evidence.subtypes,['brokerage']);
  assert.deepEqual(status.summary,{as_of:'2026-09-09T16:00:00.000Z',window_days:90,investment_accounts:1,portfolio_value:1005,positions:2,largest_position_share:0.9,trades_90d:2,buys_90d:1,sells_90d:1,traded_volume_90d:700,symbols_traded_90d:['EWZ','SBSI']});
  assert.equal('summary' in row.original_evidence,false);assert.equal(JSON.stringify(row.receipt).includes('SBSI'),false);
  const again=await app.plaid.complete(demoUser,'plaid-complete-2',job.job_id,'public-sandbox-good');
  assert.equal(again.credential_id,linked.credential_id);assert.equal(plaid.calls.length,6);
  const refreshed=await app.plaid.refresh(demoUser,'plaid-refresh-1');
  assert.equal(refreshed.status,'linked');assert.notEqual(refreshed.credential_id,linked.credential_id);
  assert.deepEqual(plaid.calls.slice(6).map(c=>c.path),['/accounts/get','/investments/holdings/get','/investments/transactions/get','/investments/transactions/get']);
  const after:any=await app.robinhood.status(demoUser);
  assert.equal(after.credential_id,refreshed.credential_id);assert.match(after.receipt.claims[0],/refreshed/);assert.equal(after.summary.trades_90d,2);
  await assert.rejects(app.plaid.pendingLinkToken(demoUser),/LINK_NOT_PENDING/);
  const portfolio=await app.portfolio.list(demoUser);
  assert.equal(portfolio.capabilities.plaid_linking,true);assert.equal(portfolio.capabilities.plaid_environment,'sandbox');
  await app.plaid.disconnect(demoUser,'plaid-disconnect-1');
  assert.equal(plaid.calls.at(-1)!.path,'/item/remove');assert.equal(plaid.calls.at(-1)!.body.access_token,ACCESS);
  assert.equal((await app.robinhood.status(demoUser)).status,'disconnected');
  await assert.rejects(app.plaid.refresh(demoUser,'plaid-refresh-2'),/PLAID_NOT_LINKED/);
  const pendingAgain=await app.plaid.begin(demoUser,'plaid-begin-3');
  assert.deepEqual(await app.plaid.pendingLinkToken(demoUser),{job_id:pendingAgain.job_id,link_token:'link-sandbox-abc',expires_at:pendingAgain.expires_at});
});

test('an Item without an investment account fails the job and is still removed at Plaid',async t=>{
  const plaid=fakePlaid([{account_id:'acc-a',type:'depository',subtype:'checking'}]);const {app}=await setup(t,plaid.transport);
  const job=await app.plaid.begin(demoUser,'plaid-begin');
  const result=await app.plaid.complete(demoUser,'plaid-complete-1',job.job_id,'public-sandbox-good');
  assert.equal(result.status,'failed');assert.equal(result.error,'NO_BROKERAGE_ACCOUNT');
  assert.equal(plaid.calls.at(-1)!.path,'/item/remove');
  assert.equal((await app.robinhood.status(demoUser)).status,'failed');
  assert.equal((await app.plaid.begin(demoUser,'plaid-begin-again')).status,'pending');
});

test('re-linking while an Item is retained removes the old Item first',async t=>{
  const plaid=fakePlaid(brokerage);const {app}=await setup(t,plaid.transport);
  const first=await app.plaid.begin(demoUser,'plaid-begin-a');await app.plaid.complete(demoUser,'plaid-complete-a',first.job_id,'public-sandbox-good');
  const second=await app.plaid.begin(demoUser,'plaid-begin-b');const before=plaid.calls.length;
  await app.plaid.complete(demoUser,'plaid-complete-b',second.job_id,'public-sandbox-good');
  assert.deepEqual(plaid.calls.slice(before,before+2).map(c=>c.path),['/item/remove','/item/public_token/exchange']);
  assert.equal(plaid.calls[before]!.body.access_token,ACCESS);
});

test('a cancelled later attempt does not hide a valid connection',async t=>{
  const plaid=fakePlaid(brokerage);const {app}=await setup(t,plaid.transport);
  const first=await app.plaid.begin(demoUser,'plaid-begin-x');await app.plaid.complete(demoUser,'plaid-complete-x',first.job_id,'public-sandbox-good');
  const probe=await app.plaid.begin(demoUser,'plaid-begin-y');
  assert.equal((await app.robinhood.status(demoUser)).status,'pending');
  await app.robinhood.cancel(demoUser,'plaid-cancel-y',probe.job_id);
  const status:any=await app.robinhood.status(demoUser);
  assert.equal(status.status,'linked');assert.equal(status.receipt.provider,'plaid');
});
