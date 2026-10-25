import {readFile,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';

export function thotUserHome(){const path=process.env.THOT_USER_HOME??process.env.THOT_USER_HOME??homedir();if(!isAbsolute(path))throw Error('INVALID_THOT_USER_HOME');return path;}
// Read a small nonsecret record from ~/.config/thot. Shared by the origin,
// connector and verifier records so every reader enforces the same shape.
export async function readThotConfigRecord(name:string,home=thotUserHome()) {
  const path=join(home,'.config/thot',name);
  try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||(stat.mode&0o077))throw Error('CAPTURE_CONFIG_PERMISSIONS');return JSON.parse(await readFile(path,'utf8'));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}
