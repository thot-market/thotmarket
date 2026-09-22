# Current THOT local purchase demonstration

Run from an isolated development checkout with Node 24, the locked dependencies,
Foundry Anvil 1.7.1, and Chromium. Serialize these runs on a shared machine: the
first fixture compiles Solidity. No hosted RPC, wallet, service credentials, or
existing data directory are accepted by this runner.

```sh
pnpm install --frozen-lockfile
pnpm test:thot:browser
pnpm test:thot:browser:percentage
```

`THOT_ANVIL_PATH` selects the local Anvil executable. `THOT_E2E_BROWSER` selects
Chromium (default `/usr/bin/chromium`). For another artifact parent directory:

```sh
node scripts/record-thot-purchase.mjs --economics quoted-cost --output /tmp/thot-demo-evidence
```

Each run creates its own loopback Anvil process, HTTP port, temporary vault and
new evidence directory. The vault is removed on exit; screenshots, seller/buyer
videos and `result.json` remain under `work/thot-browser/`. Failed runs record
the phase and screenshot and exit nonzero. Inspect the result before sharing
artifacts; a video alone is not a passing acceptance record.

The runner uses the current THOT UI and APIs for a synthetic JSONL import,
explicit sale rights, exact release metadata, a seller's typed signature,
buyer quote and wallet approval/payment. It asserts actual token debit, exact
licensed readback and unrelated-reader denial, delayed worker pickup after funding,
pending seller proceeds, and actual seller and protocol payouts with a zero referral allocation. A separate
funded order (prepared through the API and funded by the direct local signer) exercises a full refund after a simulated worker outage. The
browser supplies only the wallet transport and local development role; contract
transactions, signatures, API responses and content are real local operations.

`quoted-cost` represents the older immutable economics retained by private dev
and staging. `percentage` deploys the launch market with a shared treasury,
staking binding and 1% service fee, using 20%/30% holder discounts and a configured 35% long-lock tier. The buyer
holds 200,000 test THOT and the seller 10,000, so a 100-THOT gross price freezes
99.7 buyer debit and 99.2 seller allocation. This second fixture uses the
local controller governor; it does not demonstrate the hosted Safe approval
process, treasury purchases, real cost calibration or staking maturity.

The two deadline jumps (sale dispute window and 48-hour failed-delivery refund)
are explicitly local-only. The time helper is closed over the newly spawned
Anvil provider and checks loopback, chain 31337, Anvil client identity and
unchanged genesis before advancing. There is no hosted clock option.

Production onboarding, private dev, private staging and public testnet need
separate acceptance on their pinned release and target. An app image update
does not turn a quoted-cost deployment into percentage/shared-treasury contracts.
The demo evidence lists any remaining recovery scenarios as explicit skips.

The percentage fixture follows the 20%/30%/35% fee reductions in
[the launch deployment preparation](../contracts/scripts/prepare-thot-launch.mjs).
The long-lock tier is configured, not exercised by this recording. The application
uses an in-memory database: browser reload and stopping/starting worker scheduling
do not establish database or whole-process recovery.

The refund chapter is paced after the initial actor rate-limit window. Production
rate limits are unchanged; the recording can include this ordinary wait.
