export function setupCommand(command,escape) {
  return `<div class="setup-command"><code>${escape(command)}</code><button class="text-button" data-action="copy-setup-command" data-command="${escape(command)}">Copy command</button></div>`;
}
export function installHelp(origin,escape) {
  return `<details class="setup-install"><summary>First time on this computer?</summary><p>This developer demo needs a project checkout and Node 24 or later. From that checkout, install the helpers once:</p>${setupCommand(`node scripts/install-capture-helper.ts --thot-url ${origin}`,escape)}<p>Then open a new terminal. Python 3 and the reviewed hardware verifier are also required; the check below tells you what is missing.</p><a href="/getting-started" target="_blank" rel="noopener">First-time setup guide ↗</a></details>`;
}
export function captureSetup(client,origin,escape,step='check') {
  const name=client==='codex'?'Codex':'Claude Code';
  if(step==='check')return `<p class="eyebrow">STEP 1 OF 2 · CHECK THIS COMPUTER</p><p>Use your existing ${name} subscription login. Run this in your terminal and follow any missing prerequisite it reports:</p>${setupCommand(`thot-setup ${client}`,escape)}${installHelp(origin,escape)}<p>When the check says local prerequisites are ready, continue below.</p>`;
  return `<p class="eyebrow">STEP 2 OF 2 · START IN YOUR PROJECT</p>${setupCommand(`thot-capture ${client} --thot-url ${origin}`,escape)}<p>Open the link it prints and choose <strong>Connect</strong>. Allow local-network access if Chrome asks, so thot market can reach the helper on this computer.</p><p>Then return to your terminal and use ${name} normally. Exit ${name} to save. thot market will show <strong>Capture saved to your private vault</strong>.</p><p class="legal-note">Saving is private. You approve any later release to a buyer separately.</p>`;
}
export async function copySetupCommand(button) {
  await navigator.clipboard.writeText(button.dataset.command);button.textContent='Copied';
}
