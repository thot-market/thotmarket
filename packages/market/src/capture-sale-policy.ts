import {ensure,type Document,type Transaction} from '../../storage/src/index.ts';

/** Server-owned capture/device binding. A CLI bearer cannot choose or widen a sale mandate. */
export async function assertCaptureSaleAuthority(tx:Transaction,trace:Document,now:string) {
  if(!trace.capture_device_id)return;
  const device=await tx.maybe('auth_access','capture-device:'+trace.capture_device_id);
  const policy=typeof trace.sale_policy_id==='string'?await tx.maybe('thot_records',trace.sale_policy_id):undefined;
  ensure(device?.kind==='capture_device'&&device.owner_id===trace.owner_id&&!device.revoked_at&&device.expires_at>now&&
    device.sale_policy_id===trace.sale_policy_id&&policy?.kind==='stream_policy'&&policy.owner_id===trace.owner_id&&
    policy.capture_device_id===device.device_id&&policy.capture_client===device.client&&policy.active===true&&!policy.revoked&&typeof policy.signature==='string'&&
    policy.authorization.validUntil>Math.floor(Date.parse(now)/1000),'CAPTURE_SALES_UNAVAILABLE',409);
  // Only a completed, fully readable and assessed release can be sold under a
  // standing mandate. Pending/error projections can be retried after rebuild;
  // the original recording remains private in the meantime.
  if(trace.agent_capture_id)ensure(trace.capture_state==='COMPLETED'&&trace.projection?.status==='READY'&&trace.release_preparation?.status==='READY','CAPTURE_RELEASE_NOT_READY',409);
}
