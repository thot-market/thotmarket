import { createHash } from 'node:crypto';
import { canonicalHash, canonicalJson } from '../../protocol/src/index.ts';
import { DomainError, ensure, type Document } from '../../storage/src/index.ts';

export type CodingSessionFormat='claude-code-jsonl'|'codex-jsonl';
export interface HistoryImportOptions { maxBytes?:number;maxLines?:number;maxTurns?:number;maxTextBytes?:number;maxTurnChars?:number;maxToolPayloadBytes?:number;maxCanonicalTraceBytes?:number; }
export interface CodingSessionHistoryImport {
  schema_version:'thot.coding-session-history-import/1';
  source:{kind:'user_supplied';format:CodingSessionFormat;session_id?:string;source_bytes:number;source_sha256:string};
  trace:{turns:Array<{role:'system'|'developer'|'user'|'assistant'|'tool';content:string}>};
  summary:{records:number;metadata_records_skipped:number;turns:number;tool_calls:number;started_at?:string;ended_at?:string};
  preview:{title:string;format:string;source_label:string;source_date?:string;size_bytes:number;turn_count:number;content_commitment:string;privacy_flags:string[]};
  model_history:Array<{sequence:number;claimed_model:string;evidence:'user_supplied'}>;
  limitations:string[];
}
export type ClaudeHistoryImportOptions=HistoryImportOptions;
export type ClaudeHistoryImport=CodingSessionHistoryImport;

const DEFAULTS={maxBytes:2_000_000,maxLines:10_000,maxTurns:1_000,maxTextBytes:1_900_000,maxTurnChars:100_000,maxToolPayloadBytes:100_000,maxCanonicalTraceBytes:2_000_000};
const CLAUDE_SKIPPED=new Set(['summary','file-history-snapshot','queue-operation','progress','ai-title','atis-latch','attachment','bridge-session','cost-state','last-prompt','mode','permission-mode']);
const CLAUDE_SYSTEM_SKIPPED=new Set(['turn_duration','compact_boundary','api_error','away_summary']);
const fail=(code:string):never=>{throw new DomainError(code);};
const plain=(value:unknown):value is Document=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value:unknown,code:string,limit:number)=>{ensure(typeof value==='string',code);ensure(Buffer.byteLength(value)<=limit,'IMPORT_LIMIT_EXCEEDED');return value;};

/** JSON.parse accepts duplicate keys. Reject them so commitments stay unambiguous. */
function rejectDuplicateJsonKeys(source:string):void {
  let offset=0;const whitespace=()=>{while(/\s/.test(source[offset]??''))offset++;};
  const string=():string=>{const start=offset++;while(offset<source.length){if(source[offset]==='\\'){offset+=2;continue;}if(source[offset++]==='"')return JSON.parse(source.slice(start,offset));}return fail('MALFORMED_JSONL');};
  const value=():void=>{whitespace();const char=source[offset];if(char==='"'){string();return;}if(char==='{'){object();return;}if(char==='['){array();return;}while(offset<source.length&&!/[\s,}\]]/.test(source[offset]!))offset++;};
  const object=():void=>{offset++;whitespace();const keys=new Set<string>();if(source[offset]==='}'){offset++;return;}for(;;){ensure(source[offset]==='"','MALFORMED_JSONL');const key=string();ensure(!keys.has(key),'DUPLICATE_JSON_KEY');keys.add(key);whitespace();ensure(source[offset++]===':','MALFORMED_JSONL');value();whitespace();if(source[offset]==='}'){offset++;return;}ensure(source[offset++ ]===',','MALFORMED_JSONL');whitespace();}};
  const array=():void=>{offset++;whitespace();if(source[offset]===']'){offset++;return;}for(;;){value();whitespace();if(source[offset]===']'){offset++;return;}ensure(source[offset++ ]===',','MALFORMED_JSONL');whitespace();}};
  value();whitespace();ensure(offset===source.length,'MALFORMED_JSONL');
}

function toolResultText(value:unknown,limit:number,code:string):string {
  if(typeof value==='string')return bounded(value,code,limit);
  ensure(Array.isArray(value),code);return value.map(block=>{ensure(plain(block),code);if(block.type==='text')return bounded(block.text,code,limit);if(block.type==='tool_reference'){ensure(typeof block.tool_name==='string'&&block.tool_name.length>0&&block.tool_name.length<=200&&Object.keys(block).every(key=>['type','tool_name'].includes(key)),code);return `[Tool reference: ${block.tool_name}]`;}return fail(code);}).join('\n');
}

