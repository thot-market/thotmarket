import {mkdir,symlink,lstat,readlink,chmod,writeFile,unlink} from 'node:fs/promises';
import {thotUserHome} from '../packages/capture/src/setup.ts';
import {ensureVerifierInstalled} from '../packages/capture/src/verifier.ts';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if(Number(process.versions.node.split('.')[0])<24){console.error('Node.js 24 or later is required. Install it, check node --version, then rerun the installer.');process.exit(1);}
const helpers=['thot-capture','thot-link','thot-setup','thot-history'];
const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
function thotOrigin(value:string){const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw new Error('INVALID_THOT_ORIGIN');return url.origin;}
const argv=process.argv.slice(2);
if(argv.includes('--help')||argv.includes('-h')){console.log('Usage: node scripts/install-capture-helper.ts [--thot-url ORIGIN] [--robinhood-config FILE]\n\nInstalls thot-capture, thot-link, thot-setup and thot-history. --thot-url saves a nonsecret default Thot origin in\n~/.config/thot/capture.json. A later thot-capture --thot-url or THOT_URL overrides it.');process.exit(0);}
const options=new Map<string,string>();
for(let i=0;i<argv.length;i+=2){if(!['--thot-url','--thot-url','--robinhood-config'].includes(argv[i])||!argv[i+1])throw Error('Usage: node scripts/install-capture-helper.ts [--thot-url ORIGIN] [--robinhood-config FILE]');options.set(argv[i],argv[i+1]);}
const configuredValue=options.get('--thot-url')??options.get('--thot-url');
const configuredOrigin=configuredValue!==undefined?thotOrigin(configuredValue):null;
const bin=join(thotUserHome(),'.local/bin');
await mkdir(bin,{recursive:true});
// Remove only the known retired command from this checkout. Public branding
// maps this legacy name and script path to the former public capture command.
const legacyCommand=join(bin,'thot');
const legacySource=fileURLToPath(new URL('./thot.ts',import.meta.url));
let repaired=0;
try{
  if((await lstat(legacyCommand)).isSymbolicLink()&&await readlink(legacyCommand)===legacySource){
    try{await lstat(legacySource);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      await unlink(legacyCommand);repaired++;
    }
  }
}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
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
console.log('Installed thot-capture, thot-link, thot-setup and thot-history in '+bin+'\n'+(repaired?'Removed '+repaired+' stale helper command(s) from an earlier version.\n':'')+'Keep this extracted source folder in place. Installation alone does not connect an account, upload files or install a schedule.\n'+(configuredOrigin?'Saved default Thot origin: '+configuredOrigin:'Saved Thot origin default: unchanged'));
// Hardware verifier: fetch the pinned dcap-qvl release for this platform,
// verify its sha256 and record the absolute path. Nothing falls back to an
// unverified binary; failures name the URL and expected hash.
let verifierNote='';
try{
  const verifier=await ensureVerifierInstalled();
  if(verifier.status==='installed')verifierNote='Installed the hardware verifier dcap-qvl '+verifier.version+' at '+verifier.path+' (sha256 '+verifier.sha256+' verified). thot-setup and thot-capture find it automatically.';
  else if(verifier.status==='present')verifierNote='Hardware verifier dcap-qvl '+verifier.version+' already installed at '+verifier.path+'.';
  else if(verifier.status==='unsupported')verifierNote=verifier.instructions;
  else if(verifier.status==='disabled')verifierNote='Skipped the hardware verifier download (THOT_VERIFIER_AUTO_INSTALL=0). thot-setup installs it while online unless that variable stays set.';
  else if(verifier.status==='env')verifierNote='Using the hardware verifier named by TV_DCAP_QVL; no download was attempted.';
}catch(error){
  console.error('Hardware verifier install failed.\n'+(error as Error).message);
  console.error('The helper commands above are installed. Rerun this installer, or run thot-setup, once the verifier can be downloaded and verified.');
  process.exit(1);
}
console.log(verifierNote+'\nCheck the installed history helper:\n'+shellQuote(join(bin,'thot-history'))+' --help\nCheck live-capture prerequisites:\n'+shellQuote(join(bin,'thot-setup'))+' codex\nThen capture from your project:\n'+shellQuote(join(bin,'thot-capture'))+' codex\nUse claude instead of codex for Claude Code.\nThese full paths work without adding the helper directory to PATH. Node.js 24+ must remain available as node in each terminal.\nOptional short commands for this terminal: export PATH="$HOME/.local/bin:$PATH"\nFor future terminals, add that export to your shell startup file and reopen the terminal.\nSelection order: --thot-url, THOT_URL, saved config. No automatic production default is configured.');
