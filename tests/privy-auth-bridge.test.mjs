import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';

// Real React effects/portals, with only the external Privy SDK mocked. No auth
// service, wallet, provider request, or external network is used by this fixture.
const fixture = `
import React, {useSyncExternalStore} from 'react';
import {createPrivyAuth} from './apps/dashboard/privy-auth-entry.js';
const address='0x'+'a'.repeat(40), other='0x'+'b'.repeat(40);
const listeners=new Set();
const calls={login:0,signOut:0,signIn:0,provider:0,switchChain:0,createWallet:0};
const provider={fixture:true};
const wallet={address,walletClientType:'privy',switchChain:async()=>{calls.switchChain++;},getEthereumProvider:async()=>{calls.provider++;return provider;}};
const user={id:'synthetic-a',linkedAccounts:[{type:'wallet',chainType:'ethereum',address}]};
let snapshot={auth:{ready:false,authenticated:false,user:null,logout:async()=>{},linkWallet(){}},wallet:{ready:false,wallets:[]},modal:{isOpen:false}};
let loginHooks, controller;
const sdk={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>snapshot,setLoginHooks:value=>{loginHooks=value;},login:()=>{calls.login++;},createWallet:async()=>{calls.createWallet++;}};
globalThis.__sdk=sdk;
let initialized='pending',providers='idle',errors=[];
function setState(patch){snapshot={auth:{...snapshot.auth,...(patch.ready===undefined?{}:{ready:patch.ready}),...(patch.authenticated===undefined?{}:{authenticated:patch.authenticated,user:patch.authenticated?user:null}),...(patch.otherUser?{user:{...user,id:'synthetic-b',linkedAccounts:[{type:'wallet',chainType:'ethereum',address:other}]}}:{})},wallet:{ready:patch.walletsReady??snapshot.wallet.ready,wallets:patch.hasWallet===undefined?snapshot.wallet.wallets:patch.hasWallet?[wallet]:[]},modal:{isOpen:patch.modalOpen??snapshot.modal.isOpen}};for(const listener of listeners)listener();}
const target=document.querySelector('#choices');
window.fixture={calls,errors,setState,async start({deadline=5000,...state}={}){setState(state);controller=createPrivyAuth({document,window:{setTimeout:(callback,ms)=>window.setTimeout(callback,ms===30000?deadline:ms),clearTimeout:window.clearTimeout.bind(window)},config:{app_id:'syntheticprivyapplication123456',chain_id:31337,rpc_url:'https://rpc.example.test'},walletAuth:{async signOut(){calls.signOut++;},async signInProvider(){calls.signIn++;return true;}},onError:error=>errors.push(error.message)});controller.mount(target);controller.initialize().then(()=>{initialized='ready';},error=>{initialized=error.message;});},login:()=>controller.login(),destroy:()=>controller.destroy(),complete:()=>loginHooks.onComplete({loginAccount:{type:'email'}}),get status(){return{initialized,providers,calls:{...calls},errors:[...errors]};},providers(){providers='pending';controller.providers(address).then(value=>{providers=value.length;},error=>{providers=error.message;});}};
`;
const mockSdk = `
import React, {useSyncExternalStore} from 'react';
const sdk=()=>globalThis.__sdk;
const state=()=>useSyncExternalStore(sdk().subscribe,sdk().getSnapshot);
export const PrivyProvider=({children})=>React.createElement(React.Fragment,null,children);
export const usePrivy=()=>state().auth;
export const useWallets=()=>state().wallet;
export const useModalStatus=()=>state().modal;
export function useLogin(callbacks){sdk().setLoginHooks(callbacks);return{login:sdk().login};}
export const useCreateWallet=()=>({createWallet:sdk().createWallet});
`;
let browser, code;
before(async()=>{
  assert.ok(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must name the local Chromium executable');
  const result=await build({stdin:{contents:fixture,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'privy-bridge-fixture.js'},bundle:true,write:false,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'mock-privy-only',setup(build){build.onResolve({filter:/^@privy-io\/react-auth$/},()=>({path:'mock-privy',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:mockSdk,resolveDir:fileURLToPath(new URL('../',import.meta.url))}));}}]});
  code=result.outputFiles[0].text;
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});
async function pageFor(t,state){
  const page=await browser.newPage();t.after(()=>page.close());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.route('**/*',route=>route.abort());
  await page.setContent('<main><div id="choices"></div></main>');
  await page.addScriptTag({type:'module',content:code});
  await page.waitForFunction(()=>Boolean(window.fixture));
  await page.evaluate(state=>window.fixture.start(state),state);
  return page;
}
const status=page=>page.evaluate(()=>window.fixture.status);

