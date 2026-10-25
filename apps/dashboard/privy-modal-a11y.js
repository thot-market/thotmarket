// The sign-in and wallet dialogs are rendered by the external Privy SDK inside
// this page's DOM. The SDK's email field sits in a <label> that also contains
// the submit button (so the input's accessible name becomes the button's text),
// its six confirmation-code inputs and the code screen's back arrow are unnamed,
// and long signed messages (the workspace signature includes the wallet
// address) overflow narrow containers. This layer repairs only the accessibility
// contract of that DOM; it never changes Privy's logic or submissions.

const STYLE_ID = 'privy-modal-a11y-style';
const STYLE_TEXT = [
  '#privy-modal-content{max-width:100%}',
  '#privy-modal-content :is(p,span,div,code,pre,h1,h2,h3,h4,li,td,th){overflow-wrap:anywhere}',
  '#privy-modal-content pre,#privy-modal-content code{white-space:pre-wrap;max-width:100%}'
].join('\n');

const isEmailField = input => input.type === 'email' || /@|\be-?mail\b/i.test(input.getAttribute('placeholder') ?? '');

/** Apply the accessible names for the current Privy modal screen. Idempotent. */
export function applyPrivyModalAccessibility(root) {
  if (!root) return;
  // Email screen: the SDK wraps the input and the submit button in one label.
  for (const label of root.querySelectorAll('label')) {
    const input = [...label.querySelectorAll('input')].find(input => !input.disabled && isEmailField(input));
    if (!input) continue;
    if (!input.getAttribute('aria-label') && !input.id) input.setAttribute('aria-label', 'Email address');
    const submit = [...label.querySelectorAll('button')].at(-1);
    if (submit && !submit.getAttribute('aria-label')) submit.setAttribute('aria-label', 'Continue with email');
  }
  // Confirmation-code screen: six unnamed single-digit inputs in one group.
  const digits = [...root.querySelectorAll('input[name^="code-"]')].filter(input => !input.disabled);
  if (digits.length >= 4) {
    const group = digits[0].parentElement;
    if (group && group.getAttribute('role') !== 'group') {
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Confirmation code');
    }
    digits.forEach((input, index) => { if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', `Digit ${index + 1} of ${digits.length}`); });
    // The back arrow on this screen is an icon-only button with no name.
    const unnamed = [...root.querySelectorAll('button')].find(button => !button.textContent.trim() && !button.getAttribute('aria-label') && !button.closest('[aria-hidden="true"]'));
    if (unnamed) unnamed.setAttribute('aria-label', 'Back to email');
  }
}

/** Watch the page for the Privy modal and keep its controls labelled. */
export function installPrivyModalAccessibility({document, window}) {
  if (!document || !window || typeof window.MutationObserver !== 'function') return () => {};
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }
  let scheduled = false;
  const apply = () => { scheduled = false; applyPrivyModalAccessibility(document.querySelector('#privy-modal-content')); };
  const schedule = () => { if (!scheduled) { scheduled = true; window.queueMicrotask(apply); } };
  const observer = new window.MutationObserver(schedule);
  observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'class', 'name', 'type', 'placeholder', 'disabled']});
  apply();
  return () => { observer.disconnect(); if (scheduled) scheduled = false; };
}
