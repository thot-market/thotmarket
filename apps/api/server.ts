import {openRemoteStorage} from '../../packages/vault/src/remote-config.ts';
import {CAPTURE_PART_JSON_BYTES} from '../../packages/capture/src/limits.ts';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonicalJson } from '../../packages/protocol/src/index.ts';
import { DomainError, ensure, type Document } from '../../packages/storage/src/index.ts';
import { createApplication } from '../../packages/market/src/bootstrap.ts';
import { loadThotChainConfig } from '../../packages/chain/thot-config.ts';
import { createTestnetOperatorRuntime, loadHostedAuthMemberships, seedHostedAuthMemberships, validateThotHost } from '../../packages/runtime/src/thot-host.ts';
import { startWorkerLoop } from '../worker/main.ts';
import type { PlaidConfig } from '../../packages/market/src/plaid-link.ts';
import type { Actor } from '../../packages/market/src/service.ts';
import { demoUser, demoBuyer, demoOperator, demoSettlement, importDemo, createDemoMandate, policyInput } from '../../packages/market/src/fixtures.ts';
import { completeDevelopmentAllocations } from '../../packages/market/src/chain-worker.ts';
import { OpenAIResponsesProvider, OpenAIChatProvider } from '../../packages/inference/src/index.ts';
import { DeliveryLinks } from '../../packages/market/src/delivery-links.ts';
import { AuthAccessStore, ExternalAuth, ClerkAuth, WalletAuth, walletAuthOrigins, loadWalletAuthConfig, loadAuthConfig, type AuthProvider, type ClerkAuthConfig, type VerifiedIdentity } from '../../packages/auth/src/index.ts';
import { OperationalControls } from '../../packages/market/src/operational-controls.ts';
import { InferenceReconciliation, type BillingReconciliationConfig } from '../../packages/market/src/inference-reconciliation.ts';
import {ApiAdmission} from './admission.ts';
import {OperatorActivity} from './operator-activity.ts';
import {OperatorFleet} from './operator-fleet.ts';
import {operatorProduct} from './operator-product.ts';
import { operatorEnvironment } from './operator-environment.ts';
import {maintenanceStats} from '../../packages/market/src/maintenance.ts';
import { readPublicAsset, publicDocumentRoutes, publicLaunchConfig, type LaunchConfiguration } from './public-site.ts';

