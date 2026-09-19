import { createHash } from 'node:crypto';

/** Canonical wire JSON: recursively sorted keys; bigint values are decimal strings. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function encode(input: unknown, depth: number): string {
    if (depth > 100) throw new TypeError('Canonical JSON exceeds maximum nesting depth');
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'bigint') return JSON.stringify(input.toString());
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input))) {
        throw new TypeError('Canonical JSON numbers must be finite and integer values must be safe');
      }
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') throw new TypeError(`Unsupported canonical JSON value: ${typeof input}`);
    if (active.has(input)) throw new TypeError('Canonical JSON cannot contain cycles');
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new TypeError('Canonical JSON requires plain objects');
    }
    if (Object.getOwnPropertySymbols(input).length) throw new TypeError('Canonical JSON cannot contain symbol keys');
    active.add(input);
    try {
      if (Array.isArray(input)) {
        for (let i = 0; i < input.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, i);
          if (!descriptor) throw new TypeError('Canonical JSON cannot contain sparse arrays');
          if (!('value' in descriptor)) throw new TypeError('Canonical JSON cannot contain accessors');
        }
        return '[' + input.map(item => encode(item, depth + 1)).join(',') + ']';
      }
      const descriptors = Object.getOwnPropertyDescriptors(input);
      return '{' + Object.keys(input).sort().map(key => {
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor)) throw new TypeError('Canonical JSON cannot contain accessors');
        return JSON.stringify(key) + ':' + encode(descriptor.value, depth + 1);
      }).join(',') + '}';
    } finally {
      active.delete(input);
    }
  }
  return encode(value, 0);
}

/** Lowercase SHA-256 hex digest of the UTF-8 canonical wire representation. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export const hashCanonical = canonicalHash;
