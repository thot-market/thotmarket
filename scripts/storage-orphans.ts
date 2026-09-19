import { inventoryOrphans, restoreQuarantinedObjects } from '../packages/operations/src/index.ts';
import { parseArguments, requireArgument, runStorageCli } from '../packages/operations/src/cli.ts';
await runStorageCli(async () => {
  const args = parseArguments(process.argv.slice(2), ['--data-dir', '--restore-quarantine'], ['--quarantine']);
  const dataDir = requireArgument(args, '--data-dir');
  if (args.has('--restore-quarantine')) { if (args.has('--quarantine')) throw new Error('INVALID_STORAGE_ARGUMENTS'); const r = await restoreQuarantinedObjects({ dataDir, quarantineId: args.get('--restore-quarantine')! }); return { restored: r.restored.slice(0, 200), restoredCount: r.restored.length, output_limit: 200 }; }
  const r = await inventoryOrphans({ dataDir, quarantine: args.has('--quarantine') });
  return { ...r, candidates: r.candidates.slice(0, 200), review: r.review.slice(0, 200), missingReferenced: r.missingReferenced.slice(0, 200), quarantined: r.quarantined.slice(0, 200),
    counts: { candidates: r.candidates.length, review: r.review.length, missingReferenced: r.missingReferenced.length, quarantined: r.quarantined.length }, output_limit: 200 };
});
