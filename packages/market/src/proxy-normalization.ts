import { canonicalJson } from '../../protocol/src/index.ts';
import { ensure, type Document } from '../../storage/src/index.ts';

const plain=(v:unknown):v is Document=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bounded=(v:unknown,code:string)=>{ensure(typeof v==='string'&&Buffer.byteLength(v)<=8_000_000,code);return v;};
const json=(bytes:Buffer,code:string):Document=>{let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new Error(code);}ensure(plain(value),code);return value;};
function textParts(value:unknown,issues?:Document[]):string {
  if(typeof value==='string')return value;
  if(!Array.isArray(value)&&issues){issues.push({type:'unrecognized_content'});return '[Content not displayed; retained in original recording]';}
  ensure(Array.isArray(value),'UNSUPPORTED_PROXY_CONTENT');
  return value.map((part:any)=>{
    try{
    ensure(plain(part)&&typeof part.type==='string','UNSUPPORTED_PROXY_CONTENT');
    if(['text','input_text','output_text'].includes(part.type))return bounded(part.text,'UNSUPPORTED_PROXY_CONTENT');
    if(part.type==='tool_use'||part.type==='server_tool_use')return `[${part.type==='server_tool_use'?'Server tool':'Tool'} use: ${bounded(part.name,'UNSUPPORTED_PROXY_CONTENT')}; id=${bounded(part.id,'UNSUPPORTED_PROXY_CONTENT')}]\n${canonicalJson(part.input??{})}`;
    if(part.type==='tool_result')return `[Tool result: id=${bounded(part.tool_use_id,'UNSUPPORTED_PROXY_CONTENT')}${part.is_error===true?'; error=true':''}]\n${textParts(part.content,issues)}`;
    if(part.type==='tool_reference')return `[Discovered tool: ${bounded(part.tool_name,'UNSUPPORTED_PROXY_CONTENT')}]`;
    if(part.type==='web_search_tool_result')return `[Web search result: id=${bounded(part.tool_use_id,'UNSUPPORTED_PROXY_CONTENT')}]\n${textParts(Array.isArray(part.content)?part.content:[part.content],issues)}`;
    if(part.type==='web_search_result')return `${bounded(part.title,'UNSUPPORTED_PROXY_CONTENT')}\n${bounded(part.url,'UNSUPPORTED_PROXY_CONTENT')}`;
    if(part.type==='web_search_tool_result_error'||part.type==='tool_search_tool_result_error')return `[Tool error: ${bounded(part.error_code,'UNSUPPORTED_PROXY_CONTENT')}]`;
    if(part.type==='tool_search_tool_result')return `[Tool search result: id=${bounded(part.tool_use_id,'UNSUPPORTED_PROXY_CONTENT')}]\n${textParts([part.content],issues)}`;
    if(part.type==='tool_search_tool_search_result')return textParts(part.tool_references,issues);
    if(part.type==='input_image'||part.type==='image')return '[Image omitted]';
    if(part.type==='document'||part.type==='input_file')return '[Document attachment retained in original evidence]';
    // Hidden thinking/signatures/encrypted reasoning are deliberately absent.
    if(['thinking','redacted_thinking','reasoning'].includes(part.type))return '';
    throw new Error('UNSUPPORTED_PROXY_CONTENT');
    }catch(error){if(!issues)throw error;const type=typeof part?.type==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(part.type)?part.type:'unrecognized_content';issues.push({type});return '[Content not displayed: '+type+'; retained in original recording]';}
  }).filter(Boolean).join('\n');
}
function sse(bytes:Buffer):Document[] {
  const out:Document[]=[];
  for(const line of bytes.toString('utf8').split(/\r?\n/))if(line.startsWith('data:')){
    const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;
    try{const value=JSON.parse(data);if(plain(value))out.push(value);}catch{throw new Error('INVALID_PROXY_SSE');}
  }
  return out;
}
function claude(request:Document,responseBytes:Buffer,issues?:Document[]) {
  ensure(Array.isArray(request.messages)&&request.messages.length>0,'UNSUPPORTED_CLAUDE_REQUEST');
  const turns:Document[]=[];
  for(const message of request.messages){ensure(plain(message)&&['user','assistant','system','developer'].includes(message.role),'UNSUPPORTED_CLAUDE_REQUEST');const content=textParts(message.content,issues);if(content)turns.push({role:message.role,content});}
  const context_turn_count=turns.length;
  let response:Document|undefined,events:Document[]=[];try{response=json(responseBytes,'INVALID_CLAUDE_RESPONSE');}catch{events=sse(responseBytes);}
  let assistant='',stopped=false;
  if(response){ensure(response.type==='message'&&Array.isArray(response.content),'INVALID_CLAUDE_RESPONSE');assistant=textParts(response.content,issues);stopped=typeof response.stop_reason==='string';}
  else{
    // Render streaming blocks through the same path as replayed request history.
    // Preserve block order, initial text, and canonical tool arguments.
    const blocks:Document[]=[],indexed=new Map<number,Document>();let active:Document|undefined;
    for(const event of events){
      if(event.type==='content_block_start'){
        ensure(plain(event.content_block),'INVALID_CLAUDE_RESPONSE');active={...event.content_block};blocks.push(active);
        if(event.index!==undefined){ensure(Number.isSafeInteger(event.index)&&event.index>=0&&!indexed.has(event.index),'INVALID_CLAUDE_RESPONSE');indexed.set(event.index,active);}
      }
      if(event.type==='content_block_delta'){
        let block=event.index===undefined?active:indexed.get(event.index);
        if(event.delta?.type==='text_delta'){
          if(!block){block={type:'text',text:''};blocks.push(block);active=block;if(event.index!==undefined)indexed.set(event.index,block);}
          ensure(block.type==='text','INVALID_CLAUDE_RESPONSE');block.text=bounded(block.text??'','INVALID_CLAUDE_RESPONSE')+bounded(event.delta.text,'INVALID_CLAUDE_RESPONSE');
        }
        if(event.delta?.type==='input_json_delta'){
          ensure(block&&['tool_use','server_tool_use'].includes(block.type),'INVALID_CLAUDE_RESPONSE');block.partial_json=(block.partial_json??'')+bounded(event.delta.partial_json,'INVALID_CLAUDE_RESPONSE');
        }
      }
      if(event.type==='message_stop')stopped=true;
    }
    for(const block of blocks)if(block.partial_json){try{block.input=JSON.parse(block.partial_json);}catch{throw Error('INVALID_CLAUDE_TOOL_ARGUMENTS');}}
    assistant=textParts(blocks,issues);
  }
  ensure(stopped,'INCOMPLETE_PROXY_RESPONSE',409);if(assistant)turns.push({role:'assistant',content:assistant});
  ensure(turns.some(t=>t.role==='assistant'),'EMPTY_PROXY_RESPONSE');return {turns,context_turn_count};
}
function compactionBoundary(item:Document):string {
  if(item.type==='compaction_trigger')return '[Capture boundary: context compaction requested]';
  // This is opaque provider state, not recoverable text or a new model answer.
  bounded(item.id,'INVALID_CODEX_COMPACTION');bounded(item.encrypted_content,'INVALID_CODEX_COMPACTION');
  return '[Capture boundary: earlier context compacted; encrypted provider state retained in original recording]';
}
function codex(request:Document,responseBytes:Buffer,issues?:Document[]) {
  const input=request.input;ensure(typeof input==='string'||Array.isArray(input),'UNSUPPORTED_CODEX_REQUEST');
  const turns:Document[]=[];
  if(typeof input==='string')turns.push({role:'user',content:input});else for(const item of input){
    ensure(plain(item)&&typeof item.type==='string','UNSUPPORTED_CODEX_REQUEST');
    if(item.type==='additional_tools'){ensure(item.role==='developer'&&Array.isArray(item.tools),'UNSUPPORTED_CODEX_REQUEST');turns.push({role:'developer',content:'[Additional tool definitions]\n'+canonicalJson(item.tools)});continue;}
    if(item.type==='message'){ensure(['system','developer','user','assistant'].includes(item.role),'UNSUPPORTED_CODEX_REQUEST');const content=textParts(item.content,issues);if(content)turns.push({role:item.role,content});}
    else if(item.type==='function_call_output')turns.push({role:'tool',content:`[Tool result: id=${item.call_id}]\n${bounded(item.output,'UNSUPPORTED_CODEX_REQUEST')}`});
    else if(item.type==='function_call')turns.push({role:'assistant',content:`[Tool use: ${item.name}; id=${item.call_id}]\n${typeof item.arguments==='string'?item.arguments:canonicalJson(item.arguments)}`});
    else if(item.type==='custom_tool_call')turns.push({role:'assistant',content:`[Tool use: ${bounded(item.name,'UNSUPPORTED_CODEX_REQUEST')}; id=${bounded(item.call_id,'UNSUPPORTED_CODEX_REQUEST')}]\n${typeof item.input==='string'?bounded(item.input,'UNSUPPORTED_CODEX_REQUEST'):canonicalJson(item.input)}`});
    else if(item.type==='custom_tool_call_output')turns.push({role:'tool',content:`[Tool result: id=${bounded(item.call_id,'UNSUPPORTED_CODEX_REQUEST')}]\n${typeof item.output==='string'?bounded(item.output,'UNSUPPORTED_CODEX_REQUEST'):textParts(item.output,issues)}`});
    else if(['compaction_trigger','compaction'].includes(item.type))turns.push({role:'assistant',content:compactionBoundary(item)});
    else if(item.type==='reasoning')continue;
    else if(issues){issues.push({type:/^[a-zA-Z0-9_-]{1,80}$/.test(item.type)?item.type:'unrecognized_item'});}
    else throw new Error('UNSUPPORTED_CODEX_REQUEST');
  }
  const context_turn_count=turns.length;
  let response:Document|undefined,events:Document[]=[];try{response=json(responseBytes,'INVALID_CODEX_RESPONSE');}catch{events=sse(responseBytes);}
  const outputs:Document[]=response&&Array.isArray(response.output)?response.output:events.filter(e=>e.type==='response.output_item.done').map(e=>e.item);
  // A response can contain several output items; the next request replays them
  // separately. Keeping those boundaries prevents history from multiplying.
  for(const item of outputs){
    ensure(plain(item)&&typeof item.type==='string','INVALID_CODEX_RESPONSE');let role='assistant',content='';
    if(item.type==='message')content=textParts(item.content,issues);
    else if(item.type==='function_call')content=`[Tool use: ${item.name}; id=${item.call_id}]\n${item.arguments??'{}'}`;
    else if(item.type==='custom_tool_call')content=`[Tool use: ${bounded(item.name,'INVALID_CODEX_RESPONSE')}; id=${bounded(item.call_id,'INVALID_CODEX_RESPONSE')}]\n${typeof item.input==='string'?bounded(item.input,'INVALID_CODEX_RESPONSE'):canonicalJson(item.input)}`;
    else if(item.type==='custom_tool_call_output'){role='tool';content=`[Tool result: id=${bounded(item.call_id,'INVALID_CODEX_RESPONSE')}]\n${typeof item.output==='string'?bounded(item.output,'INVALID_CODEX_RESPONSE'):textParts(item.output,issues)}`;}
    else if(['compaction_trigger','compaction'].includes(item.type))content=compactionBoundary(item);
    else if(item.type==='reasoning')continue;
    else if(issues){issues.push({type:/^[a-zA-Z0-9_-]{1,80}$/.test(item.type)?item.type:'unrecognized_output'});content='[Output not displayed; retained in original recording]';}
    else throw new Error('UNSUPPORTED_CODEX_RESPONSE');
    if(content)turns.push({role,content});
  }
  if(!response&&outputs.length===0){let assistant='';for(const event of events)if(event.type==='response.output_text.delta')assistant+=bounded(event.delta,'INVALID_CODEX_RESPONSE');if(assistant)turns.push({role:'assistant',content:assistant});}
  const done=response?response.status==='completed':events.some(e=>e.type==='response.completed');ensure(done,'INCOMPLETE_PROXY_RESPONSE',409);
  ensure(turns.some(t=>t.role==='assistant'),'EMPTY_PROXY_RESPONSE');return {turns,context_turn_count};
}

