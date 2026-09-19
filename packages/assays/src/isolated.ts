import { canonicalHash, canonicalJson, signCanonical, uuidv7, validateTraceFeatures } from '../../protocol/src/index.ts';
import { developmentSigningKeys } from '../../provenance/src/index.ts';
import { assayCommitment, validateAssayOutput, type AssayInput, type AssayReceipt, type BoundedAssayOutput } from './index.ts';
import { superviseReviewedWorker, type ReviewedWorker, type RuntimeLimits } from './isolated-runtime.ts';

export interface IsolatedAssayOptions {
  maxRunsPerPair?: number; maxInputBytes?: number; timeoutMs?: number; heapMb?: number; maxConcurrent?: number; now?: () => Date;
}
const allowedTopics = new Set(['coding', 'research', 'finance', 'law', 'contracts', 'science', 'education', 'other']);
const allowedWorkflows = new Set(['coding', 'research', 'investment_research', 'legal_research', 'contract_review', 'chat', 'agent', 'other']);
const allowedInputFields = new Set(['traceId', 'mandateId', 'assayId', 'version', 'threshold', 'features', 'eligibility', 'criteria']);

/** Resource containment for the reviewed built-in module; not a sandbox for hostile buyer code. */
export class IsolatedAssayRunner {
  private readonly limits: RuntimeLimits;
  private readonly maxRuns: number; private readonly maxInputBytes: number; private readonly maxConcurrent: number;
  private readonly now: () => Date; private readonly counts = new Map<string, number>();
  private active = 0; private started = 0; private terminated = 0;
  private readonly worker: ReviewedWorker;

