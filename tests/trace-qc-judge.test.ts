import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { runSemanticQc, contentDigest } from '../packages/qc/index.ts';

const trace = () => ({ turns: [{ role: 'user', content: 'Return the word queue.' }, { role: 'assistant', content: 'queue' }] });
const scored = () => ({ status: 'scored', score: 3, reason_code: 'goal_achieved', coverage: { total_turns: 2, evaluated_turn_indices: [0, 1] }, evidence: [{ turn_index: 1, dimension: 'task_outcome' }] });
const options = { scope: 'private' as const };

test('semantic provider is explicit and receives actual OpenJudge rubric with indexed evidence', async () => {
  assert.equal((await runSemanticQc(trace(), undefined, options)).status, 'not_run');
  const input = trace();
  const result = await runSemanticQc(input, async request => {
    assert.match(request.messages[1]!.content, /Logical Coherence/);
    assert.match(request.messages[1]!.content, /Score 3: Successfully achieves/);
    assert.match(request.messages[1]!.content, /turn_index/);
    assert.ok(request.signal instanceof AbortSignal);
    return JSON.stringify(scored());
  }, options);
  assert.equal(result.status, 'scored'); assert.equal(result.score, 3);
  assert.equal(result.content_digest, contentDigest(input));
  assert.deepEqual(result.coverage.evaluated_turn_indices, [0, 1]);
  assert.equal(JSON.stringify(result).includes('Return the word'), false);
});

test('semantic output must validate score, all-turn coverage, references and controlled reason codes', async () => {
  const invalid: unknown[] = ['not json', { ...scored(), score: 0 }, { ...scored(), score: 4 }, { ...scored(), score: '3' }, { ...scored(), score: null },
    { ...scored(), coverage: { total_turns: 2, evaluated_turn_indices: [0] } },
    { ...scored(), coverage: { total_turns: 2, evaluated_turn_indices: [0, 0] } },
    { ...scored(), coverage: { total_turns: 3, evaluated_turn_indices: [0, 1] } },
    { ...scored(), evidence: [{ turn_index: 2, dimension: 'task_outcome' }] },
    { ...scored(), evidence: [] }, { ...scored(), reason_code: 'goal_not_achieved' },
    { ...scored(), reasoning: 'This untrusted text must not be retained.' }];
  for (const output of invalid) {
    const result = await runSemanticQc(trace(), async () => output, options);
    assert.equal(result.status, 'error'); assert.equal(result.reason, 'invalid_provider_output'); assert.equal(result.score, null);
    assert.equal(result.evidence.length, 0);
  }
  const abstained = await runSemanticQc(trace(), async () => ({ ...scored(), status: 'abstained', score: null, reason_code: 'insufficient_evidence', evidence: [] }), options);
  assert.equal(abstained.status, 'abstained'); assert.equal(abstained.score, null);
});

test('provider exception, timeout and oversized output are errors, never zero scores or error text leaks', async () => {
  const marker = randomBytes(16).toString('hex');
  const failed = await runSemanticQc(trace(), async () => { throw new Error(marker); }, options);
  assert.equal(failed.reason, 'provider_error'); assert.equal(failed.score, null);
  assert.equal(JSON.stringify(failed).includes(marker), false);
  let signal: AbortSignal | undefined;
  const timedOut = await runSemanticQc(trace(), request => { signal = request.signal; return new Promise(() => {}); }, { ...options, timeout_ms: 15 });
  assert.equal(timedOut.reason, 'provider_timeout'); assert.equal(timedOut.score, null); assert.equal(signal!.aborted, true);
  const oversized = await runSemanticQc(trace(), async () => 'x'.repeat(32_001), options);
  assert.equal(oversized.reason, 'invalid_provider_output');
});

test('missing evidence, secrets and prompt limits abstain before provider use', async () => {
  let calls = 0;
  const provider = async () => { calls++; return scored(); };
  const incomplete = await runSemanticQc({ turns: [{ role: 'user', content: 'Unfinished.' }] }, provider, options);
  assert.equal(incomplete.reason, 'incomplete_evidence');
  const sensitive = trace(); sensitive.turns[1]!.content = 'api_key=' + randomBytes(32).toString('hex');
  assert.equal((await runSemanticQc(sensitive, provider, options)).status, 'abstained');
  assert.equal((await runSemanticQc(trace(), provider, { ...options, max_prompt_bytes: 1024 })).reason, 'prompt_limit_exceeded');
  assert.equal((await runSemanticQc(trace(), provider, { ...options, timeout_ms: 60_000 })).reason, 'invalid_options');
  assert.equal(calls, 0);
});

test('provider cannot change content binding by mutating the caller input', async () => {
  const input = trace(), before = contentDigest(input);
  const result = await runSemanticQc(input, async () => { input.turns.push({ role: 'assistant', content: 'Mutation.' }); return scored(); }, options);
  assert.equal(result.status, 'scored'); assert.equal(result.content_digest, before); assert.equal(result.coverage.total_turns, 2);
});

test('prompt preserves replacement tokens literally and assigns its own immutable step indices', async () => {
  const literal = '$& $$ $` ' + "$'";
  const input = { turns: [{ role: 'user', content: literal, turn_index: 999 }, { role: 'assistant', content: 'Synthetic response.' }] };
  await runSemanticQc(input, async request => {
    assert.ok(request.messages[1]!.content.includes(literal));
    assert.ok(request.messages[1]!.content.includes('"turn_index":0'));
    assert.equal(request.messages[1]!.content.includes('"turn_index":999'), false);
    return scored();
  }, options);
});
