import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';

// Exercise the actual dashboard loader in Chromium's module map. Mock only the
// downloaded SDK and UI collaborators; an unresolved nested import cannot be
// reproduced by substituting a Promise-returning import function in a VM test.
const application = await readFile(new URL('../apps/dashboard/app.js', import.meta.url), 'utf8');
const loader = application.slice(application.indexOf('async function loadPrivyAuth()'), application.indexOf('\nfunction showIdentityLogin('));
assert.match(loader, /import\(`\.\/privy-auth\/v1\/\$\{attemptNamespace\}\/privy-auth\.bundle\.js`\)/);
const probe = `
const setTimeout=(callback,ms)=>window.setTimeout(callback,ms===30000?300:ms===90000?900:ms);
const clearTimeout=window.clearTimeout.bind(window);
let privyAuth=null,privyConfig={},privyLoading=null,privyLoginPhase='',privyLoginBusy=false,privyLoginRetry=false,privyImportRetry=0;
let walletLoginAttempt=0,signingOut=false,authMode='wallet_siwe';
const state={actor:null},walletAuth={},main=document.querySelector('main');
window.events={evaluated:[],created:[],logins:[],destroyed:[]};
const staleWorkspace=()=>new Error('stale workspace');
function showIdentityLogin(message){main.querySelector('#privy-login-status').textContent=message;main.querySelector('#privy-login-status').hidden=false;}
${loader}
main.querySelector('[data-privy-login]').addEventListener('click',()=>void openPrivyLogin());
window.fixture={ready:true};
`;
let browser;
before(async()=>{
  assert.ok(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must name the local Chromium executable');
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});

function sdk(namespace) {
  return `import {marker} from './privy-auth-chunks/shared.js';
window.events.evaluated.push(${namespace});
export function createPrivyAuth(){
  window.events.created.push(${namespace});
  return {initialize:async()=>{},mount(){},destroy(){window.events.destroyed.push(${namespace});},async login(){window.events.logins.push(${namespace});document.querySelector('#privy-wallet-choices').textContent=marker;}};
}`;
}

async function scenario(t,{target,initialFailure=false,progressChunks=0,progressTimeout=false}) {
  const requests=[],held=[],delays=new Set();
  const server=createServer((request,response)=>{
    requests.push(request.url);
    if(request.url==='/'){
      response.setHeader('Content-Type','text/html');
      response.end('<main><button data-privy-login>Sign in</button><p id="privy-login-status" hidden></p><div id="privy-wallet-choices"></div></main><script type="module" src="/probe.js"></script>');return;
    }
    if(request.url==='/probe.js'){response.setHeader('Content-Type','text/javascript');response.end(probe);return;}
    const match=request.url.match(/^\/privy-auth\/v1\/(\d+)\/(privy-auth\.bundle\.js|privy-auth-chunks\/(?:shared|step-\d+)\.js)$/);
    if(!match){response.statusCode=404;response.end();return;}
    const namespace=Number(match[1]),part=match[2]==='privy-auth.bundle.js'?'entry':'nested';
    let body=part==='entry'?sdk(namespace):'export const marker="Synthetic sign-in opened";';
    if(progressChunks&&namespace===0&&part==='nested'){
      const step=Number(match[2].match(/step-(\d+)/)?.[1]??0);
      if(step<progressChunks)body=`export {marker} from './step-${step+1}.js';`;
      const timer=setTimeout(()=>{delays.delete(timer);if(!response.destroyed){response.setHeader('Content-Type','text/javascript');response.end(body);}},120);
      delays.add(timer);return;
    }
    if(!progressChunks&&namespace===0&&part===target){
      if(initialFailure){response.statusCode=503;response.end();}
      else held.push({response,body});
      return;
    }
    response.setHeader('Content-Type','text/javascript');response.end(body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const page=await browser.newPage();const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  t.after(async()=>{for(const timer of delays)clearTimeout(timer);for(const {response}of held)response.destroy();await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.deepEqual(pageErrors,[]);});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.fixture?.ready);
  assert.equal(requests.filter(path=>path.startsWith('/privy-auth/')).length,0,'the SDK stays unloaded before the user clicks');
  const button=page.locator('[data-privy-login]');
  await button.click();
  if(progressChunks&&!progressTimeout){
    await page.waitForFunction(()=>window.events.logins.length===1);
    assert.deepEqual(await page.evaluate(()=>window.events.created),[0]);
    assert.deepEqual(await page.evaluate(()=>window.events.logins),[0]);
    const resourceCount=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/privy-auth/v1/0/')&&entry.initiatorType==='script').length);
    assert.equal(resourceCount,progressChunks+2,'Chromium reports each completed graph resource as script progress');
    return {page,held};
  }
  await page.waitForFunction(()=>document.querySelector('[data-privy-login]').textContent==='Try again');
  assert.match(await page.locator('#privy-login-status').textContent(),initialFailure?/could not download/:/download timed out/);
  assert.equal(await button.isEnabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.events.created),[]);
  await button.click();
  await page.waitForFunction(()=>window.events.logins.length===1);
  assert.equal(await page.locator('#privy-wallet-choices').textContent(),'Synthetic sign-in opened');
  assert.deepEqual(await page.evaluate(()=>window.events.created),[1]);
  assert.deepEqual(await page.evaluate(()=>window.events.logins),[1]);
  for(const path of ['/privy-auth/v1/0/privy-auth.bundle.js','/privy-auth/v1/1/privy-auth.bundle.js','/privy-auth/v1/1/privy-auth-chunks/shared.js']){
    assert.equal(requests.filter(request=>request===path).length,1,`one request for ${path}`);
  }
  if(target==='nested')assert.ok(requests.includes('/privy-auth/v1/0/privy-auth-chunks/shared.js'));
  return {page,held};
}

for(const target of ['entry','nested'])for(const lateResult of ['success','failure']){
  test(`retry escapes a pending ${target} import and ignores its late ${lateResult}`,async t=>{
    const {page,held}=await scenario(t,{target});
    assert.equal(held.length,1);
    const finished=page.waitForEvent(lateResult==='success'?'requestfinished':'requestfailed',{predicate:request=>request.url().includes('/privy-auth/v1/0/')&&request.url().endsWith(target==='entry'?'privy-auth.bundle.js':'shared.js')});
    for(const {response,body}of held){
      response.setHeader('Content-Type','text/javascript');response.statusCode=lateResult==='success'?200:503;response.end(lateResult==='success'?body:'');
    }
    await finished;
    if(lateResult==='success')await page.waitForFunction(()=>window.events.evaluated.includes(0));
    // Flush the failed module job too, so uncaught rejection/late mounting is observed.
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.deepEqual(await page.evaluate(()=>window.events.created),[1]);
    assert.deepEqual(await page.evaluate(()=>window.events.logins),[1]);
    assert.equal(await page.locator('#privy-wallet-choices').textContent(),'Synthetic sign-in opened');
  });
}

test('retry also escapes Chromium cached rejection of a nested chunk',async t=>{
  await scenario(t,{target:'nested',initialFailure:true});
});

test('real completed script resources allow a steadily advancing graph beyond the idle deadline',async t=>{
  await scenario(t,{progressChunks:3});
});

test('steady resource completions cannot keep the graph pending beyond its absolute ceiling',async t=>{
  await scenario(t,{progressChunks:7,progressTimeout:true});
});
