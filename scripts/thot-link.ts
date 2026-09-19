#!/usr/bin/env node
import {mkdir,lstat,readFile,writeFile,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {thotUserHome} from '../packages/capture/src/setup.ts';
import {randomBytes,generateKeyPairSync,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {readiness,savedThotOrigin,savedRobinhoodConfig,thotOrigin} from '../packages/capture/src/setup.ts';
import {startRobinhoodPairing} from '../packages/capture/src/robinhood-pairing.ts';

const argv=process.argv.slice(2),args=new Map<string,string>();
if(argv[0]!=='robinhood'||argv.includes('--help')){console.log('Usage: thot-link robinhood [--thot-url ORIGIN] [--config PRIVATE_CONFIG] [--trade-trace TRACE --symbol SYMBOL --window-days N]\n\nOpen the printed THOT link in Chrome. The website guides extension setup and account verification.\nUses the saved THOT origin. No gate cookie or THOT login token is needed in your terminal.');process.exit(argv.includes('--help')?0:1);}
for(let i=1;i<argv.length;i+=2){if(!['--thot-url','--config','--trade-trace','--symbol','--window-days'].includes(argv[i])||!argv[i+1])throw Error('INVALID_ARGUMENTS');args.set(argv[i],argv[i+1]);}
const tradeFlags=['--trade-trace','--symbol','--window-days'];
const tradeRequest=tradeFlags.some(k=>args.has(k))?{trace_id:args.get('--trade-trace')??'',symbol:(args.get('--symbol')??'').trim().toUpperCase(),window_days:Number(args.get('--window-days'))}:undefined;
if(tradeRequest&&(!/^[-A-Za-z0-9:_]{1,200}$/.test(tradeRequest.trace_id)||!/^[A-Z][A-Z0-9.-]{0,14}$/.test(tradeRequest.symbol)||!Number.isInteger(tradeRequest.window_days)||tradeRequest.window_days<1||tradeRequest.window_days>365))throw Error('INVALID_TRADE_REQUEST');
const origin=thotOrigin(args.get('--thot-url')??process.env.THOT_URL??await savedThotOrigin()??'http://127.0.0.1:4322');
const checks=await readiness('robinhood');
if(!checks.ready){const first=checks.checks.find(c=>!c.ok)!;console.error(first.label+' is missing.\nNext: '+first.next+'\nCheck again: thot-setup robinhood');process.exit(1);}
const root=fileURLToPath(new URL('../',import.meta.url));
const stateDir=join(thotUserHome(),'.local/share/thot/robinhood');
let config:any,extensionDir:string|undefined;
const existingConfig=args.get('--config')??await savedRobinhoodConfig();
if(existingConfig){
  // Explicit migration path only: never discover or print an existing private config.
  const value=JSON.parse(await readFile(resolve(existingConfig),'utf8'));config=value.browser??value;
}else{
  await mkdir(stateDir,{recursive:true,mode:0o700});
  const stat=await lstat(stateDir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('PRIVATE_CONFIG_PERMISSIONS');
  const path=join(stateDir,'pairing.json');
  let pairing:any;
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>8192)throw Error('PRIVATE_CONFIG_PERMISSIONS');pairing=JSON.parse(await readFile(path,'utf8'));}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
    const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
    const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'}).toString('base64');
    const id=[...createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,32)].map(x=>String.fromCharCode(97+parseInt(x,16))).join('');
    pairing={port,capability:randomBytes(32).toString('hex'),origin:'chrome-extension://'+id,key};
    await writeFile(path,JSON.stringify(pairing),{mode:0o600,flag:'wx'});
  }
  extensionDir=join(stateDir,'extension');
  try{if((await lstat(extensionDir)).isSymbolicLink())throw Error('PRIVATE_CONFIG_PERMISSIONS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await cp(join(root,'integrations/robinhood-browser-extension'),extensionDir,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extensionDir,'manifest.json'),'utf8'));manifest.key=pairing.key;
  await writeFile(join(extensionDir,'manifest.json'),JSON.stringify(manifest,null,2));
  await writeFile(join(extensionDir,'config.js'),'globalThis.THOT_ROBINHOOD_CONFIG='+JSON.stringify({bridgeUrl:`http://127.0.0.1:${pairing.port}/${pairing.capability}`})+';\n',{mode:0o600});
  config={pythonExecutable:checks.python,bridgePath:join(root,'trace-vault/browser_capture.py'),measurementsPath:join(root,'trace-vault/deploy/robinhood-measurements.json'),qvlPath:checks.qvl,extensionBridge:pairing};
}
const bridge=await startRobinhoodPairing({origin,tradeRequest,extensionDir,launch(input,update){
  const child=spawn(process.execPath,[join(root,'scripts/robinhood-existing-browser.mjs')],{stdio:['pipe','pipe','pipe']});
  let gotEvidence=false,outputBytes=0;
  child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>1_000_000){update({error:'CONNECTOR_OUTPUT_LIMIT'});child.kill();}});
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const record=JSON.parse(line);if(record.evidence)gotEvidence=true;update(record);if(record.stage)console.log(record.stage.replaceAll('_',' '));}catch{update({error:'CONNECTOR_OUTPUT_INVALID'});child.kill();}});
  child.stderr.resume();child.on('error',()=>update({error:'CONNECTOR_START_FAILED'}));child.stdin.on('error',()=>update({error:'CONNECTOR_START_FAILED'}));
  child.on('close',()=>{if(!gotEvidence)update({error:'CONNECTOR_ENDED_WITHOUT_PROOF'});});
  child.stdin.end(JSON.stringify({...input,python_executable:config.pythonExecutable,bridge_path:config.bridgePath,measurements:config.measurementsPath,dcap_qvl:config.qvlPath,extension_bridge:config.extensionBridge,report_extension_ready:true}));
  return ()=>{lines.close();child.kill('SIGTERM');};
},onClose(saved){console.log(saved?'Robinhood proof saved and verified by THOT.':'Connection closed. No new success was confirmed.');process.exitCode=saved?0:1;}});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void bridge.close());
console.log('Next: open this link in the Chrome profile you use for Robinhood.\n'+bridge.url+'\n\nKeep this terminal open. The website will guide the remaining steps.');
