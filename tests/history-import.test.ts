import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeCodeJsonl, parseCodingSessionJsonl } from '../packages/market/src/history-import.ts';
import type { Document } from '../packages/storage/src/index.ts';

const line=(value:unknown)=>JSON.stringify(value);
const fixture=[
  line({type:'summary',summary:'ignored index metadata',sessionId:'s1'}),
  line({type:'system',subtype:'turn_duration',durationMs:42,sessionId:'s1'}),
  line({type:'user',sessionId:'s1',timestamp:'2026-09-07T10:00:00Z',cwd:'/work/demo',message:{role:'user',content:'Research AAPL'}}),
  line({type:'assistant',sessionId:'s1',timestamp:'2026-09-07T10:01:00Z',message:{role:'assistant',content:[{type:'text',text:'I will inspect it.'},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'notes.txt'}}]}}),
  line({type:'user',sessionId:'s1',timestamp:'2026-09-07T10:02:00Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:[{type:'text',text:'public notes'}]}]}}),
].join('\n');

test('Claude Code JSONL import retains text and tool context while labeling source honestly',()=>{
  const result=parseClaudeCodeJsonl(fixture);
  assert.equal(result.source.kind,'user_supplied'); assert.equal(result.source.format,'claude-code-jsonl');
  assert.equal(result.summary.metadata_records_skipped,2);assert.equal(result.summary.tool_calls,1);assert.equal(result.summary.turns,4);
  assert.deepEqual(result.trace.turns.map(t=>t.role),['user','assistant','assistant','tool']);
  assert.match(result.trace.turns[2]!.content,/Tool use: Read/);assert.match(result.trace.turns[3]!.content,/public notes/);
  assert.equal(result.preview.title,'Claude Code: demo');assert.equal(result.preview.content_commitment.length,64);
  assert.match(result.limitations.join(' '),/does not authenticate/);
});

test('raw-byte and parsed commitments are stable and distinguish changed source bytes',()=>{
  const first=parseClaudeCodeJsonl(fixture), repeated=parseClaudeCodeJsonl(fixture), newline=parseClaudeCodeJsonl(fixture+'\n');
  assert.equal(first.source.source_sha256,repeated.source.source_sha256);assert.equal(first.preview.content_commitment,repeated.preview.content_commitment);
  assert.notEqual(first.source.source_sha256,newline.source.source_sha256);assert.equal(first.preview.content_commitment,newline.preview.content_commitment);
});

test('malformed, mixed-session and unsupported content fail without a partial result',()=>{
  assert.throws(()=>parseClaudeCodeJsonl('{bad'),/MALFORMED_JSONL_LINE_1/);
  assert.throws(()=>parseClaudeCodeJsonl([line({type:'user',sessionId:'a',message:{role:'user',content:'one'}}),line({type:'assistant',sessionId:'b',message:{role:'assistant',content:'two'}})].join('\n')),/MIXED_SESSION/);
  assert.throws(()=>parseClaudeCodeJsonl(line({type:'assistant',message:{role:'assistant',content:[{type:'image',source:{data:'secret'}}]}})),/UNSUPPORTED_CLAUDE_CONTENT/);
  assert.throws(()=>parseClaudeCodeJsonl(line({type:'future-record',payload:'must not vanish'})),/UNSUPPORTED_CLAUDE_RECORD/);
  assert.throws(()=>parseClaudeCodeJsonl(line({type:'system',subtype:'future-context',content:'must not vanish'})),/UNSUPPORTED_CLAUDE_RECORD/);
  assert.throws(()=>parseClaudeCodeJsonl('{"type":"user","type":"assistant","message":{"role":"assistant","content":"ambiguous"}}'),/DUPLICATE_JSON_KEY/);
});

test('parser enforces byte, line, turn and cumulative content bounds',()=>{
  assert.throws(()=>parseClaudeCodeJsonl(fixture,{maxBytes:10}),/IMPORT_TOO_LARGE/);
  assert.throws(()=>parseClaudeCodeJsonl(fixture,{maxLines:2}),/IMPORT_LIMIT_EXCEEDED/);
  assert.throws(()=>parseClaudeCodeJsonl(fixture,{maxTurns:2}),/IMPORT_LIMIT_EXCEEDED/);
  assert.throws(()=>parseClaudeCodeJsonl(fixture,{maxTextBytes:20}),/IMPORT_LIMIT_EXCEEDED/);
});

test('privacy preview flags possible secrets without exposing matches',()=>{
  const result=parseClaudeCodeJsonl(line({type:'user',message:{role:'user',content:'mail a@example.test and token sk-abcdefghijklmnop'}}));
  assert.deepEqual(result.preview.privacy_flags,['possible_email','possible_secret']);
  assert.ok(!JSON.stringify(result.preview).includes('a@example.test'));
});

test('tool reference result blocks retain tool names and reject extra uncommitted fields',()=>{
  const record={type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:[{type:'tool_reference',tool_name:'mcp__browser__read_page'}]}]}};
  assert.match(parseClaudeCodeJsonl(line(record)).trace.turns[0]!.content,/Tool reference: mcp__browser__read_page/);
  (record.message.content[0]!.content[0] as Document).unexpected='discard me';
  assert.throws(()=>parseClaudeCodeJsonl(line(record)),/UNSUPPORTED_CLAUDE_CONTENT/);
});

