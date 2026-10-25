import assert from 'node:assert/strict';
import test from 'node:test';
import {createSiteServer} from '../apps/site/server.ts';
import {chromium} from 'playwright-core';
test('public entry clicks, history and capabilities across three viewports (application destination fixture)', {timeout:120_000}, async () => {
assert.ok(process.env.THOT_E2E_BROWSER, 'THOT_E2E_BROWSER must name the local Chromium executable');
const server=createSiteServer({appUrl:'https://app.thot.market/app'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox']});
const checks=[];
try{
 for(const [width,height] of [[1440,900],[1366,768],[390,844]]){
  const page=await browser.newPage({viewport:{width,height}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // The destination is a fixture so this click audit never signs into a hosted service.
  await page.route('https://app.thot.market/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Destination fixture</title><p>Application destination fixture</p>'}));
  for(const path of ['/','/read','/tutorial','/mechanism','/whitepaper','/affiliates']){
   await page.goto(origin+path);await page.evaluate(()=>document.fonts.ready);
   const links=await page.locator('[data-workspace-link]').evaluateAll(nodes=>nodes.map(n=>n.href));assert(links.every(link=>link.startsWith('https://app.thot.market/app')));
   const cta=path==='/affiliates'?page.getByRole('link',{name:'Open your referral dashboard'}):page.locator('[data-workspace-link]').first();
   const href=await cta.getAttribute('href');await cta.click();await page.waitForURL(href);assert.equal(page.url(),href);await page.reload();assert.equal(page.url(),href);
   await page.goBack();assert.equal(page.url(),origin+path);await page.locator('.site-footer [data-workspace-link]').click();await page.waitForURL('https://app.thot.market/app');
   checks.push({kind:'browser click/reload/back/footer with synthetic destination',viewport:[width,height],route:path,links:links.length,target:href,result:'pass'});
  }
  await page.goto(origin+'/');await page.waitForFunction(()=>document.querySelector('[data-proof-environment]')?.hidden===true);assert.doesNotMatch(await page.locator('[data-market-proof]').innerText(),/unavailable/i,'proof panel must not read as an outage');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.className),'skip-link');await page.keyboard.press('Enter');await page.waitForFunction(()=>location.hash==='#main');await page.waitForTimeout(700);
  const skip=await page.evaluate(()=>({scrollY,mainTop:document.querySelector('#main').getBoundingClientRect().top}));assert(skip.scrollY>0);assert(skip.mainTop>=0&&skip.mainTop<100);
  await page.goto(origin+'/');await page.getByRole('link',{name:/See how it works/}).click();await page.waitForFunction(()=>location.hash==='#how-it-works');await page.waitForFunction(()=>{const y=document.querySelector('#how-it-works').getBoundingClientRect().top;return y>=0&&y<100;});
  const scroll=await page.evaluate(()=>({scrollY,targetTop:document.querySelector('#how-it-works').getBoundingClientRect().top,width:document.documentElement.scrollWidth}));assert(scroll.scrollY>0);assert(scroll.targetTop>=0&&scroll.targetTop<100);assert.equal(scroll.width,width);
  checks.push({kind:'browser keyboard focus, actual anchor scroll, neutral proof panel',viewport:[width,height],skip,scroll,errors,result:'pass'});assert.deepEqual(errors,[]);
  await page.goto(origin+'/app#referrals');await page.waitForURL('https://app.thot.market/app#referrals');
  for(const suffix of ['#thot=synthetic','#thot-history=synthetic','?oauth_state_id=synthetic#trace=synthetic']){
   await page.goto(origin+'/app'+suffix);await page.waitForFunction(()=>document.querySelector('#access-status')?.textContent.includes('original app'));assert.equal(page.url(),origin+'/app'+suffix);
  }
  checks.push({kind:'browser ordinary access continuation and local capability preservation',viewport:[width,height],result:'pass'});
  await page.close();
 }
 assert.equal(checks.length,24);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

});
