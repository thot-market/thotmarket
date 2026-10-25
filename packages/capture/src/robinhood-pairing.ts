import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {thotOrigin} from './setup.ts';
import {pairingMode,createDevicePairing,awaitDevicePairing,printDevicePairing,reportDevicePairingEvent,type DevicePairingSession,type PairingMode} from './device-pairing.ts';

type TradeRequest={trace_id:string;symbol:string;window_days:number};
type LinkInput={purpose?:"traded";request?:{symbol:string;window_days:number;trace_ts:string};link_ticket:unknown;witness_url:string;appraiser_url:string;thot_public_key_pem:string};
type PublicState={stage:string;extension_dir?:string;error?:string;evidence?:unknown};
export async function startRobinhoodPairing(options:{origin:string;tradeRequest?:TradeRequest;extensionDir?:string;launch:(input:LinkInput,update:(record:any)=>void)=>()=>void;timeoutMs?:number;onClose?:(saved:boolean)=>void;pairing?:PairingMode;fallbackMs?:number;transport?:typeof fetch;log?:(text:string)=>void;open?:(url:string)=>Promise<boolean>}) {
  if(options.tradeRequest){const r=options.tradeRequest;if(typeof r.trace_id!=='string'||Object.keys(r).sort().join(',')!=='symbol,trace_id,window_days'||!/^[-A-Za-z0-9:_]{1,200}$/.test(r.trace_id)||! /^[A-Z][A-Z0-9.-]{0,14}$/.test(r.symbol)||!Number.isInteger(r.window_days)||r.window_days<1||r.window_days>365)throw Error('INVALID_TRADE_REQUEST');}
  const origin=thotOrigin(options.origin),transport=options.transport??fetch,log=options.log??(()=>{}),nonce=randomBytes(24).toString('hex');
  let state:PublicState={stage:'helper_ready',extension_dir:options.extensionDir},claimed=false,stopped=false,saved=false,stopChild:(()=>void)|undefined,relay:NodeJS.Timeout|undefined,fallback:NodeJS.Timeout|undefined;
  const update=(record:any)=>{
    if(stopped||state.evidence||state.error)return;
    if(record.error){state={...state,stage:'failed',error:/^[A-Z_]{1,80}$/.test(record.error)?record.error:'CONNECTOR_FAILED'};return;}
    if(record.evidence){state={...state,stage:'proof_ready',evidence:record.evidence};return;}
    const stages:Record<string,string>={awaiting_browser_login:'awaiting_extension',awaiting_account_request:'awaiting_account_request',capturing:'capturing',verifying:'verifying'};
    if(stages[record.stage])state={...state,stage:stages[record.stage]};
  };
  // Both paths accept the same link input. Over device pairing the progress
  // the browser used to read from the loopback status endpoint is relayed
  // through the pairing session, whose replies carry the browser's signals.
  const accepted=(input:LinkInput)=>{
    if(!input||Object.keys(input).sort().join(',')!==(options.tradeRequest?'appraiser_url,link_ticket,purpose,request,thot_public_key_pem,witness_url':'appraiser_url,link_ticket,thot_public_key_pem,witness_url')||typeof input.link_ticket!=='string'||!input.link_ticket||input.link_ticket.length>16384||typeof input.thot_public_key_pem!=='string'||input.thot_public_key_pem.length>4096)throw Error('INVALID_INPUT');
    if(options.tradeRequest){const r=input.request;if(input.purpose!=='traded'||!r||Object.keys(r).sort().join(',')!=='symbol,trace_ts,window_days'||r.symbol!==options.tradeRequest.symbol||r.window_days!==options.tradeRequest.window_days||typeof r.trace_ts!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(r.trace_ts)||!Number.isFinite(Date.parse(r.trace_ts)))throw Error('INVALID_TRADE_REQUEST');}
    for(const key of ['witness_url','appraiser_url'] as const){const u=new URL(input[key]);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('INVALID_URL');}
    return input;
  };
  const startConnector=(input:LinkInput)=>{if(claimed||stopped)return false;claimed=true;state={...state,stage:'checking_services'};stopChild=options.launch(input,update);return true;};
  const startRelay=(session:DevicePairingSession)=>{
    let postedEvidence=false;
    relay=setInterval(()=>void (async()=>{
      const event=state.error?{error:state.error}:state.evidence?(postedEvidence?{stage:'proof_ready'}:{evidence:state.evidence}):{stage:state.stage};
      try{
        const signals=await reportDevicePairingEvent(origin,session.device_code,event as Record<string,unknown>,transport);
        if(state.evidence)postedEvidence=true;
        if(signals.saved)await close(true);
        else if(signals.cancelled)await close(false);
      }catch(error){
        if(['PAIRING_EXPIRED','PAIRING_CANCELLED','PAIRING_NOT_FOUND'].includes((error as Error).message))await close(false);
      }
    })(),2_000);
  };
  const timer=setTimeout(()=>void close(),options.timeoutMs??10*60_000);
  async function close(finished=saved){if(stopped)return;stopped=true;clearTimeout(timer);clearTimeout(fallback);if(relay)clearInterval(relay);stopChild?.();state={stage:'closed'};if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}options.onClose?.(finished);}
  let server:ReturnType<typeof createServer>|undefined;
  const openPairingSession=async()=>{const session=await createDevicePairing(origin,{flow:'robinhood',device_name:hostname().slice(0,80),...(options.tradeRequest?{trade_request:options.tradeRequest}:{}),...(options.extensionDir?{extension_dir:options.extensionDir}:{})},transport);printDevicePairing(session,log);return session;};
  async function pairByCode(session:DevicePairingSession){const input=accepted(await awaitDevicePairing(origin,session,{transport}) as LinkInput);if(startConnector(input))startRelay(session);}
  if((options.pairing??pairingMode())==='code'){
    const session=await openPairingSession();
    await (options.open??(async()=>false))(session.verification_uri_complete).catch(()=>false);
    void pairByCode(session).catch(async error=>{if(!stopped&&!claimed){state={...state,stage:'failed',error:/^[A-Z_]{1,80}$/.test((error as Error).message)?(error as Error).message:'PAIRING_FAILED'};await close().catch(()=>{});}});
    return {url:session.verification_uri_complete,callback:session.verification_uri_complete,close};
  }
  server=createServer(async(req,res)=>{
    const address=server!.address(),host=address&&typeof address!=='string'?`127.0.0.1:${address.port}`:'';
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.host!==host||req.headers.origin!==origin)return reply(403,{error:'FORBIDDEN'});
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Private-Network','true');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','content-type');
    if(![`/pair/${nonce}`,`/pair/${nonce}/status`,`/pair/${nonce}/cancel`,`/pair/${nonce}/saved`].includes(req.url??''))return reply(404,{error:'NOT_FOUND'});
    if(req.method==='OPTIONS')return reply(204,{});
    if(req.method==='GET'&&req.url?.endsWith('/status'))return reply(200,state);
    if(req.method!=='POST'||req.headers['content-type']!=='application/json')return reply(400,{error:'INVALID_REQUEST'});
    try {
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>64_000)throw Error('INPUT_LIMIT');}
      const body=JSON.parse(raw);
      if(req.url?.endsWith('/cancel')){reply(200,{cancelled:true});await close();return;}
      if(req.url?.endsWith('/saved')){if(!state.evidence)return reply(409,{error:'NO_PROOF'});saved=true;reply(200,{closed:true});await close();return;}
      if(claimed)return reply(409,{error:'ALREADY_PAIRED'});
      startConnector(accepted(body));
      reply(200,{paired:true});
    }catch{reply(400,{error:'INVALID_REQUEST'});}
  });
  server.requestTimeout=10_000;server.headersTimeout=5_000;
  try{await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});}catch(e){clearTimeout(timer);throw e;}
  const address=server.address();if(!address||typeof address==='string')throw Error('LISTEN_FAILED');
  const callback=`http://127.0.0.1:${address.port}/pair/${nonce}`;
  // If no browser reaches the loopback callback within a short window, the
  // same pairing continues by code on any other signed-in device.
  fallback=setTimeout(()=>void openPairingSession().then(session=>pairByCode(session)).catch(async error=>{if(!stopped&&!claimed){state={...state,stage:'failed',error:/^[A-Z_]{1,80}$/.test((error as Error).message)?(error as Error).message:'PAIRING_FAILED'};await close().catch(()=>{});}}),Math.min(options.fallbackMs??30_000,options.timeoutMs??10*60_000));
  const url=origin+'/#thot-robinhood='+Buffer.from(JSON.stringify({callback,...(options.tradeRequest?{trade_request:options.tradeRequest}:{})})).toString('base64url');
  return {callback,url,close};
}