type Application=Awaited<ReturnType<typeof createApplication>>;
const readDiagnosticCodes=new Set(['BAD_DATA','UNKNOWN_ERROR','SERVER_ERROR','TIMEOUT','NETWORK_ERROR','CALL_EXCEPTION','OFFCHAIN_FAULT']);
const readDiagnosticTransportCodes=new Set(['ECONNRESET','EAI_AGAIN']);
const readDiagnosticDomainCodes=new Set(['THOT_NOT_CONFIGURED','THOT_BLOCK_UNAVAILABLE','THOT_CODE_PIN_MISMATCH','THOT_DEPLOYMENT_ANCHOR_MISMATCH','THOT_OPERATOR_JOURNAL_REQUIRED','THOT_PRODUCTION_ACTIVATION_PENDING','ANVIL_RESET_RECONCILIATION_REQUIRED','SETTLEMENT_RECONCILIATION_REQUIRED']);
const readDiagnosticMethods=new Set(['eth_call','eth_chainId','eth_blockNumber','eth_getBlockNumber','eth_getCode','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getLogs','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas']);
function readDiagnosticFields(error:unknown):Document {
  const fields:Document={family:'unknown',code:'UNCLASSIFIED',exception_type:'Other',transient_reason:'other'};
  try {
    const e=error as any,prototype=Object.getPrototypeOf(error),errorCode=e?.code;
    if(prototype===Error.prototype)fields.exception_type='Error';
    else if(prototype===TypeError.prototype)fields.exception_type='TypeError';
    else if(prototype===SyntaxError.prototype)fields.exception_type='SyntaxError';
    else if(prototype===RangeError.prototype)fields.exception_type='RangeError';
    if(error instanceof DomainError){fields.family='domain';fields.code=readDiagnosticDomainCodes.has(errorCode)?errorCode:'UNCLASSIFIED_DOMAIN';}
    else if(readDiagnosticCodes.has(errorCode)){fields.family='ethers';fields.code=errorCode;}
    else if(readDiagnosticTransportCodes.has(errorCode)){fields.family='transport';fields.code=errorCode;}
    else if(fields.exception_type!=='Other')fields.family='builtin';
    const rpcCode=e?.info?.error?.code??e?.error?.code;
    if(Number.isSafeInteger(rpcCode))fields.rpc_code=rpcCode;
    const method=e?.info?.payload?.method??e?.payload?.method;
    if(readDiagnosticMethods.has(method))fields.rpc_method=method;
    const httpStatus=e?.info?.response?.statusCode??e?.response?.statusCode;
    if(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599)fields.http_status=httpStatus;
    // Inspect only a bounded nested RPC message, map it to a fixed enum, then
    // discard it. This never authorizes a transaction or retry of a revert.
    const rpcMessage=e?.info?.error?.message??e?.error?.message;
    const message=typeof rpcMessage==='string'?rpcMessage.slice(0,512).toLowerCase():'';
    if(/execution reverted|revert opcode/.test(message))fields.transient_reason='contract_revert';
    else if(/(?:header|block) not found|unknown block|cannot find block/.test(message))fields.transient_reason='block_unavailable';
    else if(/rate limit|too many requests|request limit/.test(message))fields.transient_reason='rate_limit';
    else if(/(?:service|upstream) unavailable|bad gateway|temporarily unavailable|connection refused|connection reset/.test(message))fields.transient_reason='upstream_unavailable';
    else if(/timed? out|timeout/.test(message))fields.transient_reason='timeout';
  } catch { /* Unusual error shapes never escape into diagnostics. */ }
  return fields;
}
export function createHttpServer(app:Application,options:{log?:(event:Document)=>void;clock?:()=>number;sessionTtlMs?:number;externalAuth?:AuthProvider;billing?:BillingReconciliationConfig;publicOrigin?:string;enableDemoOffers?:boolean;admission?:ApiAdmission;launch?:LaunchConfiguration;privy?:{app_id:string;client_id?:string};environmentName?:string;operatorActivity?:OperatorActivity;readOnly?:boolean}={}) {
  ensure(!options.readOnly||app.thot.readOnly&&!app.thot.chain?.operatorAvailable(),'THOT_READ_ONLY_SIGNER_FORBIDDEN');
  const sessions=new Map<string,{actor:Actor;expires:number}>();
  const sessionNow=options.clock??Date.now,sessionTtlMs=options.sessionTtlMs??8*3600000;
  const diagnosticTtlMs=600000,diagnosticLimit=32;
  let readDiagnostics:Array<{expires:number;entry:Readonly<Document>}>=[],diagnosticExpiryTimer:ReturnType<typeof setTimeout>|undefined;
  const pruneReadDiagnostics=()=>{
    const now=sessionNow();readDiagnostics=readDiagnostics.filter(row=>row.expires>now);
    clearTimeout(diagnosticExpiryTimer);diagnosticExpiryTimer=undefined;
    if(readDiagnostics.length){diagnosticExpiryTimer=setTimeout(pruneReadDiagnostics,Math.max(1,readDiagnostics[0]!.expires-now));diagnosticExpiryTimer.unref();}
  };
  const recordReadDiagnostic=(error:unknown,requestId:string,route:string,phase:'handling'|'response_serialization')=>{
    if(route==='/v1/operator/read-diagnostics')return;
    pruneReadDiagnostics();const now=sessionNow();
    const entry=Object.freeze({request_id:requestId,observed_at:new Date(now).toISOString(),route:route==='/v1/thot/workspace'?'/v1/thot/workspace':'other',phase,...readDiagnosticFields(error)});
    readDiagnostics.push({expires:now+diagnosticTtlMs,entry});if(readDiagnostics.length>diagnosticLimit)readDiagnostics.shift();pruneReadDiagnostics();
  };
  ensure(Number.isSafeInteger(sessionTtlMs)&&sessionTtlMs>=1&&sessionTtlMs<=8*3600000,'INVALID_SESSION_TTL');
  const deliveryLinks=new DeliveryLinks(app.service,{clock:options.clock});
  const fleet=new OperatorFleet(app.dataDir);
  const operations=new OperationalControls(app.service),billing=new InferenceReconciliation(app.service,options.billing);
  const externalAuth=options.externalAuth,authMode=externalAuth?.capabilities.mode??'development';
  if(externalAuth instanceof WalletAuth)ensure(options.publicOrigin===externalAuth.origin,'AUTH_ORIGIN_MISMATCH');
  const appOrigins=externalAuth instanceof WalletAuth?externalAuth.allowedOrigins:options.publicOrigin?[options.publicOrigin]:[];
  const appOriginByHost=new Map(appOrigins.map(origin=>[new URL(origin).host,origin]));
  const walletChainId=externalAuth?.capabilities.wallet?.chain_id;
  const walletRpcUrl=externalAuth?.capabilities.wallet?.rpc_url;
  const privy=options.privy?{app_id:options.privy.app_id,...(options.privy.client_id?{client_id:options.privy.client_id}:{}),chain_id:walletChainId,rpc_url:walletRpcUrl}:undefined;
  if(privy)ensure(externalAuth instanceof WalletAuth&&[31337,46630,4663].includes(privy.chain_id!)&&/^[a-z0-9]{20,64}$/.test(privy.app_id)&&(!privy.client_id||/^[a-z0-9_-]{10,100}$/i.test(privy.client_id)),'INVALID_PRIVY_PUBLIC_CONFIG');
  const demoOffers=app.service.config.development&&(options.enableDemoOffers??!externalAuth);
  const access=externalAuth?.access??new AuthAccessStore(app.db,'thot:development',sessionNow);
  const admission=options.admission??new ApiAdmission({clock:sessionNow});
  const handle=async(req:IncomingMessage,res:ServerResponse)=>{
    const started=Date.now(),requestId=randomUUID();let route='unknown',rateConsumed=false,phase:'handling'|'response_serialization'='handling';
    let releaseBody:undefined|(()=>void),releaseRequest:undefined|(()=>void),releaseAuth:undefined|(()=>void),releaseVerified:undefined|(()=>void);
    const chargeRate=(kind:'public'|'authenticated')=>{rateConsumed=true;if(kind==='public')admission.public();};
    const verifiedAdmission=(kind:'account'|'capture',owner:string)=>{releaseAuth?.();releaseAuth=undefined;releaseVerified=admission.enterVerified(kind,owner);chargeRate('authenticated');};
    const reply=(status:number,value:unknown)=>{
      // Serialization may reject an invalid response. Keep headers unsent so the
      // request handler can return its structured error instead of an empty 200.
      const previousPhase=phase;phase='response_serialization';
      const body=canonicalJson(value);phase=previousPhase;
      if(!req.complete&&(req.method==='POST'||req.method==='PATCH'))res.setHeader('Connection','close');
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(body);
    };
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    const clerkOrigin=externalAuth?.capabilities.clerk?.frontend_api_url,plaidCdn=app.plaid.capabilities().plaid_linking?' https://cdn.plaid.com':'';
    res.setHeader('Content-Security-Policy',privy
      ? `default-src 'self'; script-src 'self' https://challenges.cloudflare.com${plaidCdn}; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* https://auth.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org ${walletRpcUrl}; img-src 'self' data: blob:; font-src 'self'; frame-src 'self' https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com${plaidCdn}; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
      : clerkOrigin
      ? `default-src 'self'; script-src 'self' ${clerkOrigin} https://challenges.cloudflare.com${plaidCdn}; style-src 'self' 'unsafe-inline'; connect-src 'self' ${clerkOrigin} http://127.0.0.1:*; img-src 'self' data: https://img.clerk.com; frame-src ${clerkOrigin} https://challenges.cloudflare.com${plaidCdn}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
      : `default-src 'self'; script-src 'self'${plaidCdn}; style-src 'self'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data:; frame-src 'self'${plaidCdn}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    res.setHeader('X-Request-ID',requestId);
    try {
      const host=req.headers.host??'';
      // Only the actual Host selects an origin. Forwarded headers cannot select a
      // wallet namespace or bypass the exact-origin browser mutation boundary.
      const requestOrigin=appOriginByHost.get(host);
      const url=new URL(req.url??'/',`http://${host}`);route=url.pathname;
      releaseRequest=admission.enterRequest();
      // The public app shell is a safe landing page for external links and Clerk
      // redirects. This exception never applies to APIs, assets, or mutations.
      const documentNavigation=req.method==='GET'&&(publicDocumentRoutes.has(route)||route==='/ops'||route==='/ops/')
        &&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if(options.publicOrigin){
        ensure(requestOrigin,'INVALID_HOST',403);
        ensure(documentNavigation||!req.headers.origin||req.headers.origin===requestOrigin,'CROSS_ORIGIN_DENIED',403);
      } else {
        ensure(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host),'INVALID_HOST',403);
        ensure(documentNavigation||!req.headers.origin||req.headers.origin===`http://${host}`,'CROSS_ORIGIN_DENIED',403);
      }
      ensure(documentNavigation||req.headers['sec-fetch-site']!=='cross-site','CROSS_ORIGIN_DENIED',403);

      // The retained old candidate serves only authentication and already-delivered
      // licensed content. Deny every other API route before parsing a request body.
      if(options.readOnly&&route.startsWith('/v1/')){
        const safeGet=req.method==='GET'&&['/v1/public/launch-config','/v1/public/keys','/v1/auth/capabilities','/v1/auth/session','/v1/thot/capabilities','/v1/thot/workspace'].includes(route);
        const safePost=req.method==='POST'&&['/v1/auth/wallet/challenge','/v1/auth/wallet/verify','/v1/auth/session/revoke','/v1/thot/offers/delivery'].includes(route);
        ensure(safeGet||safePost,'THOT_READ_ONLY',403);
      }

      const portableAsset=route.match(/^\/capture-verifier\/(verify\.mjs|canonical\.mjs|hardware\.mjs|verify_dcap\.py|requirements\.txt|README\.txt)$/);
      if(req.method==='GET'&&portableAsset){chargeRate('public');const file=await readFile(new URL('../../packages/provenance/portable/'+portableAsset[1],import.meta.url));res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(file);return;}
      if(req.method==='GET'||req.method==='HEAD') {
        const asset=await readPublicAsset(route);
        if(asset){chargeRate('public');res.writeHead(200,{'Content-Type':asset.contentType});res.end(req.method==='HEAD'?undefined:asset.body);return;}
      }
      if(req.method==='GET'&&route==='/v1/public/launch-config'){chargeRate('public');reply(200,publicLaunchConfig(options.launch));return;}
      if(req.method==='GET'&&['/app','/app/','/ops','/ops/','/operator-app.js','/operator.css','/style.css','/app.js','/money-ui.js','/thot-ui.js','/staking-ui.js','/staking.css','/thot-analytics-ui.js','/mandate-editor.js','/inference-ui.js','/operations-ui.js','/contributor-ui.js','/clerk-auth-ui.js','/wallet-auth-ui.js','/privy-auth.bundle.js','/privy-auth-state.js','/openrouter-ui.js','/agent-capture-ui.js','/capture-export-ui.js','/library-ui.js','/setup-ui.js','/robinhood-setup-ui.js','/environment-ui.js','/getting-started','/getting-started.js'].includes(route)) {
        chargeRate('public');
        const name=route==='/app'||route==='/app/'?'index.html':route==='/ops'||route==='/ops/'?'operator.html':route==='/getting-started'?'getting-started.html':route.slice(1);
        const file=await readFile(new URL('../dashboard/'+name,import.meta.url));
        res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});res.end(file);return;
      }
      if(req.method==='GET'&&route==='/healthz') {chargeRate('public');await app.db.query('SELECT 1');reply(200,{status:'ok',mode:'local-development',version:'0.2.0',live_integrations:app.inference.capabilities().enabled});return;}
      if(req.method==='GET'&&route==='/v1/auth/capabilities'){chargeRate('public');reply(200,{mode:authMode,development_session_available:!externalAuth,bearer_required:authMode!=='wallet_siwe',external_login_available:false,session_revocation_available:true,rate_limits:access.limits,...(externalAuth instanceof WalletAuth?externalAuth.capabilitiesForOrigin(requestOrigin!):externalAuth?.capabilities??{}),...(privy?{privy}:{}),production_enabled:false});return;}
      if(req.method==='GET'&&route==='/v1/public/keys'){chargeRate('public');reply(200,{disclosure:{key_id:'thot-local-disclosure-v1',algorithm:'Ed25519',public_key_pem:app.privacy.disclosurePublicKey},development:true});return;}
      const mutating=req.method==='POST'||req.method==='PATCH';
      const bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]{1,16384})$/)?.[1];
      const cookieToken=externalAuth instanceof WalletAuth?externalAuth.tokenFromCookie(req.headers.cookie):'';
      const token=bearer||cookieToken;
      const deviceCapture=route.match(/^\/v1\/capture-devices\/([^/]+)\/(captures|disconnect)$/);
      const captureCapability=route.match(/^\/v1\/agent-captures\/([^/]+)\/(parts|complete|checkpoint|authorize|heartbeat)$/);
      const publicAuth=req.method==='POST'&&(route==='/v1/dev/session'||externalAuth instanceof WalletAuth&&['/v1/auth/wallet/challenge','/v1/auth/wallet/verify'].includes(route));
      const relayRoute=req.method==='POST'&&route==='/v1/openrouter/chat/completions';
      const delegated=req.method==='POST'&&(!!deviceCapture||!!captureCapability);
      const authenticateSession=async()=>{
        ensure(token,'UNAUTHENTICATED',401);
        if(cookieToken&&req.method!=='GET'&&req.method!=='HEAD'&&externalAuth instanceof WalletAuth)externalAuth.requireOrigin(req.headers.origin);
        if(externalAuth)return externalAuth.authenticate(token);
        const session=sessions.get(token);ensure(session&&session.expires>sessionNow(),'UNAUTHENTICATED',401);
        return {actor:session.actor,expires_at:new Date(session.expires).toISOString(),identity:undefined};
      };
      // Authenticate narrow upload capabilities before buffering any caller JSON.
      // Dispatch validates them again so revocation during upload takes effect.
      if(!publicAuth){ensure(token,'UNAUTHENTICATED',401);releaseAuth=admission.enterAuthentication(token);}
      if(publicAuth){
        if(route==='/v1/dev/session')ensure(app.service.config.development&&!externalAuth,'DEVELOPMENT_AUTH_DISABLED',403);
        else if(externalAuth instanceof WalletAuth)externalAuth.requireOrigin(req.headers.origin);
        chargeRate('public');
      }else if(relayRoute){ensure(bearer,'UNAUTHENTICATED',401);const authorization=await app.openrouter.authorize(bearer);verifiedAdmission('account',authorization.owner_id);}
      else if(delegated){
        ensure(bearer,'UNAUTHENTICATED',401);
        if(deviceCapture){const device=await app.db.transaction(tx=>app.captureDevices.authenticate(tx,decodeURIComponent(deviceCapture[1]!),bearer));verifiedAdmission('capture',device.owner_id);}
        else {const capture=await app.agentCapture.authenticate(decodeURIComponent(captureCapability![1]!),bearer);if(capture.device_id)await app.db.transaction(tx=>app.captureDevices.active(tx,capture.device_id));verifiedAdmission('capture',capture.owner_id);}
      }else {const session=await authenticateSession();verifiedAdmission('account',session.actor.id);}
      const routeLimit=publicAuth||delegated&&!['parts','complete','checkpoint'].includes(captureCapability?.[2]??'')?8192:route.startsWith('/v1/contributor/import/')?16_000_000:captureCapability?CAPTURE_PART_JSON_BYTES:4_000_000;
      const body=mutating?await jsonBody(req,Math.min(routeLimit,admission.limits.body_bytes_in_flight),admission,release=>{releaseBody=release;},()=>{if(req.headers.expect?.toLowerCase()==='100-continue')res.writeContinue();}):{};
      if(req.method==='POST'&&route==='/v1/dev/session') {
        ensure(app.service.config.development&&!externalAuth,'DEVELOPMENT_AUTH_DISABLED',403);
        const actor=body.role==='user'?demoUser:body.role==='buyer_admin'?demoBuyer:body.role==='operator_security'?demoOperator:undefined;
        ensure(actor,'ROLE_NOT_AVAILABLE',403);
        await access.consume(actor,true);
        for(const [key,value]of sessions)if(value.expires<=sessionNow())sessions.delete(key);
        ensure(sessions.size<1000,'SESSION_LIMIT',429);
        const token=randomBytes(32).toString('base64url');sessions.set(token,{actor,expires:sessionNow()+sessionTtlMs});
        reply(200,{token,actor,development:true,expires_in_seconds:Math.ceil(sessionTtlMs/1000),permissions:{trace_explorer:app.library.canExplore(actor)}});return;
      }
      if(externalAuth instanceof WalletAuth&&req.method==='POST'&&route==='/v1/auth/wallet/challenge'){
        const challenge=await externalAuth.challenge(body as any,req.headers.origin);res.setHeader('Set-Cookie',challenge.set_cookie);reply(200,challenge.body);return;
      }
      if(externalAuth instanceof WalletAuth&&req.method==='POST'&&route==='/v1/auth/wallet/verify'){
        const verified=await externalAuth.verify(body as any,req.headers.origin,req.headers.cookie);res.setHeader('Set-Cookie',verified.set_cookies);reply(200,{...verified.body,permissions:{trace_explorer:app.library.canExplore(verified.body.actor)}});return;
      }
      if(relayRoute){
        ensure(bearer,'UNAUTHENTICATED',401);
        const controller=new AbortController();const abort=()=>{if(!res.writableFinished)controller.abort();};res.once('close',abort);
        try{
          const upstream=await app.openrouter.relay(bearer,body,{idempotencyKey:typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined,signal:controller.signal});
          const headers:Record<string,string>={'Content-Type':upstream.headers.get('content-type')??'application/json','Cache-Control':'no-store','X-Accel-Buffering':'no'};
          for(const name of ['x-thot-request-id','x-thot-trace-id','x-thot-replayed','x-should-retry']){const value=upstream.headers.get(name);if(value)headers[name]=value;}
          res.writeHead(upstream.status,headers);res.flushHeaders();
          if(upstream.body){const reader=upstream.body.getReader();try{while(!controller.signal.aborted){const next=await reader.read();if(next.done)break;if(!res.write(next.value))await once(res,'drain',{signal:controller.signal});}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
          if(!res.destroyed)res.end();
        }finally{res.off('close',abort);controller.abort();}return;
      }
      ensure(token,'UNAUTHENTICATED',401);
      if(req.method==='POST'&&deviceCapture){ensure(bearer,'UNAUTHENTICATED',401);const id=decodeURIComponent(deviceCapture[1]!);reply(200,deviceCapture[2]==='captures'?await app.captureDevices.begin(id,token,body):await app.captureDevices.disconnect(id,token,String(req.headers['idempotency-key']??'')));return;}
      const authorizeCapture=route.match(/^\/v1\/agent-captures\/([^/]+)\/authorize$/);
      if(req.method==='POST'&&authorizeCapture){ensure(bearer,'UNAUTHENTICATED',401);reply(200,await app.agentCapture.authorize(decodeURIComponent(authorizeCapture[1]!),token));return;}
      const capturePart=route.match(/^\/v1\/agent-captures\/([^/]+)\/parts$/);
      if(req.method==='POST'&&capturePart){ensure(bearer,'UNAUTHENTICATED',401);ensure(typeof req.headers['idempotency-key']==='string'&&req.headers['idempotency-key'].length>=8&&req.headers['idempotency-key'].length<=160,'IDEMPOTENCY_KEY_REQUIRED');reply(200,await app.agentCapture.part(decodeURIComponent(capturePart[1]!),token,String(req.headers['idempotency-key']??''),body));return;}
      const heartbeatCapture=route.match(/^\/v1\/agent-captures\/([^/]+)\/heartbeat$/);
      if(req.method==='POST'&&heartbeatCapture){ensure(bearer,'UNAUTHENTICATED',401);reply(200,await app.agentCapture.heartbeat(decodeURIComponent(heartbeatCapture[1]!),token));return;}
      const checkpointCapture=route.match(/^\/v1\/agent-captures\/([^/]+)\/checkpoint$/);
      if(req.method==='POST'&&checkpointCapture){ensure(bearer,'UNAUTHENTICATED',401);reply(200,await app.agentCapture.checkpoint(decodeURIComponent(checkpointCapture[1]!),token,String(req.headers['idempotency-key']??''),body));return;}
      const publicCapture=route.match(/^\/v1\/agent-captures\/([^/]+)\/complete$/);
      if(req.method==='POST'&&publicCapture){ensure(bearer,'UNAUTHENTICATED',401);
        const uploadKey=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:'';
        ensure(uploadKey.length>=8&&uploadKey.length<=160,'IDEMPOTENCY_KEY_REQUIRED');
        reply(200,await app.agentCapture.complete(decodeURIComponent(publicCapture[1]!),token,uploadKey,body));return;
      }
      const verified=await authenticateSession(),actor=verified.actor,expiresAt=verified.expires_at,identity:VerifiedIdentity|undefined=verified.identity;
      // Fail closed for this limited principal, including future session routes.
      if(actor.role==='operator_maintenance')ensure(
        req.method==='GET'&&['/v1/auth/session','/v1/maintenance/stats'].includes(route)||
        req.method==='POST'&&route==='/v1/auth/session/revoke','FORBIDDEN',403);
      const service=app.service;
      const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:'';
      if(req.method==='POST'||req.method==='PATCH')ensure(key.length>=8&&key.length<=160,'IDEMPOTENCY_KEY_REQUIRED');
      if(route!=='/v1/auth/session/revoke')await access.consume(actor,req.method==='POST'||req.method==='PATCH');
      const segments=route.split('/').filter(Boolean).map(s=>decodeURIComponent(s));
      let result:unknown;
      if(route==='/v1/auth/session'&&req.method==='GET')result={...(externalAuth instanceof WalletAuth?{wallet_address:identity?.subject.split(':').at(-1),chain_id:externalAuth.chainId}:{}),actor,expires_at:expiresAt,mode:authMode,permissions:{trace_explorer:app.library.canExplore(actor)}};
      else if(route==='/v1/maintenance/stats'&&req.method==='GET'){
        ensure(url.searchParams.size===0,'INVALID_MAINTENANCE_QUERY');result=await maintenanceStats(service,actor);
      }
      else if(route==='/v1/operator/read-diagnostics'&&req.method==='GET'){
        ensure(actor.role==='operator_security','FORBIDDEN',403);pruneReadDiagnostics();
        result={retention_seconds:diagnosticTtlMs/1000,limit:diagnosticLimit,entries:Object.freeze(readDiagnostics.map(row=>Object.freeze({...row.entry})))};
      }
      else if(route==='/v1/operator/product'&&req.method==='GET'){
        ensure(actor.role==='operator_security','FORBIDDEN',403);result=await operatorProduct(app);
      }
      else if(route==='/v1/operator/activity'&&req.method==='GET'){
        ensure(actor.role==='operator_security','FORBIDDEN',403);ensure(options.operatorActivity,'ACTIVITY_NOT_CONFIGURED',503);
        const query=new URL(req.url!,'http://local').searchParams;
        const snapshot=await options.operatorActivity.snapshot({q:query.get('q')??undefined,group:query.get('group')??undefined,status:query.get('status')??undefined}) as Document;
        if(query.get('summary')==='true'){snapshot.resources.samples=snapshot.resources.samples.slice(-1);snapshot.logs.entries=[];delete snapshot.traffic.retained_24h.minute_buckets;}
        result=snapshot;
      }
      else if(route==='/v1/operator/fleet'&&['GET','POST'].includes(req.method!)){
        ensure(actor.role==='operator_security','FORBIDDEN',403);result=req.method==='POST'?await fleet.update(body):await fleet.read();
      }
      else if(route==='/v1/operator/environment'&&req.method==='GET'){
        ensure(actor.role==='operator_security','FORBIDDEN',403);
        result=await operatorEnvironment(app,{authMode,environmentName:options.environmentName});
      }
      else if(route==='/v1/auth/session/revoke'&&req.method==='POST'){
        if(externalAuth instanceof WalletAuth)res.setHeader('Set-Cookie',[externalAuth.clearSessionCookie(),externalAuth.clearChallengeCookie()]);
        ensure(Object.keys(body).length===0,'INVALID_AUTH_REVOCATION');
        if(externalAuth)result=externalAuth.revoke?await externalAuth.revoke(identity!,actor,key):await externalAuth.access.revoke(identity!,actor,key);
        else {sessions.delete(token);result={revoked:true};}
      }
      else if(route==='/v1/operator/auth/membership'&&req.method==='POST'){
        ensure(externalAuth,'EXTERNAL_AUTH_REQUIRED',409);result=await externalAuth.access.provision(actor,key,body as any);
      }
      else if(route.startsWith('/v1/dev/')) {
        ensure(service.config.development&&!externalAuth,'DEVELOPMENT_AUTH_DISABLED',403);ensure(req.method==='POST','METHOD_NOT_ALLOWED',405);
        if(route==='/v1/dev/trace'){ensure(actor.role==='user','FORBIDDEN',403);result=await importDemo(service,actor,body.scenario,key);}
        else if(route==='/v1/dev/policy') {
          ensure(actor.role==='user','FORBIDDEN',403);
          const input=await app.db.command(actor.id,key+':fixture',{action:'demo-policy'},async()=>policyInput(service));
          result=await service.createPolicy(actor,key,input);
        }
        else if(route==='/v1/dev/mandate'){ensure(actor.role==='buyer_admin','FORBIDDEN',403);result=await createDemoMandate(service,body.category,key);}
        else if(route==='/v1/dev/run-worker')result=await service.runWorker();
        else if(route==='/v1/dev/complete-burns'){ensure(!service.moneyPath,'MOCK_CHAIN_DISABLED');result=await app.db.command(actor.id,key,{action:'development-chain'},tx=>completeDevelopmentAllocations(tx,actor.id));}
        else if(route==='/v1/dev/inference-settle') {
          ensure(actor.role==='user','FORBIDDEN',403);
          await app.db.transaction(tx=>tx.get('inference_credit_reservations',body.reservation_id,actor.id));
          result=await service.settleInference(demoSettlement,key,body.reservation_id,{actual_minor:body.actual_minor});
        }
        else throw new DomainError('NOT_FOUND',404);
      }
      else if(route==='/v1/thot/capabilities'&&req.method==='GET')result=app.thot.capabilities();
      else if(route==='/v1/thot/workspace'&&req.method==='GET')result=await app.thot.workspace(actor);
      else if(route==='/v1/thot/analytics'&&req.method==='GET')result=await app.thotAnalytics.workspace(actor,Object.fromEntries(url.searchParams));
      else if(route==='/v1/thot/analytics/leaderboard'&&req.method==='GET')result=await app.thotAnalytics.leaderboard(actor,Object.fromEntries(url.searchParams));
      else if(route==='/v1/thot/analytics/profile'&&req.method==='POST')result=await app.thotAnalytics.setProfile(actor,key,body);
      else if(route==='/v1/thot/analytics/portfolio'&&req.method==='GET')result=await app.thotAnalytics.portfolio(actor,Object.fromEntries(url.searchParams));
      else if(route==='/v1/thot/analytics/cohort'&&req.method==='GET')result=await app.thotAnalytics.cohort(actor);
      else if(route==='/v1/thot/wallet/challenge'&&req.method==='POST')result=await app.thot.challenge(actor,key,body,requestOrigin??`http://${host}`);
      else if(route==='/v1/thot/wallet/link'&&req.method==='POST')result=await app.thot.link(actor,key,body);
      else if(route==='/v1/thot/trade-evidence/begin'&&req.method==='POST'){ensure(app.thot.capabilities().trade_evidence,'TRADE_EVIDENCE_UNAVAILABLE',503);result=await app.tradeEvidence.begin(actor,key,body);}
      else if(route==='/v1/thot/trade-evidence/complete'&&req.method==='POST'){ensure(app.thot.capabilities().trade_evidence,'TRADE_EVIDENCE_UNAVAILABLE',503);result=await app.tradeEvidence.complete(actor,key,body);}
      else if(route==='/v1/thot/listings/evidence'&&req.method==='POST')result=await app.thot.buyerEvidence(actor,body);
      else if(route==='/v1/thot/listings/metadata'&&req.method==='POST')result=await app.thot.listingMetadata(actor,body.trace_id);
      else if(route==='/v1/thot/listings'&&req.method==='POST')result=await app.thot.listTrace(actor,key,body);
      else if(route==='/v1/thot/listings/activate'&&req.method==='POST')result=await app.thot.activateListing(actor,key,body);
      else if(route==='/v1/thot/governance/prepare'&&req.method==='POST')result=await app.thot.prepareGovernance(actor,body);
      else if(route==='/v1/thot/streams/prepare'&&req.method==='POST')result=await app.thot.prepareStream(actor,body);
      else if(route==='/v1/thot/streams'&&req.method==='GET')result=await app.thot.listStreams(actor);
      else if(route==='/v1/thot/streams/revoke'&&req.method==='POST')result=await app.thot.revokeStream(actor,body.id);
      else if(route==='/v1/thot/sampling'&&req.method==='GET')result=await app.thot.samplingWorkspace(actor,url.searchParams.get('campaign_cursor')??undefined);
      else if(route==='/v1/thot/sampling'&&req.method==='POST')result=await app.thot.queueSamples(actor,key,body);
      else if(route==='/v1/thot/listings/unlist'&&req.method==='POST')result=await app.thot.unlist(actor,key,body.id);
      else if(route==='/v1/thot/listings/sample'&&req.method==='POST')result=await app.thot.buyerSample(actor,body);
      else if(route==='/v1/thot/assay'&&req.method==='POST')result=await app.thot.assay(actor,key,body);
      else if(route==='/v1/thot/offers/prepare'&&req.method==='POST')result=await app.thot.prepareOffer(actor,key,body);
      else if(route==='/v1/thot/offers/review'&&req.method==='POST')result=await app.thot.reviewOffer(actor,body.id);
      else if(route==='/v1/thot/offers/delivery'&&req.method==='POST')result=await app.thot.delivery(actor,body.id);
      else if(route==='/v1/thot/disputes/confirm'&&req.method==='POST')result=await app.thot.confirmDispute(actor,body);
      else if(route==='/v1/thot/disputes'&&req.method==='GET')result=await app.thot.disputes(actor,{after_id:url.searchParams.get('after_id')??undefined});
      else if(route==='/v1/thot/disputes/evidence'&&req.method==='POST')result=await app.thot.disputeEvidence(actor,body);
      else if(route==='/v1/thot/disputes/respond'&&req.method==='POST')result=await app.thot.respondToDispute(actor,body);
      else if(route==='/v1/thot/disputes/waive-response'&&req.method==='POST')result=await app.thot.waiveDisputeResponseWindow(actor,body);
      else if(route==='/v1/thot/disputes/vote'&&req.method==='POST')result=await app.thot.voteDispute(actor,body);
      else if(route==='/v1/thot/disputes/finalize'&&req.method==='POST')result=await app.thot.finalizeExpiredDispute(actor,body);
      else if(/^\/v1\/contributor\/openrouter\/requests\/[^/]+\/source$/.test(route)&&req.method==='GET')result=await app.openrouter.source(actor,decodeURIComponent(route.split('/')[5]!));
      else if(route==='/v1/contributor/openrouter'&&req.method==='GET')result=await app.openrouter.status(actor);
      else if(route==='/v1/contributor/openrouter/connect'&&req.method==='POST'){const {sale_policy_id,sale_policy_signature,rights_confirmed,model_output_licensed,...connection}=body;let salePolicyId:string|undefined;if(sale_policy_id!==undefined||sale_policy_signature!==undefined){ensure(typeof sale_policy_id==='string'&&typeof sale_policy_signature==='string','INVALID_STREAM_POLICY');ensure(rights_confirmed===true&&model_output_licensed===true,'STREAM_RIGHTS_REQUIRED');salePolicyId=(await app.thot.activateStream(actor,sale_policy_id,sale_policy_signature)).id;}else{ensure(rights_confirmed===undefined&&model_output_licensed===undefined,'INVALID_STREAM_POLICY');}result=await app.openrouter.connect(actor,connection,{salePolicyId});}
      else if(route==='/v1/contributor/openrouter/disconnect'&&req.method==='POST'){ensure(Object.keys(body).length===0,'INVALID_OPENROUTER_REQUEST');result=await app.openrouter.disconnect(actor);}
      else if(route==='/v1/thot/transaction'&&req.method==='POST')result=await app.thot.transaction(actor,body);
      else if(req.method==='GET'&&route==='/v1/money/capabilities')result=service.moneyPath?.capabilities()??{mode:'mock'};
      else if(req.method==='POST'&&segments[1]==='money'&&segments[2]==='quote'&&segments.length===4){ensure(service.moneyPath,'ANVIL_DISABLED');result=await service.moneyPath.quote(actor,segments[3]!,body.wallet_address);}
      else if(req.method==='GET'&&segments[1]==='money'&&segments[2]==='settlements'&&segments.length===4){ensure(service.moneyPath,'ANVIL_DISABLED');result=await service.moneyPath.status(actor,segments[3]!);}
      else if(req.method==='GET'&&route==='/v1/contributor/portfolio'){const portfolio=await app.portfolio.list(actor);result={...portfolio,capabilities:{...portfolio.capabilities,demo_offers:demoOffers&&!service.moneyPath,tee_capture:!!app.agentCapture.recorderPolicy}};}
      else if(req.method==='GET'&&route==='/v1/contributor/library')result=await app.library.list(actor,Object.fromEntries(url.searchParams));
      else if(segments.length===4&&segments.slice(0,3).join('/')==='v1/contributor/library'&&req.method==='GET')result=await app.library.item(actor,segments[3]!);
      else if(segments.length===4&&segments.slice(0,3).join('/')==='v1/contributor/library'&&req.method==='PATCH')result=await app.library.update(actor,key,segments[3]!,body);
      else if(req.method==='GET'&&route==='/v1/operator/trace-explorer')result=await app.library.operator(actor,Object.fromEntries(url.searchParams));
      else if(req.method==='POST'&&segments.length===5&&segments.slice(0,3).join('/')==='v1/contributor/library'&&segments[4]==='refresh')result=await app.library.reprocess(actor,key,segments[3]!);
      else if(req.method==='POST'&&segments.length===5&&segments.slice(0,3).join('/')==='v1/contributor/library'&&segments[4]==='prepare-sale')result=await app.portfolio.prepareSale(actor,key,segments[3]!,body);
      else if(req.method==='POST'&&route==='/v1/contributor/capture-devices'){
        const {sale_policy_id,sale_policy_signature,rights_confirmed,model_output_licensed,...connection}=body;
        ensure(['codex','claude'].includes(connection.client)&&typeof connection.device_name==='string'&&connection.device_name.length>=1&&connection.device_name.length<=80&&!/[\x00-\x1f\x7f]/.test(connection.device_name),'INVALID_CAPTURE_DEVICE');
        ensure(Object.keys(connection).every(k=>['client','device_name','save_privately'].includes(k)),'INVALID_CAPTURE_DEVICE');
        connection.save_privately??=true;
        ensure(typeof connection.save_privately==='boolean','INVALID_DEVICE_CONNECTION');
        let salePolicyId:string|undefined;
        if(sale_policy_id!==undefined||sale_policy_signature!==undefined){
          ensure(connection.save_privately===false&&typeof sale_policy_id==='string'&&typeof sale_policy_signature==='string','INVALID_STREAM_POLICY');
          ensure(rights_confirmed===true&&model_output_licensed===true,'STREAM_RIGHTS_REQUIRED');
          salePolicyId=(await app.thot.activateStream(actor,sale_policy_id,sale_policy_signature)).id;
        }else ensure(connection.save_privately!==false&&rights_confirmed===undefined&&model_output_licensed===undefined,'STREAM_RIGHTS_REQUIRED');
        result=await app.captureDevices.create(actor,connection,{salePolicyId});
      }
      else if(req.method==='GET'&&route==='/v1/contributor/capture-devices')result=await app.captureDevices.list(actor);
      else if(req.method==='POST'&&segments.length===5&&segments.slice(0,3).join('/')==='v1/contributor/capture-devices'&&segments[4]==='disconnect')result=await app.captureDevices.revoke(actor,key,segments[3]!);
      else if(req.method==='POST'&&route==='/v1/contributor/agent-captures/begin')result=await app.agentCapture.begin(actor,body);
      else if(req.method==='GET'&&segments.length===5&&segments.slice(0,3).join('/')==='v1/contributor/agent-captures'&&segments[4]==='status')result=await app.agentCapture.status(actor,segments[3]!);
      else if(req.method==='GET'&&segments.length===7&&segments.slice(0,3).join('/')==='v1/contributor/agent-captures'&&segments[4]==='proof'&&segments[5]==='parts')result=await app.agentCapture.proofPart(actor,segments[3]!,Number(segments[6]));
      else if(req.method==='GET'&&segments.length===5&&segments.slice(0,3).join('/')==='v1/contributor/agent-captures'&&segments[4]==='proof')result=await app.agentCapture.proof(actor,segments[3]!);
      else if(req.method==='POST'&&route==='/v1/contributor/import/preview')result=app.portfolio.preview(actor,body);
      else if(req.method==='POST'&&route==='/v1/contributor/import/confirm')result=await app.portfolio.import(actor,key,body);
      else if(req.method==='POST'&&segments.length===5&&segments[0]==='v1'&&segments[1]==='contributor'&&segments[2]==='portfolio'&&segments[4]==='demo-offer'){
        ensure(demoOffers,'DEMO_OFFERS_DISABLED',403);result=await app.portfolio.demoOffer(actor,key,segments[3]!);
      }
      else if(req.method==='POST'&&route==='/v1/contributor/robinhood/link-jobs')result=await app.robinhood.begin(actor,key);
      else if(req.method==='POST'&&route==='/v1/contributor/plaid/link-jobs')result=await app.plaid.begin(actor,key);
      else if(req.method==='POST'&&segments.length===6&&segments.slice(0,4).join('/')==='v1/contributor/plaid/link-jobs'&&segments[5]==='complete')result=await app.plaid.complete(actor,key,segments[4]!,body.public_token);
      else if(req.method==='POST'&&route==='/v1/contributor/robinhood/disconnect')result=await app.plaid.disconnect(actor,key);
      else if(req.method==='POST'&&route==='/v1/contributor/plaid/refresh')result=await app.plaid.refresh(actor,key);
      else if(req.method==='GET'&&route==='/v1/contributor/plaid/link-token')result=await app.plaid.pendingLinkToken(actor);
      else if(req.method==='GET'&&segments.length===6&&segments.slice(0,4).join('/')==='v1/contributor/robinhood/credentials'&&segments[5]==='proof')result=await app.robinhood.proof(actor,segments[4]!);
      else if(segments[0]==='v1'&&segments[1]==='contributor'&&segments[2]==='robinhood'&&segments[3]==='link-jobs'){
        if(segments.length===5&&req.method==='GET')result=await app.robinhood.get(actor,segments[4]!);
        else if(segments.length===6&&segments[5]==='cancel'&&req.method==='POST')result=await app.robinhoodBrowser.cancel(actor,key,segments[4]!);
        else if(segments.length===6&&segments[5]==='browser'&&req.method==='POST'){
          ensure(!externalAuth,'DEVELOPMENT_AUTH_DISABLED',403);result=await app.robinhoodBrowser.start(actor,key,segments[4]!);
        }
        else if(segments.length===6&&segments[5]==='complete'&&req.method==='POST')result=await app.robinhood.complete(actor,key,segments[4]!,body.evidence);
        else throw new DomainError('NOT_FOUND',404);
      }
      else if(req.method==='GET'&&route==='/v1/traces')result=await service.traces(actor);
      else if(req.method==='POST'&&route==='/v1/traces/import')result=await service.importTrace(actor,key,body);
      else if(segments[0]==='v1'&&segments[1]==='traces'&&segments.length===3&&req.method==='GET')result=await service.trace(actor,segments[2]!);
      else if(segments[0]==='v1'&&segments[1]==='traces'&&segments.length===4) {
        const id=segments[2]!,action=segments[3];
        if(action==='receipts'&&req.method==='GET')result=await service.receipts(actor,id);
        else if(action==='similarity'&&req.method==='GET')result=await service.similarity(actor,id);
        else if(action==='credentials'&&req.method==='POST')result=await service.linkEvidence(actor,key,id,'credential',body);
        else if(action==='outcomes'&&req.method==='POST')result=await service.linkEvidence(actor,key,id,'outcome',body);
        else if(action==='delete'&&req.method==='POST')result=await service.deleteTrace(actor,key,id);
        else throw new DomainError('NOT_FOUND',404);
      }
      else if(req.method==='POST'&&route==='/v1/policies')result=await service.createPolicy(actor,key,body);
      else if(req.method==='POST'&&route==='/v1/receipts/revoke')result=await service.revokeReceipt(actor,key,body.receipt_id);
      else if(req.method==='GET'&&route==='/v1/candidates')result=await service.candidates(actor);
      else if(req.method==='GET'&&segments[1]==='candidates'&&segments[3]==='preview'&&segments.length===4)result=await service.preview(actor,segments[2]!);
      else if(req.method==='POST'&&route==='/v1/sale-authorizations')result=await service.authorize(actor,key,body);
      else if(req.method==='GET'&&route==='/v1/earnings')result=await service.earnings(actor);
      else if(req.method==='GET'&&route==='/v1/inference/capabilities'){ensure(actor.role==='user','FORBIDDEN',403);result=app.inference.capabilities();}
      else if(req.method==='GET'&&route==='/v1/inference/requests')result=await app.inference.list(actor);
      else if(req.method==='POST'&&route==='/v1/inference/requests')result=await app.inference.create(actor,key,body);
      else if(segments[0]==='v1'&&segments[1]==='inference'&&segments[2]==='requests'&&segments.length>=4){
        const id=segments[3]!,action=segments[4];
        if(segments.length===4&&req.method==='GET')result=await app.inference.get(actor,id);
        else if(segments.length===5&&req.method==='POST'&&action==='execute')result=await app.inference.execute(actor,id);
        else if(segments.length===5&&req.method==='POST'&&action==='capture')result=await app.inferenceCapture.capture(actor,key,id,body);
        else if(segments.length===5&&req.method==='POST'&&action==='cancel')result=await app.inference.cancel(actor,key,id);
        else if(segments.length===5&&req.method==='POST'&&action==='delete-content')result=await app.inference.deleteContent(actor,key,id);
        else throw new DomainError('NOT_FOUND',404);
      }
      else if(req.method==='POST'&&segments[1]==='entitlements'&&segments[3]==='disposition'&&segments.length===4)result=await service.choose(actor,key,segments[2]!,body);
      else if(req.method==='POST'&&segments[1]==='entitlements'&&segments[3]==='inference-reservations'&&segments.length===4)result=await service.reserveInference(actor,key,segments[2]!,body);
      else if(req.method==='GET'&&route==='/v1/audit/export')result=await service.auditExport(actor);
      else if(req.method==='GET'&&route==='/v1/operator/reconciliation')result=await service.reconciliation(actor);
      else if(req.method==='GET'&&route==='/v1/operator/operations')result=await operations.status(actor);
      else if(req.method==='POST'&&route==='/v1/operator/controls')result=await operations.update(actor,key,body);
      else if(req.method==='GET'&&route==='/v1/operator/billing')result={capabilities:billing.capabilities(),records:await billing.list(actor)};
      else if(req.method==='POST'&&route==='/v1/operator/billing/evidence')result=await billing.submit(actor,key,body as any);
      else if(req.method==='POST'&&segments[0]==='v1'&&segments[1]==='operator'&&segments[2]==='billing'&&segments.length===5){
        ensure(Object.keys(body).length===0,'INVALID_BILLING_REVIEW_REQUEST');
        if(segments[4]==='approve')result=await billing.approve(actor,key,segments[3]!);
        else if(segments[4]==='reject')result=await billing.reject(actor,key,segments[3]!);
        else throw new DomainError('NOT_FOUND',404);
      }
      else if(route==='/v1/buyer/mandates'&&req.method==='GET')result=await service.mandates(actor);
      else if(route==='/v1/buyer/mandates'&&req.method==='POST')result=await service.createMandate(actor,key,body);
      else if(segments[1]==='buyer'&&segments[2]==='mandates'&&segments.length>=4) {
        const id=segments[3]!,action=segments[4];
        if(segments.length===4&&req.method==='PATCH')result=await service.editMandate(actor,key,id,body);
        else if(segments.length===5&&req.method==='GET'&&action==='stats')result=await service.stats(actor,id);
        else if(segments.length===5&&req.method==='POST'&&action==='fund')result=await service.fundMandate(actor,key,id,body);
        else if(segments.length===5&&req.method==='POST'&&action==='activate')result=await service.activateMandate(actor,key,id);
        else if(segments.length===5&&req.method==='POST'&&action==='pause')result=await service.pauseMandate(actor,key,id);
        else throw new DomainError('NOT_FOUND',404);
      }
      else if(segments[0]==='v1'&&segments[1]==='buyer'&&segments[2]==='deliveries'&&segments.length===5&&segments[4]==='link'&&req.method==='POST')result=await deliveryLinks.issue(actor,key,segments[3]!,body);
      else if(segments[0]==='v1'&&segments[1]==='buyer'&&segments[2]==='deliveries'&&segments.length===5&&segments[4]==='download'&&req.method==='GET') {
        ensure([...url.searchParams.keys()].every(name=>name==='capability')&&url.searchParams.getAll('capability').length===1,'INVALID_DELIVERY_LINK_REQUEST');
        result=await deliveryLinks.redeem(actor,segments[3]!,url.searchParams.get('capability'));
      }
      else if(req.method==='GET'&&segments[1]==='buyer'&&segments[2]==='deliveries'&&segments.length===4)result=await service.delivery(actor,segments[3]!);
      else throw new DomainError('NOT_FOUND',404);
      reply(200,result);
    } catch(error) {
      if(!rateConsumed){try{chargeRate('public');}catch(limited){error=limited;}}
      // Older validators still throw a fixed uppercase code. Preserve those
      // client errors, but never describe an unexpected dependency or response
      // serialization failure as invalid caller input or expose its details.
      const validationCode=error instanceof Error&&/^[A-Z][A-Z_]{2,80}$/.test(error.message)?error.message:null;
      const storageUnavailable=validationCode!==null&&['REMOTE_OBJECT_WRITE_FAILED','REMOTE_OBJECT_READ_FAILED','REMOTE_OBJECT_DELETE_FAILED','RECORDER_VERIFIER_UNAVAILABLE','REMOTE_QUOTA_NAMESPACE_MISSING','REMOTE_QUOTA_POLICY_MISMATCH'].includes(validationCode);
      const storageCapacity=validationCode!==null&&['VAULT_OWNER_QUOTA','VAULT_GLOBAL_QUOTA','VAULT_JOURNAL_CAPACITY','VAULT_DISK_HEADROOM'].includes(validationCode);
      const status=error instanceof DomainError?error.status:storageUnavailable?503:storageCapacity?429:validationCode?400:500;
      const code=error instanceof DomainError?error.code:validationCode??'INTERNAL_ERROR';
      if(['STORAGE_BUSY','STORAGE_OPERATION_IN_PROGRESS','STORAGE_OPERATION_EXPIRED','STAGED_STATE_CHANGED'].includes(code))res.setHeader('Retry-After','1');
      if(status>=500)recordReadDiagnostic(error,requestId,route,phase);
      if(!res.headersSent){if(route==='/v1/openrouter/chat/completions')res.setHeader('x-should-retry','false');if(externalAuth instanceof WalletAuth&&route==='/v1/auth/session/revoke'&&req.headers.origin===externalAuth.origin&&req.headers.host===new URL(externalAuth.origin).host)res.setHeader('Set-Cookie',[externalAuth.clearSessionCookie(),externalAuth.clearChallengeCookie()]);reply(status,{error:code,request_id:requestId});}else res.destroy();
    } finally {
      releaseBody?.();releaseVerified?.();releaseAuth?.();releaseRequest?.();
      // Never log request/response bodies, bearer tokens, headers, query strings, or exception details.
      options.operatorActivity?.record({method:req.method,route,status:res.statusCode,duration_ms:Date.now()-started,source:req.headers['x-thot-traffic-source']==='monitoring'?'monitoring':req.headers['x-thot-traffic-source']==='load-test'?'load-test':'application'});
      options.log?.({request_id:requestId,method:req.method??'UNKNOWN',status:res.statusCode,duration_ms:Date.now()-started});
    }
  };
  const server=createServer(handle);
  server.once('close',()=>{clearTimeout(diagnosticExpiryTimer);readDiagnostics=[];});
  // Never tell a client to send a large body before its credentials and budget pass.
  server.on('checkContinue',handle);
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
async function jsonBody(req:IncomingMessage,limit:number,admission:ApiAdmission,retain:(release:()=>void)=>void,admitted?:()=>void):Promise<Document> {
  ensure(req.headers['content-type']?.split(';')[0]==='application/json','JSON_CONTENT_TYPE_REQUIRED',415);
  // Reserve unknown-length input conservatively; retain the charge while parsed
  // JSON is owned by the handler, including asynchronous provider/storage work.
  const reservation=admission.openBody(typeof req.headers['content-length']==='string'?req.headers['content-length']:String(limit),limit);
  retain(reservation.release);
  const buffers:Buffer[]=[];let size=0;
  admitted?.();for await(const chunk of req){size+=chunk.length;reservation.add(chunk.length);ensure(size<=limit,'REQUEST_TOO_LARGE',413);buffers.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{throw new DomainError('INVALID_JSON');}
  ensure(body&&typeof body==='object'&&!Array.isArray(body),'JSON_OBJECT_REQUIRED');return body;
}

/** Master key derived inside the CVM from dstack KMS: stable per app-id, never written to disk. */
export function dstackMasterKey(socketPath:string):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const req=httpRequest({socketPath,path:'/GetKey',method:'POST',headers:{'Content-Type':'application/json'}},res=>{
      let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{
        try{ensure(res.statusCode===200,'DSTACK_GET_KEY_FAILED');const key=Buffer.from(JSON.parse(raw).key,'hex');ensure(key.length>=32,'DSTACK_GET_KEY_FAILED');resolve(createHash('sha256').update(key).digest());}catch(error){reject(error);}
      });
    });
    req.on('error',reject);req.end(JSON.stringify({path:'thot/master-key/v1',purpose:'thot-master-key'}));
  });
}