const codexFixture=[
  line({timestamp:'2026-09-08T10:00:00Z',type:'session_meta',payload:{id:'codex-s1',timestamp:'2026-09-08T10:00:00Z',cwd:'/work/router',originator:'codex_cli_rs'}}),
  line({timestamp:'2026-09-08T10:00:01Z',type:'event_msg',payload:{type:'user_message',message:'Inspect the parser'}}),
  line({timestamp:'2026-09-08T10:00:01Z',type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'synthetic instruction'}]}}),
  line({timestamp:'2026-09-08T10:00:02Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Inspect the parser'}]}}),
  line({timestamp:'2026-09-08T10:00:03Z',type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-1',arguments:'{"cmd":"npm test"}'}}),
  line({timestamp:'2026-09-08T10:00:04Z',type:'response_item',payload:{type:'function_call_output',call_id:'call-1',output:'tests passed'}}),
  line({timestamp:'2026-09-08T10:00:05Z',type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'The parser is sound.'}]}}),
].join('\n');

test('Codex coding-session JSONL auto-detection retains durable conversation and tool records',()=>{
  const result=parseCodingSessionJsonl(codexFixture);
  assert.equal(result.source.format,'codex-jsonl');assert.equal(result.source.session_id,'codex-s1');
  assert.equal(result.preview.format,'Codex coding-session JSONL');assert.equal(result.preview.source_label,'Codex (user supplied)');
  assert.equal(result.preview.title,'Codex: router');assert.equal(result.summary.metadata_records_skipped,2);
  assert.deepEqual(result.trace.turns.map(turn=>turn.role),['developer','user','assistant','tool','assistant']);
  assert.match(result.trace.turns[2]!.content,/exec_command/);assert.match(result.trace.turns[3]!.content,/tests passed/);
  assert.match(result.limitations.join(' '),/does not authenticate/);
});

test('Codex import rejects mixed formats, malformed payloads, and unsupported durable records',()=>{
  assert.throws(()=>parseCodingSessionJsonl(codexFixture+'\n'+fixture),/MIXED_HISTORY_FORMAT/);
  assert.throws(()=>parseCodingSessionJsonl(line({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'input_text',text:'wrong direction'}]}})),/UNSUPPORTED_CODEX_CONTENT/);
  assert.throws(()=>parseCodingSessionJsonl(line({type:'response_item',payload:{type:'future_item',content:'must not vanish'}})),/UNSUPPORTED_CODEX_RECORD/);
  assert.throws(()=>parseCodingSessionJsonl('{"type":"response_item","payload":{"type":"message","type":"future"}}'),/DUPLICATE_JSON_KEY/);
  assert.throws(()=>parseClaudeCodeJsonl(codexFixture),/UNSUPPORTED_CLAUDE_RECORD/);
});

test('imported model names remain explicit unverified claims and missing names stay unknown',()=>{
 const known=parseCodingSessionJsonl(line({type:'assistant',message:{role:'assistant',model:'claude-known-file-claim',content:'Synthetic answer'}}));
 assert.deepEqual(known.model_history,[{sequence:1,claimed_model:'claude-known-file-claim',evidence:'user_supplied'}]);
 assert.deepEqual(parseCodingSessionJsonl(fixture).model_history,[]);
});
