import { createHmac } from 'node:crypto';
import { canonicalHash, uuidv7 } from '../../protocol/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';
import type { Actor, ThotService } from './service.ts';
import type { PrivacyIntegrations } from './integrations.ts';
import type { RobinhoodLinks } from './robinhood-link.ts';

export type PlaidTransport=(path:string,body:Document)=>Promise<Document>;
export interface PlaidConfig { clientId:string; secret:string; environment:'sandbox'|'production'; redirectUri?:string; transport?:PlaidTransport; }
const user=(actor:Actor)=>ensure(actor.role==='user','FORBIDDEN',403);
const pending=(job:Document,now:string)=>job.status==='pending'&&Date.parse(job.expires_at)>Date.parse(now);
const day=(iso:string)=>iso.slice(0,10);

/** Owner-private account summary computed from Plaid holdings and 90 days of investment transactions. Never disclosed to buyers. */
export function summarize(investment:Document[],holdings:Document,transactions:Document[],observed:string){
  const ids=new Set(investment.map(a=>a.account_id));
  const securities=new Map<string,Document>((holdings.securities as Document[]).map(s=>[s.security_id,s]));
  const positions=(holdings.holdings as Document[]).filter(h=>ids.has(h.account_id)&&h.quantity>0&&securities.get(h.security_id)?.type!=='cash');
  const total=positions.reduce((sum,h)=>sum+h.institution_value,0);
  const trades=transactions.filter(t=>ids.has(t.account_id)&&(t.type==='buy'||t.type==='sell'));
  const tickers=(t:Document)=>{const s=securities.get(t.security_id);return typeof s?.ticker_symbol==='string'?[s.ticker_symbol]:[];};
  return {as_of:observed,window_days:90,investment_accounts:investment.length,
    portfolio_value:Number(investment.reduce((sum,a)=>sum+(a.balances?.current??0),0).toFixed(2)),
    positions:positions.length,largest_position_share:positions.length?Number((Math.max(...positions.map(h=>h.institution_value))/total).toFixed(3)):0,
    trades_90d:trades.length,buys_90d:trades.filter(t=>t.type==='buy').length,sells_90d:trades.filter(t=>t.type==='sell').length,
    traded_volume_90d:Number(trades.reduce((sum,t)=>sum+Math.abs(t.amount),0).toFixed(2)),
    symbols_traded_90d:[...new Set(trades.flatMap(tickers))].sort()};
}

