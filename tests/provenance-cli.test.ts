import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyProvenanceCli } from '../scripts/verify-provenance.ts';
import * as upstream from '../packages/provenance/vendor/attest-proxy-witness.ts';

test('read-only provenance diagnostic returns no private content, metadata, credentials or timestamps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-provenance-cli-'));
  try {
    const secret = 'PRIVATE USER CONTENT SHOULD NEVER BE PRINTED';
    const meta = upstream.sessionMeta('private-profile', secret);
    const req = Buffer.from(secret); const response = Buffer.from('PRIVATE RESPONSE');
    const c = await upstream.commitment('secret.example', req, response);
    const bundle = { attester: 'dstack-cvm', session_meta_b64: upstream.b64(meta), call_count: 1, session_root: upstream.hex(await upstream.sessionRoot(meta, [c])), calls: [{ n: 1, host: 'secret.example', request_redacted: upstream.latin1(req), response_b64: upstream.b64(response), commitment: upstream.hex(c), ts: '1899-01-01T00:00:00Z' }] };
    const path = join(directory, 'bundle.json'); await writeFile(path, JSON.stringify(bundle));
    const summary = await verifyProvenanceCli(['--bundle', path]);
    assert.equal(summary.confidence_tier, 'P0_OPERATOR'); assert.equal(summary.verified_content_count, 1);
    for (const s of [secret, 'PRIVATE RESPONSE', 'private-profile', 'secret.example', '1899-01-01']) assert(!JSON.stringify(summary).includes(s));
    assert.equal(summary.transcript_normalization, 'NOT_PERFORMED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('provenance CLI permits no production clock override or silently ignored arguments', async () => {
  for (const args of [[], ['--bundle', 'x', '--clock', '2025-01-01'], ['--bundle', 'x', '--bundle', 'y'], ['--bundle', 'x', '--collateral', 'c'], ['--bundle', 'x', '--policy', 'p']]) {
    await assert.rejects(verifyProvenanceCli(args), /INVALID_VERIFICATION_ARGUMENTS/);
  }
});
test('provenance CLI sanitizes parser errors without printing source snippets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thot-provenance-cli-errors-'));
  try {
    const path = join(directory, 'invalid.json'); await writeFile(path, '{"PRIVATE_SECRET_SHOULD_NOT_BE_LOGGED"');
    const result = spawnSync(process.execPath, ['scripts/verify-provenance.ts', '--bundle', path], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /INVALID_VERIFICATION_JSON/);
    assert(!`${result.stdout}${result.stderr}`.includes('PRIVATE_SECRET'));
    assert(!`${result.stdout}${result.stderr}`.includes(path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
