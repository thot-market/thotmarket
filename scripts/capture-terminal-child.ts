import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [exitFile,command,...args]=process.argv.slice(2);
const child=spawn(command!,args,{stdio:'inherit',shell:false});
const done=(code:number)=>{writeFileSync(exitFile!,JSON.stringify({code}),{mode:0o600});process.exitCode=code;};
child.once('error',()=>done(1));child.once('close',code=>done(code??1));
