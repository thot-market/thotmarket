import {ensure} from '../../storage/src/index.ts';
import type {Actor,ThotService} from './service.ts';

/** Fixed aggregates only: no document fields, identifiers, errors or object opens. */
export async function maintenanceStats(service:ThotService,actor:Actor){
  ensure(actor.role==='operator_maintenance'||actor.role==='operator_security','FORBIDDEN',403);
  const result=await service.db.query(`SELECT
    (SELECT count(*)::text FROM traces) AS traces,
    (SELECT count(*)::text FROM agent_captures) AS capture_attempts,
    (SELECT count(*)::text FROM trace_objects) AS trace_objects,
    (SELECT count(*)::text FROM licenses) AS licenses,
    (SELECT count(*)::text FROM deliveries) AS deliveries,
    (SELECT count(*)::text FROM storage_write_attempts WHERE status='active') AS active_storage_attempts,
    (SELECT count(*)::text FROM storage_write_attempts a, jsonb_array_elements(a.objects) item WHERE a.status='abandoned' AND item->>'status'='pending') AS unresolved_storage_objects`);
  return {schema_version:'thot.maintenance-stats/1',counts:result.rows[0],timings:{scope:'current_process',transactions:service.transactionTimings?.snapshot(),objects:service.staged.metrics()}};
}
