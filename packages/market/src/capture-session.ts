import {canonicalHash} from '../../protocol/src/index.ts';
import type {Document} from '../../storage/src/index.ts';

/** Client-provided conversation identity is an organization hint, never account
 * identity or evidence that historical messages were previously captured.
 * These exact request fields were observed in real native resume tests. */
export function nativeConversationKey(owner:string,client:string,request:Document):string|undefined{
  let id:unknown;
  if(client==='claude'){
    const value=request.metadata?.user_id;
    if(typeof value==='string'&&value.length<=4096){try{id=JSON.parse(value).session_id;}catch{}}
  }else if(client==='codex')id=request.client_metadata?.thread_id;
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return;
  return canonicalHash({owner,client,native_session:id.toLowerCase()});
}

export function conversationGroups(traces:Document[]):Document[][]{
  const groups=new Map<string,Document[]>();
  for(const trace of traces){
    // A capture that includes /new or /clear stays an explicitly labeled mixed
    // record until the UI supports splitting its separately witnessed sections.
    const key=canonicalHash({owner:trace.owner_id,key:trace.agent_capture_id&&trace.native_session_keys?.length===1?trace.native_session_keys[0]:trace.trace_id});
    const group=groups.get(key)??[];group.push(trace);groups.set(key,group);
  }
  return [...groups.values()].map(group=>group.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.trace_id.localeCompare(b.trace_id)));
}

export const groupState=(states:string[])=>states.includes('RECORDING')?'RECORDING':states.includes('INTERRUPTED')?'INTERRUPTED':states.at(-1);
export const groupProjection=(statuses:string[])=>['ERROR','UNREADABLE','PARTIAL','PENDING','READY'].find(s=>statuses.includes(s))??'READY';

export function appendConversationTurns(target:Document[],next:Document[],interiorContext=false){
  if(!next.length)return;
  const old=target.map(canonicalHash),incoming=next.map(canonicalHash);
  let common=0;
  while(common<old.length&&common<incoming.length&&old[common]===incoming[common])common++;
  // After /clear or compaction the repeated context is a suffix of the saved
  // view. Match it in linear time rather than duplicating that history each turn.
  const prefix=new Array(incoming.length).fill(0);
  for(let i=1,j=0;i<incoming.length;i++){while(j&&incoming[i]!==incoming[j])j=prefix[j-1];if(incoming[i]===incoming[j])j++;prefix[i]=j;}
  let overlap=0;
  for(const hash of old){if(overlap===incoming.length)overlap=prefix[overlap-1];while(overlap&&incoming[overlap]!==hash)overlap=prefix[overlap-1];if(incoming[overlap]===hash)overlap++;}
  let skip=Math.max(common,overlap);
  if(interiorContext&&common<old.length&&old.length>=2){
    // Auxiliary requests can interleave with the main thread under one native ID.
    // An exact adjacent pair ending in an assistant turn anchors replayed history
    // even when it is no longer at the end of the accumulated view. Only context
    // is searched; fresh responses are appended by appendCapturedExchange.
    const priorPairs=new Set<string>(),seenPairs=new Set<string>();
    for(let i=1;i<old.length;i++)if(target[i].role==='assistant')priorPairs.add(old[i-1]+':'+old[i]);
    for(let i=1;i<incoming.length;i++)if(next[i].role==='assistant'){
      const pair=incoming[i-1]+':'+incoming[i];
      // Preserve later repeats of an ambiguous pair instead of erasing them.
      if(!seenPairs.has(pair)&&priorPairs.has(pair))skip=Math.max(skip,i+1);
      seenPairs.add(pair);
    }
  }
  target.push(...next.slice(skip));
}

/** Context is replayable; this exchange's actual new outputs are always retained. */
export function appendCapturedExchange(target:Document[],view:{turns:Document[];context_turn_count:number},previousNative:string|null,nextNative:string|null){
  const context=view.turns.slice(0,view.context_turn_count);
  if(previousNative&&nextNative&&previousNative!==nextNative)target.push(...context);
  else appendConversationTurns(target,context,!!previousNative&&previousNative===nextNative);
  target.push(...view.turns.slice(view.context_turn_count));
}
