import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { contentDigest, runTraceQc, canonicalJson, QC_LIMITS } from '../packages/qc/index.ts';
import { classifyToolResult } from '../packages/qc/vendor/data-juicer-tool-result.ts';

const clean = () => ({ turns: [{ role: 'user', content: 'Explain the synthetic FIFO queue.' }, { role: 'assistant', content: 'The first inserted item is removed first.' }] });
test('QC is deterministic, content-bound, scope-bound and explicit about unassessed semantic quality', () => {
  const input = clean(), report = runTraceQc(input, { scope: 'private' });
  assert.equal(report.status, 'pass');
  assert.equal(report.content_digest, contentDigest(input));
  assert.match(report.content_digest!, /^[a-f0-9]{64}$/);
  assert.deepEqual(report, runTraceQc(input, { scope: 'private' }));
  assert.deepEqual(report.semantic, { status: 'not_run', reason: 'provider_not_supplied' });
  assert.equal(report.checks.find(check => check.id === 'tool_links')!.status, 'not_applicable');
  assert.equal(report.coverage.evaluated_turns, 2);
  assert.equal(contentDigest({ b: 1, a: [2, 3] }), contentDigest({ a: [2, 3], b: 1 }));
  assert.notEqual(contentDigest({ a: [2, 3] }), contentDigest({ a: [3, 2] }));
  assert.notEqual(contentDigest({ ...input, captured: false }), report.content_digest);
  assert.equal(runTraceQc(input, { scope: 'release' }).scope, 'release');
  assert.match(contentDigest(report), /^[a-f0-9]{64}$/);
});

test('rejects unsupported structure and reports evaluator limits as errors, without truncating', () => {
  for (const input of [null, {}, { turns: [] }, { turns: [{ role: 'alien', content: 'x' }] }, { turns: [{ role: 'user', content: { text: 'x' } }] }]) {
    assert.equal(runTraceQc(input, { scope: 'private' }).status, 'reject');
  }
  assert.equal(runTraceQc({ turns: Array.from({ length: 1001 }, () => ({ role: 'user', content: 'x' })) }, { scope: 'private' }).status, 'error');
  const huge = { turns: [{ role: 'user', content: 'x'.repeat(QC_LIMITS.max_bytes) }] };
  assert.equal(runTraceQc(huge, { scope: 'private' }).status, 'error');
  assert.equal(runTraceQc(huge, { scope: 'private' }).content_digest, null);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => contentDigest(circular), /invalid_json/);
  assert.equal(runTraceQc(circular, { scope: 'private' }).status, 'error');
  let invoked = false;
  const accessor = { get turns() { invoked = true; return []; } };
  assert.equal(runTraceQc(accessor, { scope: 'private' }).status, 'error');
  assert.equal(invoked, false);
  for (const value of [undefined, NaN, Infinity, () => null, new Date(), [, 1]]) assert.throws(() => canonicalJson(value));
});

test('Data-Juicer-derived patterns remain review signals, with conservative unknown handling', () => {
  assert.equal(classifyToolResult('Wrote 123 bytes'), 'success_pattern');
  assert.equal(classifyToolResult('操作失败'), 'error_pattern');
  assert.equal(classifyToolResult('OK but Error: failure'), 'error_pattern');
  assert.equal(classifyToolResult('arbitrary returned data'), 'unknown');
  // Known upstream false positive is disclosed instead of being promoted to task failure.
  assert.equal(classifyToolResult('0 tests failed'), 'error_pattern');
  const input = { turns: [
    { role: 'user', content: 'Read the synthetic file.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', content: 'Error: missing fixture', tool_call_id: 'call-1' },
    { role: 'assistant', content: 'I recovered by constructing the fixture in memory.' },
  ] };
  const report = runTraceQc(input, { scope: 'private' });
  assert.equal(report.status, 'flag');
  assert.equal(report.checks.find(check => check.id === 'tool_links')!.status, 'pass');
  assert.deepEqual(report.findings.find(item => item.code === 'tool_error_pattern')!.turn_indices, [2]);
  assert.match(report.findings.find(item => item.code === 'tool_error_pattern')!.message, /does not prove task failure/);
});

test('missing and ambiguous tool evidence is not described as proven task failure', () => {
  const input = { turns: [
    { role: 'user', content: 'Use the synthetic tool.' },
    { role: 'tool', content: 'OK', tool_call_id: 'orphan' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'repeat', function: { name: 'read' } }, { id: 'repeat', function: { name: 'read' } }] },
    { role: 'assistant', content: 'Done.' },
  ] };
  const codes = runTraceQc(input, { scope: 'private' }).findings.map(item => item.code);
  for (const expected of ['tool_call_missing', 'duplicate_tool_call_id', 'tool_result_missing']) assert.ok(codes.includes(expected));
  const flattened = runTraceQc({ turns: [{ role: 'user', content: 'Check.' }, { role: 'tool', content: '[Tool result: id=flattened] OK' }, { role: 'assistant', content: 'Done.' }] }, { scope: 'private' });
  assert.ok(flattened.findings.some(item => item.code === 'tool_link_missing'));
});

test('credential-shaped content blocks release, flags private review, and never appears in findings', () => {
  const synthetic = randomBytes(32).toString('hex');
  const input = clean(); input.turns[1]!.content = 'api_key=' + synthetic;
  const privateReport = runTraceQc(input, { scope: 'private' });
  const releaseReport = runTraceQc(input, { scope: 'release' });
  assert.equal(privateReport.status, 'flag');
  assert.equal(releaseReport.status, 'reject');
  assert.equal(releaseReport.findings[0]!.code, 'credential_pattern');
  assert.equal(JSON.stringify(privateReport).includes(synthetic), false);
  assert.equal(JSON.stringify(releaseReport).includes('api_key='), false);
  const metadata = runTraceQc({ ...clean(), credential: { client_secret: synthetic } }, { scope: 'release' });
  assert.equal(metadata.status, 'reject');
});

test('repetition and source incompleteness are bounded review findings', () => {
  const repeated = 'The same substantial synthetic answer repeated for review.';
  const report = runTraceQc({ turns: [{ role: 'user', content: 'Explain.' }, ...Array.from({ length: 100 }, () => ({ role: 'assistant', content: repeated }))], capture_complete: false }, { scope: 'private' });
  assert.equal(report.status, 'flag');
  assert.equal(report.findings.find(item => item.code === 'repeated_assistant_text')!.turn_indices.length, 32);
  assert.ok(report.findings.some(item => item.code === 'source_declared_incomplete'));
  assert.equal(JSON.stringify(report).includes(repeated), false);
  assert.ok(report.findings.length <= QC_LIMITS.max_findings);
  const incomplete = runTraceQc({ turns: [{ role: 'user', content: 'A captured unfinished request.' }] }, { scope: 'private' });
  assert.ok(incomplete.findings.some(item => item.code === 'terminal_response_missing'));
});
