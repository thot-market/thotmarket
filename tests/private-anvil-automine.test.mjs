import test from 'node:test';
import assert from 'node:assert/strict';
import {enablePrivateAutomine,automineCommand} from '../scripts/enable-private-anvil-automine.mjs';
const line=`node scripts/private-anvil-bootstrap.mjs && node -e "fetch('http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'evm_setIntervalMining',params:[0]})}).then(r=>r.json()).then(j=>{if(j.error)throw Error(JSON.stringify(j.error));console.log('interval mining disabled');})"`;
const fixture=()=>({services:{'private-anvil-bootstrap':{image:'example:fixed',command:['sh','-ec','echo bootstrap\n'+line+'\necho done'],volumes:['chain:/chain']},app:{image:'example:unchanged',environment:{CLOCK_SECONDS:'300'}}},volumes:{chain:{}}});
test('changes only the known bootstrap line and preserves input/configuration',()=>{const before=fixture(),candidate=enablePrivateAutomine(before);assert.equal(candidate.services['private-anvil-bootstrap'].command[2],before.services['private-anvil-bootstrap'].command[2].replace(line,line+' && '+automineCommand));candidate.services['private-anvil-bootstrap'].command=before.services['private-anvil-bootstrap'].command;assert.deepEqual(candidate,before);assert(!JSON.stringify(before).includes('evm_setAutomine'));});
for(const [name,change] of [
 ['missing bootstrap',r=>delete r.services['private-anvil-bootstrap']],
 ['no known setup',r=>r.services['private-anvil-bootstrap'].command=['sh','-ec','echo hello']],
 ['different parameters',r=>r.services['private-anvil-bootstrap'].command[2]=line.replace('params:[0]','params:[1]')],
 ['duplicate setup',r=>r.services['private-anvil-bootstrap'].command[2]=line+'\n'+line],
 ['already patched',r=>r.services['private-anvil-bootstrap'].command[2]+='\n'+automineCommand],
])test('refuses '+name,()=>{const r=fixture();change(r);assert.throws(()=>enablePrivateAutomine(r));});