export function normalizeProxyExchange(client:'codex'|'claude',requestBytes:Buffer,responseBytes:Buffer) {
  const request=json(requestBytes,'INVALID_PROXY_REQUEST');return {turns:(client==='claude'?claude(request,responseBytes):codex(request,responseBytes)).turns};
}

/** Preserve readable portions without guessing the meaning of unfamiliar blocks. */
export function projectProxyExchange(client:'codex'|'claude',requestBytes:Buffer,responseBytes:Buffer){
  const issues:Document[]=[],request=json(requestBytes,'INVALID_PROXY_REQUEST');
  const result=client==='claude'?claude(request,responseBytes,issues):codex(request,responseBytes,issues);
  return {...result,issues};
}

/** Requested aliases are not evidence of the model that returned a completion. */
export function proxyModelIdentity(client:'codex'|'claude',requestBytes:Buffer,responseBytes:Buffer){
  const request=json(requestBytes,'INVALID_PROXY_REQUEST');
  const safe=(value:unknown):string|null=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
  let returned:string|null=null;
  try{returned=safe(json(responseBytes,'INVALID_PROXY_RESPONSE').model);}catch{
    for(const event of sse(responseBytes)){const known=safe(event.response?.model)??safe(event.message?.model)??safe(event.model);if(known)returned=known;}
  }
  return {source:client,requested_model:safe(request.model),returned_model:returned,provider_name:null};
}