export async function startServer(options:{port?:number;dataDir?:string;databaseUrl?:string;tokenEnabled?:boolean}={}) {
  const port=options.port??Number(process.env.PORT??4318);ensure(Number.isInteger(port)&&port>=0&&port<=65535,'INVALID_PORT');
  const bind=process.env.THOT_BIND??'127.0.0.1',publicOrigin=process.env.THOT_PUBLIC_ORIGIN;
  if(publicOrigin)ensure(/^https?:\/\/[^/]+$/.test(publicOrigin),'INVALID_PUBLIC_ORIGIN');
  let allowedAppOrigins:string[]|undefined;
  if(process.env.THOT_ALLOWED_APP_ORIGINS!==undefined){
    ensure(publicOrigin&&process.env.THOT_ENABLE_WALLET_AUTH==='true'&&process.env.THOT_ALLOWED_APP_ORIGINS.length<=8192,'INVALID_APP_ORIGINS');
    try{allowedAppOrigins=JSON.parse(process.env.THOT_ALLOWED_APP_ORIGINS);walletAuthOrigins(publicOrigin,allowedAppOrigins);}
    catch{ensure(false,'INVALID_APP_ORIGINS');}
  }
  const thot=await loadThotChainConfig(process.env.THOT_CHAIN_CONFIG_FILE);
  const operatorKeyFile=process.env.THOT_TESTNET_OPERATOR_KEY_FILE;
  ensure(process.env.THOT_READ_ONLY===undefined||['true','false'].includes(process.env.THOT_READ_ONLY),'INVALID_THOT_READ_ONLY');
  const readOnly=process.env.THOT_READ_ONLY==='true';
  const membershipsFile=process.env.THOT_AUTH_MEMBERSHIPS_FILE;
  if(membershipsFile)ensure(thot,'HOSTED_AUTH_MEMBERSHIPS_REQUIRE_THOT');
  const initialMemberships=membershipsFile?await loadHostedAuthMemberships(membershipsFile):undefined;
  const hostConfiguration={thot,bind,publicOrigin,operatorKeyFile,operatorKeyEnvPresent:Object.hasOwn(process.env,'THOT_TESTNET_OPERATOR_KEY'),readOnly,masterKeySource:process.env.THOT_MASTER_KEY_SOURCE,privateAnvil:process.env.THOT_PRIVATE_ANVIL==='true'};
  // Fail before key loading, KMS calls, application creation or binding when the
  // public testnet deployment is missing an authentication boundary.
  validateThotHost({...hostConfiguration,walletAuthConfigured:process.env.THOT_ENABLE_WALLET_AUTH==='true',authConfigured:process.env.THOT_ENABLE_CLERK_AUTH==='true'||process.env.THOT_ENABLE_EXTERNAL_AUTH==='true'||process.env.THOT_ENABLE_WALLET_AUTH==='true'});
  let masterKey;
  if(process.env.THOT_MASTER_KEY_SOURCE){ensure(process.env.THOT_MASTER_KEY_SOURCE==='dstack','INVALID_MASTER_KEY_SOURCE');masterKey=await dstackMasterKey(process.env.DSTACK_SOCKET??'/var/run/dstack.sock');}
  let inference;
  let billing:BillingReconciliationConfig|undefined;
  if(process.env.THOT_ENABLE_BILLING_RECONCILIATION==='true'){
    ensure(process.env.THOT_BILLING_CONFIG_FILE,'BILLING_CONFIGURATION_REQUIRED');
    const raw=await readFile(process.env.THOT_BILLING_CONFIG_FILE,'utf8');ensure(Buffer.byteLength(raw)<=100_000,'INVALID_BILLING_CONFIG');
    billing=JSON.parse(raw);
  }
  ensure([process.env.THOT_ENABLE_CLERK_AUTH,process.env.THOT_ENABLE_EXTERNAL_AUTH,process.env.THOT_ENABLE_WALLET_AUTH].filter(v=>v==='true').length<=1,'AUTH_PROVIDER_CONFLICT');
  let walletAuthConfig;
  if(process.env.THOT_ENABLE_WALLET_AUTH==='true'){
    ensure(process.env.THOT_WALLET_AUTH_CONFIG_FILE,'WALLET_AUTH_CONFIGURATION_REQUIRED');
    walletAuthConfig=await loadWalletAuthConfig(process.env.THOT_WALLET_AUTH_CONFIG_FILE);
    ensure(walletAuthConfig.origin===publicOrigin,'AUTH_ORIGIN_MISMATCH');
    if(allowedAppOrigins!==undefined){
      ensure(walletAuthConfig.allowed_origins===undefined,'DUPLICATE_APP_ORIGINS_CONFIGURATION');
      walletAuthConfig={...walletAuthConfig,allowed_origins:allowedAppOrigins};
    }
    if(thot)ensure(walletAuthConfig.chain_id===thot.chainId,'AUTH_CHAIN_MISMATCH');
  }
  let externalAuthConfig;
  let clerkAuthConfig:ClerkAuthConfig|undefined;
  if(process.env.THOT_ENABLE_CLERK_AUTH==='true'){
    ensure(process.env.THOT_ENABLE_EXTERNAL_AUTH!=='true','AUTH_PROVIDER_CONFLICT');
    ensure(process.env.THOT_CLERK_CONFIG_FILE&&process.env.CLERK_SECRET_KEY,'CLERK_CONFIGURATION_REQUIRED');
    const raw=await loadAuthConfig(process.env.THOT_CLERK_CONFIG_FILE);
    ensure(!('secret_key' in raw),'CLERK_SECRET_MUST_USE_ENV');
    clerkAuthConfig={...(raw as unknown as ClerkAuthConfig),secret_key:process.env.CLERK_SECRET_KEY};
  }
  if(process.env.THOT_ENABLE_EXTERNAL_AUTH==='true'){
    ensure(process.env.THOT_AUTH_CONFIG_FILE,'AUTH_CONFIGURATION_REQUIRED');
    externalAuthConfig=await loadAuthConfig(process.env.THOT_AUTH_CONFIG_FILE);
  }
  if(process.env.THOT_ENABLE_LIVE_INFERENCE==='true'){
    ensure(process.env.THOT_INFERENCE_RATE_CARD_FILE&&process.env.THOT_INFERENCE_API_KEY&&process.env.THOT_INFERENCE_DAILY_BUDGET_MINOR,'INFERENCE_CONFIGURATION_REQUIRED');
    const raw=await readFile(process.env.THOT_INFERENCE_RATE_CARD_FILE,'utf8');ensure(Buffer.byteLength(raw)<=16000,'INVALID_RATE_CARD');
    const rateCard=JSON.parse(raw),apiKey=process.env.THOT_INFERENCE_API_KEY,baseUrl=process.env.THOT_INFERENCE_BASE_URL;
    inference={provider:baseUrl?new OpenAIChatProvider({apiKey,baseUrl,rateCard}):new OpenAIResponsesProvider({apiKey,rateCard}),dailyBudgetMinor:process.env.THOT_INFERENCE_DAILY_BUDGET_MINOR};
  }
  let robinhood;
  if(process.env.THOT_ROBINHOOD_CONFIG_FILE){
    const raw=await readFile(process.env.THOT_ROBINHOOD_CONFIG_FILE,'utf8');ensure(Buffer.byteLength(raw)<=16000,'INVALID_ROBINHOOD_CONFIG');robinhood=JSON.parse(raw);
  }
  let plaid:PlaidConfig|undefined;
  if(process.env.PLAID_CLIENT_ID){
    const environment=process.env.PLAID_ENV;ensure(process.env.PLAID_SECRET&&(environment==='sandbox'||environment==='production'),'PLAID_CONFIGURATION_REQUIRED');
    plaid={clientId:process.env.PLAID_CLIENT_ID,secret:process.env.PLAID_SECRET,environment,...(process.env.PLAID_REDIRECT_URI?{redirectUri:process.env.PLAID_REDIRECT_URI}:{})};
  }
  const viewers=process.env.THOT_TRACE_EXPLORER_VIEWERS??'[]';ensure(viewers.length<=4096,'INVALID_TRACE_EXPLORER_VIEWERS');
  const operatorRuntime=await createTestnetOperatorRuntime(thot,operatorKeyFile);
  let operatorActivity:OperatorActivity|undefined;
  let remoteStorage:Awaited<ReturnType<typeof openRemoteStorage>>;
  let app:Application|undefined,server:ReturnType<typeof createHttpServer>|undefined,worker:ReturnType<typeof startWorkerLoop>|undefined,closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    const drained=worker?.close();
    try{if(server?.listening)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));}
    finally{try{await drained;}finally{try{await operatorActivity?.close();}finally{try{await app?.close();}finally{try{await remoteStorage?.close();}finally{await operatorRuntime.close();}}}}}
  })();
  try{
    remoteStorage=await openRemoteStorage(process.env);
    app=await createApplication({storage:remoteStorage,thot,thotOperatorSigner:operatorRuntime.signer,readOnly,dataDir:options.dataDir,databaseUrl:options.databaseUrl,config:{tokenEnabled:options.tokenEnabled??false,traceExplorerViewers:JSON.parse(viewers)},masterKey,inference,robinhood,plaid,openrouter:{enabled:process.env.THOT_ENABLE_OPENROUTER_RELAY==='true'}});
    let externalAuth;
    if(externalAuthConfig)externalAuth=await ExternalAuth.create(app.db,externalAuthConfig);else if(clerkAuthConfig)externalAuth=await ClerkAuth.create(app.db,clerkAuthConfig);else if(walletAuthConfig)externalAuth=await WalletAuth.create(app.db,walletAuthConfig);
    validateThotHost({...hostConfiguration,walletAuthConfigured:externalAuth instanceof WalletAuth,authConfigured:!!externalAuth});
    if(initialMemberships)await seedHostedAuthMemberships(app.db,externalAuth,initialMemberships);
    operatorActivity=await OperatorActivity.create({dataDir:app.dataDir,db:app.db});
    server=createHttpServer(app,{operatorActivity,externalAuth,billing,publicOrigin,readOnly,...(process.env.THOT_PRIVY_APP_ID?{privy:{app_id:process.env.THOT_PRIVY_APP_ID,client_id:process.env.THOT_PRIVY_CLIENT_ID}}:{}),...(process.env.THOT_ENVIRONMENT_NAME?{environmentName:process.env.THOT_ENVIRONMENT_NAME}:{}),enableDemoOffers:process.env.THOT_ENABLE_DEMO_OFFERS==='true'?true:undefined,launch:{state:process.env.THOT_LAUNCH_STATE,tokenAddress:process.env.THOT_TOKEN_ADDRESS,ponsLaunchAddress:process.env.THOT_PONS_LAUNCH_ADDRESS},log:entry=>process.stdout.write(canonicalJson(entry)+'\n')});
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(port,bind,()=>resolve());});
    if(!readOnly)worker=startWorkerLoop(app,{intervalMs:(thot?.mode==='robinhood-testnet'||thot?.mode==='production')?30_000:2000});
    const address=server.address();const actualPort=typeof address==='object'&&address?address.port:port;
    const scope=thot?.mode==='production'?'Production financial contracts':thot?.mode==='robinhood-testnet'?'Robinhood public testnet; test assets only':'Local development; synthetic market funding';
    process.stdout.write(`THOT Network: ${publicOrigin??`http://${bind}:${actualPort}`}\n${scope}. Authentication ${externalAuth?`${externalAuth.capabilities.mode}; demo sessions disabled`:'local development selector'}. External inference ${inference?'explicitly enabled with operator budget':'disabled'}. Public paid launch remains disabled.\n`);
    return {app,server,url:`http://127.0.0.1:${actualPort}`,close};
  }catch(error){await close();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const running=await startServer({databaseUrl:process.env.DATABASE_URL,tokenEnabled:process.env.THOT_MOCK_TOKEN==='true'});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{await running.close();process.exit(0);});
}
