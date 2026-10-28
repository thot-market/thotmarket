import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteServer} from '../apps/site/server.ts';
import {chromium} from 'playwright-core';
const fixture={as_of:'2026-01-10T12:00:00Z',stats:{listings_active:3,sellers_listing:2,independent:null},listings:[
 {public_path:'/l/test-one',title:'Synthetic coding research',turn_count:12,created_at:'2026-01-08T01:00:00Z',price_atoms:'2000000000000000000',capture_model:{source:'Test source',returned_model:'Test model'}},
 {public_path:'/l/test-two',title:'Synthetic financial research',turn_count:3,created_at:'2026-01-10T01:00:00Z',price_atoms:'1000000000000000000'},
 {public_path:'/l/test-three',title:'Synthetic image dataset',content_kind:'research',file_count:2,created_at:'2026-01-09T01:00:00Z',price_atoms:'3000000000000000000'}]};
test('market dashboard filters, sorts, charts, retries and fits mobile', {timeout:120000},async()=>{
 const server=createSiteServer({appUrl:'https://app.thot.market/app'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,args:['--no-sandbox']});
 try{
  for(const width of [1440,390]){
   const page=await browser.newPage({viewport:{width,height:1000}});let fail=false,empty=false;const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/v1/public/catalogue',r=>fail?r.fulfill({status:503,body:'unavailable'}):r.fulfill({json:empty?{...fixture,stats:{listings_active:0,sellers_listing:0,independent:null},listings:[]}:fixture}));
   await page.goto(`http://127.0.0.1:${server.address().port}/stats`);await page.waitForFunction(()=>document.querySelector('[data-stat="listings"]').textContent==='3');
   assert.equal(await page.locator('[data-stat="turns"]').textContent(),'15');
   assert.equal(await page.locator('[data-catalogue] tr').count(),3);
   await page.locator('[data-chart="turns"]').click();assert.match(await page.locator('[data-chart-container] svg').getAttribute('aria-label'),/15 turns/);
   await page.locator('[data-filter="files"]').click();assert.equal(await page.locator('[data-catalogue] tr').count(),1);assert.match(await page.locator('[data-catalogue]').textContent(),/image dataset/);
   await page.locator('[data-filter="all"]').click();await page.locator('[data-search]').fill('coding');assert.equal(await page.locator('[data-catalogue] tr').count(),1);
   await page.locator('[data-search]').fill('no matches');assert.match(await page.locator('[data-catalogue]').textContent(),/No listings match/);
   await page.locator('[data-search]').fill('');await page.locator('[data-sort]').selectOption('price');assert.match(await page.locator('[data-catalogue] tr').first().textContent(),/financial/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,JSON.stringify(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.tagName+'.'+n.className).slice(0,12)}))));
   fail=true;await page.locator('[data-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-stats-note]').textContent.includes('last successful'));assert.equal(await page.locator('[data-stat="listings"]').textContent(),'3');
   await page.reload();await page.waitForFunction(()=>document.querySelector('[data-stats-note]').textContent.includes('unavailable'));assert.equal(await page.locator('[data-stat="listings"]').textContent(),'—');
   fail=false;empty=true;await page.locator('[data-refresh]').click();await page.waitForFunction(()=>document.querySelector('[data-stat="listings"]').textContent==='0');assert.match(await page.locator('[data-catalogue]').textContent(),/No public listings/);
   assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
