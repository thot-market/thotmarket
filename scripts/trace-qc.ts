#!/usr/bin/env node
import {constants} from 'node:fs';
import {open,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTraceQc} from '../packages/qc/index.ts';

const usage='Usage: node scripts/trace-qc.ts --input conversation.json [--scope private|release] [--format json|html] [--output report-file]\n';
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderQcReport(report:ReturnType<typeof runTraceQc>):string{
  const findings=report.findings.map(f=>`<li><strong>${escape(f.code)}</strong><p>${escape(f.message)}</p>${f.turn_indices.length?`<small>Turns ${f.turn_indices.map(n=>n+1).join(', ')}</small>`:''}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Trace quality check</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#1d2d20;background:#f5f4ec;margin:0;padding:24px}main{max-width:800px;margin:auto;padding:28px;background:#fffef9;border:1px solid #d6ddcf;border-radius:12px}h1{font-size:28px}h2{font-size:19px}li{margin-bottom:18px}small,p{overflow-wrap:anywhere}dt{font-weight:600}dd{margin:0 0 14px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:8px;text-align:left;border-bottom:1px solid #d6ddcf}@media(max-width:600px){body{padding:12px}main{padding:18px}}</style></head><body><main><h1>Trace quality check</h1><p>${escape(report.summary)}</p><dl><dt>Result</dt><dd>${escape(report.status)}</dd><dt>Scope</dt><dd>${escape(report.scope)}</dd><dt>Content version</dt><dd>${escape(report.content_digest??'Unavailable')}</dd><dt>Check version</dt><dd>${escape(report.policy_version)}</dd></dl><h2>Findings</h2>${findings?`<ul>${findings}</ul>`:report.status==='error'?'<p>These checks could not assess this input.</p>':'<p>No issues found by these basic checks.</p>'}<h2>Coverage</h2><table><thead><tr><th>Check</th><th>Result</th><th>Turns checked</th></tr></thead><tbody>${report.checks.map(c=>`<tr><td>${escape(c.id)}</td><td>${escape(c.status)}</td><td>${c.evaluated_turns.length} / ${c.total_turns}</td></tr>`).join('')}</tbody></table><p>AI review not run. A basic check does not prove task success, establish sale rights, or estimate a price.</p><p>This report contains no source excerpts. Keep it private with the content it describes.</p></main></body></html>\n`;
}

export async function main(args:string[]){
  if(args.length===1&&['--help','-h'].includes(args[0]!)){process.stdout.write(usage);return;}
  const options:Record<string,string>={};
  for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if(!['--input','--scope','--format','--output'].includes(key)||options[key]!==undefined||!value||value.startsWith('--'))throw Error('QC_CLI_ARGUMENTS');options[key]=value;}
  if(!options['--input']||!['private','release'].includes(options['--scope']??'private')||!['json','html'].includes(options['--format']??'json'))throw Error('QC_CLI_ARGUMENTS');
  const handle=await open(options['--input'],constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let content:unknown;
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size>2_000_000)throw Error('QC_CLI_INPUT_LIMIT');
    const bytes=Buffer.alloc(stat.size+1);let used=0;
    while(used<bytes.length){const part=await handle.read(bytes,used,bytes.length-used,null);if(!part.bytesRead)break;used+=part.bytesRead;}
    if(used!==stat.size)throw Error('QC_CLI_INPUT_CHANGED');
    try{content=JSON.parse(bytes.subarray(0,used).toString('utf8'));}catch{throw Error('QC_CLI_INVALID_JSON');}
  }finally{await handle.close();}
  const report=runTraceQc(content,{scope:(options['--scope']??'private') as 'private'|'release'});
  const output=options['--format']==='html'?renderQcReport(report):JSON.stringify(report,null,2)+'\n';
  if(options['--output'])await writeFile(options['--output'],output,{flag:'wx',mode:0o600});else process.stdout.write(output);
  if(report.status==='error')process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main(process.argv.slice(2)).catch(error=>{const code=error instanceof Error&&/^QC_CLI_[A-Z_]+$/.test(error.message)?error.message:'QC_CLI_IO_ERROR';process.stderr.write(code+'\n'+usage);process.exitCode=2;});
}
