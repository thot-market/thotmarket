import { createHmac } from 'node:crypto';
import { canonicalHash } from '../../protocol/src/index.ts';
import { assertTraceContent, type TraceContent, type ProvenanceTier } from '../../provenance/src/index.ts';
import type { RightsAssessment } from '../../policy/src/index.ts';

export interface SpanEdit { start: number; end: number; replacement: string; }
export interface ScrubReceipt { schema_version: 'trace.scrub/1'; input_hash: string; output_hash: string; scrubber_version: string; edits_count: number; limitations: string[]; }

const SECRET_RULES = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)\s*[:=]\s*["']?[^\s"']{4,}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/i,
];
export function scanSecrets(trace: TraceContent): { rejected: boolean; secretTypes: string[] } {
  assertTraceContent(trace);
  const names = ['private_key', 'bearer_token', 'api_key', 'assigned_secret', 'credential_connection_string'];
  const matches = SECRET_RULES.flatMap((rule, index) => trace.turns.some(turn => rule.test(turn.content)) ? [names[index]!] : []);
  return { rejected: matches.length > 0, secretTypes: matches };
}

/** Target known credential spans; keep surrounding reasoning and tool structure.
 * Raw originals stay in the owner's encrypted vault and never use this output.
 * A residual secret detector failure still blocks release at the integration. */
export function redactCredentialSpans(text:string):{text:string;count:number}{
  let count=0;
  const rules=[
    /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gi,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi,
    /\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
    /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)["']?\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/gi,
  ];
  // Tool arguments often contain JSON encoded inside another JSON string.
  // Match its escaped delimiters while retaining the value's surrounding syntax.
  text=text.replace(/(\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)\\+["']\s*:\s*\\+["'])([^\\"']+)/gi,(_all,prefix)=>{count++;return prefix+'[REDACTED]';});
  for(const rule of rules)text=text.replace(rule,()=>{count++;return '[REDACTED]';});
  return {text,count};
}
export function redactTraceCredentials(trace:TraceContent):TraceContent{
  assertTraceContent(trace);return {turns:trace.turns.map(turn=>({...turn,content:redactCredentialSpans(turn.content).text}))};
}

/** Detector output is data only. The replacement vocabulary prevents a model from injecting prose. */
export function validateSpanEdits(text: string, value: unknown, options: { maxEdits?: number; maxOutputBytes?: number } = {}): SpanEdit[] {
  if (typeof text !== 'string' || !Array.isArray(value) || value.length > (options.maxEdits ?? 1000) || Buffer.byteLength(JSON.stringify(value)) > (options.maxOutputBytes ?? 64_000)) throw new Error('INVALID_SPAN_EDITS');
  const edits: SpanEdit[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['start', 'end', 'replacement'].includes(key)) || !Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) || raw.start < 0 || raw.end <= raw.start || raw.end > text.length || typeof raw.replacement !== 'string' || !/^\[(?:REDACTED|PERSON|ORGANIZATION|LOCATION|EMAIL|PHONE|EXCLUDED)(?:_[a-f0-9]{8,16})?\]$/.test(raw.replacement)) throw new Error('INVALID_SPAN_EDITS');
    // UTF-16 positions must not split a surrogate pair.
    for (const index of [raw.start, raw.end]) if (index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]!) && /[\uDC00-\uDFFF]/.test(text[index]!)) throw new Error('INVALID_SPAN_BOUNDARY');
    edits.push({ start: raw.start, end: raw.end, replacement: raw.replacement });
  }
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index > 0 && edits[index - 1]!.end > edit.start)) throw new Error('OVERLAPPING_SPAN_EDITS');
  return edits;
}
export function applySpanEdits(text: string, value: unknown): string {
  const edits = validateSpanEdits(text, value);
  let result = text;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
}

