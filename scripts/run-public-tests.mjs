import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const { suites } = JSON.parse(readFileSync(new URL('../release/test-suites.json', import.meta.url), 'utf8'));
const selected = process.argv[2];
if (process.argv.length !== 3 || (selected !== 'all' && !Object.hasOwn(suites, selected))) {
  throw new Error(`Choose one suite: ${Object.keys(suites).join(', ')}, all`);
}
const env = { ...process.env, NODE_ENV: 'test', THOT_MONEY_POOL: 'local-v2' };
if (env.THOT_ANVIL_PATH) {
  if (!isAbsolute(env.THOT_ANVIL_PATH)) throw new Error('THOT_ANVIL_PATH must be absolute');
  // Both fixture implementations must use the selected local binary.
  env.PATH = `${dirname(env.THOT_ANVIL_PATH)}${delimiter}${env.PATH ?? ''}`;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
function python(name) {
  const value = env[name];
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`${name} must name an installed absolute Python interpreter; see TESTING.md`);
  return value;
}
for (const name of selected === 'all' ? Object.keys(suites) : [selected]) {
  const suite = suites[name];
  console.log(`Public test suite: ${name}`);
  for (const path of [...(suite.node ?? []), ...(suite.python ?? [])]) {
    if (!existsSync(new URL('../' + path, import.meta.url))) throw new Error(`Missing exported test: ${path}`);
  }
  for (const requirement of suite.requires ?? []) {
    if (requirement === 'anvil') {
      const result = spawnSync(env.THOT_ANVIL_PATH ?? 'anvil', ['--version'], { env, encoding: 'utf8' });
      if (result.status !== 0 || !/^anvil Version: 1\.7\.1\s*$/m.test(result.stdout ?? '')) throw new Error('Anvil 1.7.1 is required; see TESTING.md');
    }
    if (requirement === 'dcap') run(python('THOT_DCAP_TEST_PYTHON'), ['-c', 'import dcap_qvl']);
    if (requirement === 'portable-dcap') run(python('THOT_PORTABLE_DCAP_TEST_PYTHON'), ['-c', 'import dcap_qvl']);
    if (requirement === 'trade-python') run(python('THOT_TRADE_TEST_PYTHON'), ['-c', 'import cryptography']);
    if (requirement === 'browser') {
      if (!env.THOT_E2E_BROWSER || !isAbsolute(env.THOT_E2E_BROWSER) || !existsSync(env.THOT_E2E_BROWSER)) throw new Error('THOT_E2E_BROWSER must name the browser executable');
      if (process.platform === 'linux') {
        run('sh', ['-c', 'command -v Xvfb >/dev/null && command -v ffmpeg >/dev/null']);
      }
    }
  }
  if (suite.node?.length) run(process.execPath, ['--test', '--test-concurrency=1', ...suite.node]);
  for (const path of suite.python ?? []) run(python('THOT_TRADE_TEST_PYTHON'), [path]);
}
