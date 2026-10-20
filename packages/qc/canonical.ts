import { createHash } from 'node:crypto';

export const QC_LIMITS = Object.freeze({ max_bytes: 2_000_000, max_turns: 1000, max_findings: 64 });
export class QcInputError extends Error {
  readonly code: 'input_limit_exceeded' | 'invalid_json';
  constructor(code: 'input_limit_exceeded' | 'invalid_json') { super(code); this.code = code; }
}

/** Bounded canonical JSON: sorted object keys, original array order, JSON values only. */
export function canonicalJson(value: unknown): string {
  const chunks: string[] = [], ancestors = new Set<object>();
  let bytes = 0, nodes = 0;
  const add = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > QC_LIMITS.max_bytes) throw new QcInputError('input_limit_exceeded');
    chunks.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64 || ++nodes > 100_000) throw new QcInputError('input_limit_exceeded');
    if (item === null || typeof item === 'boolean') { add(JSON.stringify(item)); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new QcInputError('invalid_json');
      add(JSON.stringify(item)); return;
    }
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > QC_LIMITS.max_bytes) throw new QcInputError('input_limit_exceeded');
      add(JSON.stringify(item)); return;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new QcInputError('invalid_json');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new QcInputError('invalid_json');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key === 'symbol')) throw new QcInputError('invalid_json');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (item.length > 10_000) throw new QcInputError('input_limit_exceeded');
      if (Object.keys(item).length !== item.length) throw new QcInputError('invalid_json');
      add('[');
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor)) throw new QcInputError('invalid_json');
        if (i) add(',');
        visit(descriptor.value, depth + 1);
      }
      add(']');
    } else {
      const keys = Object.keys(descriptors).sort();
      if (keys.length > 10_000) throw new QcInputError('input_limit_exceeded');
      add('{');
      keys.forEach((key, index) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !('value' in descriptor)) throw new QcInputError('invalid_json');
        if (index) add(',');
        add(JSON.stringify(key)); add(':'); visit(descriptor.value, depth + 1);
      });
      add('}');
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return chunks.join('');
}

export function contentDigest(content: unknown): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}
