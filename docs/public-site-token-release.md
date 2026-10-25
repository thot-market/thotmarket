# Public token presentation and site builds

The public entry website and the application image have separate deployment lanes. Updating private dev/staging or a production application CVM does not publish the Cloudflare entry site.

The token's availability is separate from marketplace contracts, treasury campaigns and staking activation. A verified published token can have a visible trading link while a new mechanism still requires acceptance. Conversely, a dev/staging workspace's test token does not authorize a production trading destination.

## Required release inputs

Production entry builds, including the default canonical app destination, require an explicit reviewed launch configuration. A build without it fails with `PRODUCTION_TOKEN_CONFIGURATION_REQUIRED`; incomplete published addresses fail with `INCOMPLETE_LAUNCH_CONFIGURATION`. This prevents rebuilding accepted copy with silent preview defaults.

Supply a JSON file containing only `state`, `tokenAddress` and `ponsLaunchAddress`. Set state to launched only after verifying the intended chain, actual token address and intended Pons launch destination. Verify they refer to the intended project; they are distinct fields and must not be assumed identical. Keep this file with the reviewed release inputs and retain its hash. The build does not independently authenticate addresses or perform chain transactions.

```
node scripts/build-cloudflare-pages.ts --app-url https://app.thot.market/app --launch-config reviewed-token.json
```

Configured private/test destinations can retain preview state. Migration mode remains separate. Public release publication still requires its own authorization and exact artifact review.

## Acceptance

Inspect the built `v1/public/launch-config.json`, source/artifact hashes, address text and copy control, trading destination, and desktop/mobile rendering. Published configuration shows the exact supplied address. Preview configuration keeps the production destination hidden. A failed configuration request reports information unavailable rather than claiming the token is not yet published. Token availability never upgrades the mechanism status or enables holder dividends.

Compare the entire proposed site against the current published site, including manually published corrections, before replacing it. Verify the artifact actually deployed, not only the source branch or a successful upload. Preserve newer entry links, content and routing, and record the predecessor Worker version for recovery. A static-site bundle default or a prior app release is not evidence that the currently published token presentation was preserved.
