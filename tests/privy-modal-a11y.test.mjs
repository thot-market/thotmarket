import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';

// The Privy SDK renders its sign-in dialog inside this page's DOM. This fixture
// reproduces the shapes that matter to accessibility (#81/#82/#87) — the email
// input wrapped in the same <label> as the submit button, six unnamed code
// inputs, an icon-only back button, and a long signed message — against the
// real module from apps/dashboard/privy-modal-a11y.js.
const fixture=`
import {installPrivyModalAccessibility,applyPrivyModalAccessibility} from './apps/dashboard/privy-modal-a11y.js';
window.fixture={install:installPrivyModalAccessibility,apply:applyPrivyModalAccessibility};
`;
const emailScreen=`
<div id="privy-modal-content"><form>
  <h3>Log in or create account</h3>
  <label><svg width="16" height="16"></svg><input type="email" placeholder="you@example.com"><button type="submit" disabled>Submit</button></label>
</form></div>`;
const codeScreen=(digits=6)=>`
<div id="privy-modal-content"><div>
  <button class="back"><svg width="16" height="16"></svg></button>
  <h3>Enter confirmation code</h3>
  <div class="inputs">${Array.from({length:digits},(_,i)=>`<input name="code-${i}" type="text" inputmode="numeric" autocomplete="off">`).join('')}</div>
  <button class="close" aria-label="Close dialog">✕</button>
</div></div>`;
const walletMessageScreen=(address)=>`
<div id="privy-modal-content"><h3>Signature request</h3>
  <pre id="signed-message">https://staging.example.test wants you to sign in with your Ethereum account:
${address}

Sign in to thot market and link this wallet for payouts.

URI: https://staging.example.test/app
Request ID: 0123456789abcdef0123456789abcdef</pre>
</div>`;
let browser,code;
before(async()=>{
  assert(process.env.THOT_E2E_BROWSER,'THOT_E2E_BROWSER must name Chromium');
  const result=await build({stdin:{contents:fixture,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'privy-a11y-fixture.js'},bundle:true,write:false,format:'esm',platform:'browser'});
  code=result.outputFiles[0].text;
  browser=await chromium.launch({executablePath:process.env.THOT_E2E_BROWSER,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});
async function pageFor(t){
  const page=await browser.newPage({viewport:{width:500,height:761}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
  await page.setContent('<!doctype html><html><head></head><body><main></main></body></html>');
  await page.addScriptTag({type:'module',content:code});
  await page.waitForFunction(()=>window.fixture);
  return page;
}

test('the email field is named Email address and the button Continue with email',async t=>{
  const page=await pageFor(t);
  await page.evaluate(html=>{document.body.insertAdjacentHTML('beforeend',html);},emailScreen);
  await page.evaluate(()=>window.fixture.install({document,window}));
  // The SDK re-renders; the observer must have applied the names immediately.
  await page.waitForFunction(()=>document.querySelector('#privy-modal-content label input')?.getAttribute('aria-label')==='Email address');
  assert.equal(await page.getAttribute('#privy-modal-content label button','aria-label'),'Continue with email');
  // A later re-render of the same screen keeps the names.
  await page.evaluate(html=>{document.querySelector('#privy-modal-content').innerHTML=html.replace(/^<div id="privy-modal-content">|<\/div>$/g,'');},emailScreen);
  await page.waitForFunction(()=>document.querySelector('#privy-modal-content label input')?.getAttribute('aria-label')==='Email address');
});

test('confirmation-code inputs get a group label and per-digit names, and the back arrow is named',async t=>{
  const page=await pageFor(t);
  await page.evaluate(html=>{document.body.insertAdjacentHTML('beforeend',html);},codeScreen(6));
  await page.evaluate(()=>window.fixture.install({document,window}));
  await page.waitForFunction(()=>document.querySelector('input[name="code-0"]')?.getAttribute('aria-label')==='Digit 1 of 6');
  const group=await page.evaluate(()=>{const inputs=document.querySelector('input[name="code-0"]').parentElement;return {role:inputs.getAttribute('role'),label:inputs.getAttribute('aria-label')};});
  assert.deepEqual(group,{role:'group',label:'Confirmation code'});
  for(let index=0;index<6;index++)assert.equal(await page.getAttribute(`input[name="code-${index}"]`,'aria-label'),`Digit ${index+1} of 6`);
  assert.equal(await page.getAttribute('#privy-modal-content .back','aria-label'),'Back to email');
  // An already-named control is never relabelled.
  assert.equal(await page.getAttribute('#privy-modal-content .close','aria-label'),'Close dialog');
});

test('long wallet addresses wrap inside the signature message with no horizontal scroll (#87)',async t=>{
  const page=await pageFor(t);
  const address='0x1234567890abcdef1234567890abcdef12345678';
  await page.evaluate(({address,screen})=>{document.body.insertAdjacentHTML('beforeend',screen);},{address,screen:walletMessageScreen(address)});
  await page.evaluate(()=>window.fixture.install({document,window}));
  await page.locator('#signed-message').waitFor();
  await page.locator('#signed-message').evaluate(node=>{node.style.width='312px';});
  await page.waitForTimeout(50);
  const overflow=await page.locator('#signed-message').evaluate(node=>({scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}));
  assert.ok(overflow.scrollWidth<=overflow.clientWidth,'the signed message wraps within its 312px container');
});