test('anonymous auth readiness opens login before connected wallets are ready, and modal cancellation permits retry',async t=>{
  const page=await pageFor(t,{});
  await assert.rejects(page.evaluate(()=>window.fixture.login()),/still loading/);
  assert.equal((await status(page)).initialized,'pending');
  await page.evaluate(()=>window.fixture.setState({ready:true,walletsReady:false}));
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.login());
  await page.evaluate(()=>window.fixture.login());
  assert.equal((await status(page)).calls.login,1);
  assert.equal((await status(page)).calls.provider,0);
  await page.evaluate(()=>window.fixture.setState({modalOpen:true}));
  await page.waitForTimeout(20);
  await page.evaluate(()=>window.fixture.setState({modalOpen:false}));
  await page.waitForTimeout(20);
  await page.evaluate(()=>window.fixture.login());
  assert.equal((await status(page)).calls.login,2);
});

test('authenticated startup still waits for wallet readiness and reports a bounded failure',async t=>{
  const page=await pageFor(t,{ready:true,authenticated:true,walletsReady:false,hasWallet:true,deadline:100});
  await assert.rejects(page.evaluate(()=>window.fixture.login()),/still loading/);
  await page.waitForFunction(()=>window.fixture.status.initialized.includes('did not load'));
  const result=await status(page);assert.equal(result.calls.signIn,0);assert.equal(result.calls.provider,0);
});

test('sign-in after anonymous initialization waits for wallets before signing and never offers to create a premature wallet',async t=>{
  const page=await pageFor(t,{ready:true});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.login());
  await page.evaluate(()=>{window.fixture.setState({authenticated:true});window.fixture.complete();});
  await page.waitForTimeout(25);
  assert.equal((await status(page)).calls.signIn,0);
  assert.equal(await page.locator('#choices').textContent(),'');
  await page.evaluate(()=>window.fixture.setState({walletsReady:true,hasWallet:true}));
  await page.waitForFunction(()=>window.fixture.status.calls.signIn===1);
  await page.waitForTimeout(25);
  assert.equal((await status(page)).calls.signIn,1);
  assert.equal((await status(page)).calls.switchChain,1);
});

test('provider restore waits for wallets even when anonymous initialization already resolved',async t=>{
  const page=await pageFor(t,{ready:true});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.setState({authenticated:true,hasWallet:true}));
  await page.waitForTimeout(20);
  await page.evaluate(()=>window.fixture.providers());
  await page.waitForTimeout(20);
  assert.equal((await status(page)).providers,'pending');assert.equal((await status(page)).calls.provider,0);
  await page.evaluate(()=>window.fixture.setState({walletsReady:true}));
  await page.waitForFunction(()=>window.fixture.status.providers===1);
  assert.equal((await status(page)).calls.provider,1);assert.equal((await status(page)).calls.signIn,0);
});

for(const change of ['destroy','otherUser'])test(`waiting provider restore returns no old provider after ${change}`,async t=>{
  const page=await pageFor(t,{ready:true});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.setState({authenticated:true,hasWallet:true}));
  await page.waitForTimeout(20);await page.evaluate(()=>window.fixture.providers());
  await page.evaluate(change=>change==='destroy'?window.fixture.destroy():window.fixture.setState({otherUser:true}),change);
  await page.waitForFunction(()=>window.fixture.status.providers===0);
  await page.evaluate(()=>window.fixture.setState({walletsReady:true}));
  assert.equal((await status(page)).calls.provider,0);assert.equal((await status(page)).calls.signIn,0);
});

test('wallet readiness after initialized login has its own bounded provider-restore timeout',async t=>{
  const page=await pageFor(t,{ready:true,deadline:100});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.setState({authenticated:true,hasWallet:true}));
  await page.waitForTimeout(20);await page.evaluate(()=>window.fixture.providers());
  await page.waitForFunction(()=>typeof window.fixture.status.providers==='string'&&window.fixture.status.providers.includes('still loading'));
  await page.evaluate(()=>window.fixture.setState({walletsReady:true}));
  assert.equal((await status(page)).calls.provider,0);assert.equal((await status(page)).calls.signIn,0);
});
