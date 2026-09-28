#!/usr/bin/env node
// Read CVM container logs through the token-checked log port (see scripts/log-filter.mjs).
// Usage: CVM_LOG_TOKEN=<token> node scripts/cvm-logs.mjs https://<app-id>-4330.<gateway> [container] [--tail N] [--follow]
const [origin,name,...flags]=process.argv.slice(2);
if(!origin||!process.env.CVM_LOG_TOKEN)throw Error('usage: CVM_LOG_TOKEN=<token> cvm-logs.mjs <log origin> [container] [--tail N] [--follow]');
const headers={authorization:'Bearer '+process.env.CVM_LOG_TOKEN};
const get=async path=>{const response=await fetch(new URL(path,origin),{headers});if(!response.ok)throw Error(`HTTP ${response.status} for ${path}`);return response;};
if(!name){
  for(const c of await (await get('/containers/json?all=1')).json())console.log(c.Names[0].slice(1).padEnd(40),c.State.padEnd(10),c.Status);
}else{
  const tail=flags.includes('--tail')?flags[flags.indexOf('--tail')+1]:'200';
  const response=await get(`/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}${flags.includes('--follow')?'&follow=1':''}`);
  // Non-TTY Docker logs are framed: 1 byte stream (1 stdout, 2 stderr), 3 zero bytes, 4-byte big-endian length.
  let buffer=Buffer.alloc(0);
  for await(const chunk of response.body){
    buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=8&&buffer.length>=8+buffer.readUInt32BE(4)){
      const size=buffer.readUInt32BE(4);
      (buffer[0]===2?process.stderr:process.stdout).write(buffer.subarray(8,8+size));
      buffer=buffer.subarray(8+size);
    }
  }
}
