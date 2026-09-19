importScripts('config.js');
const FETCH_TIMEOUT_MS=5_000,READY_POLL_MS=3_000;
let bridgeBase=null,bridgeReady=false,delivered=false;
function configuredBridge(value){try{const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||!/^\/([a-f0-9]{64})\/?$/.test(url.pathname))return null;return url.href.replace(/\/$/,'');}catch{return null;}}
bridgeBase=configuredBridge(globalThis.THOT_ROBINHOOD_CONFIG?.bridgeUrl);
async function localFetch(path,options={}){if(!bridgeBase)throw new Error('bridge_unavailable');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);try{return await fetch(bridgeBase+path,{...options,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'});}finally{clearTimeout(timer);}}
async function checkReady(){if(!bridgeBase){bridgeReady=false;return false;}try{const response=await localFetch('/ready',{method:'GET',headers:{Accept:'application/json'}}),value=response.ok?await response.json():null,next=value?.ready===true;if(!next)delivered=false;bridgeReady=next;return next;}catch{bridgeReady=false;delivered=false;return false;}}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.url?.startsWith('https://robinhood.com/')!==true)return;
  if(message?.type==='thot-robinhood-ready'){void checkReady().then(ready=>reply({ready}));return true;}
  if(message?.type!=='thot-robinhood-token'||delivered||typeof message.token!=='string'||!/^[^\s\r\n]{1,8192}$/.test(message.token))return;
  void checkReady().then(async ready=>{if(!ready||delivered)return;delivered=true;try{const response=await localFetch('/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:message.token})});if(!response.ok)delivered=false;}catch{delivered=false;}});
});
chrome.runtime.onStartup.addListener(()=>void checkReady());chrome.runtime.onInstalled.addListener(()=>void checkReady());void checkReady();setInterval(()=>void checkReady(),READY_POLL_MS);
