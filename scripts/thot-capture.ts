#!/usr/bin/env node
import {exportLocalCapture} from '../packages/capture/src/export.ts';
import {captureTerminal} from '../packages/capture/src/terminal.ts';
import {privateDirectory,storePrivate,loadPrivate} from '../packages/capture/src/local-state.ts';
import {captureSync,captureOrigin,capturePost} from '../packages/capture/src/sync.ts';
import {connectCapture,disconnectCapture} from '../packages/capture/src/connect.ts';
import {readiness,thotUserHome,savedThotOrigin,executable} from '../packages/capture/src/setup.ts';
import {startTeeCapture} from '../packages/capture/src/tee/client.ts';
import {assessRecorder,type RecorderAssessment} from '../packages/capture/src/tee/attestation.ts';
import {recorderPolicyFile} from '../packages/capture/src/tee/policy-file.ts';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {clientInvocation,type CaptureClient} from '../packages/capture/src/index.ts';
import {captureTiming} from '../packages/capture/src/timing.ts';

// The browser authorizes storage to its signed-in Thot account; the CLI retains its
// own provider authentication. No provider key, earnings or brokerage link is needed.
const argv=process.argv.slice(2);
const timing=captureTiming();timing.emit('helper_started');
if(argv.includes('--help')||argv.includes('-h')){
  console.log('Usage: thot-capture codex|claude [--thot-url URL] [--recorder-url URL] [--reference-policy FILE] [--require-reference] [--project DIR] [-- CLI arguments]\n       thot-capture --retry CAPTURE_ID\n       thot-capture --export CAPTURE_ID --output NEW_DIRECTORY\n       thot-capture --disconnect codex|claude\n\nUses your existing CLI login. Thot opens your browser once to connect this tool. Returning captures reuse it.\nWork normally; signed checkpoints save privately while you work. Encrypted local copies are kept after saving.\nExport writes private plaintext files for independent inspection. Keep them private.\nUse --local-retention until-saved to reclaim local bodies after successful save; default: keep.\nA visible bar shows what is saved and what is pending locally.\nAPI selection: --thot-url, THOT_URL, saved configuration. No production default is configured yet.\nRecorder selection: reviewed reference policy or explicit --recorder-url / THOT_RECORDER_URL. Strict reference checks use --require-reference.');
  process.exit(0);
}
if(['codex','claude'].includes(argv[0]))argv.splice(0,1,'--client',argv[0]);
const split=argv.indexOf('--'),flags=split<0?argv:argv.slice(0,split),clientArgs=split<0?[]:argv.slice(split+1);
const requireReference=flags.includes('--require-reference');
if(requireReference)flags.splice(flags.indexOf('--require-reference'),1);
const params=new Map<string,string>();
for(let i=0;i<flags.length;i+=2){if(!['--client','--thot-url','--thot-url','--recorder-url','--reference-policy','--project','--retry','--disconnect','--export','--output','--local-retention','--collateral'].includes(flags[i])||!flags[i+1])throw new Error('INVALID_CAPTURE_ARGUMENT');params.set(flags[i],flags[i+1]);}
async function selectedOrigin(){const value=params.get('--thot-url')??params.get('--thot-url')??process.env.THOT_URL??process.env.THOT_URL??await savedThotOrigin();if(!value)throw Error('THOT_PRODUCTION_ORIGIN_UNCONFIGURED: use --thot-url or THOT_URL until production is accepted');return thotOrigin(value);}
const stateRoot=resolve(thotUserHome(),'.local/state/thot/captures');
const thotOrigin=captureOrigin;
function savedMessage(origin:string,result:any){
  process.stdout.write('\nSaved to your private vault: '+origin+'/#trace='+encodeURIComponent(result.trace_id)+'\n');
  if(['PARTIAL','UNREADABLE','ERROR'].includes(result.projection?.status))process.stderr.write('The original recording is safe. Some content is not ready to display yet; you can find it in your vault.\n');
  if(result.capture_summary?.interrupted)process.stderr.write('Interrupted responses are retained in the evidence. Your vault shows the saved boundary.\n');
}
const retry=params.get('--retry'),disconnect=params.get('--disconnect');
const connectionRoot=resolve(thotUserHome(),'.local/state/thot/connections');
const exportId=params.get('--export');
if(exportId){
  if(!/^[a-zA-Z0-9-]{16,80}$/.test(exportId)||!params.get('--output'))throw Error('EXPORT_REQUIRES_CAPTURE_ID_AND_OUTPUT');
  let collateral:unknown;if(params.has('--collateral')){const path=resolve(params.get('--collateral')!);if((await lstat(path)).size>2_000_000)throw Error('COLLATERAL_SIZE_LIMIT');collateral=JSON.parse(await readFile(path,'utf8'));}
  const result=await exportLocalCapture(join(stateRoot,exportId),resolve(params.get('--output')!),collateral);
  process.stdout.write('Private plaintext export: '+result.directory+'\nVerify independently: node '+JSON.stringify(join(result.directory,'verify.mjs'))+'\nHardware attestation is included when available; the basic verifier checks integrity and signatures only.\n');
}else if(disconnect){
  if(!['codex','claude'].includes(disconnect))throw Error('Choose codex or claude to disconnect.');
  const origin=await selectedOrigin();
  await disconnectCapture(connectionRoot,origin,disconnect as CaptureClient);process.stdout.write('This tool is disconnected from Thot. Saved conversations remain in your vault. New automatic listings are stopped; use Connections to confirm wallet revocation of prepared unfunded offers.\n');
}else if(retry){
  if(!/^[a-zA-Z0-9-]{16,80}$/.test(retry))throw new Error('INVALID_CAPTURE_ID');
  const dir=join(stateRoot,retry);let pending:any,final=true;
  try{pending=await loadPrivate(dir);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;pending=await loadPrivate(join(dir,'checkpoint'));final=false;}
  const sync=await captureSync(pending,dir);
  try{if(final)savedMessage(pending.origin,await sync.finish(pending));else{await sync.flush();process.stdout.write('Last signed checkpoint saved. The interrupted interval after it is not claimed as captured.\n'+pending.origin+'\n');}}finally{sync.close();}
}else{
  const client=params.get('--client') as CaptureClient;if(!['codex','claude'].includes(client))throw new Error('Choose --client codex or --client claude.');
  const origin=await selectedOrigin(),project=resolve(params.get('--project')??process.cwd());
  if(!(await lstat(project)).isDirectory())throw new Error('CAPTURE_PROJECT_NOT_DIRECTORY');
  if(process.stdin.isTTY&&process.stdout.isTTY&&!await executable('tmux')){console.error('Install tmux to show the persistent Thot capture bar, then run this command again.');process.exit(1);}
  const setup=await readiness(client);
  timing.emit('readiness_done');
  if(!setup.ready){console.error('Setup needed: '+setup.checks.find(c=>!c.ok)!.next+'\nCheck again: thot-setup '+client);process.exit(1);}
  if(requireReference&&!setup.checks.find(c=>c.id==='verifier')?.ok)throw Error('RECORDER_VERIFIER_REQUIRED');
  const retention=params.get('--local-retention')??'keep';if(!['keep','until-saved'].includes(retention))throw Error('INVALID_LOCAL_RETENTION');
  const connection={...await connectCapture({origin,client,project:basename(project),root:connectionRoot,...((process.env.THOT_CAPTURE_NO_OPEN??process.env.THOT_CAPTURE_NO_OPEN)==='1'?{open:async()=>false}:{})}),local_retention:retention as 'keep'|'until-saved'};
  timing.emit('connection_ready');
  process.stdout.write('Private vault account: '+connection.account_id+' · project: '+basename(project)+'\n');
  process.stdout.write(connection.automatic_sales?'Automatic sales: eligible completed sessions use your signed connection policy. A funded purchase is required for earnings.\n':'Private capture: no automatic sale policy is active for this session.\n');
  const recorderUrl=params.get('--recorder-url')??process.env.THOT_RECORDER_URL;
  const explicitPolicy=params.get('--reference-policy')??process.env.THOT_RECORDER_POLICY_FILE??process.env.THOT_RECORDER_POLICY_FILE;
  const policySource=explicitPolicy??(recorderUrl?'explicit-recorder-url':await recorderPolicyFile(origin));
  const policy=recorderUrl&&!explicitPolicy?{url:recorderUrl,instances:{}}:JSON.parse(await readFile(policySource,'utf8'));
  if(recorderUrl&&explicitPolicy){if(new URL(recorderUrl).origin!==new URL(policy.url).origin)throw Error('RECORDER_POLICY_URL_MISMATCH');policy.url=recorderUrl;}
  if(!policy.url)throw Error('THOT_RECORDER_URL_UNCONFIGURED: use --recorder-url or a reviewed reference policy');
  process.stderr.write('Checking recorder identity and reference policy before sending model credentials…\n');
  await privateDirectory(stateRoot);const dir=join(stateRoot,connection.capture_id);await privateDirectory(dir);await privateDirectory(join(dir,'parts'));
  await storePrivate(join(dir,'connection'),{...connection,client,project});
  const display=captureTerminal();let lastSyncError:string|undefined;
  const sync=await captureSync(connection,dir,progress=>{
    timing.emit('sync_progress',{saved:progress.saved,pending:progress.pending,...(progress.saveMsLast!==undefined?{save_ms:progress.saveMsLast}:{})});
    display.update({saved:progress.saved,pending:progress.pending,syncError:!!progress.error,saveMsP50:progress.saveMsP50,saveMsLast:progress.saveMsLast,oldestPendingAt:progress.oldestPendingAt,uploadBps:progress.uploadBps});
    if(progress.error&&progress.error!==lastSyncError)process.stderr.write('Thot: saved locally; vault sync will retry automatically ('+progress.error+').\n');
    lastSyncError=progress.error;
  });
  let proxy:Awaited<ReturnType<typeof startTeeCapture>>;
  let assessment:RecorderAssessment|undefined;
  try{proxy=await startTeeCapture({client,captureId:connection.capture_id,uploadToken:connection.upload_token,policy,onTiming:timing.emit,onPart:part=>sync.part(part),onCheckpoint:checkpoint=>sync.checkpoint(checkpoint),onState:(state,detail)=>{if(state==='interrupted'){display.update({interrupted:true});process.stderr.write('Thot capture: '+(detail??'interrupted')+'\n');}}},async attestation=>{
    assessment=await assessRecorder(attestation,policy,{strict:requireReference,policySource});
    await storePrivate(join(dir,'client-verification'),assessment);
    const status=assessment.hardware==='verified'&&assessment.references==='matched'?'hardware and references matched':'SERVICE TRUST: hardware '+assessment.hardware+', references '+assessment.references;
    process.stderr.write('Recorder trust: '+status+'; policy '+policySource+'\n');
    if(assessment.references==='mismatched')process.stderr.write('Reference mismatch: actual '+assessment.app_id+'/'+assessment.compose_hash+', expected '+(assessment.expected_compose_hash??'unlisted')+'\n');
  });}
  catch(error){
    const code=error instanceof Error?error.message:'CAPTURE_CONNECTION_FAILED';
    const messages:Record<string,string>={
      CAPTURE_AUTHORIZATION_REJECTED:'The recorder could not verify this vault’s capture approval. Ask the demo operator to check the recorder-to-vault connection.',
      CAPTURE_AUTHORIZATION_UNAVAILABLE:'The recorder could not reach the vault to verify your approval. Please try again shortly.',
      RECORDER_BUSY:'The recorder is at capacity. Please try again shortly.',
      TEE_SESSION_REJECTED:'The recorder rejected the connection. Share this error code with the demo operator.'
    };
    sync.close();
    console.error('\nCapture did not start. '+(messages[code]??'The recorder connection or verification failed.')+'\nYour coding tool was not started. No model credentials were sent.\nError: '+(/^[A-Z0-9_]{1,80}$/.test(code)?code:'CAPTURE_CONNECTION_FAILED'));process.exit(1);
  }
  process.stderr.write((assessment?.hardware==='verified'&&assessment.references==='matched'?'Independently checked recorder.':'Service-trust recorder; independent workload verification was not completed.')+' Starting '+client+' with your existing login.\n');
  let heartbeatPending=false;
  const heartbeat=setInterval(()=>{if(heartbeatPending)return;heartbeatPending=true;void capturePost(connection,'heartbeat',{},'heartbeat-'+Date.now()).catch(()=>{}).finally(()=>{heartbeatPending=false;});},20000).unref();
  let exitCode=1;
  try{
    const invocation=clientInvocation(client,proxy.baseUrl,clientArgs);
    timing.emit('client_started');
    exitCode=await display.run(invocation,project);
    timing.emit('client_exited');
  }finally{
    clearInterval(heartbeat);
    try{
      const result=await proxy.finish();
      if(!(result.bundle.format==='thot.proxy-capture/2'?result.bundle.parts.length:result.bundle.exchanges.length))process.stderr.write('No model exchanges were captured. Nothing was saved.\n');
      else{
        process.stderr.write('Saving the final checkpoint…\n');
        savedMessage(origin,await sync.finish(result));
        if(retention==='keep')process.stdout.write('Encrypted local copy kept. Export anytime: thot-capture --export '+connection.capture_id+' --output NEW_DIRECTORY\n');
      }
    }catch(error){
      const code=error instanceof Error&&/^[A-Z0-9_]{1,100}$/.test(error.message)?error.message:'CAPTURE_SAVE_INTERRUPTED';
      process.stderr.write(code+'\nYour local encrypted recording is retained. Earlier acknowledged vault checkpoints remain saved.\nNo model call will be replayed. Retry saving: thot-capture --retry '+connection.capture_id+'\n');process.exitCode=1;
    }finally{sync.close();timing.emit('helper_finished');await timing.flush();}
  }
  process.exitCode=process.exitCode??exitCode;
}