export function scrubTrace(input: { trace: TraceContent; traceId: string; pseudonymKey: Buffer | string; exclusionTerms?: string[]; entitySpans?: Record<number, SpanEdit[]>; redactSecrets?: boolean }): { trace: TraceContent; receipt: ScrubReceipt } {
  assertTraceContent(input.trace);
  if (!input.traceId || Buffer.byteLength(input.pseudonymKey) < 16) throw new Error('INVALID_PSEUDONYM_CONTEXT');
  if (!input.redactSecrets && scanSecrets(input.trace).rejected) throw new Error('SECRET_HARD_REJECT');
  const terms = input.exclusionTerms ?? [];
  if (terms.length > 100 || terms.some(term => typeof term !== 'string' || term.trim().length < 2 || term.length > 200)) throw new Error('INVALID_EXCLUSION_TERMS');
  let count = 0;
  const pseudonym = (kind: string, value: string) => `[${kind}_${createHmac('sha256', input.pseudonymKey).update(input.traceId + '\0' + value.toLowerCase()).digest('hex').slice(0, 12)}]`;
  const trace: TraceContent = { turns: input.trace.turns.map((turn, turnIndex) => {
    let text = turn.content;
    // Optional NER/detector outputs are bounded spans, never instructions or a dynamic system prompt.
    const supplied = input.entitySpans?.[turnIndex] ?? [];
    text = applySpanEdits(text, supplied); count += supplied.length;
    if(input.redactSecrets){const filtered=redactCredentialSpans(text);text=filtered.text;count+=filtered.count;}
    const replace = (expression: RegExp, kind: string) => { text = text.replace(expression, value => { count++; return pseudonym(kind, value); }); };
    replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'EMAIL');
    replace(/(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\w.])/g, 'PHONE');
    for (const term of terms) {
      const expression = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(expression, () => { count++; return '[EXCLUDED]'; });
    }
    return { role: turn.role, content: text };
  }) };
  return { trace, receipt: { schema_version: 'trace.scrub/1', input_hash: canonicalHash(input.trace), output_hash: canonicalHash(trace), scrubber_version: input.redactSecrets?'thot-targeted-scrub/2':'thot-deterministic-scrub/1', edits_count: count, limitations: ['Regex rules and optional supplied entity spans do not guarantee complete PII removal.', 'No production NER or contextual LLM classifier is configured.'] } };
}

export interface TraceFeatures {
  schema_version: 'trace.features/1'; trace_id: string; topic_labels: string[];
  workflow_type: 'coding' | 'research' | 'investment_research' | 'legal_research' | 'contract_review' | 'chat' | 'agent' | 'other';
  counts: { turns: number; tool_calls: number }; signals: Record<string, number>;
  available_predicates: { credential_types: string[]; outcome_types: string[] };
  rights_status: RightsAssessment['status']; provenance_tier: ProvenanceTier; feature_model_version: string;
}
const SAFE_TOPICS = ['coding', 'research', 'finance', 'law', 'contracts', 'science', 'education', 'other'];
export function extractPrivacySafeFeatures(input: { trace: TraceContent; traceId: string; rights: RightsAssessment; provenanceTier: ProvenanceTier; workflowType?: TraceFeatures['workflow_type']; topicLabels?: string[]; credentialTypes?: string[]; outcomeTypes?: string[] }): TraceFeatures {
  assertTraceContent(input.trace);
  if (!['coding', 'research', 'investment_research', 'legal_research', 'contract_review', 'chat', 'agent', 'other'].includes(input.workflowType ?? 'other') ||
      !['P0_OPERATOR', 'P1_WITNESSED', 'P2_TEE', 'P3_UPSTREAM'].includes(input.provenanceTier) ||
      !['eligible', 'eligible_with_restrictions', 'manual_review', 'rejected'].includes(input.rights?.status) || input.rights.trace_id !== input.traceId) throw new Error('UNSAFE_FEATURE_CONTEXT');
  const labels = input.topicLabels ?? [];
  if (labels.some(label => !SAFE_TOPICS.includes(label))) throw new Error('UNSAFE_TOPIC_LABEL');
  const credentialTypes = input.credentialTypes ?? []; const outcomeTypes = input.outcomeTypes ?? [];
  if (credentialTypes.some(type => !['workplace_cohort', 'professional_cohort'].includes(type)) || outcomeTypes.some(type => !['security_traded', 'security_held', 'security_action'].includes(type))) throw new Error('UNSAFE_PREDICATE_METADATA');
  return { schema_version: 'trace.features/1', trace_id: input.traceId, topic_labels: [...new Set(labels)], workflow_type: input.workflowType ?? 'other', counts: { turns: input.trace.turns.length, tool_calls: input.trace.turns.filter(turn => turn.role === 'tool').length }, signals: {}, available_predicates: { credential_types: [...new Set(credentialTypes)], outcome_types: [...new Set(outcomeTypes)] }, rights_status: input.rights.status, provenance_tier: input.provenanceTier, feature_model_version: 'thot-safe-features-rules/1' };
}
