import { Contract, Interface, JsonRpcProvider, TypedDataEncoder, verifyTypedData, getAddress, keccak256, id as hashId, ZeroHash } from 'ethers';
import { canonicalHash } from '../protocol/src/index.ts';
import { ensure, type Document, type Transaction } from '../storage/src/index.ts';
import { currentDraftInput } from '../market/src/mandate-draft.ts';
import { assertOperationEnabled } from '../market/src/operational-controls.ts';
import type { Actor, ThotService } from '../market/src/service.ts';

export const approvalTuple='(bytes32 licenseId,bytes32 mandateId,bytes32 releaseHash,bytes32 termsHash,address recipient,uint256 gross,uint256 minThot,uint256 deadline)';
export const marketAbi=[
  'function deposit(bytes32,bytes32,uint256,uint256)', 'function refund(bytes32,uint256)',
  'function mandates(bytes32) view returns(address buyer,bytes32 commitment,uint256 maxUnit,uint256 available)',
  'function receipts(bytes32) view returns(bytes32 approvalHash,uint256 paidThot,uint256 burnedThot)',
  `function settle(${approvalTuple},bytes)`, 'function operator() view returns(address)',
  'function payment() view returns(address)','function thot() view returns(address)','function router() view returns(address)',
  'event Funded(bytes32 indexed mandateId,address indexed buyer,bytes32 commitment,uint256 amount,uint256 maxUnit)',
  'event Settled(bytes32 indexed licenseId,bytes32 indexed mandateId,address indexed recipient,bytes32 approvalHash,uint256 gross,uint256 paidThot,uint256 burnedThot,uint256 operatorPayment)',
];
export const approvalTypes={Approval:[
  {name:'licenseId',type:'bytes32'},{name:'mandateId',type:'bytes32'},{name:'releaseHash',type:'bytes32'},{name:'termsHash',type:'bytes32'},
  {name:'recipient',type:'address'},{name:'gross',type:'uint256'},{name:'minThot',type:'uint256'},{name:'deadline',type:'uint256'},
]};
const tokenAbi=['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)'];
export interface AnvilConfig {
  rpcUrl:string; market:string; payment:string; thot:string; router:string; operator:string;
  deploymentBlock:number; deploymentBlockHash:string; maxSlippageBps:number;
}
const atoms=(minor:string)=>BigInt(minor);
const asHex=(value:string)=>'0x'+value;

/** Real EVM effects, deliberately restricted to a loopback Anvil chain. No public
 * chain signer or production-mode escape hatch is provided by this adapter. */
