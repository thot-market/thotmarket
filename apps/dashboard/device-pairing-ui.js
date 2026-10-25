// Device-code pairing entry (#thot-pair=CODE). A helper whose loopback
// callback cannot be reached prints a short code; this module looks the
// session up and hands the approval to the flow it belongs to.
export function normalizePairingCode(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const code = value.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
  return code.length === 8 && [...code].every(c => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'.includes(c)) ? code.slice(0, 4) + '-' + code.slice(4) : null;
}

export function parseDevicePairingFragment(location = window.location, history = window.history) {
  if (!location.hash?.startsWith('#thot-pair=')) return null;
  const value = location.hash.slice('#thot-pair='.length);
  history.replaceState(history.state, '', location.pathname + location.search);
  return { code: value === '' ? null : normalizePairingCode(value) };
}

// The line every code-mode approval screen adds: which device asked to pair.
export function requestingDevice(request, escape) {
  if (request?.mode !== 'code') return '';
  return `<p>Requesting device: <strong>${escape(request.device_name ?? 'unknown device')}</strong>${request.request_ip ? ` · IP ${escape(request.request_ip)}` : ''}. Check this is your helper before approving.</p>`;
}

export function createDevicePairingUI({ state, api, openDialog, dialog, escape, flows }) {
  let pending = null;   // a typed code, or 'entry' for the manual-entry dialog

  function entryDialog(message = '') {
    openDialog('Connect a device', 'Enter the pairing code shown in your terminal.', `<p>${message ? message + ' ' : ''}The code is eight characters, like <code>AB2C-EF3D</code>, and works once.</p><label for="device-pairing-code">Pairing code</label><input id="device-pairing-code" autocomplete="off" spellcheck="false" maxlength="32" placeholder="AB2C-EF3D">`, '<button class="button secondary" data-action="close-dialog">Cancel</button><button class="button" data-action="device-pairing-submit">Review this device</button>');
  }
  async function lookup(code) {
    const generation = state.generation, actor = state.actor?.id;
    try {
      const info = await api('/v1/contributor/device-pairing/' + encodeURIComponent(code));
      if (state.generation !== generation || state.actor?.id !== actor || state.role !== 'user') return;
      if (!flows[info.flow] || ['delivered', 'cancelled', 'denied'].includes(info.status)) {
        openDialog('This code is no longer waiting', 'Start the pairing again in your terminal.', '<p>The code already completed or was refused. Codes work once and expire after ten minutes.</p>');
        return;
      }
      flows[info.flow].acceptDevicePairing({ ...info, code });
    } catch (error) {
      if (state.generation !== generation || state.actor?.id !== actor) return;
      if (error.code === 'PAIRING_EXPIRED') openDialog('This pairing code expired', 'Start the pairing again in your terminal.', '<p>Codes stay valid for ten minutes.</p>');
      else if (error.code === 'PAIRING_NOT_FOUND') entryDialog('That code was not found.');
      else entryDialog('That code could not be checked.');
    }
  }
  function authReady() {
    if (pending === null || !state.loaded || state.role !== 'user') return;
    if (pending === 'entry') { pending = null; entryDialog(); return; }
    const code = pending; pending = null;
    void lookup(code);
  }
  function acceptFragment(value = parseDevicePairingFragment()) {
    if (!value) return false;
    pending = value.code === null ? 'entry' : value.code;
    authReady();
    return true;
  }
  acceptFragment();
  return {
    acceptFragment,
    authReady,
    authLost() { pending = null; },
    async handle(action) {
      if (action !== 'device-pairing-submit') return false;
      const field = dialog.querySelector('#device-pairing-code');
      const code = normalizePairingCode(field?.value ?? '');
      if (!code) { field?.focus(); throw Error('Enter the eight-character code from your terminal, like AB2C-EF3D.'); }
      await lookup(code);
      return true;
    }
  };
}
