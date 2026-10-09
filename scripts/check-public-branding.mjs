#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Character codes prevent the source checker from matching its own definition.
const forbidden=new RegExp(String.fromCharCode(119,97,107,101),'i');
// Development coordination is not release surface: the export deletes these paths before it
// scans. The standalone check skips the same set, so both entry points verify one namespace
// and a development tree that carries internal notes still passes.
export const INTERNAL_PATHS=[/^steering\//];
export function checkPublicBranding(root){
  const paths=execFileSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  if(!paths.length)throw Error('No tracked public source to check');
  let files=0,withheld=0;
  for(const path of paths){
    const full=resolve(root,path),stat=lstatSync(full);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Nonregular public source: '+path);
    if(INTERNAL_PATHS.some(pattern=>pattern.test(path))){withheld++;continue;}
    if(forbidden.test(path)||forbidden.test(readFileSync(full).toString('latin1'))){
      throw Error('Legacy project identity in public source: '+path);
    }
    files++;
  }
  return {files,withheld};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const checked=checkPublicBranding(process.cwd());
  console.log(`Public source namespace verified: ${checked.files} files${checked.withheld?` (${checked.withheld} withheld internal coordination files not scanned)`:''}.`);
}