export function plaidHttpTransport(environment:string):PlaidTransport {
  return async(path,body)=>{
    const response=await fetch(`https://${environment}.plaid.com${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json() as Document;
    ensure(response.ok,`PLAID_${result.error_code??'REQUEST_FAILED'}`,502);
    return result;
  };
}

/** Plaid-backed brokerage connection: the same link-job lifecycle as the witnessed path, sourced from Plaid's API instead of a Robinhood TLS transcript.
 *  The Item is retained (token sealed in the owner's vault) so credentials refresh without spending another Plaid connection. */
export class PlaidLinks {
  private subjectKey:Buffer; private call?:PlaidTransport;
  readonly service:ThotService; readonly privacy:PrivacyIntegrations; readonly links:RobinhoodLinks; readonly config?:PlaidConfig;
  constructor(service:ThotService,privacy:PrivacyIntegrations,masterKey:Buffer,links:RobinhoodLinks,config?:PlaidConfig){
    this.service=service;this.privacy=privacy;this.links=links;this.config=config;
    this.subjectKey=createHmac('sha256',masterKey).update('thot-plaid-subject-v1').digest();
    if(config){ensure((config.environment==='sandbox'||config.environment==='production')&&!!config.clientId&&!!config.secret,'INVALID_PLAID_CONFIG');this.call=config.transport??plaidHttpTransport(config.environment);}
  }
  capabilities(){return this.config?{plaid_linking:true,plaid_environment:this.config.environment,plaid_oauth_redirect:!!this.config.redirectUri}:{plaid_linking:false};}
  private auth(){return {client_id:this.config!.clientId,secret:this.config!.secret};}
  private async owner(actor:Actor){return this.service.db.transaction(tx=>tx.get('users',actor.id,actor.id));}
  private async token(actor:Actor,owner:Document){ensure(owner.plaid_item,'PLAID_NOT_LINKED',409);return (await this.privacy.open(actor.id,owner.plaid_item.ref)).access_token as string;}
  private async remove(accessToken:string){await this.call!('/item/remove',{...this.auth(),access_token:accessToken});}

  async begin(actor:Actor,key:string){user(actor);ensure(this.call,'PLAID_LINKING_UNAVAILABLE',503);
    const now=this.service.now();
    ensure(!((await this.owner(actor)).robinhood_link_jobs??[]).some((j:Document)=>pending(j,now)),'LINK_ALREADY_PENDING',409);
    const job_id=uuidv7();
    const token=await this.call!('/link/token/create',{...this.auth(),client_name:'THOT Network',language:'en',country_codes:['US'],products:['investments'],
      user:{client_user_id:createHmac('sha256',this.subjectKey).update('link:'+actor.id).digest('hex')},...(this.config!.redirectUri?{redirect_uri:this.config!.redirectUri}:{})});
    ensure(typeof token.link_token==='string'&&Number.isFinite(Date.parse(token.expiration)),'PLAID_INVALID_LINK_TOKEN',502);
    return this.service.db.command(actor.id,key,{action:'plaid.begin',job_id},async tx=>{
      const owner=await tx.get('users',actor.id,actor.id),jobs:Document[]=owner.robinhood_link_jobs??[];
      ensure(!jobs.some(j=>pending(j,now)),'LINK_ALREADY_PENDING',409);
      const job={job_id,connector:'plaid',environment:this.config!.environment,status:'pending',stage:'awaiting_plaid_link',issued_at:now,expires_at:token.expiration,link_token:token.link_token};
      owner.robinhood_link_jobs=[...jobs.slice(-19),job];await tx.update('users',actor.id,owner);
      await tx.audit(actor.id,'PlaidLinkStarted',{job_id});
      return {...this.links.view(job),link_token:token.link_token,environment:this.config!.environment};
    });
  }
  /** The pending Link token, so the page can resume Link after an OAuth redirect. */
  async pendingLinkToken(actor:Actor){user(actor);
    const job=((await this.owner(actor)).robinhood_link_jobs??[]).findLast((j:Document)=>j.connector==='plaid'&&pending(j,this.service.now()));
    ensure(job,'LINK_NOT_PENDING',409);return {job_id:job.job_id,link_token:job.link_token,expires_at:job.expires_at};
  }
  /** Read accounts, holdings and 90 days of transactions for a retained or fresh Item. */
  private async observe(accessToken:string){
    const accounts=await this.call!('/accounts/get',{...this.auth(),access_token:accessToken});
    const investment=(accounts.accounts as Document[]).filter(a=>a.type==='investment');
    const observed=this.service.now();
    if(!investment.length)return {accounts,investment,observed};
    const holdings=await this.call!('/investments/holdings/get',{...this.auth(),access_token:accessToken});
    const range={start_date:day(new Date(Date.parse(observed)-90*86400_000).toISOString()),end_date:day(observed)};
    const transactions:Document[]=[];
    do{const page=await this.call!('/investments/transactions/get',{...this.auth(),access_token:accessToken,...range,options:{count:500,offset:transactions.length}});
      transactions.push(...(page.investment_transactions as Document[]));if(transactions.length>=page.total_investment_transactions||!page.investment_transactions.length)break;}while(true);
    return {accounts,investment,observed,summary:summarize(investment,holdings,transactions,observed)};
  }
  private async issue(tx:any,actor:Actor,seen:Awaited<ReturnType<PlaidLinks['observe']>>,refreshed:boolean){
    const {accounts,investment,observed}=seen,env=this.config!.environment;
    const evidence={schema_version:'thot.plaid-account-control/1',connector:'plaid',environment:env,institution_id:accounts.item.institution_id,
      investment_accounts:investment.length,subtypes:[...new Set(investment.map(a=>String(a.subtype)))].sort(),request_ids:{accounts:accounts.request_id},observed_at:observed,refreshed};
    const subject=createHmac('sha256',this.subjectKey).update(investment.map(a=>String(a.account_id)).sort().join('\n')).digest('hex');
    const receipt=this.privacy.normalizeBrokerage(actor.id,subject,canonicalHash(evidence),observed,new Date(Date.parse(observed)+86400_000).toISOString(),{provider:'plaid',provider_method:env==='sandbox'?'plaid_sandbox_api':'plaid_api',issuer_key_id:'thot-brokerage-bridge-plaid-v1',
      claims:[`Plaid ${env} reported ${investment.length} investment account(s) at institution ${accounts.item.institution_id} for this contributor's retained connection${refreshed?' (refreshed)':''}.`]});
    await tx.insert('credential_receipts',receipt.receipt_id,actor.id,{receipt,original_evidence:evidence,private_summary:seen.summary});
    for(const trace of await tx.list('traces',actor.id)){if(trace.deleted)continue;trace.credential_ids=[...new Set([...trace.credential_ids,receipt.receipt_id])];await tx.update('traces',trace.trace_id,trace);}
    await this.service.enqueueMatching(tx);
    return receipt;
  }
  async complete(actor:Actor,key:string,id:string,publicToken:unknown){user(actor);ensure(this.call,'PLAID_LINKING_UNAVAILABLE',503);
    const env=this.config!.environment;
    ensure(typeof publicToken==='string'&&new RegExp(`^public-${env}-[A-Za-z0-9-]{1,200}$`).test(publicToken),'INVALID_PUBLIC_TOKEN');
    const owner=await this.owner(actor),job=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);
    ensure(job&&job.connector==='plaid','NOT_FOUND',404);
    if(job.status==='linked')return this.links.get(actor,id);
    ensure(pending(job,this.service.now()),'LINK_NOT_PENDING',409);
    if(owner.plaid_item)await this.remove(await this.token(actor,owner));
    const exchange=await this.call!('/item/public_token/exchange',{...this.auth(),public_token:publicToken});
    const seen=await this.observe(exchange.access_token);
    if(!seen.investment.length)await this.remove(exchange.access_token);
    const sealed=seen.investment.length?await this.privacy.seal(actor.id,{access_token:exchange.access_token}):undefined;
    return this.service.db.command(actor.id,key,{action:'plaid.complete',id,item:exchange.item_id},async tx=>{
      const owner=await tx.get('users',actor.id,actor.id),current=(owner.robinhood_link_jobs??[]).find((j:Document)=>j.job_id===id);
      ensure(current&&pending(current,this.service.now()),'LINK_NOT_PENDING',409);
      delete current.link_token;delete owner.plaid_item;
      if(!seen.investment.length){Object.assign(current,{status:'failed',stage:'failed',error:'NO_BROKERAGE_ACCOUNT'});await tx.update('users',actor.id,owner);return this.links.view(current);}
      const receipt=await this.issue(tx,actor,seen,false);
      owner.plaid_item={ref:sealed,item_id:exchange.item_id,institution_id:seen.accounts.item.institution_id,linked_at:seen.observed};
      Object.assign(current,{status:'linked',stage:'verified',credential_id:receipt.receipt_id,verified_at:seen.observed,evidence_hash:receipt.source_evidence_hash});
      await tx.update('users',actor.id,owner);await tx.audit(actor.id,'PlaidCredentialLinked',{job_id:id,receipt_id:receipt.receipt_id});
      return this.links.view(current);
    });
  }
  /** Re-observe the retained Item and issue a fresh 24h credential without a new Plaid connection. */
  async refresh(actor:Actor,key:string){user(actor);ensure(this.call,'PLAID_LINKING_UNAVAILABLE',503);
    const owner=await this.owner(actor);
    const seen=await this.observe(await this.token(actor,owner));
    ensure(seen.investment.length,'NO_BROKERAGE_ACCOUNT',422);
    const job_id=uuidv7();
    return this.service.db.command(actor.id,key,{action:'plaid.refresh',job_id},async tx=>{
      const owner=await tx.get('users',actor.id,actor.id);ensure(owner.plaid_item,'PLAID_NOT_LINKED',409);
      const receipt=await this.issue(tx,actor,seen,true);
      const job={job_id,connector:'plaid',environment:this.config!.environment,status:'linked',stage:'verified',issued_at:seen.observed,expires_at:receipt.valid_until,credential_id:receipt.receipt_id,verified_at:seen.observed,evidence_hash:receipt.source_evidence_hash};
      owner.robinhood_link_jobs=[...(owner.robinhood_link_jobs??[]).slice(-19),job];await tx.update('users',actor.id,owner);
      await tx.audit(actor.id,'PlaidCredentialRefreshed',{job_id,receipt_id:receipt.receipt_id});
      return this.links.view(job);
    });
  }
  /** Remove the retained Item at Plaid, then revoke every brokerage credential. */
  async disconnect(actor:Actor,key:string){user(actor);
    const owner=await this.owner(actor);
    if(owner.plaid_item){
      await this.remove(await this.token(actor,owner));
      await this.service.db.transaction(async tx=>{const o=await tx.get('users',actor.id,actor.id);delete o.plaid_item;await tx.update('users',actor.id,o);});
    }
    return this.links.disconnect(actor,key);
  }
}
