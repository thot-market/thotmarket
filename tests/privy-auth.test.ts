import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module
import {eligiblePrivyWallets, selectPrivyWallet, validatePrivyConfig} from '../apps/dashboard/privy-auth-state.js';

const a='0x'+'a'.repeat(40),b='0x'+'b'.repeat(40),c='0x'+'c'.repeat(40);
const wallet=(address:string,type='privy')=>({address,walletClientType:type,getEthereumProvider:async()=>({})});
const user={id:'did:privy:fixture',linkedAccounts:[{type:'wallet',chainType:'ethereum',address:a},{type:'wallet',chainType:'ethereum',address:b}]};
test('Privy ignores unlinked connected wallets and Solana accounts',()=>{
  const candidates=[wallet(a),wallet(c),wallet(a.toUpperCase().replace('0X','0x')),{address:'solana-account',getEthereumProvider:async()=>({})}];
  assert.deepEqual(eligiblePrivyWallets(user,candidates).map((w:any)=>w.address),[a]);
  assert.deepEqual(eligiblePrivyWallets(null,candidates),[]);
  assert.deepEqual(eligiblePrivyWallets({linkedAccounts:[{type:'wallet',chainType:'solana',address:a}]},candidates),[]);
});
test('multiple linked wallets require explicit choice and never fall back to an unrelated address',()=>{
  const candidates=[wallet(a),wallet(b,'metamask')];
  assert.equal(selectPrivyWallet(user,candidates),null);
  assert.equal(selectPrivyWallet(user,candidates,b).address,b);
  assert.throws(()=>selectPrivyWallet(user,candidates,c),/not connected/);
  assert.equal(selectPrivyWallet(user,[wallet(a)]).address,a);
});
test('Privy public config admits app/client identifiers and drops every unneeded field',()=>{
  assert.deepEqual(validatePrivyConfig({app_id:'cmu2kc1sv03370dla944rfnb7',chain_id:46630,rpc_url:'https://rpc.testnet.chain.robinhood.com',secret:'never-client-side',role:'operator_security'}),{appId:'cmu2kc1sv03370dla944rfnb7',chainId:46630,rpcUrl:'https://rpc.testnet.chain.robinhood.com/'});
  assert.deepEqual(validatePrivyConfig({app_id:'cmu2kc1sv03370dla944rfnb7',chain_id:4663,rpc_url:'https://rpc.mainnet.chain.robinhood.com'}),{appId:'cmu2kc1sv03370dla944rfnb7',chainId:4663,rpcUrl:'https://rpc.mainnet.chain.robinhood.com/'});
  const rpc='https://thot.example.test/rpc/'+'r'.repeat(43);
  assert.deepEqual(validatePrivyConfig({app_id:'cmu2kc1sv03370dla944rfnb7',client_id:'client-public-fixture',chain_id:31337,rpc_url:rpc}),{appId:'cmu2kc1sv03370dla944rfnb7',clientId:'client-public-fixture',chainId:31337,rpcUrl:rpc});
  for(const config of [{app_id:'https://evil.test',chain_id:46630},{app_id:'cmu2kc1sv03370dla944rfnb7',client_id:'" unsafe-inline',chain_id:46630},{app_id:'',chain_id:46630},{app_id:'cmu2kc1sv03370dla944rfnb7',chain_id:1},{app_id:'cmu2kc1sv03370dla944rfnb7',chain_id:4663,rpc_url:'https://rpc.testnet.chain.robinhood.com'},{app_id:'cmu2kc1sv03370dla944rfnb7'}])assert.throws(()=>validatePrivyConfig(config),/not configured/);
});
