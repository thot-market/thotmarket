import { canonicalHash, canonicalJson, signCanonical, uuidv7 } from '../../protocol/src/index.ts';
import { developmentSigningKeys } from '../../provenance/src/index.ts';
import type { TraceFeatures } from '../../scrubber/src/index.ts';

export { IsolatedAssayRunner, type IsolatedAssayOptions } from './isolated.ts';

export interface AssayReceipt {
  schema_version: 'trace.assay/1'; assay_receipt_id: string; mandate_id: string; trace_id: string;
  assay_id: string; assay_version: string; assay_commitment: string; input_hash: string;
  result: 'accepted' | 'rejected' | 'error'; score?: number; bounded_labels?: Record<string, string | number | boolean>;
  output_hash: string; executed_at: string; signature: string;
}
export interface AssayInput {
  traceId: string; mandateId: string; assayId: string; version: string; threshold: number; features: TraceFeatures;
  eligibility: { provenance: boolean; credentials: boolean; outcomes: boolean; rights: boolean; policy: boolean };
  criteria?: { workflowTypes?: string[]; topicLabels?: string[]; minTurns?: number };
}
export interface BoundedAssayOutput { accepted: boolean; score?: number; labels?: { relevance: 'low' | 'medium' | 'high' }; }

export function validateAssayOutput(value: unknown): BoundedAssayOutput {
  try {
    // Reject getters, exotic prototypes, and non-JSON values before reading any field.
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 128 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const output = JSON.parse(encoded) as BoundedAssayOutput;
    if (Object.keys(output).some(key => !['accepted', 'score', 'labels'].includes(key)) || typeof output.accepted !== 'boolean' ||
        (output.score !== undefined && (!Number.isFinite(output.score) || output.score < 0 || output.score > 1)) ||
        (output.labels !== undefined && (!output.labels || typeof output.labels !== 'object' || Object.keys(output.labels).length !== 1 || !['low', 'medium', 'high'].includes(output.labels.relevance)))) throw new Error();
    return output;
  } catch { throw new Error('INVALID_ASSAY_OUTPUT'); }
}

export function assayCommitment(assayId: string, version: string, criteria: AssayInput['criteria'] = {}, threshold?: number): string {
  return canonicalHash({ assay_id: assayId, version, criteria, threshold: threshold ?? null, implementation: 'thot-reviewed-safe-features/1', input_scope: 'safe-features-v1', output_schema: 'accepted-score-relevance/1' });
}

/** Reviewed bounded code only. A hostile buyer cannot supply JavaScript, prompts, URLs, or tools. */
export class AssayRunner {
  private counts = new Map<string, number>(); private maxRuns: number; private maxInputBytes: number; private now: () => Date;
  constructor(options: { maxRunsPerPair?: number; maxInputBytes?: number; now?: () => Date } = {}) {
    this.maxRuns = options.maxRunsPerPair ?? 3; this.maxInputBytes = options.maxInputBytes ?? 16_000; this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.maxRuns) || this.maxRuns < 1 || this.maxRuns > 100 || !Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes < 1 || this.maxInputBytes > 64_000) throw new Error('INVALID_ASSAY_QUOTA');
  }
  run(input: AssayInput): AssayReceipt {
    // Required gate order is controlled by the service; these checks provide a second fail-closed boundary.
    if (!input?.eligibility || ['provenance', 'credentials', 'outcomes', 'rights', 'policy'].some(key => input.eligibility[key as keyof AssayInput['eligibility']] !== true)) throw new Error('ASSAY_INELIGIBLE');
    if (!['eligible', 'eligible_with_restrictions'].includes(input.features?.rights_status)) throw new Error('ASSAY_RIGHTS_DENIED');
    const criteria = input.criteria ?? {}; const commitment = assayCommitment(input.assayId, input.version, criteria, input.threshold);
    const inputHash = canonicalHash(input.features);
    let result: AssayReceipt['result'] = 'error'; let output: BoundedAssayOutput | undefined;
    try {
      if (input.assayId !== 'safe-features' || input.version !== '1') throw new Error('UNSUPPORTED_ASSAY');
      if (!input.traceId || !input.mandateId || input.features.trace_id !== input.traceId || input.features.schema_version !== 'trace.features/1' || !Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1) throw new Error('INVALID_ASSAY_INPUT');
      if (Buffer.byteLength(canonicalJson({ features: input.features, criteria })) > this.maxInputBytes) throw new Error('ASSAY_INPUT_QUOTA');
      if (Object.keys(criteria).some(key => !['workflowTypes', 'topicLabels', 'minTurns'].includes(key)) ||
          (criteria.workflowTypes && (criteria.workflowTypes.length > 9 || criteria.workflowTypes.some(value => !['coding', 'research', 'investment_research', 'legal_research', 'contract_review', 'chat', 'agent', 'other'].includes(value)))) ||
          (criteria.topicLabels && (criteria.topicLabels.length > 8 || criteria.topicLabels.some(value => !['coding', 'research', 'finance', 'law', 'contracts', 'science', 'education', 'other'].includes(value)))) ||
          (criteria.minTurns !== undefined && (!Number.isSafeInteger(criteria.minTurns) || criteria.minTurns < 1 || criteria.minTurns > 1000))) throw new Error('INVALID_ASSAY_CRITERIA');
      const key = canonicalHash({ trace: input.traceId, mandate: input.mandateId });
      const previous = this.counts.get(key) ?? 0;
      if (previous >= this.maxRuns) throw new Error('ASSAY_RUN_QUOTA');
      this.counts.set(key, previous + 1);
      const checks: boolean[] = [];
      if (criteria.workflowTypes?.length) checks.push(criteria.workflowTypes.includes(input.features.workflow_type));
      if (criteria.topicLabels?.length) checks.push(criteria.topicLabels.some(label => input.features.topic_labels.includes(label)));
      if (criteria.minTurns !== undefined) checks.push(input.features.counts.turns >= criteria.minTurns);
      const score = checks.length ? checks.filter(Boolean).length / checks.length : 1;
      output = validateAssayOutput({ accepted: score >= input.threshold, score, labels: { relevance: score < 0.34 ? 'low' : score < 0.67 ? 'medium' : 'high' } });
      result = output.accepted ? 'accepted' : 'rejected';
    } catch {
      // Error details may reveal input and are deliberately absent from the buyer receipt.
      result = 'error';
    }
    const publicOutput = output ?? { accepted: false };
    const unsigned: Omit<AssayReceipt, 'signature'> = {
      schema_version: 'trace.assay/1', assay_receipt_id: uuidv7(), mandate_id: input.mandateId, trace_id: input.traceId,
      assay_id: input.assayId, assay_version: input.version, assay_commitment: commitment, input_hash: inputHash,
      result, ...(output?.score === undefined ? {} : { score: output.score }), ...(output?.labels ? { bounded_labels: output.labels } : {}),
      output_hash: canonicalHash(publicOutput), executed_at: this.now().toISOString(),
    };
    return { ...unsigned, signature: signCanonical(unsigned, developmentSigningKeys('thot-development-assay').privateKey) };
  }
}
