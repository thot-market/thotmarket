import { uuidv7 } from '../../protocol/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';
import type { ThotService, Actor } from './service.ts';

export const demoUser:Actor={id:'demo-user',role:'user'};
export const demoBuyer:Actor={id:'demo-buyer-admin',role:'buyer_admin',buyer_id:'demo-buyer'};
export const demoOperator:Actor={id:'demo-security',role:'operator_security'};
export const demoSettlement:Actor={id:'demo-settlement',role:'service_settlement'};
export function policyInput(service:ThotService):Document {
  return {mode:'manual_approval',allowed_categories:['general','research_flow','professional_flow'],prohibited_categories:[],
    allowed_buyers:['demo-buyer'],prohibited_buyers:[],allowed_purposes:['research'],prohibited_purposes:[],
    evidence_disclosure:{trace_body:true,credential_predicate_types:['workplace_cohort'],outcome_predicate_types:['security_traded'],identity_disclosure:false},
    license_defaults:{exclusive:false,max_retention_days:30,onward_transfer:false,model_training:false},payout_preference:'ask_each_sale',effective_at:service.now()};
}
export function mandateInput(service:ThotService,category='general'):Document {
  ensure(['general','research_flow','professional_flow'].includes(category),'INVALID_CATEGORY');
  return {criteria:{provenance_tiers:['P0_OPERATOR'],workflow_types:[category==='research_flow'?'investment_research':category==='professional_flow'?'contract_review':'coding'],rights_required:['eligible'],
    ...(category==='professional_flow'?{credential_predicates:[{type:'workplace_cohort',accepted_values:['cohort:law_firm_eligible_v1'],freshness_days:30}]}:{}),
    ...(category==='research_flow'?{outcome_predicates:[{type:'security_traded',security_ids:['broker:AAPL@mapping-v1']}]}:{})},
    assay:{assay_id:'safe-features',version:'1',threshold:0.5,input_scope:'safe-features-v1',output_schema:'accepted-score-relevance/1'},
    economics:{currency:'USD',unit_price_minor:'10000',total_budget_minor:'100000',max_units:10,direct_cost_policy_id:'direct-costs/v1'},
    license:{purpose:'research',model_training:false,onward_transfer:false,exclusive:false,retention_days:30},
    funding:{mode:'offchain_escrow'},expires_at:service.future(7*86400),license_template_id:'development-research-v1'};
}
export async function importDemo(service:ThotService,actor:Actor,scenario='coding',key=uuidv7()) {
  ensure(service.config.development,'DEVELOPMENT_DISABLED',403);
  const fixtures:Record<string,Document>={
    coding:{turns:[{role:'user',content:'Help debug a TypeScript cache function. The key must include the tenant ID. Contact alex@example.test for the synthetic test.'},{role:'assistant',content:'Make the cache key tenant-scoped and add a cross-tenant unit test.'},{role:'tool',content:'Tests: same tenant cache hit; different tenant cache miss; all pass.'}]},
    research:{turns:[{role:'user',content:'Compare public AAPL earnings history and the sensitivity of a valuation to revenue assumptions. This is synthetic public-information research.'},{role:'assistant',content:'Separate observed public results from hypothetical growth assumptions; a sensitivity table is not a return prediction.'}]},
    professional:{turns:[{role:'user',content:'Review this synthetic, public-domain sample contract clause for clarity. I own these exercise notes and no client material is included.'},{role:'assistant',content:'Distinguish the notice period, the effective date, and the termination obligations. This is a drafting exercise.'}]},
    privileged:{turns:[{role:'user',content:'ATTORNEY-CLIENT PRIVILEGED: client confidential litigation strategy. This synthetic fixture must be rejected.'}]}
  };
  ensure(fixtures[scenario],'INVALID_SCENARIO');
  const category=scenario==='research'?'research_flow':['professional','privileged'].includes(scenario)?'professional_flow':'general';
  const bundle=await service.db.command(actor.id,key+':fixture',{action:'demo-fixture',scenario},async()=>service.privacy.createDemoBundle(fixtures[scenario]!,actor.id));
  const result=await service.importTrace(actor,key,{bundle,category,rights_confirmed:true,model_output_licensed:true});
  if(['professional','privileged'].includes(scenario)) {
    const receipt=await service.db.command(actor.id,key+':credential-fixture',{action:'demo-credential',trace:result.trace_id},async()=>service.privacy.demoCredential(actor.id));
    await service.linkEvidence(actor,key+':credential',result.trace_id,'credential',{receipt});
  }
  if(scenario==='research') {
    const receipt=await service.db.command(actor.id,key+':outcome-fixture',{action:'demo-outcome',trace:result.trace_id},async()=>service.privacy.demoOutcome(actor.id,result.trace_id,'broker:AAPL@mapping-v1'));
    await service.linkEvidence(actor,key+':outcome',result.trace_id,'outcome',{receipt});
  }
  return service.db.command(actor.id,'demo:'+key,{scenario},async()=>({...result,scenario,simulated:true}));
}
export async function createDemoMandate(service:ThotService,category='general',key=uuidv7()) {
  ensure(service.config.development,'DEVELOPMENT_DISABLED',403);
  const input=await service.db.command(demoBuyer.id,key+':fixture',{action:'demo-mandate',category},async()=>mandateInput(service,category));
  const m=await service.createMandate(demoBuyer,key+':create',input);
  await service.fundMandate(demoBuyer,key+':fund',m.mandate_id,{});
  await service.activateMandate(demoBuyer,key+':activate',m.mandate_id);
  return m;
}
