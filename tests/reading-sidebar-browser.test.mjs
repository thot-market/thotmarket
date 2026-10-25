import assert from 'node:assert/strict';
import test from 'node:test';
import {createSiteServer} from '../apps/site/server.ts';
import {chromium} from 'playwright-core';

// #84: the idea page's sticky "In this story" sidebar must keep its last link
// reachable on short viewports — it either fits or scrolls independently — and
// the CTA arrows must render from the page itself, not a font glyph (#86).
test('the reading sidebar keeps its last link reachable on short viewports', {timeout:120_000}, async () => {
  assert.ok(process.env.THOT_E2E_BROWSER, 'THOT_E2E_BROWSER must name Chromium');
  const server=createSiteServer({appUrl:'https://app.thot.market/app'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox']});
  try{
    for(const [width,height] of [[1188,761],[1280,720]]){
      const page=await browser.newPage({viewport:{width,height}});
      await page.goto(origin+'/read');await page.evaluate(()=>document.fonts.ready);
      const aside=page.locator('.reading-aside');
      await aside.waitFor();
      // Scroll until the sidebar is stuck, then prove the final link can be
      // brought fully inside the viewport by scrolling the sidebar alone.
      const result=await page.evaluate(() => {
        const aside=document.querySelector('.reading-aside');
        const link=aside.querySelector('ol li:last-child a');
        // Instant scroll: the site uses smooth scrolling for anchors.
        const delta=aside.getBoundingClientRect().top-30;
        if(delta>0)window.scrollTo({top:window.scrollY+delta,behavior:'instant'});
        const stuck=aside.getBoundingClientRect().top<=31;
        if(!stuck)return {stuck,reachable:false};
        // Fit or independent scroll: either the link is already in view, or the
        // aside itself is the scrolling container that can reveal it.
        const fits=()=>link.getBoundingClientRect().bottom<=window.innerHeight+1;
        if(fits())return {stuck,reachable:true,scrolled:false};
        if(aside.scrollHeight<=aside.clientHeight)return {stuck,reachable:false,scrolled:false,reason:'not scrollable'};
        aside.scrollTop=aside.scrollHeight;
        return {stuck,reachable:fits(),scrolled:true};
      });
      assert.equal(result.stuck,true,`sidebar sticks at ${width}×${height}`);
      assert.equal(result.reachable,true,`last sidebar link reachable at ${width}×${height}`);
      // #86: CTAs carry an inline SVG arrow, never a font glyph.
      const arrows=await page.locator('.reading-next .button svg.arrow-icon').count();
      assert.equal(arrows,1);
      assert.equal(await page.locator('.reading-next .button').innerText().then(text=>text.includes('↗')),false,'no raw arrow glyph remains');
      // The same holds on every reading page.
      for(const path of ['/tutorial','/mechanism','/whitepaper']){
        await page.goto(origin+path);
        assert.equal(await page.locator('body').innerText().then(() => page.evaluate(() => document.body.textContent.includes('↗'))),false,`${path} has no raw arrow glyph`);
      }
      await page.close();
    }
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
