import {verifyProxyCapture} from './agent-capture-ui.js';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const bytes=text=>new TextEncoder().encode(text).byteLength;
/** Sequential export; caller owns authentication checks and user-selected storage.
 * export.json is written last so a partial download cannot look like a full copy. */
export async function writeCaptureExport({captureId,api,write,readAsset,checkOwner=()=>{},progress=()=>{}}){
 const proof=await api('/v1/contributor/agent-captures/'+encodeURIComponent(captureId)+'/proof');checkOwner();
 const {tee_evidence:evidence,...bundle}=proof.bundle??{};
 if(bundle.format!=='thot.proxy-capture/2'||!evidence||bundle.capture_id!==captureId)throw Error('This export needs a signed multipart capture.');
 const a=evidence.attestation,value={format:'thot.capture-export/1',bundle,evidence:{statement:evidence.statement,signature:evidence.signature,attestation:{statement:a.statement,...(a.quote!==undefined?{quote:a.quote}:{}),...(a.event_log!==undefined?{event_log:a.event_log}:{})}}};
 let total=0;
 const save=async(name,v,limit)=>{checkOwner();const text=canonical(v)+'\n',size=bytes(text);total+=size;if(size>limit||total>1024*1024*1024)throw Error('This capture exceeds the portable export limit.');await write(name,text);checkOwner();};
 const checked=await verifyProxyCapture(proof.bundle,async sequence=>{checkOwner();const {part}=await api('/v1/contributor/agent-captures/'+encodeURIComponent(captureId)+'/proof/parts/'+sequence);checkOwner();await save('parts/'+sequence+'.json',part,60*1024*1024);progress(sequence,bundle.parts.length);return part;});
 if(!checked.tee)throw Error('Recorder seal is missing.');
 for(const name of ['verify.mjs','canonical.mjs','hardware.mjs','verify_dcap.py','requirements.txt','README.txt']){const text=await readAsset(name);checkOwner();if(bytes(text)>200000)throw Error('Verifier file exceeds its size limit.');await write(name,text);checkOwner();}
 await save('export.json',value,2_000_000);
 return checked;
}
export async function chooseEmptyExportDirectory(picker){
 const dir=await picker({mode:'readwrite',id:'thot-private-export'});
 for await(const _entry of dir.keys())throw Error('Choose an empty folder so existing files are preserved.');
 return {async write(path,text){const pieces=path.split('/');let parent=dir;if(pieces.length===2)parent=await dir.getDirectoryHandle(pieces[0],{create:true});const f=await parent.getFileHandle(pieces.at(-1),{create:true}),stream=await f.createWritable();try{await stream.write(text);await stream.close();}catch(e){await stream.abort().catch(()=>{});throw e;}}};
}
