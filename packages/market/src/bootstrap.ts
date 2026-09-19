import type {ObjectTiming} from './staged-storage.ts';
import type {RemoteAccounting} from '../../vault/src/remote-accounting.ts';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { Database, ensure, TransactionTimingCollector, type DatabaseOptions } from '../../storage/src/index.ts';
import { PrivacyIntegrations } from './integrations.ts';
import { ThotService, type MarketConfig } from './service.ts';
import { type InferenceProvider } from '../../inference/src/index.ts';
import { InferenceGateway } from './inference-gateway.ts';
import { DataDirectoryLease, ensureStorageFormat } from '../../operations/src/lease.ts';
import { RobinhoodLinks, type RobinhoodConfig, type EvidenceVerifier } from './robinhood-link.ts';
import { ContributorPortfolio } from './contributor-portfolio.ts';
import { RobinhoodBrowserCoordinator } from './robinhood-browser.ts';
import { PlaidLinks, type PlaidConfig } from './plaid-link.ts';
import { InferencePortfolioCapture } from './inference-capture.ts';
import {TraceLibrary} from './trace-library.ts';
import {CaptureDevices} from './capture-devices.ts';
import { AgentCaptureIngestion } from './agent-capture.ts';
import {ThotChain, type ThotChainConfig} from '../../chain/thot.ts';
import {ThotMarketplace} from './thot-market.ts';
import {ThotAnalytics} from './thot-analytics.ts';
import {ThotTradeEvidence} from './thot-trade-evidence.ts';
import {AnvilMoneyPath} from '../../chain/anvil.ts';
import type {Signer} from 'ethers';
import {OpenRouterRelay,type OpenRouterRelayOptions} from './openrouter-relay.ts';
import type {CiphertextStore,KeyProvider} from '../../vault/src/index.ts';

export const DEVELOPMENT_LICENSE='SYNTHETIC DEVELOPMENT DATA ONLY. Non-exclusive research evaluation for 30 days. No model training, onward transfer, re-identification, or account access. This fixture is not an approved legal contract for real data.';
export const PORTFOLIO_DEMO_LICENSE='LOCAL PORTFOLIO DEMONSTRATION ONLY. The selected scrubbed content and account-control predicate may be displayed to the simulated buyer in this user-controlled local workspace for up to 1 day. No external transfer, model training, onward sharing, re-identification or account access. Price, payment and settlement are simulated. This is not a license to an external buyer.';
export const defaultConfig:MarketConfig={development:true,tokenEnabled:false,standingAuthorization:false,exclusivity:false,
  approvedLicenseTemplates:{'development-research-v1':DEVELOPMENT_LICENSE,'local-portfolio-demo-v1':PORTFOLIO_DEMO_LICENSE},approvedCostCodes:[],maxDirectCostsMinor:'0'};

