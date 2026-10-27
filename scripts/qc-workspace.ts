#!/usr/bin/env node
/** Local operator inventory and owner-authorized QC. Never prints source content. */
import {constants} from 'node:fs';
import {open,writeFile,mkdir,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {runTraceQc} from '../packages/qc/index.ts';

const usage=`Usage: thot-qc COMMAND [OPTIONS]
  login       Import downloaded QC connection: --config FILE (saved privately on this computer)
  logout      Revoke this computer's QC connection
  pull        Review batch: --directory NEW_DIR --offset 0 --limit 20 (at most 20 sources)
  judge       Save your verdict: --input source.json --verdict pass|flag|reject
              --usefulness 0..4 --completeness 0..4 --evaluator VERSION
  inventory   Operator metadata: --offset 0 --limit 50
  library     Your saved work: --cursor CURSOR
  export      One exact source: --trace ID --scope private|release
  review-source  Consent-approved sale version: --trace ID
  submit      Operator verdict: --trace ID --input verdict.json
  check       Local evaluation: --input exported-source.json (no config needed)
  report      Current server QC: --trace ID --scope private|release
  review      Owner feedback: --trace ID --input review.json
Without --config, uses ~/.config/thot/qc.json. Online commands write a new
private JSON file in the current directory unless --output is supplied.
Get a QC connection at https://app.thot.market/ops → Connect local QC.
Config: {"origin":"https://app.thot.market","cookie":"SESSION_COOKIE"}
A bearer token may replace cookie. Credentials must be in an owner-only file.
Inventory access does not grant permission to read another user's private content.
`;
function ensure(ok:unknown,code:string):asserts ok{if(!ok)throw Error('QC_WORKSPACE_'+code);}
async function readJson(path:string,secret=false,imported=false){
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await handle.stat();ensure(stat.isFile()&&stat.size<=8_000_000,'INPUT_LIMIT');
    if(imported){ensure(stat.uid===process.getuid?.(),'CONFIG_OWNER');await handle.chmod(0o600);}
    if(secret)ensure((stat.mode&0o077)===0&&stat.uid===process.getuid?.(),'CONFIG_PERMISSIONS');
    const bytes=Buffer.alloc(stat.size+1);let used=0;
    while(used<bytes.length){const part=await handle.read(bytes,used,bytes.length-used,null);if(!part.bytesRead)break;used+=part.bytesRead;}
    ensure(used===stat.size,'INPUT_CHANGED');return JSON.parse(bytes.subarray(0,used).toString('utf8'));
  }finally{await handle.close();}
}
export async function main(args:string[]){
  if(args.length===0||args.length===1&&['--help','-h'].includes(args[0]!)){process.stdout.write(usage);return;}
  const [command,...rest]=args,options:Record<string,string>={};
  ensure(['login','logout','pull','judge','inventory','library','export','check','report','review','review-source','submit'].includes(command??''),'COMMAND');
  const allowed:Record<string,string[]>={login:[],logout:[],pull:['directory','offset','limit'],judge:['input','verdict','usefulness','completeness','evaluator'],inventory:['offset','limit'],library:['cursor'],export:['trace','scope'],check:['input'],report:['trace','scope'],review:['trace','input'],'review-source':['trace'],submit:['trace','input']};
  for(let i=0;i<rest.length;i+=2){const name=rest[i]!.slice(2),value=rest[i+1];ensure(rest[i]!.startsWith('--')&&['config','output',...allowed[command!]!].includes(name)&&!options[name]&&value&&!value.startsWith('--'),'ARGUMENTS');options[name]=value;}
  const savedConfig=join(homedir(),'.config','thot','qc.json');
  if(command==='login'){
    ensure(options.config,'ARGUMENTS');
    const config=await readJson(options.config,false,true),origin=new URL(config.origin);
    ensure(origin.href===origin.origin+'/'&&!origin.username&&!origin.password&&origin.protocol==='https:','ORIGIN');
    ensure(/^qc_[A-Za-z0-9_-]{43}$/.test(config.token)&&config.scope==='local_qc','SCOPED_CONNECTION_REQUIRED');
    const response=await fetch(origin.origin+'/v1/auth/session',{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+config.token}});
    ensure(response.ok,'HTTP_'+response.status);
    const session=await response.json();ensure(session.actor?.role==='operator_security'&&session.scope==='local_qc','OPERATOR_REQUIRED');
    const target=options.output??savedConfig;await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,JSON.stringify({origin:origin.origin,token:config.token,scope:'local_qc',expires_at:session.expires_at})+'\n',{flag:'wx',mode:0o600});
    process.stdout.write('QC connected on this computer. Run thot-qc inventory.\n');return;
  }
  if(!['check','judge'].includes(command!))options.config??=savedConfig;
  options.output??=resolve('thot-qc-'+command+'-'+Date.now()+'-'+randomUUID().slice(0,8)+'.json');
  if(command==='pull'){
    ensure(options.directory,'DIRECTORY_REQUIRED');
    const directory=resolve(options.directory);await mkdir(directory,{mode:0o700});
    const inventory=join(directory,'inventory.json');
    await main(['inventory','--config',options.config!,'--output',inventory,'--offset',options.offset??'0','--limit',options.limit??'20']);
    const page=await readJson(inventory),sources=page.items.flatMap((item:any)=>item.qc_sources??[]).filter((source:any)=>source.review_allowed===true);
    const entries:any[]=[],seen=new Set<string>();
    for(const source of sources){
      ensure(typeof source.trace_id==='string'&&typeof source.source_version==='string','RESPONSE');
      const id=createHash('sha256').update(source.trace_id+':'+source.source_version).digest('hex');
      if(seen.has(id))continue;seen.add(id);if(entries.length>=20)break;
      const sourceFile=join(directory,id+'.source.json'),reportFile=join(directory,id+'.report.json');
      try{
        await main(['review-source','--config',options.config!,'--trace',source.trace_id,'--output',sourceFile]);
        ensure((await readJson(sourceFile)).selected_source?.source_version===source.source_version,'SOURCE_CHANGED');
        await main(['check','--input',sourceFile,'--output',reportFile]);
        entries.push({trace_id:source.trace_id,source_version:source.source_version,source:sourceFile,report:reportFile,status:'ready'});
      }catch(error){
        const code=error instanceof Error&&/^QC_WORKSPACE_[A-Z_0-9]+$/.test(error.message)?error.message:'QC_WORKSPACE_IO_ERROR';
        entries.push({trace_id:source.trace_id,source_version:source.source_version,status:'unavailable',error:code});
      }
    }
    await writeFile(join(directory,'index.json'),JSON.stringify({entries,has_more_inventory:page.has_more,source_limit:20,eligible_in_page:sources.length},null,2)+'\n',{flag:'wx',mode:0o600});
    process.stdout.write('Review batch saved: '+entries.filter(e=>e.status==='ready').length+' ready, '+entries.filter(e=>e.status!=='ready').length+' unavailable. Read index.json.\n');return;
  }
  let result:unknown;
  if(command==='check'||command==='judge'){
    ensure(options.input&&!options.config,'ARGUMENTS');const input=await readJson(options.input);
    ensure(input.schema_version==='trace-qc-export/v1'&&['private','release'].includes(input.selected_source?.scope),'EXPORT_REQUIRED');
    const report=runTraceQc(input.content,{scope:input.selected_source.scope});
    ensure(report.content_digest===input.selected_source.content_hash,'CONTENT_CHANGED');
    if(command==='judge'){
      ensure(input.selected_source.scope==='release'&&/^[a-f0-9]{64}$/.test(input.selected_source.source_version),'EXPORT_REQUIRED');
      ensure(['pass','flag','reject'].includes(options.verdict??'')&&/^[0-4]$/.test(options.usefulness??'')&&/^[0-4]$/.test(options.completeness??'')&&/^[A-Za-z0-9._-]{1,80}$/.test(options.evaluator??''),'VERDICT');
      result={source_version:input.selected_source.source_version,verdict:options.verdict,usefulness:Number(options.usefulness),completeness:Number(options.completeness),evaluator:options.evaluator};
    }else result={selected_source:input.selected_source,report};
  }else{
    ensure(options.config,'CONFIG_REQUIRED');const config=await readJson(options.config,true),origin=new URL(config.origin);
    ensure(origin.href===origin.origin+'/'&&!origin.username&&!origin.password&&(origin.protocol==='https:'||origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)),'ORIGIN');
    ensure((typeof config.cookie==='string'&&config.cookie.length>0)!==(typeof config.token==='string'&&config.token.length>0),'AUTH_REQUIRED');
    const query=new URLSearchParams();let path:string,body:unknown;
    if(command==='logout'){path='/v1/auth/session/revoke';body={};}
    else if(command==='inventory'){
      for(const [key,fallback,max] of [['offset','0',Number.MAX_SAFE_INTEGER],['limit','50',100]] as const){const value=options[key]??fallback;ensure(/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)<=max&&(key!=='limit'||Number(value)>0),'PAGE');query.set(key,value);}
      path='/v1/operator/trace-explorer';
    }else if(command==='library'){path='/v1/contributor/library';if(options.cursor)query.set('cursor',options.cursor);}
    else{
      ensure(options.trace&&options.trace.length<=160,'TRACE_REQUIRED');path='/v1/contributor/library/'+encodeURIComponent(options.trace)+'/qc';
      if(command==='review'||command==='submit'){ensure(options.input,'INPUT_REQUIRED');path=command==='submit'?'/v1/operator/local-qc/'+encodeURIComponent(options.trace)+'/review':path+'/review';body=await readJson(options.input);}
      else{const scope=options.scope??'private';ensure(['private','release'].includes(scope),'SCOPE');query.set('scope',scope);if(command==='export')path+='/source';if(command==='review-source'){path='/v1/operator/local-qc/'+encodeURIComponent(options.trace)+'/source';query.delete('scope');}}
    }
    const response=await fetch(origin.origin+path+'?'+query,{redirect:'error',signal:AbortSignal.timeout(30_000),method:body?'POST':'GET',headers:{...(config.cookie?{Cookie:config.cookie}:{Authorization:'Bearer '+config.token}),Origin:origin.origin,...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
    ensure(response.ok||command==='logout'&&response.status===401,'HTTP_'+response.status);ensure(response.headers.get('content-type')?.includes('application/json'),'RESPONSE');
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of response.body!){size+=chunk.length;ensure(size<=8_000_000,'RESPONSE_LIMIT');chunks.push(chunk);}
    result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if(command==='logout'){await unlink(options.config!);process.stdout.write('QC connection revoked and local configuration removed.\n');return;}
  await writeFile(options.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write('Saved private JSON: '+resolve(options.output)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{
  const code=error instanceof Error&&/^QC_WORKSPACE_[A-Z_0-9]+$/.test(error.message)?error.message:'QC_WORKSPACE_IO_ERROR';
  process.stderr.write(code+'\n');process.exitCode=2;
});
