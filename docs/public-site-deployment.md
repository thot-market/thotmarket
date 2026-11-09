# Public site deployment

The public site is separate from the marketplace application. Its Cloudflare Worker serves only the allowlisted static export. It has no script and needs no application secrets.

Build the static site with `scripts/build-cloudflare-pages.ts` and a reviewed launch configuration. Deploy the merged source with `wrangler deploy --config deploy/public-site.wrangler.jsonc`, using the maintainer's existing Cloudflare account credentials in the environment. Record the previous deployment version before publishing. The config preserves the existing public hostname and has no preview hostname.

Validate navigation across the public pages and the public health endpoint. `tests/site-navigation-browser.test.mjs` checks stable navigation.
