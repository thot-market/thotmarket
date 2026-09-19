(()=>{
  let nonce=null;
  const apiGet=request=>request.method==='GET'&&new URL(request.url).origin==='https://api.robinhood.com';
  const bearer=value=>{const match=typeof value==='string'&&/^Bearer ([^\s\r\n]{1,8192})$/.exec(value);return match?.[1]??null;};
  const relay=token=>{if(nonce&&token)window.postMessage({source:'thot-robinhood-main',type:'token',nonce,token},'https://robinhood.com');};
  window.addEventListener('message',event=>{if(event.source!==window||event.origin!=='https://robinhood.com'||event.data?.source!=='thot-robinhood-extension'||event.data?.type!=='arm'||!/^[a-f0-9]{64}$/.test(event.data?.nonce))return;nonce=event.data.nonce;window.postMessage({source:'thot-robinhood-main',type:'armed',nonce},'https://robinhood.com');});
  const nativeFetch=window.fetch;
  window.fetch=function(...args){let observed=null;if(nonce){try{const request=new Request(args[0],args[1]);if(apiGet(request))observed=bearer(request.headers.get('authorization'));}catch{}}return nativeFetch.apply(this,args).then(response=>{if(response.status===200)relay(observed);return response;});};
  const requests=new WeakMap(),nativeOpen=XMLHttpRequest.prototype.open,nativeHeader=XMLHttpRequest.prototype.setRequestHeader,nativeSend=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url,...rest){let target=null;try{target=new URL(String(url),location.href).href;}catch{}requests.set(this,{method:String(method).toUpperCase(),url:target,token:null});return nativeOpen.call(this,method,url,...rest);};
  XMLHttpRequest.prototype.setRequestHeader=function(name,value){const record=requests.get(this);if(record&&nonce&&String(name).toLowerCase()==='authorization')record.token=bearer(String(value));return nativeHeader.call(this,name,value);};
  XMLHttpRequest.prototype.send=function(...args){const record=requests.get(this);if(record)this.addEventListener('loadend',()=>{requests.delete(this);if(this.status===200&&record.url){try{if(apiGet(new Request(record.url,{method:record.method})))relay(record.token);}catch{}}},{once:true});return nativeSend.apply(this,args);};
})();
