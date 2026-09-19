export function parseArguments(args: string[], valueKeys: string[], flags: string[] = []): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (result.has(key)) throw new Error('DUPLICATE_STORAGE_ARGUMENT');
    if (flags.includes(key)) { result.set(key, 'true'); continue; }
    const value = args[++i];
    if (!valueKeys.includes(key) || !value || value.startsWith('--')) throw new Error('INVALID_STORAGE_ARGUMENTS');
    result.set(key, value);
  }
  return result;
}
export function requireArgument(args: Map<string, string>, key: string): string { const value = args.get(key); if (!value) throw new Error('MISSING_STORAGE_ARGUMENT'); return value; }
export async function runStorageCli(operation: () => Promise<unknown>): Promise<void> {
  try { console.log(JSON.stringify(await operation(), null, 2)); }
  catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'STORAGE_OPERATION_FAILED';
    console.error(JSON.stringify({ success: false, error: code })); process.exitCode = 1;
  }
}
