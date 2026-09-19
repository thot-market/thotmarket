import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

export type CaptureDisplay={interrupted:boolean;saved:number;pending:number;syncError?:boolean;saveMsP50?:number;saveMsLast?:number;oldestPendingAt?:number;uploadBps?:number};
export function captureLabel(state:CaptureDisplay){
  const status=state.interrupted?'CAPTURE INTERRUPTED':state.saved+state.pending>0?'RECORDING':'WAITING FOR FIRST CAPTURE';
  if(process.env.THOT_CAPTURE_STATUS==='metrics'&&!state.interrupted){
    const seg=[`${state.saved} saved`+(state.pending?` · ${state.pending} pending`:'')];
    if(state.saveMsP50!==undefined&&state.saveMsLast!==undefined)seg.push(`save p50/last ${Math.round(state.saveMsP50)}/${Math.round(state.saveMsLast!)}ms`);
    if(state.oldestPendingAt!==undefined)seg.push(`lag ${(Math.max(0,Date.now()-state.oldestPendingAt)/1000).toFixed(1)}s`);
    if(state.uploadBps!==undefined)seg.push(`↑ ${(state.uploadBps/1024).toFixed(0)}KiB/s`);
    if(state.syncError)seg.push('sync retrying');
    return `THOT | ${status} | PRIVATE VAULT | ${seg.join(' · ')}`;
  }
  return `THOT | ${status} | PRIVATE VAULT | ${state.saved} exchanges verified & saved${state.pending?` | ${state.pending} pending locally`:''}${state.syncError?' | sync retrying':''}`;
}

/** A separate tmux server reserves a visible row outside either coding tool's
 * screen. No user tmux configuration, existing server, or CLI settings are edited. */
export function captureTerminal(){
  let socket:string|undefined,env:NodeJS.ProcessEnv|undefined;
  let state:CaptureDisplay={interrupted:false,saved:0,pending:0};
  const tmux=(args:string[])=>execFileSync('tmux',['-f','/dev/null','-S',socket!,...args],{env,stdio:['ignore','pipe','pipe'],timeout:5000}).toString();
  function update(next:Partial<CaptureDisplay>){
    state={...state,...next};if(!socket)return;
    try{tmux(['set-option','-g','status-style',state.interrupted?'bg=colour124,fg=white':'bg=colour23,fg=white']);tmux(['set-option','-g','status-format[0]',`#[bold] ${captureLabel(state)} #[default]`]);}catch{/* The child may have just exited. */}
  }
  return {update,async run(invocation:{command:string;args:string[];env:NodeJS.ProcessEnv},cwd:string){
    const interactive=process.stdin.isTTY&&process.stdout.isTTY&&!invocation.args.some(a=>['--print','-p','exec','--help','-h','--version'].includes(a));
    let dir:string|undefined,child:ReturnType<typeof spawn>|undefined;
    env={...invocation.env};delete env.TMUX;
    try{
      if(interactive){
        process.stdout.write('\x1b[2J\x1b[H');
        dir=await mkdtemp(join(tmpdir(),'thot-terminal-'));socket=join(dir,'tmux.sock');
        const runner=fileURLToPath(new URL('../../../scripts/capture-terminal-child.ts',import.meta.url));
        tmux(['new-session','-d','-s','capture','-c',cwd,process.execPath,runner,join(dir,'exit.json'),invocation.command,...invocation.args]);
        tmux(['set-option','-g','status','on']);tmux(['set-option','-g','status-position','top']);tmux(['set-option','-g','prefix','None']);
        tmux(['set-option','-g','set-titles','on']);tmux(['set-option','-g','set-titles-string','THOT capture']);
        update({});child=spawn('tmux',['-S',socket,'attach-session','-t','capture'],{cwd,env,stdio:'inherit'});
      }else{process.stderr.write(captureLabel(state)+'\n');child=spawn(invocation.command,invocation.args,{cwd,env:invocation.env,stdio:'inherit',shell:false});}
      const stop=()=>{if(socket){try{tmux(['kill-session','-t','capture']);}catch{}}else child?.kill('SIGTERM');};
      process.on('SIGINT',stop);process.on('SIGTERM',stop);
      let code:number;
      try{code=await new Promise<number>((resolve,reject)=>{child!.once('error',()=>reject(Error('CAPTURE_CLIENT_START_FAILED')));child!.once('close',c=>resolve(c??1));});}
      finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
      if(dir){try{return JSON.parse(await readFile(join(dir,'exit.json'),'utf8')).code as number;}catch{return code||1;}}
      return code;
    }finally{if(socket){try{tmux(['kill-server']);}catch{}}socket=undefined;if(dir)await rm(dir,{recursive:true,force:true});}
  }};
}
