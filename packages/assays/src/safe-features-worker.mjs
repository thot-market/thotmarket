// Reviewed built-in evaluator only. No dynamic imports, eval, buyer tools, file reads,
// model calls, URLs, or network APIs. Its sole input/output channel is bounded JSON.
const chunks = [];
let received = 0;
process.stdin.on('data', chunk => {
  received += chunk.length;
  if (received > 16_000) process.exit(20);
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.protocol !== 'thot.assay-worker/1' || input.module !== 'safe-features/1') process.exit(21);
    const checks = [];
    if (input.criteria.workflowTypes?.length) checks.push(input.criteria.workflowTypes.includes(input.features.workflow_type));
    if (input.criteria.topicLabels?.length) checks.push(input.criteria.topicLabels.some(topic => input.features.topic_labels.includes(topic)));
    if (input.criteria.minTurns !== undefined) checks.push(input.features.turns >= input.criteria.minTurns);
    const score = checks.length ? checks.filter(Boolean).length / checks.length : 1;
    const output = { accepted: score >= input.threshold, score,
      labels: { relevance: score < 0.34 ? 'low' : score < 0.67 ? 'medium' : 'high' } };
    process.stdout.write(JSON.stringify(output));
  } catch {
    // No error text or input is returned, including parse and internal exceptions.
    process.exitCode = 22;
  }
});
