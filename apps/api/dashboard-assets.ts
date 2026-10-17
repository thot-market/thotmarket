import {createHash} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {promisify} from 'node:util';
import {brotliCompress, constants, gzip} from 'node:zlib';
import {DomainError} from '../../packages/storage/src/index.ts';

// Only packaged, public code may be compressed or retained. Never key this cache
// by request URLs, query strings, cookies, authorization, or API response bodies.
const routes=new Set([
  '/operator-app.js','/operator.css','/style.css','/app.js','/money-ui.js','/thot-ui.js',
  '/staking-ui.js','/staking.css','/thot-analytics-ui.js','/mandate-editor.js',
  '/inference-ui.js','/operations-ui.js','/contributor-ui.js','/clerk-auth-ui.js',
  '/wallet-auth-ui.js','/privy-auth-state.js','/openrouter-ui.js',
  '/openrouter-usage.js','/agent-capture-ui.js','/capture-export-ui.js','/library-ui.js','/history-sync-ui.js',
  '/setup-ui.js','/robinhood-setup-ui.js','/environment-ui.js','/getting-started.js',
  '/connected-journey-ui.js',
]);
const compressBrotli=promisify(brotliCompress),compressGzip=promisify(gzip);
const maxFileBytes=16*1024*1024,maxSourceBytes=32*1024*1024,compressionOverhead=65536;
type Encoding='br'|'gzip'|'identity';
type Representation={body:Buffer;etag:string;encoding:Encoding;contentType:string};
type Asset={identity:Representation;compressed:Map<Encoding,Promise<Representation>>};
const generatedFile=/^(?:privy-auth\.bundle\.js|privy-auth-chunks\/[A-Z0-9]{8}\.js)$/;
function canonicalRoute(route:string):string|null {
  if(routes.has(route))return route;
  const match=route.match(/^\/privy-auth\/v1\/(?:0|[1-9][0-9]{0,3})\/(.+)$/);
  const file=match?.[1]??route.slice(1);
  return route.startsWith('/')&&generatedFile.test(file)?'/'+file:null;
}
export const isDashboardAssetRoute=(route:string)=>canonicalRoute(route)!==null;
type ManifestAsset={path:string;bytes:number;sha256:string};

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

/** One immutable image's asset cache; restarting picks up a release. The fixed
 * routes plus at most 512 manifest-listed chunks share a 32 MiB source budget.
 * Retry namespaces all use the canonical cache key. Each async encoding is
 * shared and bounded by source + 64 KiB; all representations stay below 170 MiB. */
export function createDashboardAssets(directory=new URL('../dashboard/',import.meta.url)) {
  const cached=new Map<string,Promise<Asset>>();let sourceBytes=0;
  let manifest:Promise<Map<string,ManifestAsset>>|null=null;
  async function generatedAssets():Promise<Map<string,ManifestAsset>> {
    if(!manifest)manifest=(async()=>{
      const handle=await open(new URL('privy-auth.assets.json',directory),fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
      try{
        const stat=await handle.stat();
        if(!stat.isFile()||stat.size>128*1024)throw new Error('manifest limit');
        const bytes=Buffer.alloc(stat.size+1);let read=0;
        while(read<bytes.length){const part=await handle.read(bytes,read,bytes.length-read,null);if(!part.bytesRead)break;read+=part.bytesRead;}
        if(read!==stat.size)throw new Error('manifest changed');
        const value=JSON.parse(bytes.subarray(0,read).toString('utf8'));
        if(value?.format!=='thot.privy-assets/1'||!Array.isArray(value.assets)||value.assets.length<1||value.assets.length>512)throw new Error('manifest format');
        const entries=new Map<string,ManifestAsset>();let total=0;
        for(const asset of value.assets){
          if(!asset||typeof asset.path!=='string'||!generatedFile.test(asset.path)||entries.has('/'+asset.path)||
            !Number.isSafeInteger(asset.bytes)||asset.bytes<0||asset.bytes>maxFileBytes||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))throw new Error('manifest asset');
          total+=asset.bytes;if(total>maxSourceBytes)throw new Error('manifest byte limit');entries.set('/'+asset.path,asset);
        }
        if(!entries.has('/privy-auth.bundle.js'))throw new Error('manifest entry');return entries;
      }finally{await handle.close();}
    })().catch(()=>{manifest=null;throw new DomainError('DASHBOARD_ASSET_UNAVAILABLE',503);});
    return manifest;
  }
  const representation=(route:string,body:Buffer,encoding:Encoding):Representation=>({
    body,encoding,etag:'"'+createHash('sha256').update(body).digest('hex')+'"',
    contentType:route.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',
  });
  async function load(route:string,expected?:ManifestAsset):Promise<Asset>{
    let reserved=0;
    try{
      if(route.startsWith('/privy-auth-chunks/')){
        const parent=await lstat(new URL('privy-auth-chunks',directory));if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('asset directory');
      }
      const file=await open(new URL(route.slice(1),directory),fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
      try{
        const stat=await file.stat();
        if(!stat.isFile()||stat.size>maxFileBytes||sourceBytes+stat.size>maxSourceBytes||expected&&stat.size!==expected.bytes)throw new Error('asset limit');
        sourceBytes+=stat.size;reserved=stat.size;
        // Bound even an accidentally growing development file before retaining
        // it; deployed image inputs do not change during a process's lifetime.
        const body=Buffer.alloc(stat.size+1);
        let bytes=0;
        while(bytes<body.length){const read=await file.read(body,bytes,body.length-bytes,null);if(!read.bytesRead)break;bytes+=read.bytesRead;}
        if(bytes!==stat.size||expected&&createHash('sha256').update(body.subarray(0,bytes)).digest('hex')!==expected.sha256)throw new Error('asset changed');
        return {identity:representation(route,body.subarray(0,bytes),'identity'),compressed:new Map()};
      }finally{await file.close();}
    }catch{
      sourceBytes-=reserved;
      throw new DomainError('DASHBOARD_ASSET_UNAVAILABLE',503);
    }
  }
  return async(route:string,acceptEncoding:string|undefined):Promise<Representation>=>{
    const canonical=canonicalRoute(route);
    if(!canonical)throw new DomainError('NOT_FOUND',404);
    let expected:ManifestAsset|undefined;
    if(!routes.has(canonical)){expected=(await generatedAssets()).get(canonical);if(!expected)throw new DomainError('NOT_FOUND',404);}
    route=canonical;
    const encoding=encodingFor(acceptEncoding);
    if(!encoding)throw new DomainError('ASSET_ENCODING_NOT_ACCEPTABLE',406);
    let pending=cached.get(route);
    if(!pending){pending=load(route,expected).catch(error=>{cached.delete(route);throw error;});cached.set(route,pending);}
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