type ParsedRecord={turns:Array<{role:'system'|'developer'|'user'|'assistant'|'tool';content:string;toolCall?:boolean}>;skipped:boolean;sessionId?:string;timestamp?:string;project?:string};
function claudeRecord(record:Document,limits:typeof DEFAULTS):ParsedRecord {
  const sessionId=typeof record.sessionId==='string'?record.sessionId:undefined,timestamp=typeof record.timestamp==='string'?record.timestamp:undefined,project=typeof record.cwd==='string'?record.cwd.split(/[\\/]/).filter(Boolean).at(-1):undefined;
  if(CLAUDE_SKIPPED.has(String(record.type))||record.isMeta===true||(record.type==='system'&&CLAUDE_SYSTEM_SKIPPED.has(String(record.subtype))))return {turns:[],skipped:true,sessionId,timestamp,project};
  ensure(record.type==='user'||record.type==='assistant','UNSUPPORTED_CLAUDE_RECORD');const message=record.message;
  ensure(plain(message)&&message.role===record.type,'UNSUPPORTED_CLAUDE_RECORD');const role=message.role as 'user'|'assistant';
  if(typeof message.content==='string')return {turns:[{role,content:bounded(message.content,'UNSUPPORTED_CLAUDE_CONTENT',limits.maxTextBytes)}],skipped:false,sessionId,timestamp,project};
  ensure(Array.isArray(message.content),'UNSUPPORTED_CLAUDE_CONTENT');const turns:ParsedRecord['turns']=[];let text:string[]=[];const flush=()=>{if(text.length){turns.push({role,content:text.join('\n\n')});text=[];}};
  for(const block of message.content){ensure(plain(block)&&typeof block.type==='string','UNSUPPORTED_CLAUDE_CONTENT');if(block.type==='text')text.push(bounded(block.text,'UNSUPPORTED_CLAUDE_CONTENT',limits.maxTextBytes));else if(block.type==='thinking')text.push('[Thinking]\n'+bounded(block.thinking,'UNSUPPORTED_CLAUDE_CONTENT',limits.maxTextBytes));else if(block.type==='tool_use'){flush();ensure(role==='assistant'&&typeof block.name==='string'&&block.name.length>0&&block.name.length<=200&&typeof block.id==='string','UNSUPPORTED_CLAUDE_CONTENT');let encoded:string;try{encoded=canonicalJson(block.input);}catch{return fail('UNSUPPORTED_CLAUDE_CONTENT');}ensure(Buffer.byteLength(encoded)<=limits.maxToolPayloadBytes,'IMPORT_LIMIT_EXCEEDED');turns.push({role:'assistant',content:`[Tool use: ${block.name}; id=${block.id}]\n${encoded}`,toolCall:true});}else if(block.type==='tool_result'){flush();ensure(role==='user'&&typeof block.tool_use_id==='string','UNSUPPORTED_CLAUDE_CONTENT');turns.push({role:'tool',content:`[Tool result: id=${block.tool_use_id}${block.is_error===true?'; error=true':''}]\n${toolResultText(block.content,limits.maxToolPayloadBytes,'UNSUPPORTED_CLAUDE_CONTENT')}`});}else fail('UNSUPPORTED_CLAUDE_CONTENT');}
  flush();return {turns,skipped:false,sessionId,timestamp,project};
}

