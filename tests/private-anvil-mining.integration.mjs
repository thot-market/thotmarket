import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {automineCommand} from '../scripts/enable-private-anvil-automine.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('bootstrap automining confirms transactions without idle block growth or state reset',async t=>{
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.env.THOT_ANVIL_PATH??'anvil',['--host','127.0.0.1','--port',String(port),'--silent'],{stdio:'ignore'});let spawnError;child.on('error',e=>spawnError=e);t.after(()=>child.kill('SIGTERM'));
 const url='http://127.0.0.1:'+port;
 async function rpc(method,params=[]){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(1000)});const body=await r.json();assert(!body.error);return body.result;}
 let ready=false;for(let i=0;i<50;i++){if(spawnError)throw spawnError;try{await rpc('eth_chainId');ready=true;break}catch{await pause(100)}}assert(ready,'Anvil ready');
 assert.match(await rpc('web3_clientVersion'),/anvil\/v1\.7\.1/);
 const genesis=(await rpc('eth_getBlockByNumber',['0x0',false])).hash,[from,to]=await rpc('eth_accounts');
 await rpc('evm_setIntervalMining',[0]);const head=await rpc('eth_blockNumber'),balance=BigInt(await rpc('eth_getBalance',[to,'latest']));
 const pending=await rpc('eth_sendTransaction',[{from,to,value:'0x1'}]);await pause(500);assert.equal(await rpc('eth_getTransactionReceipt',[pending]),null);assert.equal(await rpc('eth_blockNumber'),head);
 await promisify(execFile)('/bin/sh',['-ec',automineCommand.replace('http://127.0.0.1:8545',url)]);
 const started=performance.now(),next=await rpc('eth_sendTransaction',[{from,to,value:'0x1'}]);
 let receipt;for(let i=0;i<30;i++){receipt=await rpc('eth_getTransactionReceipt',[next]);if(receipt)break;await pause(100)}
 assert.equal(receipt?.status,'0x1');assert.equal((await rpc('eth_getTransactionReceipt',[pending])).status,'0x1');
 const milliseconds=Math.round(performance.now()-started);assert(milliseconds<3000);
 assert.equal(BigInt(await rpc('eth_getBalance',[to,'latest'])),balance+2n);assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,genesis);
 const idle=await rpc('eth_blockNumber');await pause(2000);assert.equal(await rpc('eth_blockNumber'),idle);
 t.diagnostic(JSON.stringify({confirmation_ms:milliseconds,idle_observation_ms:2000,genesis_and_balances_preserved:true,pending_transaction_included:true}));
});
