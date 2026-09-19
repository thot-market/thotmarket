import { createOfflineBackup } from '../packages/operations/src/index.ts';
import { parseArguments, requireArgument, runStorageCli } from '../packages/operations/src/cli.ts';
await runStorageCli(async () => {
  const args = parseArguments(process.argv.slice(2), ['--data-dir', '--output']);
  return createOfflineBackup({ dataDir: requireArgument(args, '--data-dir'), backupDir: requireArgument(args, '--output') });
});
