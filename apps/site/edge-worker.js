// Only public metadata passes through this fixed endpoint. Never forward browser
// credentials, arbitrary paths, query strings, or headers to the application.
export async function publicCatalogue(fetcher = fetch) {
  const [statsResponse, listingsResponse] = await Promise.all([
    fetcher('https://app.thot.market/v1/public/stats', {headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000)}),
    fetcher('https://app.thot.market/v1/public/listings', {headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(8000)}),
  ]);
  if(!statsResponse.ok||!listingsResponse.ok)throw Error(`PUBLIC_MARKET_UNAVAILABLE: stats=${statsResponse.status}, listings=${listingsResponse.status}`);
  const stats=await statsResponse.json(), catalogue=await listingsResponse.json();
  if(!Number.isSafeInteger(stats.listings_active)||!Number.isSafeInteger(stats.sellers_listing)||!Array.isArray(catalogue.listings))throw Error('INVALID_PUBLIC_MARKET');
  const fields=['public_path','title','price_atoms','content_kind','file_count','turn_count','capture_model','created_at','workflow'];
  return {as_of:new Date().toISOString(),stats:{listings_active:stats.listings_active,sellers_listing:stats.sellers_listing,independent:stats.independent??null},listings:catalogue.listings.slice(0,48).map(item=>Object.fromEntries(fields.filter(key=>item[key]!==undefined).map(key=>[key,item[key]])))};
}
export default {
  async fetch(request, env, ctx) {
    const url=new URL(request.url);
    if(url.pathname!=='/v1/public/catalogue')return env.ASSETS.fetch(request);
    if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers:{Allow:'GET'}});
    const key=new Request(url.origin+'/v1/public/catalogue');
    const cached=await caches.default.match(key);if(cached)return cached;
    try {
      const payload=await publicCatalogue();
      const response=Response.json(payload,{headers:{'Cache-Control':'public, max-age=60','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
      ctx.waitUntil(caches.default.put(key,response.clone()));return response;
    }catch(error){console.warn('public_catalogue_unavailable', error instanceof Error ? error.message : 'unknown');return Response.json({error:'PUBLIC_MARKET_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
  },
};
