import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {copyFile,chmod} from 'node:fs/promises';
await build({entryPoints:[fileURLToPath(new URL('../../scripts/qc-workspace.ts',import.meta.url))],outfile:fileURLToPath(new URL('runtime/qc.mjs',import.meta.url)),bundle:true,platform:'node',format:'esm',target:'node24'});
await copyFile(new URL('../../LICENSE',import.meta.url),new URL('LICENSE',import.meta.url));
await chmod(new URL('bin/thot-qc.js',import.meta.url),0o755);
