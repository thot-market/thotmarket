import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {runInNewContext} from 'node:vm';
const root=new URL('../integrations/robinhood-browser-extension/',import.meta.url),main=await readFile(new URL('main-hook.js',root),'utf8'),worker=await readFile(new URL('service-worker.js',root),'utf8'),manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
test('manifest grants only Robinhood-page and private-loopback access',()=>{assert.deepEqual(manifest.permissions,[]);assert.deepEqual(manifest.host_permissions,['https://robinhood.com/*','http://127.0.0.1/*']);assert.deepEqual(manifest.content_scripts.map((entry:any)=>entry.matches),[['https://robinhood.com/*'],['https://robinhood.com/*']]);});
test('main hook preserves fetch result and relays only successful API GET bearer after arm',async()=>{
  const messages:any[]=[],listeners:any[]=[];class X{};
  const response={status:200};const window:any={fetch:async()=>response,postMessage:(value:any)=>messages.push(value),addEventListener:(_type:string,fn:any)=>listeners.push(fn)};(X as any).prototype.open=function(){};(X as any).prototype.setRequestHeader=function(){};(X as any).prototype.send=function(){};(X as any).prototype.addEventListener=function(){};
  const context:any={window,XMLHttpRequest:X,Request,URL,location:{href:'https://robinhood.com/'}};runInNewContext(main,context);
  const original=await window.fetch('https://api.robinhood.com/accounts/',{method:'GET',headers:{Authorization:'Bearer before-arm'}});assert.equal(original,response);assert.equal(messages.length,0);
  listeners[0]({source:window,origin:'https://robinhood.com',data:{source:'thot-robinhood-extension',type:'arm',nonce:'a'.repeat(64)}});
  await window.fetch('https://api.robinhood.com/accounts/',{method:'GET',headers:{Authorization:'Bearer once'}});await window.fetch('https://api.robinhood.com/orders/',{method:'POST',headers:{Authorization:'Bearer no'}});await window.fetch('https://example.com/',{method:'GET',headers:{Authorization:'Bearer no'}});
  assert.equal(messages.filter(value=>value.type==='token').length,1);assert.equal(messages.find(value=>value.type==='token').token,'once');
});
test('service worker checks readiness and delivers at most once to the configured loopback capability',async()=>{
  const listener:any={},requests:any[]=[];const event=(name:string)=>({addListener(fn:any){listener[name]=fn;}});const chrome:any={runtime:{onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')}};
  const context:any={URL,AbortController,chrome,globalThis:null,importScripts(){},setInterval(){},setTimeout,clearTimeout,fetch:async(url:string,options:any)=>{requests.push({url,options});return{ok:true,json:async()=>({ready:true})};}};context.globalThis=context;context.THOT_ROBINHOOD_CONFIG={bridgeUrl:'http://127.0.0.1:18769/'+'b'.repeat(64)};runInNewContext(worker,context);await new Promise(resolve=>setImmediate(resolve));
  const sender={url:'https://robinhood.com/'},message={type:'thot-robinhood-token',token:'secret'};listener.message(message,sender,()=>{});listener.message(message,sender,()=>{});await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  const captures=requests.filter(request=>request.url.endsWith('/capture'));assert.equal(captures.length,1);assert.deepEqual(JSON.parse(captures[0].options.body),{token:'secret'});assert.ok(requests.every(request=>request.url.startsWith('http://127.0.0.1:18769/')));
});
