import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createApplication} from '../packages/market/src/bootstrap.ts';
import {createHttpServer} from '../apps/api/server.ts';
import {startWorkerLoop} from '../apps/worker/main.ts';
import {canonicalHash} from '../packages/protocol/src/index.ts';

const owner={id:'demo-user',role:'user'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const history=(id,answer)=>[
  {type:'user',sessionId:'synthetic-auto-qc-'+id,message:{role:'user',content:'Synthetic '+id+': explain queue cancellation and recovery.'}},
  {type:'assistant',sessionId:'synthetic-auto-qc-'+id,message:{role:'assistant',content:answer}},
].map(row=>JSON.stringify(row)).join('\n');

async function until(read,accept,message,{timeout=20000}={}){
  const end=Date.now()+timeout;let value;
  do{value=await read();if(accept(value))return value;await pause(100);}while(Date.now()<end);
  assert.fail(message+'; last state: '+JSON.stringify(value));
}

// Actual dashboard, import handlers, durable QC jobs, worker, local checker and
// encrypted vault. Development-role authentication and synthetic capture bytes
// avoid wallet/provider dependencies. Browser requests stay on this loopback app.
async function fixture(t){
  assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must select local Chromium');
  const evidence=resolve(process.env.THOT_AUTO_QC_ARTIFACTS??'work/auto-qc-browser');await mkdir(evidence,{recursive:true});
  const dir=await mkdtemp(join(tmpdir(),'thot-auto-qc-browser-')),errors=[],requests=[],outsideRequests=[],barriers=[],screenshots=[];
  let browser,context,page,worker,held;
  const app=await createApplication({dataDir:join(dir,'app'),memory:true});
  const server=createHttpServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const session=await fetch(origin+'/v1/dev/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'user'})}).then(response=>response.json());
  assert.equal(session.actor.id,owner.id);
  t.after(async()=>{
    for(const barrier of barriers)barrier.release.resolve();
    await worker?.close();
    await writeFile(join(evidence,'browser-errors.json'),JSON.stringify(errors,null,2)+'\n');
    if(page&&!page.isClosed())await page.screenshot({path:join(evidence,'final-state.png'),fullPage:!await page.locator('#detail-dialog').evaluate(el=>el.open)}).catch(()=>{});
    await context?.close();await browser?.close();server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));await app.close();await rm(dir,{recursive:true,force:true});
  });
  async function call(path,body){
    const response=await fetch(origin+path,{headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
    return{status:response.status,body:await response.json()};
  }
  async function openBrowser(){
    browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin){outsideRequests.push(url.origin);return route.abort();}
      const record={path:url.pathname,search:url.search,method:request.method()};requests.push(record);
      const barrier=held?.matches(record)?held:null;
      if(!barrier)return route.continue();
      held=null;const response=await route.fetch();barrier.status=response.status();barrier.entered.resolve();await barrier.release.promise;
      await route.fulfill({response});barrier.finished.resolve();
    });
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/app');await page.locator('#conversation-library').waitFor();return page;
  }
  async function closeBrowser(){await context.close();await browser.close();context=null;browser=null;page=null;}
  async function screenshot(name){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(evidence,name+'.png'),fullPage:!await page.locator('#detail-dialog').evaluate(el=>el.open)});screenshots.push(name+'.png');}
  async function upload(id,answer){
    await page.locator('#conversation-library .section-head [data-action="journey-add"]').click();
    await page.locator('#detail-dialog [data-action="journey-local"][data-client="claude"]').click();
    await page.locator('#detail-dialog [data-action="import-research"]').click();
    await page.locator('#research-file').setInputFiles({name:'synthetic-'+id+'.jsonl',mimeType:'application/x-ndjson',buffer:Buffer.from(history(id,answer))});
    await page.locator('#research-preview-form button[type="submit"]').click();
    const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/contributor/import/confirm'&&response.request().method()==='POST');
    await page.locator('[data-action="confirm-research"]').click();const reply=await response;assert.equal(reply.status(),200);const result=await reply.json();
    await row(result.trace_id).waitFor();return result;
  }
  async function sync(id,answer){
    const text=history(id,answer),source_id='a'.repeat(32);
    const grant=await call('/v1/contributor/history-devices',{client:'claude',source_ids:[source_id],backfill:true,daily_time_utc:'02:00',consent:'private-history-upload-v1'});
    assert.equal(grant.status,200);
    const response=await fetch(origin+'/v1/history-devices/'+grant.body.device_id+'/imports',{method:'POST',headers:{Authorization:'Bearer '+grant.body.device_token,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({source_id,file_id:createHash('sha256').update(id).digest('hex'),version_id:createHash('sha256').update(text).digest('hex'),text})});
    assert.equal(response.status,200);return response.json();
  }
  const row=id=>page.locator('[data-testid="conversation-row"][data-trace-id="'+id+'"]');
  const panel=()=>page.locator('#trace-quality-check');
  const qcPath=id=>'/v1/contributor/library/'+id+'/qc';
  const qc=id=>app.qc.get(owner,id,{scope:'private'});
  async function openReader(id){await row(id).locator('[data-action="library-open"]').first().click();await panel().waitFor();}
  async function closeReader(){await page.locator('#detail-dialog [data-action="close-dialog"]').first().click();}
  function holdResponse(matches){assert(!held);const barrier={matches,entered:deferred(),release:deferred(),finished:deferred()};barriers.push(barrier);held=barrier;return barrier;}
  function startWorker(){assert(!worker);worker=startWorkerLoop(app,{intervalMs:50,onError:error=>errors.push(error.message)});}
  async function stopWorker(){await worker?.close();worker=null;}
  async function capture(previous,answer,index){
    const capture=await app.agentCapture.begin(owner,{client:'claude',save_privately:true}),now=new Date().toISOString();
    const request={model:'synthetic-auto-qc-model',metadata:{user_id:JSON.stringify({session_id:'98464535-5678-4000-8000-123456789abc'})},messages:[...previous,{role:'user',content:'Synthetic grouped queue request '+index}]};
    const response={type:'message',content:[{type:'text',text:answer}],stop_reason:'end_turn'};
    const payload={sequence:1,upstream:'https://api.anthropic.com',path:'/v1/messages',request_body_b64:Buffer.from(JSON.stringify(request)).toString('base64'),response_body_b64:Buffer.from(JSON.stringify(response)).toString('base64'),status:200,content_type:'application/json',started_at:now,finished_at:now,complete:true};
    const part={...payload,commitment:canonicalHash(payload)};await app.agentCapture.part(capture.capture_id,capture.upload_token,'auto-qc-browser-stage-'+index,{part});
    const manifest={format:'thot.proxy-capture/2',capture_id:capture.capture_id,client:'claude',started_at:now,finished_at:now,parts:[{sequence:1,commitment:part.commitment}]};
    return app.agentCapture.complete(capture.capture_id,capture.upload_token,'auto-qc-browser-complete-'+index,{bundle:{...manifest,root:canonicalHash(manifest)}});
  }
  return{app,evidence,errors,requests,outsideRequests,screenshots,call,openBrowser,closeBrowser,screenshot,upload,sync,row,panel,qcPath,qc,openReader,closeReader,holdResponse,startWorker,stopWorker,capture,releaseOnCleanup:release=>barriers.push({release}),get page(){return page;}};
}

