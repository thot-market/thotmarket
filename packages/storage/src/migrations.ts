// One ordered manifest for startup, cold snapshots and maintenance schema checks.
export const MIGRATION_FILES = ['001_initial.sql', '002_inference.sql', '003_operations.sql', '004_agent_capture.sql', '005_thot.sql', '006_staged_storage.sql', '007_trace_qc.sql', '008_auth_market_indexes.sql'] as const;
export const MIGRATION_VERSIONS: readonly string[] = MIGRATION_FILES.map(name=>name.slice(0,3));
export const CURRENT_MIGRATION = MIGRATION_VERSIONS.at(-1)!;
