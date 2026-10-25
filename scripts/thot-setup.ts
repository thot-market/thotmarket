#!/usr/bin/env node
import {readiness} from '../packages/capture/src/setup.ts';
import {ensureVerifierInstalled} from '../packages/capture/src/verifier.ts';
const target=process.argv[2];
if(!['codex','claude','zai','robinhood'].includes(target)){
  console.log('Usage: thot-setup codex|claude|zai|robinhood\n\nChecks local prerequisites without opening accounts, reading login files, or making model calls. On the first run it also installs the pinned hardware verifier (dcap-qvl) for this platform by downloading it, verifying its sha256 and recording the path; set TV_DCAP_QVL to keep using your own absolute verifier path.');process.exit(target==='--help'?0:1);
}
// First-run verifier install: an explicit TV_DCAP_QVL always wins and nothing
// is recorded when the pinned bytes cannot be downloaded and verified.
try{
  const verifier=await ensureVerifierInstalled();
  if(verifier.status==='installed')console.log('Installed the hardware verifier dcap-qvl '+verifier.version+' at '+verifier.path+' (sha256 '+verifier.sha256+' verified).');
  else if(verifier.status==='present')console.log('Hardware verifier dcap-qvl '+verifier.version+' found at '+verifier.path+'.');
  else if(verifier.status==='unsupported')console.log(verifier.instructions);
  else if(verifier.status==='disabled')console.log('Automatic hardware verifier install is disabled (THOT_VERIFIER_AUTO_INSTALL=0).');
  else if(verifier.status==='env')console.log('Using the hardware verifier named by TV_DCAP_QVL; no download was attempted.');
}catch(error){console.error('Hardware verifier install failed.\n'+(error as Error).message);}
const result=await readiness(target as 'codex'|'claude'|'zai'|'robinhood');
for(const check of result.checks)console.log(`${check.ok?'✓':'✕'} ${check.label}`);
const missing=result.checks.find(c=>!c.ok);
if(missing){console.log('\nNext: '+missing.next);process.exitCode=1;}
else console.log('\nLocal prerequisites are ready. '+(target==='robinhood'?'Next: thot-link robinhood. The website checks the Chrome connector and verifies your account.':`Recorder trust status is reported before your coding client starts. Use --require-reference for independent hardware and policy checks.\nNext: from your project, run thot-capture ${target}.`));
