# THOT Robinhood Connector

This unpacked Manifest V3 extension connects an existing signed-in Robinhood tab
to a local THOT companion. The companion creates a private copy of this directory
and writes `config.js` with a random loopback capability URL in a private local directory. The pairing configuration persists so the installed extension can reconnect; the companion accepts account authentication only during an active short-lived link job.

At document start on `https://robinhood.com`, a small main-world hook wraps `fetch`
and `XMLHttpRequest` without changing requests or responses. It relays a Bearer
value only for a successful HTTPS `GET` to `api.robinhood.com`, through a fresh
per-page nonce to the isolated extension world. The service worker rechecks that
the private companion has an active user-started job before one loopback delivery.

The manifest has no cookie, debugger, tab, browsing-history or storage permission.
Do not put account tokens or brokerage data in `config.js`. Load the generated
private copy supplied by the companion rather than editing this template.

This connector is separate from the packaged `thot` capture command. From the
repository root, inspect prerequisites with `node scripts/thot-setup.ts robinhood`
and the connector options with `node scripts/thot-link.ts --help`. A live link
requires a compatible application, independently accepted witness/appraiser policy,
and an existing brokerage login; this source preview does not supply that acceptance.

After configuring those inputs, `node scripts/thot-link.ts robinhood` generates
the private extension copy and opens the account-linking flow. It stores pairing
state under `~/.local/share/thot/robinhood/`. Review
[the companion](../../scripts/thot-link.ts) and
[pairing checks](../../packages/capture/src/robinhood-pairing.ts) before connecting.
The website does not receive the provider bearer through this flow.
