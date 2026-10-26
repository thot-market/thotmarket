import {isResearch,validateResearchPackage} from '../content/src/research.ts';
import {redactCredentialSpans} from '../scrubber/src/index.ts';
import { createHash } from 'node:crypto';
import { canonicalJson, QC_LIMITS, QcInputError } from './canonical.ts';
import { classifyToolResult } from './vendor/data-juicer-tool-result.ts';
import type { QcCheck, QcFinding, QcScope, QcStatus, TraceContent, TraceQcReport, TraceTurn } from './types.ts';
export { canonicalJson, contentDigest, QC_LIMITS, QcInputError } from './canonical.ts';
export type * from './types.ts';
export { runSemanticQc } from './semantic.ts';
export type { SemanticQcProvider, SemanticQcRequest, SemanticQcOptions, SemanticQcResult, SemanticEvidence } from './semantic.ts';
export const QC_POLICY_VERSION = 'trace-qc-2026-10-18.1';

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function validTurn(value: unknown): value is TraceTurn {
  if (!isRecord(value) || typeof value.role !== 'string' || !ROLES.has(value.role) || typeof value.content !== 'string') return false;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 256)) return false;
  if (value.tool_call_id !== undefined && (typeof value.tool_call_id !== 'string' || !value.tool_call_id || value.tool_call_id.length > 256)) return false;
  if (value.tool_calls !== undefined) {
    if (value.role !== 'assistant' || !Array.isArray(value.tool_calls) || value.tool_calls.length > 128) return false;
    for (const call of value.tool_calls) {
      if (!isRecord(call) || typeof call.id !== 'string' || !call.id || call.id.length > 256 || !isRecord(call.function) || typeof call.function.name !== 'string' || !call.function.name || call.function.name.length > 256) return false;
      if (call.type !== undefined && call.type !== 'function') return false;
      if (call.function.arguments !== undefined && typeof call.function.arguments !== 'string' && !isRecord(call.function.arguments)) return false;
    }
  }
  return true;
}

/** Strictly validated content; does not execute trace text, tools or instructions. */
export function parseTraceContent(content: unknown): TraceContent | null {
  if (!isRecord(content) || !Array.isArray(content.turns) || !content.turns.length || content.turns.length > QC_LIMITS.max_turns || !content.turns.every(validTurn)) return null;
  return content as unknown as TraceContent;
}