function codexText(content:unknown,role:'system'|'developer'|'user'|'assistant',limit:number):string {
  ensure(Array.isArray(content),'UNSUPPORTED_CODEX_CONTENT');const expected=role==='assistant'?'output_text':'input_text';return content.map(block=>{ensure(plain(block)&&block.type===expected&&Object.keys(block).every(k=>['type','text'].includes(k)),'UNSUPPORTED_CODEX_CONTENT');return bounded(block.text,'UNSUPPORTED_CODEX_CONTENT',limit);}).join('\n\n');
}
function codexRecord(record:Document,limits:typeof DEFAULTS):ParsedRecord {
  ensure(typeof record.type==='string'&&plain(record.payload),'UNSUPPORTED_CODEX_RECORD');const payload=record.payload,timestamp=typeof record.timestamp==='string'?record.timestamp:undefined;
  if(record.type==='session_meta'){ensure(typeof payload.id==='string'&&payload.id.length>0,'UNSUPPORTED_CODEX_RECORD');const project=typeof payload.cwd==='string'?payload.cwd.split(/[\\/]/).filter(Boolean).at(-1):undefined;return {turns:[],skipped:true,sessionId:payload.id,project,timestamp:typeof payload.timestamp==='string'?payload.timestamp:timestamp};}
  if(record.type==='event_msg'||record.type==='turn_context')return {turns:[],skipped:true,timestamp};
  ensure(record.type==='response_item'&&typeof payload.type==='string','UNSUPPORTED_CODEX_RECORD');
  if(payload.type==='message'){
    ensure(['system','developer','user','assistant'].includes(payload.role),'UNSUPPORTED_CODEX_CONTENT');const role=payload.role as 'system'|'developer'|'user'|'assistant';return {turns:[{role,content:codexText(payload.content,role,limits.maxTextBytes)}],skipped:false,timestamp};
  }
  if(payload.type==='function_call'){ensure(typeof payload.name==='string'&&payload.name.length>0&&payload.name.length<=200&&typeof payload.call_id==='string','UNSUPPORTED_CODEX_CONTENT');const args=bounded(payload.arguments,'UNSUPPORTED_CODEX_CONTENT',limits.maxToolPayloadBytes);let encoded:string;try{encoded=canonicalJson(JSON.parse(args));}catch{return fail('UNSUPPORTED_CODEX_CONTENT');}return {turns:[{role:'assistant',content:`[Tool use: ${payload.name}; id=${payload.call_id}]\n${encoded}`,toolCall:true}],skipped:false,timestamp};}
  if(payload.type==='function_call_output'){ensure(typeof payload.call_id==='string','UNSUPPORTED_CODEX_CONTENT');return {turns:[{role:'tool',content:`[Tool result: id=${payload.call_id}]\n${bounded(payload.output,'UNSUPPORTED_CODEX_CONTENT',limits.maxToolPayloadBytes)}`}],skipped:false,timestamp};}
  if(payload.type==='reasoning'&&payload.encrypted_content!=null)return {turns:[],skipped:true,timestamp};
  return fail('UNSUPPORTED_CODEX_RECORD');
}

function detect(first:Document):CodingSessionFormat {
  if(first.type==='session_meta'||first.type==='response_item'||first.type==='event_msg'||first.type==='turn_context')return 'codex-jsonl';
  if(typeof first.type==='string'&&(plain(first.message)||CLAUDE_SKIPPED.has(first.type)||first.type==='system'))return 'claude-code-jsonl';
  return fail('UNSUPPORTED_HISTORY_FORMAT');
}

