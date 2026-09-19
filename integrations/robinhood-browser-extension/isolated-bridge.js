const channelNonce=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
let armed=false;
function armWhenReady(){chrome.runtime.sendMessage({type:'thot-robinhood-ready'},response=>{if(chrome.runtime.lastError||response?.ready!==true||armed)return;window.postMessage({source:'thot-robinhood-extension',type:'arm',nonce:channelNonce},'https://robinhood.com');});}
window.addEventListener('message',event=>{if(event.source!==window||event.origin!=='https://robinhood.com'||event.data?.source!=='thot-robinhood-main'||event.data?.nonce!==channelNonce)return;if(event.data.type==='armed'){armed=true;return;}if(event.data.type==='token'&&armed&&typeof event.data.token==='string')chrome.runtime.sendMessage({type:'thot-robinhood-token',token:event.data.token});});
armWhenReady();setInterval(armWhenReady,1_000);
