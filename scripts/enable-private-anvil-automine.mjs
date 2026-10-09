#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Run after the existing interval-mining shutdown. This changes mining mode only;
// it does not reset state or manually mine blocks. The bootstrap shares Anvil's network.
export const automineProgram = `fetch('http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'evm_setAutomine',params:[true]}),signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw Error('AUTOMINE_HTTP_FAILED');const j=await r.json();if(j.error||!Object.hasOwn(j,'result'))throw Error('AUTOMINE_RPC_FAILED');console.log('transaction automining enabled');}).catch(()=>{console.error('AUTOMINE_SETUP_FAILED');process.exitCode=1;})`;
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export const automineCommand='node -e '+shellQuote(automineProgram);
export function enablePrivateAutomine(input){
 const result=structuredClone(input),service=result.services?.['private-anvil-bootstrap'];
 if(!service)throw Error('PRIVATE_BOOTSTRAP_REQUIRED');
 const command=service.command;
 if(typeof command!=='string'&&!(Array.isArray(command)&&command.every(v=>typeof v==='string')))throw Error('UNSUPPORTED_BOOTSTRAP_COMMAND');
 const parts=typeof command==='string'?[command]:command;
 if(parts.some(p=>p.includes('evm_setAutomine')))throw Error('AUTOMINE_ALREADY_CONFIGURED_REVIEW_REQUIRED');
 let matches=0;
 const updated=parts.map(part=>part.split('\n').map(line=>{
  if(!line.includes('evm_setIntervalMining'))return line;
  // Refuse to guess at an unfamiliar bootstrap or split/multiline RPC program.
  if(!/^node scripts\/private-anvil-bootstrap\.mjs && node -e ".*method:'evm_setIntervalMining',params:\[0\].*"$/.test(line))throw Error('UNRECOGNIZED_INTERVAL_SETUP');
  matches++;return line+' && '+automineCommand;
 }).join('\n'));
 if(matches!==1)throw Error('EXACTLY_ONE_INTERVAL_SETUP_REQUIRED');
 service.command=typeof command==='string'?updated[0]:updated;
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==4)throw Error('USAGE_INPUT_COMPOSE_OUTPUT_COMPOSE');
  const result=enablePrivateAutomine(JSON.parse(await readFile(process.argv[2],'utf8')));
  await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('Prepared private bootstrap candidate; deployment is a separate authorized operation.');
 }catch(error){console.error(/^[A-Z_]+$/.test(error.message)?error.message:'PREPARATION_FAILED');process.exitCode=1;}
}
