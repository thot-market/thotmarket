import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {promisify} from 'node:util';
import {brotliCompress, constants, gzip} from 'node:zlib';
import {DomainError} from '../../packages/storage/src/index.ts';

// Only packaged, public code may be compressed or retained. Never key this cache
// by request URLs, query strings, cookies, authorization, or API response bodies.
const routes=new Set([
  '/operator-app.js','/operator.css','/style.css','/app.js','/money-ui.js','/thot-ui.js',
  '/staking-ui.js','/staking.css','/thot-analytics-ui.js','/mandate-editor.js',
  '/inference-ui.js','/operations-ui.js','/contributor-ui.js','/clerk-auth-ui.js',
  '/wallet-auth-ui.js','/privy-auth.bundle.js','/privy-auth-state.js','/openrouter-ui.js',
  '/openrouter-usage.js','/agent-capture-ui.js','/capture-export-ui.js','/library-ui.js',
  '/setup-ui.js','/robinhood-setup-ui.js','/environment-ui.js','/getting-started.js',
]);
const compressBrotli=promisify(brotliCompress),compressGzip=promisify(gzip);
const maxFileBytes=16*1024*1024,maxSourceBytes=32*1024*1024,compressionOverhead=65536;
type Encoding='br'|'gzip'|'identity';
type Representation={body:Buffer;etag:string;encoding:Encoding;contentType:string};
type Asset={identity:Representation;compressed:Map<Encoding,Promise<Representation>>};
export const isDashboardAssetRoute=(route:string)=>routes.has(route);

function encodingFor(header:string|undefined):Encoding|null {
  if(!header?.trim())return 'identity';
  const weights=new Map<string,number>();
  for(const item of header.split(',')){
    const [name,...parameters]=item.trim().toLowerCase().split(';');
    if(!['br','gzip','identity','*'].includes(name!))continue;
    let quality=1;
    if(parameters.length){
      const match=parameters.length===1?parameters[0]!.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/):null;
      quality=match?Number(match[1]):0;
    }
    weights.set(name!,Math.min(weights.get(name!)??1,quality));
  }
  let selected:Encoding|null=null,best=0;
  // Prefer an accepted compressed representation over an implicit identity.
  // Explicit identity quality still participates in the client's preference.
  for(const encoding of ['br','gzip','identity'] as const){
    const quality=weights.get(encoding)??(encoding==='identity'?0:weights.get('*')??0);
    if(quality>best){selected=encoding;best=quality;}
  }
  if(selected)return selected;
  return (weights.get('identity')??(weights.get('*')===0?0:1))>0?'identity':null;
}

export function matchesAssetEtag(header:string|undefined,etag:string):boolean {
  return header?.trim()==='*'||Boolean(header?.split(',').some(value=>value.trim().replace(/^W\//,'')===etag));
}

/** One immutable image's asset cache; restarting the server picks up a release.
 * At most the fixed route set and 32 MiB of source are retained. Each async
 * encoding is shared across concurrent requests and bounded by source + 64 KiB;
 * all three representations together remain below 100 MiB. */
export function createDashboardAssets(directory=new URL('../dashboard/',import.meta.url)) {
  const cached=new Map<string,Promise<Asset>>();let sourceBytes=0;
  const representation=(route:string,body:Buffer,encoding:Encoding):Representation=>({
    body,encoding,etag:'"'+createHash('sha256').update(body).digest('hex')+'"',
    contentType:route.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',
  });
  async function load(route:string):Promise<Asset>{
    let reserved=0;
    try{
      const file=await open(new URL(route.slice(1),directory),'r');
      try{
        const stat=await file.stat();
        if(!stat.isFile()||stat.size>maxFileBytes||sourceBytes+stat.size>maxSourceBytes)throw new Error('asset limit');
        sourceBytes+=stat.size;reserved=stat.size;
        // Bound even an accidentally growing development file before retaining
        // it; deployed image inputs do not change during a process's lifetime.
        const body=Buffer.alloc(stat.size+1);
        let bytes=0;
        while(bytes<body.length){const read=await file.read(body,bytes,body.length-bytes,null);if(!read.bytesRead)break;bytes+=read.bytesRead;}
        if(bytes!==stat.size)throw new Error('asset changed');
        return {identity:representation(route,body.subarray(0,bytes),'identity'),compressed:new Map()};
      }finally{await file.close();}
    }catch{
      sourceBytes-=reserved;
      throw new DomainError('DASHBOARD_ASSET_UNAVAILABLE',503);
    }
  }
  return async(route:string,acceptEncoding:string|undefined):Promise<Representation>=>{
    if(!routes.has(route))throw new DomainError('NOT_FOUND',404);
    const encoding=encodingFor(acceptEncoding);
    if(!encoding)throw new DomainError('ASSET_ENCODING_NOT_ACCEPTABLE',406);
    let pending=cached.get(route);
    if(!pending){pending=load(route).catch(error=>{cached.delete(route);throw error;});cached.set(route,pending);}
    const asset=await pending;
    if(encoding==='identity')return asset.identity;
    let compressed=asset.compressed.get(encoding);
    if(!compressed){
      const body=asset.identity.body,maxOutputLength=body.length+compressionOverhead;
      compressed=(encoding==='br'
        ?compressBrotli(body,{params:{[constants.BROTLI_PARAM_QUALITY]:4},maxOutputLength})
        :compressGzip(body,{level:6,maxOutputLength}))
        .then(value=>representation(route,value,encoding))
        .catch(()=>{asset.compressed.delete(encoding);throw new DomainError('DASHBOARD_ASSET_UNAVAILABLE',503);});
      asset.compressed.set(encoding,compressed);
    }
    return compressed;
  };
}
