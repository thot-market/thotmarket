import { restoreOfflineBackup, verifyOfflineBackup } from '../packages/operations/src/index.ts';
import { parseArguments, requireArgument, runStorageCli } from '../packages/operations/src/cli.ts';
await runStorageCli(async () => {
  const args = parseArguments(process.argv.slice(2), ['--backup', '--data-dir', '--manifest-sha256'], ['--verify-only']);
  const input = { backupDir: requireArgument(args, '--backup'), expectedManifestHash: requireArgument(args, '--manifest-sha256') };
  if (args.has('--verify-only')) { if (args.has('--data-dir')) throw new Error('INVALID_STORAGE_ARGUMENTS'); const verified = await verifyOfflineBackup(input); return { verified: true, manifestHash: verified.manifestHash, entries: verified.manifest.entries.length }; }
  return restoreOfflineBackup({ ...input, dataDir: requireArgument(args, '--data-dir') });
});
