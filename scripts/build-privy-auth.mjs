#!/usr/bin/env node
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,dirname} from 'node:path';

export async function buildPrivyAuth({outdir = fileURLToPath(new URL('../apps/dashboard/', import.meta.url))} = {}) {
  const directory=resolve(outdir);
  const result=await build({entryPoints: [fileURLToPath(new URL('../apps/dashboard/privy-auth-entry.js', import.meta.url))], outdir:directory,
    entryNames:'privy-auth.bundle',chunkNames:'privy-auth-chunks/[hash]',splitting:true,write:false,
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, sourcemap: false,
    define: {'process.env.NODE_ENV': '"production"'}, legalComments: 'inline', metafile: true, logLevel: 'warning'});
  const assets=result.outputFiles.map(file=>({path:relative(directory,file.path).split('\\').join('/'),bytes:file.contents.length,
    sha256:createHash('sha256').update(file.contents).digest('hex')})).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(assets.length>512||assets.reduce((sum,file)=>sum+file.bytes,0)>32*1024*1024||
    !assets.some(file=>file.path==='privy-auth.bundle.js')||assets.some(file=>file.bytes>16*1024*1024||
      !/^(?:privy-auth\.bundle\.js|privy-auth-chunks\/[A-Z0-9]{8}\.js)$/.test(file.path)))throw new Error('PRIVY_ASSET_BUILD_LIMIT');
  const manifest=JSON.stringify({format:'thot.privy-assets/1',assets})+'\n';
  if(Buffer.byteLength(manifest)>128*1024)throw new Error('PRIVY_ASSET_MANIFEST_LIMIT');
  // Generated artifacts are image inputs, never source exports. Clear stale
  // chunks and publish the allowlist last so a rebuild cannot bless old files.
  await mkdir(directory,{recursive:true});
  await rm(resolve(directory,'privy-auth-chunks'),{recursive:true,force:true});
  for(const file of result.outputFiles){await mkdir(dirname(file.path),{recursive:true});await writeFile(file.path,file.contents);}
  await writeFile(resolve(directory,'privy-auth.assets.json'),manifest);
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildPrivyAuth();
