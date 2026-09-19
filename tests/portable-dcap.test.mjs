import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyHardware} from '../packages/provenance/portable/hardware.mjs';
const python=process.env.THOT_PORTABLE_DCAP_TEST_PYTHON;
const quote=readFileSync(new URL('../packages/provenance/fixtures/dcap-qvl-v0.6.1-tdx-quote.hex',import.meta.url),'utf8').trim();
const collateral=JSON.parse(readFileSync(new URL('../packages/provenance/fixtures/dcap-qvl-v0.6.1-tdx-collateral.json',import.meta.url),'utf8'));
const at=1750329147,platform_policy={allow_dynamic_platform:true,allow_cached_keys:true,allow_smt:true};
const gate={skip:!python?'Set THOT_PORTABLE_DCAP_TEST_PYTHON to an isolated interpreter with the portable hash-pinned dependency; no simulated pass':false};
function run(patch={}){return spawnSync(python,['-I','-B',fileURLToPath(new URL('../packages/provenance/portable/verify_dcap.py',import.meta.url))],{encoding:'utf8',input:JSON.stringify({protocol:'thot.dcap-offline/1',quote_hex:quote,collateral,verification_time_seconds:at,platform_policy,...patch}),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});}
test('portable offline adapter authenticates genuine Intel fixture at historical time',gate,()=>{const r=run();assert.equal(r.status,0,r.stderr);const claims=JSON.parse(r.stdout);assert.equal(claims.verified,true);assert.equal(claims.debug,false);assert.equal(claims.quote_hash,'c42f9164325024bca2757bc8819b11879a0a369132ea4e2b7c85df4805ea72db');assert.equal(claims.earliest_expiration_seconds,1752919235);});
test('portable offline adapter rejects expired, missing, damaged and stricter-policy collateral',gate,()=>{for(const patch of [{verification_time_seconds:Math.floor(Date.now()/1000)},{collateral:{}},{quote_hex:'00'+quote.slice(2)},{platform_policy:{allow_dynamic_platform:false,allow_cached_keys:false,allow_smt:false}}])assert.notEqual(run(patch).status,0);});
test('genuine hardware quote cannot authenticate an unrelated THOT recorder key',gate,async()=>{await assert.rejects(verifyHardware({quote,statement:{purpose:'thot.tee-recorder-key/1',signing_key:'invented',channel_key:'invented'},event_log:[]},{instances:{},platform_policy},collateral,{python,at}),/RECORDER_KEY_BINDING_INVALID/);});
