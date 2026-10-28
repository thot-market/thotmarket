import assert from 'node:assert/strict';
import test from 'node:test';
import {createSiteServer} from '../apps/site/server.ts';
import {chromium} from 'playwright-core';

test('public pages retain the same navigation and header layout', {timeout:120_000}, async () => {
  const server=createSiteServer({appUrl:'https://app.thot.market/app'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,headless:true,args:['--no-sandbox']});
  try {
    for(const width of [1440,1024,768,390]) {
      const page=await browser.newPage({viewport:{width,height:900}});
      let baseline;
      for(const route of ['/','/read','/stats','/bill','/affiliates','/mechanism','/tutorial','/whitepaper']) {
        await page.goto(origin+route);
        await page.evaluate(()=>document.fonts.ready);
        const state=await page.locator('.site-header').evaluate(header=>({
          links:[...header.querySelectorAll('.main-nav a')].map(a=>({text:a.textContent,href:a.getAttribute('href'),x:Math.round(a.getBoundingClientRect().x),y:Math.round(a.getBoundingClientRect().y)})),
          height:Math.round(header.getBoundingClientRect().height),
          cta:header.querySelector('[data-workspace-link]').textContent,
          current:header.querySelector('[aria-current="page"]')?.getAttribute('href')??null,
          fits:[...header.querySelectorAll('a')].every(a=>a.getBoundingClientRect().left>=0&&a.getBoundingClientRect().right<=innerWidth),
        }));
        assert.equal(state.fits,true,`${width} ${route}: header stays in viewport`);
        assert.equal(state.cta,'Open app');
        if(!baseline)baseline=state;
        assert.deepEqual(state.links,baseline.links,`${width} ${route}: links and positions`);
        assert.equal(state.height,baseline.height,`${width} ${route}: height`);
        assert.equal(state.current,['/read','/stats','/bill','/affiliates','/mechanism'].includes(route)?route:null);
        if(process.env.THOT_NAV_SCREENSHOTS&&['/','/read','/affiliates'].includes(route))await page.screenshot({path:`${process.env.THOT_NAV_SCREENSHOTS}/${width}-${route.slice(1)||'home'}.png`});
      }
      await page.close();
    }
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
