/** Monetary wire values use integer minor units, encoded as canonical decimal strings. */
export function parseMoney(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError('Money must be a nonnegative canonical integer string in minor units');
  }
  return BigInt(value);
}

export function formatMoney(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('Money must be a nonnegative bigint');
  return value.toString();
}

/** Explicit decimal conversion for boundary adapters; never accepts floating-point input. */
export function parseDecimalMoney(value: string, decimals = 6): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new TypeError('Invalid currency decimals');
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new TypeError('Invalid decimal money string');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new TypeError('Money has more fractional digits than the currency permits');
  return BigInt(whole!) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
