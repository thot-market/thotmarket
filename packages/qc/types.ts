export type QcScope = 'private' | 'release';
export type QcStatus = 'pass' | 'flag' | 'reject' | 'error';
export type QcCheckStatus = QcStatus | 'not_applicable' | 'not_run';
export interface QcFinding {
  code: string;
  severity: 'info' | 'flag' | 'reject';
  message: string;
  turn_indices: number[];
  file_paths?: string[];
  occurrence_count: number;
}
export interface QcCheck {
  id: string;
  status: QcCheckStatus;
  evaluated_turns: number[];
  evaluated_files?: string[];
  total_turns: number;
}
export interface TraceQcReport {
  schema_version: 'trace-qc/v1';
  policy_version: string;
  content_digest: string | null;
  scope: QcScope;
  status: QcStatus;
  summary: string;
  findings: QcFinding[];
  checks: QcCheck[];
  coverage: { total_turns: number; evaluated_turns: number; truncated: false; total_files?:number; evaluated_files?:number; files?:Array<{path:string;checks:string[];status:string}> };
  content_kind?:'research';
  semantic: { status: 'not_run'; reason: 'provider_not_supplied' };
  limits: { max_bytes: number; max_turns: number; max_findings: number };
}
export interface TraceTurn {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';
  content: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments?: string | Record<string, unknown> }; type?: string }>;
  tool_call_id?: string;
  name?: string;
}
export interface TraceContent { turns: TraceTurn[]; [key: string]: unknown }
