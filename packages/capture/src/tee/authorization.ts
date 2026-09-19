// Only deployment-configured THOT instances receive capture capabilities.
// The client cannot choose an authorization URL or cause a redirect.
export function authorizationOrigins(value:string):string[] {
 const values=JSON.parse(value);if(!Array.isArray(values)||values.length<1||values.length>4)throw Error('INVALID_AUTH_ORIGINS');
 return values.map(value=>{const u=new URL(value);if(u.protocol!=='https:'||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('INVALID_AUTH_ORIGIN');return u.origin;});
}
export async function authorizeCapture(origins:string[],capture:{capture_id:string;client:string;upload_token:string},send:typeof fetch=fetch){
 for(const origin of origins){
  const response=await send(origin+'/v1/agent-captures/'+encodeURIComponent(capture.capture_id)+'/authorize',{method:'POST',headers:{Authorization:'Bearer '+capture.upload_token,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15_000)});
  if(response.status===401){await response.body?.cancel();continue;}
  if(!response.ok){await response.body?.cancel();throw Error('CAPTURE_AUTHORIZATION_UNAVAILABLE');}
  const binding=await response.json() as any;
  if(binding.capture_id!==capture.capture_id||binding.client!==capture.client||binding.status!=='AWAITING_UPLOAD'||!Number.isFinite(Date.parse(binding.expires_at))||Date.parse(binding.expires_at)<=Date.now()||typeof binding.consent_hash!=='string'||!/^[a-f0-9]{64}$/.test(binding.consent_hash))throw Error('CAPTURE_AUTHORIZATION_REJECTED');
  return binding;
 }
 throw Error('CAPTURE_AUTHORIZATION_REJECTED');
}
