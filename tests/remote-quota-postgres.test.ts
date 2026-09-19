import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {openPostgresAccounting,DEFAULT_REMOTE_QUOTAS} from '../packages/vault/src/remote-accounting.ts';
const url=process.env.THOT_QUOTA_TEST_DATABASE_URL;
test('separate PostgreSQL pools enforce shared reservations across replicas and application rollback',{skip:!url},async t=>{
  const namespace='test_'+randomUUID().replaceAll('-','');
  const limits={...DEFAULT_REMOTE_QUOTAS,userObjects:3,ownerObjects:3};
  await assert.rejects(openPostgresAccounting(url!,namespace,limits),/REMOTE_QUOTA_NAMESPACE_MISSING/);
  const [a,b]=await Promise.all([openPostgresAccounting(url!,namespace,limits,undefined,true),openPostgresAccounting(url!,namespace,limits,undefined,true)]);
  t.after(async()=>{await a.close();await b.close();});
  const results=await Promise.allSettled(Array.from({length:24},(_,i)=>(i%2?a:b).accounting.reserve('object_'+i,'alice',100,false)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
  assert.deepEqual((await b.accounting.usage('alice')).owner,{bytes:300,objects:3});
  const pool=new Pool({connectionString:url});t.after(()=>pool.end());
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Reservation commits independently while an application transaction is open.
    const otherNamespace=namespace+'_rollback';const c=await openPostgresAccounting(url!,otherNamespace,limits,undefined,true);t.after(()=>c.close());
    await c.accounting.reserve('surviving','alice',100,false);await client.query('ROLLBACK');
    assert.equal((await c.accounting.usage('alice')).owner.objects,1);
  }finally{client.release();}
});
