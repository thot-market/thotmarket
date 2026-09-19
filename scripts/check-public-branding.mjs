#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Character codes prevent the source checker from matching its own definition.
const forbidden=new RegExp(String.fromCharCode(119,97,107,101),'i');
export function checkPublicBranding(root){
  const paths=execFileSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  if(!paths.length)throw Error('No tracked public source to check');
  for(const path of paths){
    const full=resolve(root,path),stat=lstatSync(full);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Nonregular public source: '+path);
    if(forbidden.test(path)||forbidden.test(readFileSync(full).toString('latin1'))){
      throw Error('Legacy project identity in public source: '+path);
    }
  }
  return paths.length;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log('Public source namespace verified: '+checkPublicBranding(process.cwd())+' files.');
}
