#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='setup'){
  if(args[1] && !['claude','codex','--help','-h'].includes(args[1])){
    console.error('Usage: thot setup claude|codex');process.exit(1);
  }
  process.argv.splice(2,1);
  if(!process.argv[2] || process.argv[2]==='-h')process.argv[2]='--help';
  await import('../runtime/scripts/thot-setup.js');
}else await import('../runtime/scripts/thot-capture.js');
