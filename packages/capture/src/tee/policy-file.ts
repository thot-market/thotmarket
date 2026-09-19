import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {captureOrigin} from '../sync.ts';

const repository=new URL('../../../../',import.meta.url);
const environments=[['dev','test'],['staging','staging']] as const;
const retainedTargets=['deploy/cvm/archive/dev-v12-20260918/dev.json'] as const;
const localPath=(path:string)=>fileURLToPath(new URL(path,repository));
const policyPath=(path:string)=>{
  if(!/^deploy\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(path))throw Error('INVALID_CAPTURE_POLICY_PATH');
  return localPath(path);
};

// Public source exports omit private environment descriptors. Missing descriptors
// select the inert default; malformed descriptors that are present still fail.
async function optionalTarget(path:string){
  try{return JSON.parse(await readFile(localPath(path),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}

/** Select only policies shipped with this reviewed helper, never server-supplied pins. */
export async function recorderPolicyFile(origin:string,env:{THOT_RECORDER_POLICY_FILE?:string}=process.env){
  if(env.THOT_RECORDER_POLICY_FILE!==undefined)return env.THOT_RECORDER_POLICY_FILE;
  const selectedOrigin=captureOrigin(origin);
  for(const [branch,site] of environments){
    const target=await optionalTarget(`deploy/cvm/${branch}.json`);
    if(target===undefined)continue;
    const website=JSON.parse(await readFile(localPath(`deploy/thot-${site}.wrangler.jsonc`),'utf8'));
    const nativeOrigin=`https://${target.app_id}-4318.${target.gateway_domain}`;
    // The website route is an exact host; never interpret wildcard subdomains.
    const aliases=website.routes.map((route:{pattern:string})=>{
      if(!/^[a-z0-9.-]+\/\*$/.test(route.pattern))throw Error('INVALID_CAPTURE_SITE_ORIGIN');
      return captureOrigin('https://'+route.pattern.slice(0,-2));
    });
    const stableOrigin=branch==='dev'?'https://app.test.thot.market':'https://app.staging.thot.market';
    if(selectedOrigin===nativeOrigin||selectedOrigin===stableOrigin||aliases.includes(selectedOrigin)){
      return policyPath(target.recorder_policy_path);
    }
  }
  // Retained databases and purchased releases keep their original native origin.
  // Website aliases always choose the current environment above, never an archive.
  for(const path of retainedTargets){
    const target=await optionalTarget(path);
    if(target===undefined)continue;
    if(selectedOrigin===`https://${target.app_id}-4318.${target.gateway_domain}`){
      return policyPath(target.recorder_policy_path);
    }
  }
  return localPath('deploy/tee-recorder-policy.json');
}
