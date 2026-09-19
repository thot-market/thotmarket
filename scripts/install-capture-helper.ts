import {mkdir,symlink,lstat,readlink,chmod,writeFile} from 'node:fs/promises';
import {thotUserHome} from '../packages/capture/src/setup.ts';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const helpers=['thot','thot-link','thot-setup'];
function thotOrigin(value:string){const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw new Error('INVALID_THOT_ORIGIN');return url.origin;}
const argv=process.argv.slice(2);
if(argv.includes('--help')||argv.includes('-h')){console.log('Usage: node scripts/install-capture-helper.ts [--thot-url ORIGIN] [--robinhood-config FILE]\n\nInstalls thot, thot-link and thot-setup. --thot-url saves a nonsecret default THOT origin in\n~/.config/thot/capture.json. A later thot --thot-url or THOT_URL overrides it.');process.exit(0);}
const options=new Map<string,string>();
for(let i=0;i<argv.length;i+=2){if(!['--thot-url','--robinhood-config'].includes(argv[i])||!argv[i+1])throw Error('Usage: node scripts/install-capture-helper.ts [--thot-url ORIGIN] [--robinhood-config FILE]');options.set(argv[i],argv[i+1]);}
const configuredOrigin=options.has('--thot-url')?thotOrigin(options.get('--thot-url')!):null;
const bin=join(thotUserHome(),'.local/bin');
await mkdir(bin,{recursive:true});
for(const name of helpers){
const source=fileURLToPath(new URL('./'+name+'.ts',import.meta.url)),target=join(bin,name);
try{const stat=await lstat(target);if(!stat.isSymbolicLink()||await readlink(target)!==source)throw new Error(name+' already exists at another location; run this installer from that checkout to update it.');}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await symlink(source,target);}
await chmod(source,0o755);
}
if(configuredOrigin){
  const configDir=join(thotUserHome(),'.config/thot'),configPath=join(configDir,'capture.json');
  await mkdir(configDir,{recursive:true,mode:0o700});
  const stat=await lstat(configDir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error('CAPTURE_CONFIG_PERMISSIONS');
  try{const existing=await lstat(configPath);if(!existing.isFile()||existing.isSymbolicLink())throw new Error('CAPTURE_CONFIG_PERMISSIONS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await writeFile(configPath,JSON.stringify({thot_url:configuredOrigin},null,2)+'\n',{mode:0o600});await chmod(configPath,0o600);
}
if(options.has('--robinhood-config')){
  const configFile=resolve(options.get('--robinhood-config')!);if(!(await lstat(configFile)).isFile())throw Error('ROBINHOOD_CONFIG_NOT_FILE');
  const dir=join(thotUserHome(),'.config/thot');await mkdir(dir,{recursive:true,mode:0o700});const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('ROBINHOOD_CONFIG_PERMISSIONS');
  const path=join(dir,'robinhood.json');try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())throw Error('ROBINHOOD_CONFIG_PERMISSIONS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await writeFile(path,JSON.stringify({config_file:configFile})+'\n',{mode:0o600});await chmod(path,0o600);
  console.log('Saved existing Robinhood connector preference. No extension reinstall is needed.');
}
console.log('Installed thot, thot-link and thot-setup in '+bin+'\nFrom your project, run: thot codex\nOr: thot claude\n'+(configuredOrigin?'Saved default THOT: '+configuredOrigin:'Saved THOT default: unchanged')+'\nIf command not found, add ~/.local/bin to PATH or open a new terminal.\nCheck prerequisites: thot-setup codex (or claude / robinhood).\nSelection order: --thot-url, THOT_URL, saved config, then http://127.0.0.1:4322.');