  constructor(options: IsolatedAssayOptions = {}, internalTestWorker?: ReviewedWorker) {
    if (Object.keys(options).some(key => !['maxRunsPerPair', 'maxInputBytes', 'timeoutMs', 'heapMb', 'maxConcurrent', 'now'].includes(key))) throw new Error('INVALID_ASSAY_RUNTIME_OPTIONS');
    this.maxRuns = options.maxRunsPerPair ?? 3; this.maxInputBytes = options.maxInputBytes ?? 16_000;
    this.maxConcurrent = options.maxConcurrent ?? 2; this.now = options.now ?? (() => new Date());
    this.limits = { timeoutMs: options.timeoutMs ?? 1000, heapMb: options.heapMb ?? 32, maxOutputBytes: 128, maxStderrBytes: 1024 };
    for (const [value, minimum, maximum] of [[this.maxRuns, 1, 100], [this.maxInputBytes, 1, 16_000],
      [this.maxConcurrent, 1, 4], [this.limits.timeoutMs, 1, 5000], [this.limits.heapMb, 16, 64]]) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('INVALID_ASSAY_QUOTA');
    }
    this.worker = internalTestWorker ?? 'safe-features-v1';
  }

  diagnostics() { return { active: this.active, started: this.started, terminated: this.terminated,
    timeout_ms: this.limits.timeoutMs, heap_mb: this.limits.heapMb, max_concurrent: this.maxConcurrent }; }

  async run(input: AssayInput): Promise<AssayReceipt> {
    let wire: string;
    try { wire = canonicalJson(input); } catch { throw new Error('INVALID_ASSAY_INPUT'); }
    if (Buffer.byteLength(wire) > this.maxInputBytes) throw new Error('ASSAY_INPUT_QUOTA');
    const safe = JSON.parse(wire) as AssayInput;
    if (!safe?.eligibility || ['provenance', 'credentials', 'outcomes', 'rights', 'policy'].some(key => safe.eligibility[key as keyof AssayInput['eligibility']] !== true)) throw new Error('ASSAY_INELIGIBLE');
    if (!['eligible', 'eligible_with_restrictions'].includes(safe.features?.rights_status)) throw new Error('ASSAY_RIGHTS_DENIED');
    if (Object.keys(safe).some(key => !allowedInputFields.has(key)) || !safe.traceId || !safe.mandateId
      || safe.traceId.length > 128 || safe.mandateId.length > 128 || typeof safe.assayId !== 'string' || safe.assayId.length > 128
      || typeof safe.version !== 'string' || safe.version.length > 64) throw new Error('INVALID_ASSAY_INPUT');
    const criteria = safe.criteria ?? {};
    const inputHash = canonicalHash(safe.features);
    const baseCommitment = assayCommitment(safe.assayId, safe.version, criteria, safe.threshold);
    let output: BoundedAssayOutput | undefined;
    let sourceHash: string | null = null;
    try {
      if (safe.assayId !== 'safe-features' || safe.version !== '1') throw new Error('UNSUPPORTED_ASSAY');
      validateTraceFeatures(safe.features);
      if (safe.features.trace_id !== safe.traceId || !Number.isFinite(safe.threshold) || safe.threshold < 0 || safe.threshold > 1
        || safe.features.topic_labels.length > 8 || safe.features.topic_labels.some(topic => !allowedTopics.has(topic))
        || safe.features.counts.turns > 1000 || safe.features.counts.tool_calls > 1000) throw new Error('INVALID_ASSAY_INPUT');
      if (Object.keys(criteria).some(key => !['workflowTypes', 'topicLabels', 'minTurns'].includes(key))
        || (criteria.workflowTypes !== undefined && (!Array.isArray(criteria.workflowTypes) || criteria.workflowTypes.length > 8 || criteria.workflowTypes.some(value => !allowedWorkflows.has(value))))
        || (criteria.topicLabels !== undefined && (!Array.isArray(criteria.topicLabels) || criteria.topicLabels.length > 8 || criteria.topicLabels.some(value => !allowedTopics.has(value))))
        || (criteria.minTurns !== undefined && (!Number.isSafeInteger(criteria.minTurns) || criteria.minTurns < 1 || criteria.minTurns > 1000))) throw new Error('INVALID_ASSAY_CRITERIA');
      const key = canonicalHash({ trace: safe.traceId, mandate: safe.mandateId }); const count = this.counts.get(key) ?? 0;
      if (count >= this.maxRuns || this.active >= this.maxConcurrent) throw new Error('ASSAY_RUN_QUOTA');
      this.counts.set(key, count + 1); this.active++; this.started++;
      try {
        // No raw text, source evidence, identity, environment, model prompts, or URLs cross this boundary.
        const request = canonicalJson({ protocol: 'thot.assay-worker/1', module: 'safe-features/1', threshold: safe.threshold,
          features: { workflow_type: safe.features.workflow_type, topic_labels: safe.features.topic_labels, turns: safe.features.counts.turns }, criteria });
        const executed = await superviseReviewedWorker(this.worker, request, this.limits);
        sourceHash = executed.sourceHash; if (executed.killed) this.terminated++;
        if (executed.failure) throw new Error(executed.failure);
        output = validateAssayOutput(executed.output);
        // The reviewed module's acceptance must be consistent with the committed threshold.
        if (output.score === undefined || output.accepted !== (output.score >= safe.threshold)) throw new Error('INCONSISTENT_ASSAY_OUTPUT');
      } finally { this.active--; }
    } catch {
      // Buyer-visible errors contain no input, exception messages, stderr, or execution diagnostics.
      output = undefined;
    }
    const unsigned: Omit<AssayReceipt, 'signature'> = { schema_version: 'trace.assay/1', assay_receipt_id: uuidv7(),
      trace_id: safe.traceId, mandate_id: safe.mandateId, assay_id: safe.assayId, assay_version: safe.version,
      assay_commitment: canonicalHash({ semantic_commitment: baseCommitment, runtime: 'thot-isolated-assay/1',
        worker_source_sha256: sourceHash, module: this.worker, limits: this.limits, input_scope: 'safe-features-v1', output_schema: 'accepted-score-relevance/1' }),
      input_hash: inputHash, result: output ? output.accepted ? 'accepted' : 'rejected' : 'error',
      ...(output?.score === undefined ? {} : { score: output.score }), ...(output?.labels ? { bounded_labels: output.labels } : {}),
      output_hash: canonicalHash(output ?? { accepted: false }), executed_at: this.now().toISOString() };
    return { ...unsigned, signature: signCanonical(unsigned, developmentSigningKeys('thot-development-assay').privateKey) };
  }
}
