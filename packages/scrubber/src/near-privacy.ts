import {applySpanEdits} from './index.ts';
import type {TraceContent} from '../../provenance/src/index.ts';

const ENDPOINT='https://cloud-api.near.ai/v1/privacy/classify';
const MODEL='openai/privacy-filter';
// Never put provider responses, inputs, credentials or exception messages into receipts/logs.
export class NearPrivacyFilter {
 private busy=false;
 private retryAt=0;
 private key:string;private request:typeof fetch;private timeoutMs:number;
 constructor(key:string,request:typeof fetch=fetch,timeoutMs=8000){this.key=key;this.request=request;this.timeoutMs=timeoutMs;}
 async filter(trace:TraceContent):Promise<{trace:TraceContent;status:string;edits:number}> {
  const fallback=(status:string)=>({trace,status,edits:0});
  if(!this.key)return fallback('disabled');
  if(this.busy||Date.now()<this.retryAt)return fallback('fallback_circuit_open');
  // Bounded work protects recording and the shared transaction queue. Large releases
  // keep the baseline filter; they are never mislabelled as fully model-filtered.
  if(trace.turns.reduce((n,t)=>n+t.content.length,0)>6144)return fallback('fallback_size_limit');
  const chunks:{turn:number;start:number;text:string}[]=[];
  for(const [turn,t]of trace.turns.entries()){
   let offset=0;
   while(offset<t.content.length){
    const chars=Array.from(t.content.slice(offset)),text=chars.slice(0,192).join('');
    chunks.push({turn,start:offset,text});
    if(chunks.length>32)return fallback('fallback_size_limit');
    offset+=text.length;
   }
  }
  if(!chunks.length)return {trace,status:'near_complete',edits:0};
  this.busy=true;
  try {
   const signal=AbortSignal.timeout(this.timeoutMs);
   const response=await this.request(ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,input:chunks.map(c=>c.text)}),signal,redirect:'error'});
   if(!response.ok){this.retryAt=Date.now()+([401,402,403].includes(response.status)?300000:30000);return fallback('fallback_provider_unavailable');}
   // Bound the decoded response too; JSON.parse(response.text()) alone is unbounded.
   const reader=response.body?.getReader();if(!reader)throw Error('INVALID_RESPONSE');
   const parts:Uint8Array[]=[];let bytes=0;
   for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>128000){await reader.cancel();throw Error('RESPONSE_LIMIT');}parts.push(part.value);}
   const result=JSON.parse(Buffer.concat(parts).toString('utf8'));
   if(result.model!==MODEL||!Array.isArray(result.data)||result.data.length!==chunks.length)throw Error('INVALID_RESPONSE');
   const edits=new Map<number,{start:number;end:number;replacement:string}[]>(),seen=new Set<number>();
   for(const row of result.data){
    if(!Number.isInteger(row.index)||row.index<0||row.index>=chunks.length||seen.has(row.index)||!Array.isArray(row.spans)||row.spans.length>192)throw Error('INVALID_RESPONSE');
    seen.add(row.index);const chunk=chunks[row.index]!,chars=Array.from(chunk.text);
    for(const span of row.spans){
     if(typeof span.category!=='string'||!span.category.startsWith('private_')||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>chars.length||typeof span.text!=='string'||chars.slice(span.start,span.end).join('')!==span.text)throw Error('INVALID_SPAN');
     // Offset units are Unicode code points. Preserve spaces around the detected PII.
     const leading=span.text.match(/^\s*/u)[0].length,trailing=span.text.match(/\s*$/u)[0].length;
     const start=chunk.start+chars.slice(0,span.start).join('').length+leading,end=chunk.start+chars.slice(0,span.end).join('').length-trailing;
     if(end<=start)continue;
     const rows=edits.get(chunk.turn)??[];rows.push({start,end,replacement:'[REDACTED]'});edits.set(chunk.turn,rows);
    }
   }
   const output={...trace,turns:trace.turns.map((turn,index)=>({...turn,content:applySpanEdits(turn.content,edits.get(index)??[])}))};
   return {trace:output,status:'near_complete',edits:[...edits.values()].reduce((n,e)=>n+e.length,0)};
  }catch{this.retryAt=Date.now()+30000;return fallback('fallback_timeout_or_invalid_response');}
  finally{this.busy=false;}
 }
}