test('automatic private checks continue with the browser closed and restore compact, source-bound owner review',{timeout:240000},async t=>{
  const f=await fixture(t),cleanAnswer='The synthetic queue now drains in FIFO order.';
  const credentialShape=['api','key'].join('_')+'='+'synthetic'.repeat(5),flaggedAnswer='Synthetic detector example: '+credentialShape;
  const rowStatus=id=>f.row(id).locator('[data-testid="qc-status"]');
  const readerStatus=()=>f.panel().locator('[data-testid="qc-reader-status"]');
  const details=()=>f.panel().locator('#trace-qc-details');
  const noRunControls=async()=>assert.equal(await f.page.getByRole('button',{name:/^Run checks(?: again)?$/}).count(),0,'automatic checks have no ordinary manual-start control');
  const waitRow=(id,label)=>rowStatus(id).filter({hasText:label}).waitFor();
  const finish=async id=>until(()=>f.qc(id),result=>result.status==='complete','automatic QC must finish');

  await f.openBrowser();
  const flagged=await f.upload('private-warning',flaggedAnswer),initial=await f.qc(flagged.trace_id);
  assert.equal(initial.status,'not_run');assert.equal(initial.automation.state,'queued');
  await waitRow(flagged.trace_id,'Queued');await noRunControls();
  assert.equal(await f.panel().count(),0,'upload queues QC before the reader is ever opened');
  await f.screenshot('01-upload-saved-checks-queued');
  await f.closeBrowser();f.startWorker();const first=await finish(flagged.trace_id);await f.stopWorker();
  assert.equal(first.report.status,'flag');assert(first.report.findings.some(f=>f.code==='credential_pattern'));
  assert.equal(first.review,null);assert.equal(first.report.semantic.status,'not_run');
  assert.equal(f.requests.filter(r=>r.path===f.qcPath(flagged.trace_id)).length,0,'no browser QC request was needed for completion');
  await f.openBrowser();await waitRow(flagged.trace_id,'Needs attention');

  // The upload-only history API uses the same durable path as scheduled history
  // imports. A new record appears in the open list without a reload or reader.
  const clean=await f.sync('daily-upload',cleanAnswer);
  await waitRow(clean.trace_id,'Queued');
  const cleanRaw=await f.app.db.transaction(tx=>tx.get('traces',clean.trace_id,owner.id)),opened=deferred(),release=deferred();
  const open=f.app.privacy.open.bind(f.app.privacy);let heldSource=false;
  f.app.privacy.open=async(...args)=>{
    if(!heldSource&&canonicalHash(args[1])===canonicalHash(cleanRaw.raw_ref)){heldSource=true;opened.resolve();await release.promise;}
    return open(...args);
  };
  f.releaseOnCleanup(release);
  f.startWorker();await opened.promise;await waitRow(clean.trace_id,'Checking');
  await f.openReader(clean.trace_id);await readerStatus().filter({hasText:'Checking'}).waitFor();
  assert.match(await f.page.locator('.library-conversation').innerText(),/Synthetic daily-upload/);
  assert.equal(await details().getAttribute('open'),null);
  await f.screenshot('02-reading-during-automatic-checks');
  await f.closeReader();release.resolve();await finish(clean.trace_id);await f.stopWorker();f.app.privacy.open=open;
  await waitRow(clean.trace_id,'Checked');await waitRow(flagged.trace_id,'Needs attention');
  await noRunControls();await f.screenshot('03-my-work-automatic-statuses');

  await f.openReader(flagged.trace_id);await readerStatus().filter({hasText:'Needs attention'}).waitFor();
  assert.equal(await details().getAttribute('open'),null,'findings and feedback start collapsed');
  const compact=await f.panel().boundingBox(),conversation=await f.page.locator('.library-conversation').boundingBox();
  assert(compact.height<240,'compact status does not consume the reader');
  assert(conversation.y<1000,'conversation starts within the desktop viewport');
  await f.screenshot('04-compact-reader-desktop');
  await f.page.setViewportSize({width:390,height:844});
  assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page does not overflow');
  assert(await f.panel().evaluate(el=>el.scrollWidth<=el.clientWidth),'compact status fits mobile');
  await f.screenshot('05-compact-reader-mobile');
  await details().locator('summary').first().click();
  await f.panel().getByText(/AI review (?:has )?not run/).waitFor();
  assert.equal((await f.panel().innerText()).includes(credentialShape),false,'QC summary does not expose source excerpts');
  assert.equal(await f.panel().locator('[data-action="qc-retry"]').count(),0,'quality findings never offer a technical retry');
  await f.screenshot('06-findings-mobile');await f.page.setViewportSize({width:1440,height:1000});
  await f.closeReader();
  const financial=f.holdResponse(r=>r.path==='/v1/thot/workspace'&&r.method==='GET');
  await f.page.reload();await financial.entered.promise;await f.openReader(flagged.trace_id);
  await readerStatus().filter({hasText:'Needs attention'}).waitFor();await details().locator('summary').first().click();
  const reviewReply=f.page.waitForResponse(response=>new URL(response.url()).pathname===f.qcPath(flagged.trace_id)+'/review'&&response.request().method()==='POST');
  await f.panel().locator('[data-action="qc-review"][data-decision="disagree"]').click();
  const reviewResponse=await reviewReply,submitted=reviewResponse.request().postDataJSON(),reviewed=await reviewResponse.json();
  assert.equal(reviewResponse.status(),200);assert.equal(submitted.report_digest,first.report_digest);assert.equal(submitted.source_version,first.selected_source.source_version);
  assert.equal(reviewed.review.decision,'disagree');assert.deepEqual(reviewed.report,first.report,'human feedback cannot rewrite machine findings');
  financial.release.resolve();await financial.finished.promise;
  await f.panel().getByText('Feedback saved for this version.',{exact:true}).waitFor();await f.screenshot('07-human-feedback-separate');
  await f.closeReader();await f.page.reload();await f.openReader(flagged.trace_id);
  await details().locator('summary').first().click();await f.panel().getByText('Feedback saved for this version.',{exact:true}).waitFor();
  const restored=await f.qc(flagged.trace_id);assert.equal(restored.cached,true);assert.equal(restored.report_digest,first.report_digest);assert.equal(restored.review.decision,'disagree');
  assert.equal(f.requests.filter(r=>r.path===f.qcPath(flagged.trace_id)&&r.method==='POST').length,0,'reload restores the existing result without running checks');

  // A different retained source can reuse an identical content report, but its
  // human feedback is stale. The UI must actually reload after the real 409.
  const oldSource=await f.app.db.transaction(tx=>tx.get('traces',flagged.trace_id,owner.id));
  const replacementRef=await f.app.privacy.seal(owner.id,await f.app.privacy.open(owner.id,oldSource.raw_ref));
  await f.app.db.transaction(async tx=>{const trace=await tx.get('traces',flagged.trace_id,owner.id);trace.projection_refs=[...(trace.projection_refs??[]),trace.raw_ref];trace.raw_ref=replacementRef;await tx.update('traces',flagged.trace_id,trace);});
  const staleReply=f.page.waitForResponse(response=>new URL(response.url()).pathname===f.qcPath(flagged.trace_id)+'/review'&&response.request().method()==='POST');
  const changedReply=f.page.waitForResponse(response=>new URL(response.url()).pathname===f.qcPath(flagged.trace_id)&&response.request().method()==='GET');
  await f.panel().locator('[data-action="qc-review"][data-decision="agree"]').click();
  assert.equal((await staleReply).status(),409);const changed=await (await changedReply).json();
  assert.equal(changed.status,'not_run');assert.equal(changed.review,null);
  await until(()=>f.panel().locator('[data-action="qc-review"]').count(),count=>count===0,'stale feedback must disappear while the new source is checked');
  f.startWorker();const refreshed=await finish(flagged.trace_id);await readerStatus().filter({hasText:'Needs attention'}).waitFor();await f.stopWorker();
  assert.equal(refreshed.report_digest,first.report_digest);assert.notEqual(refreshed.selected_source.source_version,first.selected_source.source_version);assert.equal(refreshed.review,null);
  await f.panel().locator('[data-action="qc-review"][data-decision="disagree"]').click();
  await f.panel().getByText('Feedback saved for this version.',{exact:true}).waitFor();

  // Sale preparation queues a separate source; switching immediately removes
  // private feedback while the selected sale-version response is still pending.
  await f.closeReader();
  const preview=f.app.portfolio.preview(owner,{filename:'synthetic-private-warning.jsonl',text:history('private-warning',flaggedAnswer)});
  const prepared=await f.call('/v1/contributor/library/'+flagged.trace_id+'/prepare-sale',{content_commitment:preview.content_commitment,rights_confirmed:true,model_output_licensed:true});
  assert.equal(prepared.status,200);
  f.startWorker();await until(()=>f.app.qc.get(owner,flagged.trace_id,{scope:'release'}),r=>r.status==='complete','sale version must be checked automatically');await f.stopWorker();
  await f.page.reload();await f.openReader(flagged.trace_id);await details().locator('summary').first().click();
  await f.panel().getByText('Feedback saved for this version.',{exact:true}).waitFor();
  const scopeReply=f.holdResponse(r=>r.path===f.qcPath(flagged.trace_id)&&r.search==='?scope=release'&&r.method==='GET');
  await f.panel().locator('select[name="scope"]').selectOption('release');await scopeReply.entered.promise;
  assert.equal(await f.panel().locator('[data-action="qc-review"]').count(),0,'scope changes clear old review controls before the response');
  scopeReply.release.resolve();await scopeReply.finished.promise;
  await f.panel().getByText('The conversation below is your private copy.',{exact:false}).waitFor();
  const released=await f.app.qc.get(owner,flagged.trace_id,{scope:'release'});assert.equal(released.scope,'release');assert.equal(released.review,null);
  assert.notEqual(released.report_digest,first.report_digest);await f.screenshot('08-sale-version-source-identity');
  await f.closeReader();

  const one=await f.capture([],cleanAnswer,1),previous=(await f.app.library.item(owner,one.trace_id)).content.turns;
  const two=await f.capture(previous,flaggedAnswer,2);
  f.startWorker();await finish(one.trace_id);await finish(two.trace_id);await f.stopWorker();
  await f.page.reload();await waitRow(one.trace_id,'Needs attention');
  assert.match(await f.row(one.trace_id).innerText(),/1 of 2 recordings need attention/);
  await f.openReader(one.trace_id);assert.equal(await f.page.locator('.library-conversation .library-turn').count(),4);
  await readerStatus().filter({hasText:'Checked'}).waitFor();await details().locator('summary').first().click();
  await f.panel().locator('[data-action="qc-review"][data-decision="agree"]').click();
  await f.panel().getByText('Feedback saved for this version.',{exact:true}).waitFor();
  const recordingReply=f.holdResponse(r=>r.path===f.qcPath(two.trace_id)&&r.method==='GET');
  await f.panel().locator('select[name="trace_id"]').selectOption(two.trace_id);await recordingReply.entered.promise;
  assert.equal(await f.panel().locator('[data-action="qc-review"]').count(),0,'recording changes clear feedback for the previous source immediately');
  recordingReply.release.resolve();await recordingReply.finished.promise;await readerStatus().filter({hasText:'Needs attention'}).waitFor();
  assert.equal(await f.panel().getByText('Feedback saved for this version.',{exact:true}).count(),0);
  assert.equal(await f.panel().locator('select[name="trace_id"]').inputValue(),two.trace_id);
  await f.screenshot('09-grouped-recording-attention');await f.closeReader();

  // Technical failure/retry and a late response use the real endpoints; the
  // only injected failure is a local checker exception, never a fake response.
  const broken=await f.upload('temporary-check-error',cleanAnswer),evaluate=f.app.qc.evaluate;
  f.app.qc.evaluate=()=>{throw new Error('SYNTHETIC_QC_ENGINE_FAILURE');};
  try{
    for(let attempt=0;attempt<3;attempt++){
      if(attempt)await f.app.db.transaction(tx=>tx.sql.query("UPDATE outbox_events SET available_at=now() WHERE owner_id=$1 AND event_type='CheckTraceQuality' AND payload->>'trace_id'=$2 AND status='pending'",[owner.id,broken.trace_id]));
      await f.app.qc.processPending(2);
    }
  }finally{f.app.qc.evaluate=evaluate;}
  const failed=await f.qc(broken.trace_id);assert.equal(failed.automation.state,'failed');assert.equal(failed.automation.retryable,true);
  await waitRow(broken.trace_id,'Check unavailable');await f.openReader(broken.trace_id);
  await readerStatus().filter({hasText:'Check unavailable'}).waitFor();
  assert.doesNotMatch(await f.panel().innerText(),/No issues found|Needs attention/,'operational failure is not a quality outcome');
  const retry=f.panel().locator('[data-action="qc-retry"]');await retry.waitFor();await f.screenshot('10-operational-retry');
  const retryReply=f.page.waitForResponse(response=>new URL(response.url()).pathname===f.qcPath(broken.trace_id)+'/retry'&&response.request().method()==='POST');
  await retry.click();const retryResponse=await retryReply;assert.equal(retryResponse.status(),200);assert.equal((await retryResponse.json()).automation.state,'queued');
  f.startWorker();await finish(broken.trace_id);await readerStatus().filter({hasText:'Checked'}).waitFor();await f.stopWorker();
  assert.equal(await f.panel().locator('[data-action="qc-retry"]').count(),0);await noRunControls();
  const completeGets=f.requests.filter(r=>r.path===f.qcPath(broken.trace_id)&&r.method==='GET').length;
  await pause(2300);assert.equal(f.requests.filter(r=>r.path===f.qcPath(broken.trace_id)&&r.method==='GET').length,completeGets,'completed reader stops polling');
  await f.closeReader();

  const expired=await f.upload('expired-pending-check',cleanAnswer);await f.openReader(expired.trace_id);
  await readerStatus().filter({hasText:'Queued for checks'}).waitFor();
  const expiredReply=f.page.waitForResponse(response=>new URL(response.url()).pathname===f.qcPath(expired.trace_id)&&response.request().method()==='GET'&&response.status()===410);
  await f.app.db.transaction(async tx=>{const trace=await tx.get('traces',expired.trace_id,owner.id);trace.retention_expires_at='2000-01-01T00:00:00.000Z';await tx.update('traces',expired.trace_id,trace);});
  await expiredReply;await readerStatus().filter({hasText:'Status unavailable'}).waitFor();
  assert.equal(await f.panel().locator('[data-action="qc-review"],[data-action="qc-retry"]').count(),0,'an unavailable source cannot retain action controls');
  const unavailableGets=f.requests.filter(r=>r.path===f.qcPath(expired.trace_id)&&r.method==='GET').length;
  await pause(4500);assert.equal(f.requests.filter(r=>r.path===f.qcPath(expired.trace_id)&&r.method==='GET').length,unavailableGets,'terminal source errors stop the pending reader retry timer');
  await f.closeReader();
  const late=f.holdResponse(r=>r.path===f.qcPath(flagged.trace_id)&&r.method==='GET');
  await f.openReader(flagged.trace_id);await late.entered.promise;await f.closeReader();
  await f.page.locator('.journey-menu>summary').click();await f.page.locator('#role').selectOption('buyer_admin');
  await f.page.waitForFunction(()=>document.querySelector('#role')?.value==='buyer_admin'&&!document.querySelector('#role')?.disabled);
  late.release.resolve();await late.finished.promise;await pause(2300);
  assert.equal(await f.panel().count(),0,'late status cannot reconstruct a private reader after account change');
  assert.doesNotMatch(await f.page.locator('body').innerText(),/Synthetic private-warning|Synthetic daily-upload/);
  assert.equal(await f.page.locator('#detail-dialog').getAttribute('open'),null);
  assert.deepEqual(f.errors,[]);assert.deepEqual(f.outsideRequests,[]);
  assert.equal(f.requests.filter(r=>/\/qc$/.test(r.path)&&r.method==='POST').length,0,'the browser never starts an ordinary QC run');
  await writeFile(join(f.evidence,'result.json'),JSON.stringify({status:'PASS',scope:'Real local dashboard, manual upload, upload-only history HTTP ingestion, durable QC jobs, shared worker loop, local engine and encrypted evidence. Synthetic captures group two recordings; synthetic source-reference and retention updates exercise invalidation and expiry. The browser process is closed before the first worker starts. Synthetic checker exceptions exhaust the three automatic attempts; only retry scheduling timestamps are accelerated. Explicit operational retry then runs the real checker; a real HTTP response is delayed for account isolation. No provider, wallet, hosted service or external browser request.',checks:['Upload acknowledges and queues before QC execution','Worker completes with browser process closed and no reader visit','History upload appears and pending status updates without navigation','Reading remains available while a worker holds its source read','Compact desktop/mobile status with optional findings and version-bound feedback','Reload restores immutable result and separate human feedback','Private feedback works while financial workspace is pending','Changed source reloads after stale feedback and binds a fresh review','Private and sale scope changes clear stale feedback','Grouped records expose attention counts and selected recording identity','Quality findings offer no retry; operational failure offers Retry check','Completed reader stops polling','Expired queued source returns real 410 and stops polling','Late response cannot disclose content after account change','No ordinary Run checks action or browser QC-run POST'],screenshots:f.screenshots,errors:f.errors},null,2)+'\n');
});
