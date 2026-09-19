import {spawn} from 'node:child_process';

/** Invoke the configured OS URL handler. Browser identity/profile selection is
 * left to the user's desktop. No remote debugging, focus control or new profile. */
export async function openBrowser(url:string,launch:typeof spawn=spawn,platform=process.platform){
  const command=platform==='darwin'?'open':platform==='linux'?'xdg-open':undefined;
  if(!command)return false;
  return new Promise<boolean>(resolve=>{
    let done=false;const finish=(ok:boolean)=>{if(!done){done=true;clearTimeout(timer);resolve(ok);}};
    const child=launch(command,[url],{stdio:'ignore',shell:false,detached:true});
    const timer=setTimeout(()=>{child.unref();finish(true);},2000);
    child.once('error',()=>finish(false));child.once('exit',code=>finish(code===0));
  });
}
