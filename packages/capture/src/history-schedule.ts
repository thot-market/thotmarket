import {mkdir,lstat,open,rename,unlink,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join,isAbsolute,parse,sep} from 'node:path';
import {spawn} from 'node:child_process';

type Runner=(command:string,args:string[])=>Promise<void>;
const marker='Managed by THOT private history uploader';
const xml=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const unitArg=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',()=>'$$')+'"';
export type HistoryScheduleOptions={id:string;home:string;stateRoot:string;entry:string;node?:string;time:string;platform?:string;uid?:number;run?:Runner};
export function historyScheduleFiles(options:HistoryScheduleOptions){
  if(!/^[a-f0-9]{24}$/.test(options.id)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.time))throw Error('INVALID_HISTORY_SCHEDULE');
  const node=options.node??process.execPath;for(const value of [options.home,options.stateRoot,options.entry,node])if(!isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))throw Error('INVALID_HISTORY_SCHEDULE_PATH');
  const args=[node,options.entry,'run','--id',options.id,'--state-root',options.stateRoot,'--scheduled'];
  const platform=options.platform??process.platform,name='thot-history-'+options.id;
  if(platform==='linux')return [
    {path:join(options.home,'.config/systemd/user',name+'.service'),body:'# '+marker+'\n[Unit]\nDescription=THOT private history upload\n[Service]\nType=oneshot\nUMask=0077\nExecStart='+args.map(unitArg).join(' ')+'\n'},
    {path:join(options.home,'.config/systemd/user',name+'.timer'),body:'# '+marker+'\n[Unit]\nDescription=THOT daily private history upload\n[Timer]\nOnCalendar=*-*-* '+options.time+':00 UTC\nOnStartupSec=2min\nPersistent=true\nUnit='+name+'.service\n[Install]\nWantedBy=timers.target\n'},
  ];
  if(platform==='darwin')return [{path:join(options.home,'Library/LaunchAgents',name+'.plist'),body:'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- '+marker+' -->\n<plist version="1.0"><dict><key>Label</key><string>'+name+'</string><key>ProgramArguments</key><array>'+args.map(arg=>'<string>'+xml(arg)+'</string>').join('')+'</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>900</integer><key>Umask</key><integer>63</integer></dict></plist>\n'}];
  throw Error('HISTORY_SCHEDULER_PLATFORM_UNSUPPORTED');
}
const nativeRun:Runner=(command,args)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:'ignore',shell:false});const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  child.once('error',()=>{clearTimeout(timer);reject(Error('HISTORY_SCHEDULER_UNAVAILABLE'));});child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('HISTORY_SCHEDULER_UNAVAILABLE'));});
});
async function checkedDirectory(path:string){let cursor=parse(path).root;for(const part of path.slice(cursor.length).split(sep).filter(Boolean)){cursor=join(cursor,part);const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('HISTORY_SCHEDULE_FILE_CONFLICT');}if(await realpath(path)!==path)throw Error('HISTORY_SCHEDULE_FILE_CONFLICT');}
async function existing(path:string){try{const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size>20000||(stat.mode&0o077))throw Error('HISTORY_SCHEDULE_FILE_CONFLICT');const body=await file.readFile('utf8');if(!body.includes(marker))throw Error('HISTORY_SCHEDULE_FILE_CONFLICT');return true;}finally{await file.close();}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw Error('HISTORY_SCHEDULE_FILE_CONFLICT');}}
export async function installHistorySchedule(options:HistoryScheduleOptions){
  const files=historyScheduleFiles(options),platform=options.platform??process.platform,run=options.run??nativeRun,name='thot-history-'+options.id;
  for(const file of files){const dir=file.path.slice(0,file.path.lastIndexOf('/'));await mkdir(dir,{recursive:true,mode:0o700});await checkedDirectory(dir);await existing(file.path);const temp=join(dir,'.thot-schedule-'+randomBytes(12).toString('hex')),handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(file.body);await handle.sync();}finally{await handle.close();}try{await checkedDirectory(dir);await rename(temp,file.path);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
  if(platform==='linux'){await run('systemctl',['--user','daemon-reload']);await run('systemctl',['--user','enable','--now',name+'.timer']);}
  else{const domain='gui/'+(options.uid??process.getuid?.());if(domain.endsWith('undefined'))throw Error('HISTORY_SCHEDULER_UNAVAILABLE');await run('launchctl',['bootout',domain,files[0]!.path]).catch(()=>{});await run('launchctl',['bootstrap',domain,files[0]!.path]);}
  return {platform,time_utc:options.time,files:files.map(f=>f.path)};
}
export async function removeHistorySchedule(options:HistoryScheduleOptions){
  const files=historyScheduleFiles(options),platform=options.platform??process.platform,run=options.run??nativeRun,name='thot-history-'+options.id;
  for(const file of files){await checkedDirectory(file.path.slice(0,file.path.lastIndexOf('/')));await existing(file.path);}
  if(platform==='linux')await run('systemctl',['--user','disable','--now',name+'.timer']);
  else await run('launchctl',['bootout','gui/'+(options.uid??process.getuid?.()),files[0]!.path]);
  for(const file of files)await unlink(file.path).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(platform==='linux')await run('systemctl',['--user','daemon-reload']);
}