/** Strict, bounded, auto-detecting parser for one user-supplied coding-session JSONL file. */
export function parseCodingSessionJsonl(input:string|Buffer,options:HistoryImportOptions={}):CodingSessionHistoryImport {
  const limits={...DEFAULTS,...options};for(const value of Object.values(limits))ensure(Number.isSafeInteger(value)&&value>0,'INVALID_IMPORT_LIMITS');
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input,'utf8');ensure(bytes.length>0,'EMPTY_IMPORT');ensure(bytes.length<=limits.maxBytes,'IMPORT_TOO_LARGE');const text=bytes.toString('utf8');ensure(Buffer.from(text,'utf8').equals(bytes),'INVALID_UTF8');
  const lines=text.split(/\r?\n/);ensure(lines.length<=limits.maxLines+1,'IMPORT_LIMIT_EXCEEDED');let format:CodingSessionFormat|undefined;const turns:CodingSessionHistoryImport['trace']['turns']=[];let records=0,skipped=0,toolCalls=0,totalText=0;const sessions=new Set<string>(),timestamps:string[]=[],models:CodingSessionHistoryImport['model_history']=[];let project:string|undefined;
  for(let i=0;i<lines.length;i++){const line=lines[i]!;if(!line.trim())continue;records++;let record:unknown;try{rejectDuplicateJsonKeys(line);record=JSON.parse(line);}catch(error){if(error instanceof DomainError&&error.code==='DUPLICATE_JSON_KEY')throw error;fail(`MALFORMED_JSONL_LINE_${i+1}`);}ensure(plain(record),'UNSUPPORTED_HISTORY_RECORD');format??=detect(record);ensure(detect(record)===format,'MIXED_HISTORY_FORMAT');const claimed=record.message?.model??record.payload?.model;if(typeof claimed==='string'&&claimed.length>0&&claimed.length<=200&&!/[\u0000-\u001f\u007f]/.test(claimed)&&models.at(-1)?.claimed_model!==claimed)models.push({sequence:records,claimed_model:claimed,evidence:'user_supplied'});const parsed=format==='codex-jsonl'?codexRecord(record,limits):claudeRecord(record,limits);if(parsed.sessionId)sessions.add(parsed.sessionId);if(parsed.timestamp){ensure(Number.isFinite(Date.parse(parsed.timestamp)),format==='codex-jsonl'?'INVALID_CODEX_TIMESTAMP':'INVALID_CLAUDE_TIMESTAMP');timestamps.push(new Date(parsed.timestamp).toISOString());}project??=parsed.project;if(parsed.skipped)skipped++;for(const turn of parsed.turns){ensure(turn.content.length<=limits.maxTurnChars,'IMPORT_LIMIT_EXCEEDED');totalText+=Buffer.byteLength(turn.content);ensure(totalText<=limits.maxTextBytes,'IMPORT_LIMIT_EXCEEDED');turns.push({role:turn.role,content:turn.content});if(turn.toolCall)toolCalls++;}ensure(turns.length<=limits.maxTurns,'IMPORT_LIMIT_EXCEEDED');}
  ensure(records>0&&format&&turns.length>0,'EMPTY_IMPORT');ensure(sessions.size<=1,'MIXED_SESSION');timestamps.sort();const trace={turns};ensure(Buffer.byteLength(canonicalJson(trace))<=limits.maxCanonicalTraceBytes,'IMPORT_LIMIT_EXCEEDED');const sourceDate=timestamps[0],provider=format==='codex-jsonl'?'Codex':'Claude Code';const privacyFlags=[/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)?'possible_email':undefined,/\b(?:sk-|gh[pousr]_)/.test(text)?'possible_secret':undefined].filter((x):x is string=>!!x);
  return {schema_version:'thot.coding-session-history-import/1',source:{kind:'user_supplied',format,...(sessions.size?{session_id:[...sessions][0]}:{}),source_bytes:bytes.length,source_sha256:createHash('sha256').update(bytes).digest('hex')},trace,model_history:models,summary:{records,metadata_records_skipped:skipped,turns:turns.length,tool_calls:toolCalls,...(sourceDate?{started_at:sourceDate,ended_at:timestamps.at(-1)}:{})},preview:{title:project?`${provider}: ${project}`:`${provider} session`,format:format==='codex-jsonl'?'Codex coding-session JSONL':'Claude Code JSONL',source_label:`${provider} (user supplied)`,...(sourceDate?{source_date:sourceDate}:{}),size_bytes:bytes.length,turn_count:turns.length,content_commitment:canonicalHash(trace),privacy_flags:privacyFlags},limitations:['User-supplied history: this receipt commits to imported bytes and parsed content but does not authenticate the conversation or provider.',format==='codex-jsonl'?'Codex session metadata, event telemetry, token counts and encrypted reasoning are omitted; system/developer instructions, supported user/assistant text and function calls/results are retained. Model names in this file are unverified user-supplied claims.':'Claude Code application metadata records (including snapshots, UI state, permission state and attachment metadata) are omitted; supported message text, thinking, tool calls and text/tool-reference results are retained.']};
}

export function parseClaudeCodeJsonl(input:string|Buffer,options:ClaudeHistoryImportOptions={}):ClaudeHistoryImport {
  try {const parsed=parseCodingSessionJsonl(input,options);ensure(parsed.source.format==='claude-code-jsonl','UNSUPPORTED_CLAUDE_RECORD');return parsed;}
  catch(error){if(error instanceof DomainError&&error.code==='UNSUPPORTED_HISTORY_FORMAT')fail('UNSUPPORTED_CLAUDE_RECORD');throw error;}
}