export class AnvilMoneyPath {
  readonly service:ThotService; readonly config:AnvilConfig;
  readonly provider:JsonRpcProvider; readonly contract:Contract; readonly router:Contract;
  private running?:Promise<{processed:number;failed:number}>;
  // Fault-injection seam used only by the integration harness, after mining and
  // before SQL acknowledgement. Never exposed over HTTP.
  afterMined?:()=>Promise<void>;
  onFailure?:(error:unknown)=>void;
  constructor(service:ThotService,config:AnvilConfig) {
    const url=new URL(config.rpcUrl);
    ensure(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'ANVIL_LOOPBACK_REQUIRED');
    ensure(service.config.development&&service.config.tokenEnabled,'ANVIL_DEVELOPMENT_REQUIRED');
    ensure(Number.isInteger(config.maxSlippageBps)&&config.maxSlippageBps>=0&&config.maxSlippageBps<=100,'SLIPPAGE_POLICY_REQUIRED');
    ensure(Number.isSafeInteger(config.deploymentBlock)&&config.deploymentBlock>0&&/^0x[0-9a-f]{64}$/.test(config.deploymentBlockHash),'DEPLOYMENT_ANCHOR_REQUIRED');
    for(const field of ['market','payment','thot','router','operator'] as const)getAddress(config[field]);
    this.service=service;this.config=config;
    this.provider=new JsonRpcProvider(config.rpcUrl,undefined,{cacheTimeout:-1,batchMaxCount:1});
    this.provider.pollingInterval=100;
    this.contract=new Contract(config.market,marketAbi,this.provider);
    this.router=new Contract(config.router,['function getAmountsOut(uint256,address[]) view returns(uint256[])'],this.provider);
  }
  async guard() {
    ensure((await this.provider.send('web3_clientVersion',[])).toLowerCase().includes('anvil')&&await this.provider.send('eth_chainId',[])==='0x7a69','ANVIL_CHAIN_REQUIRED');
    ensure((await this.provider.getBlock(this.config.deploymentBlock))?.hash===this.config.deploymentBlockHash,'ANVIL_RESET_RECONCILIATION_REQUIRED',503);
    const values=await Promise.all(['operator','payment','thot','router'].map(name=>this.contract.getFunction(name)()));
    for(const [i,name] of ['operator','payment','thot','router'].entries())ensure(values[i].toLowerCase()===(this.config as any)[name].toLowerCase(),'ANVIL_CONTRACT_MISMATCH');
  }
  capabilities() { return {mode:'anvil',chain_id:31337,test_assets:true,payment_symbol:'tUSD',payout:'THOT',market:this.config.market,thot:this.config.thot,payment:this.config.payment,max_slippage_bps:this.config.maxSlippageBps,direct_costs_minor:'0',...{rpc_url:this.config.rpcUrl}}; }
  domain() { return {name:'THOT Trace Market',version:'1',chainId:31337,verifyingContract:this.config.market}; }
  async fund(actor:Actor,key:string,id:string,input:Document):Promise<Document> {
    ensure(actor.role==='buyer_admin'&&actor.buyer_id,'FORBIDDEN',403);await this.guard();
    // Recover a mined deposit even if the browser lost the transaction response.
    if(!input.transaction_hash){
      await this.service.db.transaction(tx=>tx.get('mandates',id,actor.buyer_id));
      const deposits=await this.contract.queryFilter(this.contract.filters.Funded(hashId(id)),this.config.deploymentBlock,'latest');
      if(deposits.length){ensure(deposits.length===1,'FUNDING_EVENT_CONFLICT');return this.fund(actor,key,id,{transaction_hash:deposits[0]!.transactionHash});}
    }
    if(!input.transaction_hash)return this.service.db.command(actor.id,key,{action:'prepareAnvilFunding',id,input},async tx=>{
      const m=await tx.get('mandates',id,actor.buyer_id);
      ensure(['draft','pending_funding'].includes(m.status),'MANDATE_STATE',409);
      ensure((await tx.get('buyers',actor.buyer_id!,actor.buyer_id)).approved,'BUYER_NOT_APPROVED',403);
      ensure(input.expected_revision===(m.draft_revision??1),'MANDATE_REVISION_CONFLICT',409);
      ensure(m.economics.currency==='USDC'&&m.funding.mode==='onchain_escrow','ANVIL_PAYMENT_DENOMINATION_REQUIRED');
      const wallet=getAddress(input.wallet_address),commitment=asHex(canonicalHash(currentDraftInput(m)));
      if(m.anvil_funding)ensure(m.anvil_funding.wallet===wallet&&m.anvil_funding.commitment===commitment,'FUNDING_SCOPE_CONFLICT',409);
      m.anvil_funding={wallet,commitment};m.status='pending_funding';await tx.update('mandates',id,m);
      const approve=new Interface(tokenAbi).encodeFunctionData('approve',[this.config.market,atoms(m.economics.total_budget_minor)]);
      const deposit=this.contract.interface.encodeFunctionData('deposit',[hashId(id),commitment,atoms(m.economics.unit_price_minor),atoms(m.economics.total_budget_minor)]);
      return {status:'AWAITING_WALLET',mandate_id:id,chain_id:31337,transactions:[{to:this.config.payment,data:approve},{to:this.config.market,data:deposit}]};
    });
    ensure(/^0x[0-9a-fA-F]{64}$/.test(input.transaction_hash),'INVALID_TRANSACTION');
    const receipt=await this.provider.getTransactionReceipt(input.transaction_hash);
    ensure(receipt?.status===1&&receipt.to?.toLowerCase()===this.config.market.toLowerCase(),'FUNDING_NOT_CONFIRMED',409);
    ensure((await this.provider.getBlock(receipt.blockNumber))?.hash===receipt.blockHash,'NONCANONICAL_FUNDING',409);
    const event=receipt.logs.filter(log=>log.address.toLowerCase()===this.config.market.toLowerCase()).map(log=>this.contract.interface.parseLog(log)).find(log=>log?.name==='Funded'&&log.args.mandateId===hashId(id));
    ensure(event,'FUNDING_EVENT_REQUIRED');
    const onchain=await this.contract.mandates(hashId(id));
    return this.service.db.command(actor.id,key,{action:'confirmAnvilFunding',id,input},async tx=>{
      const m=await tx.get('mandates',id,actor.buyer_id);
      ensure(m.anvil_funding?.wallet===getAddress(event.args.buyer)&&m.anvil_funding.commitment===event.args.commitment,'FUNDING_SCOPE_CONFLICT');
      ensure(event.args.amount===atoms(m.economics.total_budget_minor)&&event.args.maxUnit===atoms(m.economics.unit_price_minor)&&onchain.available===event.args.amount,'FUNDING_AMOUNT_OR_REFUND_MISMATCH');
      await this.service.recordFunding(tx,m,'anvil:'+receipt.hash,BigInt(m.economics.total_budget_minor));
      return {status:'funded',funded_minor:m.funding.funded_minor,transaction_hash:receipt.hash,test_assets:true,simulated:false};
    });
  }
  async quote(actor:Actor,candidateId:string,wallet:string) {
    ensure(actor.role==='user','FORBIDDEN',403);await this.guard();const recipient=getAddress(wallet);
    const c=await this.service.db.transaction(tx=>tx.get('mandate_candidates',candidateId,actor.id));
    ensure(c.status==='USER_AUTH_PENDING','CANDIDATE_ALREADY_AUTHORIZED',409);
    const gross=BigInt(c.expected_gross_minor),spend=(gross*65n/100n+gross*20n/100n);
    const output=await this.router.getAmountsOut(spend,[this.config.payment,this.config.thot]);
    const min=output[1]*BigInt(10_000-this.config.maxSlippageBps)/10_000n;
    const block=await this.provider.getBlock('latest');ensure(block,'CHAIN_UNAVAILABLE');
    const approval={licenseId:hashId(c.license_id),mandateId:hashId(c.mandate_id),releaseHash:asHex(c.release_hash),termsHash:asHex(c.license_hash),recipient,gross:atoms(c.expected_gross_minor).toString(),minThot:min.toString(),deadline:Math.min(block.timestamp+600,Math.floor(Date.parse(c.expires_at)/1000))};
    const quote={domain:this.domain(),types:approvalTypes,primaryType:'Approval',message:approval};
    const quoteId=canonicalHash(quote);
    await this.service.db.transaction(async tx=>{if(!await tx.maybe('chain_transactions','quote:'+quoteId))await tx.insert('chain_transactions','quote:'+quoteId,actor.id,{kind:'ANVIL_QUOTE',candidate_id:candidateId,quote});});
    return {...quote,quote_id:quoteId,expected_thot_atoms:output[1].toString(),test_assets:true};
  }
  async validateApproval(tx:Transaction,actor:Actor,c:Document,input:Document) {
    ensure(input.payout_preference==='token','ANVIL_TOKEN_PAYOUT_REQUIRED');
    const quote=await tx.get('chain_transactions','quote:'+input.quote_id,actor.id);
    const a=quote.quote.message;
    ensure(quote.candidate_id===(c.candidate_id??c.id)&&a.licenseId===hashId(c.license_id)&&a.releaseHash===asHex(c.release_hash)&&a.termsHash===asHex(c.license_hash)&&a.mandateId===hashId(c.mandate_id)&&a.gross===atoms(c.expected_gross_minor).toString(),'AUTHORIZATION_SCOPE_MISMATCH');
    ensure(a.deadline>Math.floor(Date.parse(this.service.now())/1000),'QUOTE_EXPIRED');
    ensure(verifyTypedData(this.domain(),approvalTypes,a,input.wallet_signature)===getAddress(a.recipient),'WRONG_WALLET_SIGNATURE');
    return {approval:a,signature:input.wallet_signature,approval_hash:TypedDataEncoder.hash(this.domain(),approvalTypes,a)};
  }
  async enqueue(tx:Transaction,license:Document,authorization:Document) {
    ensure(authorization.anvil_approval,'WALLET_APPROVAL_REQUIRED');
    await tx.insert('chain_transactions','sale:'+license.license_id,license.owner_user_id,{kind:'ANVIL_SALE',license_id:license.license_id,status:'PENDING',attempts:0,...authorization.anvil_approval});
  }
  async status(actor:Actor,id:string) {
    return this.service.db.transaction(async tx=>{
      const l=await tx.get('licenses',id);
      ensure(actor.role==='user'?l.owner_user_id===actor.id:['buyer_admin','buyer_member'].includes(actor.role)&&l.buyer_id===actor.buyer_id,'NOT_FOUND',404);
      const s=await tx.get('chain_transactions','sale:'+id);
      return {license_id:id,status:s.status,last_error:s.last_error??null,transaction_hash:s.transaction_hash??null,receipt:s.receipt??null,test_assets:true};
    });
  }
  async assertPaid(tx:Transaction,id:string) {
    const s=await tx.maybe('chain_transactions','sale:'+id);
    ensure(s?.status==='FINALIZED'&&s.receipt?.approval_hash===s.approval_hash,'PAYMENT_PENDING',409);
  }
  async verifyDelivery(actor:Actor,id:string) {
    const status=await this.status(actor,id);
    ensure(status.status==='FINALIZED','PAYMENT_PENDING',409);
    await this.guard();
    const r=status.receipt;
    const receipt=await this.provider.getTransactionReceipt(r.transaction_hash);
    ensure(receipt?.status===1&&receipt.blockHash===r.block_hash&&(await this.provider.getBlock(receipt.blockNumber))?.hash===r.block_hash,'SETTLEMENT_RECONCILIATION_REQUIRED',503);
    ensure((await this.contract.receipts(hashId(id))).approvalHash===r.approval_hash,'SETTLEMENT_RECONCILIATION_REQUIRED',503);
  }
  async findReceipt(order:Document) {
    const saved=await this.contract.receipts(order.approval.licenseId);
    if(saved.approvalHash===ZeroHash)return;
    ensure(saved.approvalHash===order.approval_hash,'CHAIN_RECEIPT_CONFLICT');
    const logs=await this.contract.queryFilter(this.contract.filters.Settled(order.approval.licenseId),this.config.deploymentBlock,'latest');
    ensure(logs.length===1,'CHAIN_RECEIPT_CONFLICT');const log=logs[0]!;
    const parsed=this.contract.interface.parseLog(log)!;
    const receipt=await this.provider.getTransactionReceipt(log.transactionHash);
    ensure(receipt?.status===1&&(await this.provider.getBlock(receipt.blockNumber))?.hash===receipt.blockHash,'NONCANONICAL_SETTLEMENT');
    ensure(parsed.args.approvalHash===order.approval_hash&&parsed.args.paidThot===saved.paidThot&&parsed.args.burnedThot===saved.burnedThot&&parsed.args.gross===BigInt(order.approval.gross)&&parsed.args.recipient===getAddress(order.approval.recipient),'CHAIN_RECEIPT_CONFLICT');
    return {transaction_hash:receipt.hash,block_number:receipt.blockNumber,block_hash:receipt.blockHash,approval_hash:saved.approvalHash,paid_thot_atoms:saved.paidThot.toString(),burned_thot_atoms:saved.burnedThot.toString(),operator_payment_atoms:parsed.args.operatorPayment.toString(),recipient:order.approval.recipient,chain_id:31337,confirmations:1,test_assets:true,simulated:false};
  }
  run() { return this.running??=(this.drain().finally(()=>{this.running=undefined;})); }
  private async drain() {
    await this.guard();let processed=0,failed=0;
    const orders=await this.service.db.transaction(tx=>tx.list('chain_transactions'));
    for(let order of orders.filter(o=>o.kind==='ANVIL_SALE'&&o.status!=='FINALIZED')) {
      try {
        let receipt=await this.findReceipt(order);
        if(!receipt) {
          await this.service.db.transaction(async tx=>{await assertOperationEnabled(tx,'sales');});
          if(!order.raw_transaction) {
            // Persist the signed transaction BEFORE broadcasting. A timeout or
            // process death resubmits these same bytes / nonce, not a new payment.
            const signer=await this.provider.getSigner(this.config.operator);
            const request={to:this.config.market,data:this.contract.interface.encodeFunctionData('settle',[order.approval,order.signature])};
            const gasLimit=await signer.estimateGas(request),nonce=await this.provider.getTransactionCount(this.config.operator,'pending');
            const fees=await this.provider.getFeeData();
            const bytes=await signer.signTransaction({...request,gasLimit,nonce,chainId:31337,type:2,maxFeePerGas:fees.maxFeePerGas!,maxPriorityFeePerGas:fees.maxPriorityFeePerGas!});
            ensure(typeof bytes==='string'&&bytes.startsWith('0x'),'SIGNED_TRANSACTION_REQUIRED');
            order={...order,raw_transaction:bytes,transaction_hash:keccak256(bytes),status:'SIGNED'};
            await this.service.db.transaction(tx=>tx.update('chain_transactions',order.id,order));
          }
          const existing=await this.provider.getTransactionReceipt(order.transaction_hash);
          if(existing?.status===0) {delete order.raw_transaction;delete order.transaction_hash;throw new Error('CHAIN_TRANSACTION_REVERTED');}
          if(!existing)await this.provider.broadcastTransaction(order.raw_transaction);
          await this.provider.waitForTransaction(order.transaction_hash,1,10_000);
          receipt=await this.findReceipt(order);ensure(receipt,'SETTLEMENT_NOT_CONFIRMED');
          await this.afterMined?.();
        }
        // No network requests occur in this database transaction.
        await this.service.db.transaction(async tx=>{
          const current=await tx.get('chain_transactions',order.id);
          if(current.status==='FINALIZED')return;
          await this.service.settleLicense(tx,order.license_id,receipt);
          await tx.update('chain_transactions',order.id,{...current,status:'FINALIZED',transaction_hash:receipt!.transaction_hash,receipt,last_error:null});
          const d=await tx.get('deliveries',order.license_id);
          if(d.status==='PAYMENT_PENDING'){d.status='AVAILABLE';await tx.update('deliveries',order.license_id,d);}
        });processed++;
      } catch(error) {
        this.onFailure?.(error);
        // Preserve transaction bytes even if submission was ambiguous. Contract
        // idempotency and receipt recovery are independent of SQL acknowledgements.
        const message=error instanceof Error?error.message:'';
        const code=message==='INJECTED_AFTER_MINING'?'RECOVERY_REQUIRED':message.includes('INSUFFICIENT_ESCROW')?'ESCROW_REFUNDED_OR_INSUFFICIENT':(message.includes('INSUFFICIENT_OUTPUT_AMOUNT')||message.includes('SLIPPAGE_OR_PARTIAL_INPUT'))?'PRICE_MOVED':message.includes('PAUSED_OR_EXPIRED')?'QUOTE_EXPIRED_OR_MARKET_PAUSED':message.includes('OPERATION_PAUSED')?'SALES_PAUSED':'SETTLEMENT_WAITING';
        await this.service.db.transaction(tx=>tx.update('chain_transactions',order.id,{...order,status:'WAITING',attempts:order.attempts+1,last_error:code}));failed++;
      }
    }
    return {processed,failed};
  }
  async close() {await this.running;this.provider.destroy();}
}