// Strong credential-shaped signals, not verification of live credentials or an exhaustive scrubber.
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:sk_live_|rk_live_)[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)\s{0,16}["']?\s{0,16}[:=]\s{0,16}["']?\s{0,16}[A-Za-z0-9_./+=-]{24,}/i,
  /\bauthorization\s{0,16}["']?\s{0,16}[:=]\s{0,16}["']?\s{0,16}bearer\s{1,16}[A-Za-z0-9_./+=-]{24,}/i,
];

export function runTraceQc(content: unknown, options: { scope: QcScope }): TraceQcReport {
  const scope = options?.scope === 'release' ? 'release' : 'private';
  const report: TraceQcReport = {
    schema_version: 'trace-qc/v1', policy_version: QC_POLICY_VERSION, content_digest: null,
    scope, status: 'error', summary: 'Checks could not assess this input.', findings: [], checks: [],
    coverage: { total_turns: 0, evaluated_turns: 0, truncated: false },
    semantic: { status: 'not_run', reason: 'provider_not_supplied' }, limits: { ...QC_LIMITS },
  };
  if (options?.scope !== 'private' && options?.scope !== 'release') return report;
  let encoded: string;
  try {
    encoded = canonicalJson(content);
    report.content_digest = createHash('sha256').update(encoded).digest('hex');
  } catch (error) {
    report.checks.push({ id: error instanceof QcInputError ? error.code : 'invalid_json', status: 'error', evaluated_turns: [], total_turns: 0 });
    return report;
  }
  if(isResearch(content)){
    report.content_kind='research';
    let p;try{p=validateResearchPackage(content);}catch{report.status='reject';report.summary='Research package structure or file commitments are invalid.';report.findings.push({code:'invalid_package_structure',severity:'reject',message:'Check the supported manifest, files, references and hashes.',turn_indices:[],occurrence_count:1});return report;}
    const files=p.files.map(f=>f.path),sensitive=p.files.filter(f=>typeof f.text==='string'&&(redactCredentialSpans(f.text).count>0||SECRET_PATTERNS.some(rule=>rule.test(f.text!)))).map(f=>f.path);
    report.coverage={total_turns:0,evaluated_turns:0,truncated:false,total_files:files.length,evaluated_files:files.length,files:files.map(path=>({path,checks:['file_inventory','sensitive_content'],status:'checked'}))};
    report.checks=[{id:'file_inventory',status:'pass',evaluated_turns:[],evaluated_files:files,total_turns:0},{id:'sensitive_content',status:sensitive.length?(scope==='release'?'reject':'flag'):'pass',evaluated_turns:[],evaluated_files:files,total_turns:0},{id:'research_correctness',status:'not_run',evaluated_turns:[],evaluated_files:[],total_turns:0},{id:'code_execution',status:'not_run',evaluated_turns:[],evaluated_files:[],total_turns:0}];
    if(sensitive.length)report.findings.push({code:'credential_pattern',severity:scope==='release'?'reject':'flag',message:'Credential-shaped material requires private review and removal before release.',turn_indices:[],file_paths:sensitive,occurrence_count:sensitive.length});
    report.status=sensitive.length?(scope==='release'?'reject':'flag'):'pass';report.summary='File inventory and local sensitive-pattern checks only. Research completeness, truth, rights, code execution and source authenticity are not established.';return report;
  }
  if (isRecord(content) && Array.isArray(content.turns) && content.turns.length > QC_LIMITS.max_turns) {
    report.checks.push({ id: 'input_limit_exceeded', status: 'error', evaluated_turns: [], total_turns: content.turns.length });
    return report;
  }
  const trace = parseTraceContent(content);
  if (!trace) {
    report.status = 'reject'; report.summary = 'The input does not have the supported trace structure.';
    report.findings.push({ code: 'invalid_trace_structure', severity: 'reject', message: 'Use a nonempty turns array with supported roles, text content and valid tool-call fields.', turn_indices: [], occurrence_count: 1 });
    report.checks.push({ id: 'structure', status: 'reject', evaluated_turns: [], total_turns: 0 });
    return report;
  }
  const turns = trace.turns, all = turns.map((_, i) => i);
  report.coverage = { total_turns: turns.length, evaluated_turns: turns.length, truncated: false };
  const finding = (code: string, message: string, indices: number[], severity: QcFinding['severity'] = 'flag') => {
    const existing = report.findings.find(item => item.code === code);
    if (existing) {
      existing.occurrence_count++;
      existing.turn_indices = [...new Set([...existing.turn_indices, ...indices])].slice(0, 32);
    } else if (report.findings.length < QC_LIMITS.max_findings) report.findings.push({ code, severity, message, turn_indices: indices.slice(0, 32), occurrence_count: 1 });
  };
  const check = (id: string, evaluated: number[], codes: string[]) => {
    const findings = report.findings.filter(item => codes.includes(item.code));
    const status: QcCheck['status'] = !evaluated.length ? 'not_applicable' : findings.some(item => item.severity === 'reject') ? 'reject' : findings.some(item => item.severity === 'flag') ? 'flag' : 'pass';
    report.checks.push({ id, status, evaluated_turns: evaluated, total_turns: turns.length });
  };
  turns.forEach((turn, i) => { if (!turn.content.trim() && !turn.tool_calls?.length) finding('empty_turn', 'A captured turn has no text or structured tool calls.', [i]); });
  check('structure', all, ['empty_turn']);

  const calls = new Map<string, number>(), resolved = new Set<string>(), toolIndices: number[] = [], linkIndices: number[] = [];
  turns.forEach((turn, i) => {
    if (turn.tool_calls?.length) {
      linkIndices.push(i);
      for (const call of turn.tool_calls) {
        if (calls.has(call.id)) finding('duplicate_tool_call_id', 'A tool-call identifier is reused, so result linkage is ambiguous.', [calls.get(call.id)!, i]);
        else calls.set(call.id, i);
      }
    }
    if (turn.role !== 'tool' && turn.role !== 'function') return;
    toolIndices.push(i); linkIndices.push(i);
    if (!turn.tool_call_id) finding('tool_link_missing', 'A tool result has no structured call identifier; execution linkage cannot be assessed.', [i]);
    else if (!calls.has(turn.tool_call_id)) finding('tool_call_missing', 'A tool result has no matching earlier captured call; the source may be incomplete.', [i]);
    else if (resolved.has(turn.tool_call_id)) finding('duplicate_tool_result', 'Multiple results refer to one call; review whether these are streamed or duplicated results.', [i]);
    else resolved.add(turn.tool_call_id);
    const label = classifyToolResult(turn.content);
    if (label === 'error_pattern') finding('tool_error_pattern', 'Tool output matches an error pattern. Recovery may be legitimate; this does not prove task failure.', [i]);
    else if (label === 'unknown') finding('tool_result_unassessed', 'Tool output has no recognized result pattern; execution success is unassessed.', [i], 'info');
    else finding('tool_success_pattern', 'Tool output matches a success pattern; successful execution and task completion remain unverified.', [i], 'info');
  });
  for (const [id, index] of calls) if (!resolved.has(id)) finding('tool_result_missing', 'A captured tool call has no matching captured result; outcome evidence is missing.', [index]);
  check('tool_links', [...new Set(linkIndices)], ['duplicate_tool_call_id', 'tool_link_missing', 'tool_call_missing', 'duplicate_tool_result', 'tool_result_missing']);
  check('tool_result_patterns', toolIndices, ['tool_error_pattern']);

  turns.forEach((turn, i) => {
    // Scan decoded fields as well as canonical text, without copying a matched value into results.
    if (SECRET_PATTERNS.some(pattern => pattern.test(turn.content) || pattern.test(canonicalJson(turn)))) finding('credential_pattern', 'Credential-shaped material needs private review and removal before release. A match does not establish credential validity.', [i], scope === 'release' ? 'reject' : 'flag');
  });
  if (SECRET_PATTERNS.some(pattern => pattern.test(encoded)) && !report.findings.some(item => item.code === 'credential_pattern')) finding('credential_pattern', 'Credential-shaped material in source fields needs private review before release.', [], scope === 'release' ? 'reject' : 'flag');
  check('sensitive_content', all, ['credential_pattern']);

  const assistantIndices: number[] = [], repetitions = new Map<string, number[]>();
  turns.forEach((turn, i) => {
    if (turn.role !== 'assistant') return;
    assistantIndices.push(i);
    const text = turn.content.trim();
    if (text.length < 32) return;
    const key = createHash('sha256').update(text).digest('hex');
    const indices = repetitions.get(key) ?? []; indices.push(i); repetitions.set(key, indices);
  });
  for (const indices of repetitions.values()) if (indices.length >= 3) finding('repeated_assistant_text', 'At least three assistant turns repeat the same substantial text; review context before treating this as a loop.', indices);
  check('repetition', assistantIndices, ['repeated_assistant_text']);
  if (!turns.some(turn => turn.role === 'user')) finding('task_context_missing', 'No user turn is captured; the task objective may be missing.', []);
  const last = turns.at(-1)!;
  if (last.role !== 'assistant' || last.tool_calls?.length) finding('terminal_response_missing', 'The capture ends without a final assistant response; completion is unassessed.', [turns.length - 1]);
  if (trace.truncated === true || trace.capture_complete === false || trace.incomplete === true) finding('source_declared_incomplete', 'Source metadata declares an incomplete or truncated capture.', []);
  check('capture_completeness', all, ['task_context_missing', 'terminal_response_missing', 'source_declared_incomplete']);
  report.status = report.findings.some(item => item.severity === 'reject') ? 'reject' : report.findings.some(item => item.severity === 'flag') ? 'flag' : 'pass';
  const summaries: Record<QcStatus, string> = { pass: 'No deterministic review flags found. Task quality and completion remain unassessed.', flag: 'Review signals found. They do not establish task failure.', reject: 'This scope has blocking structural or sensitive-content findings.', error: 'Checks could not assess this input.' };
  report.summary = summaries[report.status];
  return report;
}
