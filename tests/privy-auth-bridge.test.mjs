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
let loginHooks, controller, modalBehavior='ready';
function modalContent(kind){
 let content=document.querySelector('#privy-modal-content');
 if(!content){content=document.createElement('div');content.id='privy-modal-content';document.body.appendChild(content);}
 content.innerHTML=kind==='ready'?'<input type="email" placeholder="Email"><button disabled>Submit</button>':kind==='wallet'?'<button>Continue with a wallet</button>':kind==='disabled'?'<input type="email" disabled><button disabled>Continue</button>':kind==='hidden'?'<input type="email" hidden><button style="display:none">Continue</button>':'<p>Loading</p><button aria-label="Close"><svg></svg></button>';
}
const sdk={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>snapshot,setLoginHooks:value=>{loginHooks=value;},login:()=>{calls.login++;modalContent(modalBehavior);},createWallet:async()=>{calls.createWallet++;}};
globalThis.__sdk=sdk;
let initialized='pending',providers='idle',opening='idle',errors=[];
function setState(patch){snapshot={auth:{...snapshot.auth,...(patch.ready===undefined?{}:{ready:patch.ready}),...(patch.authenticated===undefined?{}:{authenticated:patch.authenticated,user:patch.authenticated?user:null}),...(patch.otherUser?{user:{...user,id:'synthetic-b',linkedAccounts:[{type:'wallet',chainType:'ethereum',address:other}]}}:{})},wallet:{ready:patch.walletsReady??snapshot.wallet.ready,wallets:patch.hasWallet===undefined?snapshot.wallet.wallets:patch.hasWallet?[wallet]:[]},modal:{isOpen:patch.modalOpen??snapshot.modal.isOpen}};for(const listener of listeners)listener();}
const target=document.querySelector('#choices');
window.fixture={calls,errors,setState,async start({deadline=5000,modal='ready',...state}={}){modalBehavior=modal;setState(state);controller=createPrivyAuth({document,window:{setTimeout:(callback,ms)=>window.setTimeout(callback,ms===30000?deadline:ms),clearTimeout:window.clearTimeout.bind(window)},config:{app_id:'syntheticprivyapplication123456',chain_id:31337,rpc_url:'https://rpc.example.test'},walletAuth:{async signOut(){calls.signOut++;},async signInProvider(){calls.signIn++;return true;}},onError:error=>errors.push(error.message)});controller.mount(target);controller.initialize().then(()=>{initialized='ready';},error=>{initialized=error.message;});},modalContent,beginLogin(){opening='pending';controller.login().then(()=>{opening='resolved';},error=>{opening={message:error.message,code:error.code};});},login:()=>controller.login(),destroy:()=>controller.destroy(),complete:()=>loginHooks.onComplete({loginAccount:{type:'email'}}),get status(){return{initialized,providers,opening,calls:{...calls},errors:[...errors]};},providers(){providers='pending';controller.providers(address).then(value=>{providers=value.length;},error=>{providers=error.message;});}};
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

for(const modal of ['loading','disabled','hidden'])test(`initial ${modal} modal does not resolve as a usable sign-in form and has a recoverable opening deadline`,async t=>{
  const page=await pageFor(t,{ready:true,modal,deadline:120});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.beginLogin());
  await page.waitForFunction(()=>window.fixture.status.opening?.code==='PRIVY_LOGIN_OPEN_FAILED');
  const result=await status(page);assert.match(result.opening.message,/Sign-in options could not load/);
  assert.equal(result.calls.login,1);assert.equal(result.calls.signIn,0);assert.equal(result.calls.provider,0);
});

for(const controls of ['ready','wallet'])test(`opening waits for visible usable ${controls} controls, then stops timing the user's login`,async t=>{
  const page=await pageFor(t,{ready:true,modal:'loading',deadline:300});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.beginLogin());await page.waitForTimeout(25);
  assert.equal((await status(page)).opening,'pending');
  await page.evaluate(controls=>window.fixture.modalContent(controls),controls);
  await page.waitForFunction(()=>window.fixture.status.opening==='resolved');
  await page.waitForTimeout(350);
  assert.equal((await status(page)).opening,'resolved');assert.deepEqual((await status(page)).errors,[]);
  assert.equal((await status(page)).calls.signIn,0);
});

for(const ending of ['cancel','destroy'])test(`${ending} while modal code is loading settles and cleans up the opening waiter without a load error`,async t=>{
  const page=await pageFor(t,{ready:true,modal:'loading',deadline:200});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>{window.fixture.setState({modalOpen:true});window.fixture.beginLogin();});
  await page.waitForTimeout(25);assert.equal((await status(page)).opening,'pending');
  await page.evaluate(ending=>ending==='destroy'?window.fixture.destroy():window.fixture.setState({modalOpen:false}),ending);
  await page.waitForFunction(()=>window.fixture.status.opening==='resolved');
  await page.waitForTimeout(250);assert.deepEqual((await status(page)).errors,[]);
  assert.equal((await status(page)).calls.signIn,0);
});

test('already authenticated wallet selection is independent of the anonymous modal deadline',async t=>{
  const page=await pageFor(t,{ready:true,authenticated:true,walletsReady:true,hasWallet:true,modal:'loading',deadline:100});
  await page.waitForFunction(()=>window.fixture.status.initialized==='ready');
  await page.evaluate(()=>window.fixture.beginLogin());
  await page.waitForFunction(()=>window.fixture.status.opening==='resolved'&&window.fixture.status.calls.signIn===1);
  assert.equal((await status(page)).calls.login,0);assert.deepEqual((await status(page)).errors,[]);
});
