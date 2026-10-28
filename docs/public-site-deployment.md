# Public site deployment

The public site is separate from the marketplace application. Its Cloudflare Worker serves the allowlisted static export and one read-only metadata endpoint, `/v1/public/catalogue`. That endpoint reads only the application's fixed public stats and listing URLs, forwards no visitor credentials or request parameters, and caches successful results for 60 seconds. All other requests use the static asset binding. No application secrets are required by the Worker.

Build the static site with `scripts/build-cloudflare-pages.ts` and a reviewed launch configuration. Deploy the merged source with `wrangler deploy --config deploy/public-site.wrangler.jsonc`, using the maintainer's existing Cloudflare account credentials in the environment. Record the previous deployment version before publishing. The config preserves the existing public hostname and has no preview hostname.

Validate `/stats` on desktop and mobile, the catalogue endpoint, search/filter/sort controls, both chart measures, navigation across the public pages, and the public health endpoint. `tests/public-catalogue.test.mjs` and `tests/public-catalogue-browser.test.mjs` cover the data boundary and page behavior. `tests/site-navigation-browser.test.mjs` checks stable navigation.

The timeline reconstructs currently listed records by their original creation dates. It is not a historical snapshot series, net market growth, or unique underlying trace count. The directory endpoint currently exposes at most 48 entries; the UI identifies partial coverage. Conversation turns are not provider-billed tokens. Do not estimate or label them as tokens.
