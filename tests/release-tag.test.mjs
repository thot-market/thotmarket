import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextTag} from '../scripts/release.mjs';

test('the next release candidate follows the highest existing version', () => {
  assert.equal(nextTag(['v0.3.0-rc.9', 'v0.3.0-rc.26', 'v0.3.0-rc.3', 'not-a-version']), 'v0.3.0-rc.27');
  assert.equal(nextTag(['v0.2.9-rc.40', 'v0.3.0-rc.1']), 'v0.3.0-rc.2');
  assert.throws(() => nextTag([]), /No existing release tag/);
});
