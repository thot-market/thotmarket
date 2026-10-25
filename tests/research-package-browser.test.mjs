// Run the HTTP/local-chain research journey with actual desktop/mobile UI steps.
process.env.THOT_RESEARCH_BROWSER='1';
await import('./research-delivery.integration.mjs');
