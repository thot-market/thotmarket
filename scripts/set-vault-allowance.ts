import {openRemoteStorage} from '../packages/vault/src/remote-config.ts';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--owner'||args[2]!=='--bytes'||args[4]!=='--objects'||args[6]!=='--reason')throw Error('Usage: node scripts/set-vault-allowance.ts --owner ID --bytes NUMBER --objects NUMBER --reason TEXT');
if(!process.env.THOT_QUOTA_ADMIN_DATABASE_URL)throw Error('QUOTA_ADMIN_CREDENTIAL_REQUIRED');
const remote=await openRemoteStorage({...process.env,THOT_QUOTA_DATABASE_URL:process.env.THOT_QUOTA_ADMIN_DATABASE_URL,THOT_REMOTE_STORAGE_INITIALIZE:undefined});
if(!remote)throw Error('REMOTE_STORAGE_CONFIGURATION_REQUIRED');
try{
  const allowance=await remote.accounting.setOwnerAllowance(args[1]!,Number(args[3]),Number(args[5]),args[7]!);
  console.log(JSON.stringify({status:'ALLOWANCE_UPDATED',...allowance}));
}finally{await remote.close();}
