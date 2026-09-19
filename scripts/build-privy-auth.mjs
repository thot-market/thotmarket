#!/usr/bin/env node
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export async function buildPrivyAuth({outdir = fileURLToPath(new URL('../apps/dashboard/', import.meta.url))} = {}) {
  return build({entryPoints: [fileURLToPath(new URL('../apps/dashboard/privy-auth-entry.js', import.meta.url))], outfile: resolve(outdir, 'privy-auth.bundle.js'),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, sourcemap: false,
    define: {'process.env.NODE_ENV': '"production"'}, legalComments: 'inline', metafile: true, logLevel: 'warning'});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPrivyAuth();
