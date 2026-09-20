#!/usr/bin/env node
import {readiness} from '../packages/capture/src/setup.ts';
const target=process.argv[2];
if(!['codex','claude','robinhood'].includes(target)){
  console.log('Usage: thot-setup codex|claude|robinhood\n\nChecks local prerequisites without opening accounts, reading login files, or making model calls.');process.exit(target==='--help'?0:1);
}
const result=await readiness(target as 'codex'|'claude'|'robinhood');
for(const check of result.checks)console.log(`${check.ok?'✓':'✕'} ${check.label}`);
const missing=result.checks.find(c=>!c.ok);
if(missing){console.log('\nNext: '+missing.next);process.exitCode=1;}
else console.log('\nLocal prerequisites are ready. '+(target==='robinhood'?'Next: thot-link robinhood. The website checks the Chrome connector and verifies your account.':`Recorder trust status is reported before your coding client starts. Use --require-reference for independent hardware and policy checks.\nNext: from your project, run thot-capture ${target}.`));
