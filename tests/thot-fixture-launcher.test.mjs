import test from 'node:test';
import assert from 'node:assert/strict';
import { deployThotFixture } from '../contracts/scripts/thot-local-fixture.mjs';

test('an explicit missing Anvil fails before compiling contracts or waiting for RPC', { timeout: 5000 }, async () => {
  await assert.rejects(deployThotFixture({ anvilPath: '/not-installed/thot-anvil' }), /Local Anvil unavailable.*THOT_ANVIL_PATH/);
});

test('a successful unrelated executable is not accepted as Anvil', { timeout: 5000 }, async () => {
  await assert.rejects(deployThotFixture({ anvilPath: process.execPath }), /Local Anvil unavailable/);
});

test('empty or invalid explicit executable values cannot fall back to an installed binary', async () => {
  for (const anvilPath of ['', '   ', 'anvil\0other', null]) {
    await assert.rejects(deployThotFixture({ anvilPath }), /Invalid Anvil executable/);
  }
});
