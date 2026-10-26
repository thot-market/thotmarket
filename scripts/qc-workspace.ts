#!/usr/bin/env node
/** Local operator inventory and owner-authorized QC. Never prints source content. */
import {constants} from 'node:fs';
import {open,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {runTraceQc} from '../packages/qc/index.ts';

const usage=`Usage: node scripts/qc-workspace.ts COMMAND --config private-config.json --output new-file.json [OPTIONS]
  inventory   Operator metadata: --offset 0 --limit 50
  library     Your saved work: --cursor CURSOR
  export      One exact source: --trace ID --scope private|release
  review-source  Consent-approved sale version: --trace ID
  submit      Operator verdict: --trace ID --input verdict.json
  check       Local evaluation: --input exported-source.json (no config needed)
  report      Current server QC: --trace ID --scope private|release
  review      Owner feedback: --trace ID --input review.json
Config: {"origin":"https://app.thot.market","cookie":"SESSION_COOKIE"}
A bearer token may replace cookie. Credentials must be in an owner-only file.
Inventory access does not grant permission to read another user's private content.
`;
function ensure(ok:unknown,code:string):asserts ok{if(!ok)throw Error('QC_WORKSPACE_'+code);}
async function readJson(path:string,secret=false){
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await handle.stat();ensure(stat.isFile()&&stat.size<=8_000_000,'INPUT_LIMIT');
    if(secret)ensure((stat.mode&0o077)===0&&stat.uid===process.getuid?.(),'CONFIG_PERMISSIONS');
    const bytes=Buffer.alloc(stat.size+1);let used=0;
    while(used<bytes.length){const part=await handle.read(bytes,used,bytes.length-used,null);if(!part.bytesRead)break;used+=part.bytesRead;}
    ensure(used===stat.size,'INPUT_CHANGED');return JSON.parse(bytes.subarray(0,used).toString('utf8'));
  }finally{await handle.close();}
}
export async function main(args:string[]){
  if(args.length===1&&['--help','-h'].includes(args[0]!)){process.stdout.write(usage);return;}
  const [command,...rest]=args,options:Record<string,string>={};
  ensure(['inventory','library','export','check','report','review','review-source','submit'].includes(command??''),'COMMAND');
  const allowed:Record<string,string[]>={inventory:['offset','limit'],library:['cursor'],export:['trace','scope'],check:['input'],report:['trace','scope'],review:['trace','input'],'review-source':['trace'],submit:['trace','input']};
  for(let i=0;i<rest.length;i+=2){const name=rest[i]!.slice(2),value=rest[i+1];ensure(rest[i]!.startsWith('--')&&['config','output',...allowed[command!]!].includes(name)&&!options[name]&&value&&!value.startsWith('--'),'ARGUMENTS');options[name]=value;}
  ensure(options.output,'OUTPUT_REQUIRED');let result:unknown;
  if(command==='check'){
    ensure(options.input&&!options.config,'ARGUMENTS');const input=await readJson(options.input);
    ensure(input.schema_version==='trace-qc-export/v1'&&['private','release'].includes(input.selected_source?.scope),'EXPORT_REQUIRED');
    const report=runTraceQc(input.content,{scope:input.selected_source.scope});
    ensure(report.content_digest===input.selected_source.content_hash,'CONTENT_CHANGED');
    result={selected_source:input.selected_source,report};
  }else{
    ensure(options.config,'CONFIG_REQUIRED');const config=await readJson(options.config,true),origin=new URL(config.origin);
    ensure(origin.href===origin.origin+'/'&&!origin.username&&!origin.password&&(origin.protocol==='https:'||origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)),'ORIGIN');
    ensure((typeof config.cookie==='string'&&config.cookie.length>0)!==(typeof config.token==='string'&&config.token.length>0),'AUTH_REQUIRED');
    const query=new URLSearchParams();let path:string,body:unknown;
    if(command==='inventory'){
      for(const [key,fallback,max] of [['offset','0',Number.MAX_SAFE_INTEGER],['limit','50',100]] as const){const value=options[key]??fallback;ensure(/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)<=max&&(key!=='limit'||Number(value)>0),'PAGE');query.set(key,value);}
      path='/v1/operator/trace-explorer';
    }else if(command==='library'){path='/v1/contributor/library';if(options.cursor)query.set('cursor',options.cursor);}
    else{
      ensure(options.trace&&options.trace.length<=160,'TRACE_REQUIRED');path='/v1/contributor/library/'+encodeURIComponent(options.trace)+'/qc';
      if(command==='review'||command==='submit'){ensure(options.input,'INPUT_REQUIRED');path=command==='submit'?'/v1/operator/local-qc/'+encodeURIComponent(options.trace)+'/review':path+'/review';body=await readJson(options.input);}
      else{const scope=options.scope??'private';ensure(['private','release'].includes(scope),'SCOPE');query.set('scope',scope);if(command==='export')path+='/source';if(command==='review-source'){path='/v1/operator/local-qc/'+encodeURIComponent(options.trace)+'/source';query.delete('scope');}}
    }
    const response=await fetch(origin.origin+path+'?'+query,{redirect:'error',signal:AbortSignal.timeout(30_000),method:body?'POST':'GET',headers:{...(config.cookie?{Cookie:config.cookie}:{Authorization:'Bearer '+config.token}),Origin:origin.origin,...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});
    ensure(response.ok,'HTTP_'+response.status);ensure(response.headers.get('content-type')?.includes('application/json'),'RESPONSE');
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of response.body!){size+=chunk.length;ensure(size<=8_000_000,'RESPONSE_LIMIT');chunks.push(chunk);}
    result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  await writeFile(options.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write('Saved private JSON output.\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{
  const code=error instanceof Error&&/^QC_WORKSPACE_[A-Z_0-9]+$/.test(error.message)?error.message:'QC_WORKSPACE_IO_ERROR';
  process.stderr.write(code+'\n');process.exitCode=2;
});