/** Development server intentionally cannot be turned into a production deployment by one flag. */
export async function createApplication(options:{dataDir?:string;databaseUrl?:string;memory?:boolean;onTransactionTiming?:DatabaseOptions['onTransactionTiming'];onObjectTiming?:(timing:Readonly<ObjectTiming>)=>void;config?:Partial<MarketConfig>;masterKey?:Buffer;storage?:{ciphertext:CiphertextStore;keys?:KeyProvider;accounting?:RemoteAccounting;identity?:string};inference?:{provider:InferenceProvider;dailyBudgetMinor:string};robinhood?:RobinhoodConfig;brokerageVerifier?:EvidenceVerifier;tradeEvidenceVerifier?:EvidenceVerifier;plaid?:PlaidConfig;thot?:ThotChainConfig;thotOperatorSigner?:Signer;readOnly?:boolean;openrouter?:OpenRouterRelayOptions}={}) {
  ensure(process.env.NODE_ENV!=='production','PRODUCTION_READINESS_GATES_UNRESOLVED',503);
  ensure(!options.storage?.accounting||typeof options.storage.identity==='string'&&/^[a-f0-9]{64}$/.test(options.storage.identity),'INVALID_REMOTE_STORAGE_IDENTITY');
  const lease=await DataDirectoryLease.acquire(resolve(options.dataDir??process.env.THOT_DATA_DIR??'.thot'),{mode:'application',create:true});
  const dataDir=lease.dataDir;
  let db:Database|undefined,moneyPath:AnvilMoneyPath|undefined,thotChain:ThotChain|undefined,openrouter:OpenRouterRelay|undefined;
  try {
  await ensureStorageFormat(lease,{version:1,backend:options.databaseUrl?'postgres':options.memory?'memory':'pglite',keyCustody:options.masterKey?'external':'local-file',...(options.storage?.ciphertext?{objectStorage:'external' as const}:{}),...(options.storage?.identity?{objectStorageIdentity:options.storage.identity}:{}),...(options.storage?.keys?{objectKeyCustody:'external' as const}:{})});
  let masterKey=options.masterKey;
  if(!masterKey) {
    const keyPath=join(dataDir,'local-vault.key');
    try {
      const handle=await open(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      masterKey=randomBytes(32);try{await handle.writeFile(masterKey);await handle.sync();}finally{await handle.close();}
    } catch(error:any) {
      if(error.code!=='EEXIST')throw error;
      const handle=await open(keyPath,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {const stat=await handle.stat();ensure(stat.isFile()&&stat.size===32&&(stat.mode&0o077)===0,'INSECURE_LOCAL_KEY');masterKey=await handle.readFile();}finally{await handle.close();}
    }
  }
  const config={...defaultConfig,...options.config};
  ensure(config.development,'PRODUCTION_READINESS_GATES_UNRESOLVED',503);
  ensure(config.privateRetentionDays===undefined||(Number.isSafeInteger(config.privateRetentionDays)&&config.privateRetentionDays>=1&&config.privateRetentionDays<=365),'INVALID_RETENTION_POLICY');
  ensure(config.traceExplorerViewers===undefined||(Array.isArray(config.traceExplorerViewers)&&config.traceExplorerViewers.length<=20&&config.traceExplorerViewers.every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id))),'INVALID_TRACE_EXPLORER_VIEWERS');
  const transactionTimings=new TransactionTimingCollector();
  db=await Database.open({...(options.databaseUrl?{url:options.databaseUrl}:options.memory?{}:{dataDir:join(dataDir,'postgres')}),onTransactionTiming:timing=>{transactionTimings.observe(timing);options.onTransactionTiming?.(timing);}});
  const privacy=new PrivacyIntegrations({development:true,vaultRoot:join(dataDir,'objects'),masterKey,clock:config.clock,ciphertextStore:options.storage?.ciphertext,objectKeyProvider:options.storage?.keys,remoteAccounting:options.storage?.accounting});
  const service=new ThotService(db,privacy,config);service.transactionTimings=transactionTimings;service.staged.onObjectTiming=options.onObjectTiming;await service.seedDevelopment();
  openrouter=new OpenRouterRelay(service,{fingerprintSecret:createHmac('sha256',masterKey).update('thot-openrouter-provider-key-fingerprint-v1').digest(),enabled:process.env.THOT_ENABLE_OPENROUTER_RELAY==='true',...options.openrouter,...(options.readOnly?{enabled:false}:{})});
  if(!options.readOnly)await openrouter.recover();
  if(config.anvil){service.moneyPath=moneyPath=new AnvilMoneyPath(service,config.anvil);await service.moneyPath.guard();}
  ensure(!options.thotOperatorSigner||options.thot,'THOT_SIGNER_WITHOUT_CONFIG');
  ensure(!options.readOnly||!options.thotOperatorSigner,'THOT_READ_ONLY_SIGNER_FORBIDDEN');
  if(options.thot){ensure(!config.anvil,'MONEY_PATH_CONFLICT');thotChain=new ThotChain(options.thot,{operatorSigner:options.thotOperatorSigner});await thotChain.guard();}
  const tradeEvidence=new ThotTradeEvidence(service,masterKey,options.robinhood,options.tradeEvidenceVerifier);
  const thot=new ThotMarketplace(service,thotChain,createHmac('sha256',masterKey).update('thot-preview-seed-v2').digest(),tradeEvidence,options.readOnly===true);
  const thotAnalytics=new ThotAnalytics(service,thotChain,{storageUsage:async owner=>(await privacy.vault.usage(owner)).owner});
  service.thotRetention=(tx,id)=>thot.cleanupTrace(tx,id);
  const inference=new InferenceGateway(service,options.inference?.provider,options.inference?.dailyBudgetMinor);
  const inferenceCapture=new InferencePortfolioCapture(service);
  const agentCapture=new AgentCaptureIngestion(service,process.env.THOT_RECORDER_POLICY_FILE?JSON.parse(await readFile(process.env.THOT_RECORDER_POLICY_FILE,'utf8')):undefined);
  const library=new TraceLibrary(service);
  const captureDevices=new CaptureDevices(service,agentCapture);
  agentCapture.deviceActive=(tx,id)=>captureDevices.active(tx,id);
  service.captureProject=(id,root)=>agentCapture.project(id,root);
  const robinhood=new RobinhoodLinks(service,privacy,masterKey,options.robinhood,options.brokerageVerifier);
  const plaid=new PlaidLinks(service,privacy,masterKey,robinhood,options.plaid);
  const portfolio=new ContributorPortfolio(service,robinhood,plaid);
  const robinhoodBrowser=new RobinhoodBrowserCoordinator(robinhood,options.robinhood?.browser);
  let closing:Promise<void>|undefined;
  return {db,privacy,service,thot,thotAnalytics,tradeEvidence,inference,inferenceCapture,agentCapture,captureDevices,library,robinhood,robinhoodBrowser,plaid,portfolio,openrouter,dataDir,close:()=>closing??=(async()=>{await openrouter!.close();thotChain?.close();await service.moneyPath?.close();await robinhoodBrowser.close();await db!.close();await lease.release();})()};
  } catch(error) {await openrouter?.close();thotChain?.close();await moneyPath?.close();if(db)await db.close();await lease.release();throw error;}
}
