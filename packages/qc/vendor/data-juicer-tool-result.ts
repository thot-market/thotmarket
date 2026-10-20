// Copyright 2025 The Data-Juicer Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from tool_success_tagger_mapper.py at the commit in sources.json.
// Changes: TypeScript regex flags; string-only input; no previews, content slicing,
// framework mutation or optimistic success fallback. Unmatched output is unknown.
// Error precedence and upstream success/error patterns are retained.

const SUCCESS_PATTERNS = [
  /wrote\s+\d+\s*bytes/i,
  /^(?:success|ok)(?:\s|$)/i,
  /\bsuccessfully\b/i,
  /^ok$/i,
];
const ERROR_PATTERNS = [
  /\berror\s*:/i, /\bexception\b/i, /\bfailed\b/i, /\bfailure\b/i,
  /not\s+found/i, /permission\s+denied/i,
  /(?:执行|操作|请求|调用|接口)失败/, /(?:发生|出现)错误/, /错误码/,
  /无法访问/, /权限不足/, /无权限/, /找不到(?:文件|路径)?/,
];

/** A pattern match is a review signal, never proof of execution or task outcome. */
export function classifyToolResult(content: string): 'success_pattern' | 'error_pattern' | 'unknown' {
  const text = content.trim();
  if (!text) return 'unknown';
  if (ERROR_PATTERNS.some(pattern => pattern.test(text))) return 'error_pattern';
  if (SUCCESS_PATTERNS.some(pattern => pattern.test(text))) return 'success_pattern';
  return 'unknown';
}
