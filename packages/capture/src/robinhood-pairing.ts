import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {thotOrigin} from './setup.ts';

type TradeRequest={trace_id:string;symbol:string;window_days:number};
type LinkInput={purpose?:"traded";request?:{symbol:string;window_days:number;trace_ts:string};link_ticket:unknown;witness_url:string;appraiser_url:string;thot_public_key_pem:string};
type PublicState={stage:string;extension_dir?:string;error?:string;evidence?:unknown};
export async function startRobinhoodPairing(options:{origin:string;tradeRequest?:TradeRequest;extensionDir?:string;launch:(input:LinkInput,update:(record:any)=>void)=>()=>void;timeoutMs?:number;onClose?:(saved:boolean)=>void}) {
  if(options.tradeRequest){const r=options.tradeRequest;if(typeof r.trace_id!=='string'||Object.keys(r).sort().join(',')!=='symbol,trace_id,window_days'||!/^[-A-Za-z0-9:_]{1,200}$/.test(r.trace_id)||! /^[A-Z][A-Z0-9.-]{0,14}$/.test(r.symbol)||!Number.isInteger(r.window_days)||r.window_days<1||r.window_days>365)throw Error('INVALID_TRADE_REQUEST');}
  const origin=thotOrigin(options.origin),nonce=randomBytes(24).toString('hex');
  let state:PublicState={stage:'helper_ready',extension_dir:options.extensionDir},claimed=false,stopped=false,saved=false,stopChild:(()=>void)|undefined;
  const update=(record:any)=>{
    if(stopped||state.evidence||state.error)return;
    if(record.error){state={...state,stage:'failed',error:/^[A-Z_]{1,80}$/.test(record.error)?record.error:'CONNECTOR_FAILED'};return;}
    if(record.evidence){state={...state,stage:'proof_ready',evidence:record.evidence};return;}
    const stages:Record<string,string>={awaiting_browser_login:'awaiting_extension',awaiting_account_request:'awaiting_account_request',capturing:'capturing',verifying:'verifying'};
    if(stages[record.stage])state={...state,stage:stages[record.stage]};
  };
  const server=createServer(async(req,res)=>{
    const address=server.address(),host=address&&typeof address!=='string'?`127.0.0.1:${address.port}`:'';
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
      if(!body||Object.keys(body).sort().join(',')!==(options.tradeRequest?'appraiser_url,link_ticket,purpose,request,thot_public_key_pem,witness_url':'appraiser_url,link_ticket,thot_public_key_pem,witness_url')||typeof body.link_ticket!=='string'||!body.link_ticket||body.link_ticket.length>16384||typeof body.thot_public_key_pem!=='string'||body.thot_public_key_pem.length>4096)throw Error('INVALID_INPUT');
      if(options.tradeRequest){const r=body.request;if(body.purpose!=='traded'||!r||Object.keys(r).sort().join(',')!=='symbol,trace_ts,window_days'||r.symbol!==options.tradeRequest.symbol||r.window_days!==options.tradeRequest.window_days||typeof r.trace_ts!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(r.trace_ts)||!Number.isFinite(Date.parse(r.trace_ts)))throw Error('INVALID_TRADE_REQUEST');}
      for(const key of ['witness_url','appraiser_url']){const u=new URL(body[key]);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('INVALID_URL');}
      claimed=true;state={...state,stage:'checking_services'};
      stopChild=options.launch(body,update);reply(200,{paired:true});
    }catch{reply(400,{error:'INVALID_REQUEST'});}
  });
  server.requestTimeout=10_000;server.headersTimeout=5_000;
  const timer=setTimeout(()=>void close(),options.timeoutMs??10*60_000);
  async function close(){if(stopped)return;stopped=true;clearTimeout(timer);stopChild?.();state={stage:'closed'};server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));options.onClose?.(saved);}
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch(e){clearTimeout(timer);throw e;}
  const address=server.address();if(!address||typeof address==='string')throw Error('LISTEN_FAILED');
  const callback=`http://127.0.0.1:${address.port}/pair/${nonce}`;
  return {callback,url:origin+'/#thot-robinhood='+Buffer.from(JSON.stringify({callback,...(options.tradeRequest?{trade_request:options.tradeRequest}:{})})).toString('base64url'),close};
}
