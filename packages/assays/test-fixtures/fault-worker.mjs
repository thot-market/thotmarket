// Test-only reviewed failure fixtures. Production API never accepts a worker selector.
// They return no arbitrary source text and do not perform filesystem or network I/O.
process.stdin.resume();
process.stdin.on('end', () => {
  const scenario = process.argv[2];
  if (scenario === 'test-timeout') { while (true) { /* exercise supervisor hard termination */ } }
  if (scenario === 'test-crash') throw new Error('PRIVATE-EXCEPTION-SENTINEL');
  if (scenario === 'test-invalid-output') { process.stdout.write(JSON.stringify({ accepted: true, score: 1, raw_trace: 'PRIVATE-OUTPUT-SENTINEL' })); return; }
  if (scenario === 'test-excess-output') { while (true) process.stdout.write('x'.repeat(4096)); }
  if (scenario === 'test-excess-stderr') { while (true) process.stderr.write('PRIVATE-STDERR-SENTINEL'.repeat(128)); }
  if (scenario === 'test-memory') { const retained = []; while (true) retained.push(new Array(250_000).fill('memory-quota-fixture')); }
  if (scenario === 'test-environment') {
    const leaked = ['THOT_TEST_SECRET', 'NODE_OPTIONS', 'DATABASE_URL'].some(key => process.env[key] !== undefined);
    process.stdout.write(JSON.stringify({ accepted: !leaked, score: leaked ? 0 : 1, labels: { relevance: leaked ? 'low' : 'high' } })); return;
  }
  process.exitCode = 23;
});
