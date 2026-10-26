import test from 'node:test';
import assert from 'node:assert/strict';
import { createBill, showCost } from '../apps/site/bill.js';

test('token bill counts each Claude message once and each Codex session by its last running total', async () => {
  const bill = createBill();
  const claude = { type: 'assistant', sessionId: 's1', timestamp: '2026-10-01T10:00:00Z', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  // Claude Code writes one line per content block with the same usage; it must count once.
  await bill.file([JSON.stringify(claude), JSON.stringify(claude), 'not json', JSON.stringify({ message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 9 } } })], 'a.jsonl');
  const tick = (n) => JSON.stringify({ timestamp: '2026-10-02T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, cached_input_tokens: n / 2, output_tokens: 10 } } } });
  await bill.file([JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-x' } }), tick(100), tick(400)], 'b.jsonl');
  const s = bill.summary();
  assert.equal(s.tokens, 2_000_000 + 410);
  assert.equal(s.cost, 24, 'Opus 5.5 at $4 in and $20 out per million');
  assert.equal(s.sessions, 2);
  assert.equal(s.days, 2);
  assert.equal(s.top, 'claude-opus-5-5');
  assert.equal(showCost(s), true);
  assert.equal(showCost({ ...s, priced: 1 }), false, 'no dollar figure when most tokens have no known price');
});
