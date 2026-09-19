#!/usr/bin/env node
/** Build a reviewable CLI tarball from an exact sanitized source tag. No upload. */
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';

const packageDir=dirname(fileURLToPath(import.meta.url));
const root=resolve(packageDir,'../..');
const [tag,outputArg]=process.argv.slice(2);
if(!/^cli\/v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(tag??'')||!outputArg)throw Error('Usage: node packages/thot-cli/prepare-release.mjs cli/vVERSION NEW_OUTPUT_DIRECTORY');
const output=resolve(outputArg);
if(output.startsWith(root+'/'))throw Error('OUTPUT_MUST_BE_OUTSIDE_SOURCE');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const version=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8')).version;
if(tag!==`cli/v${version}`)throw Error('CLI_TAG_VERSION_MISMATCH');
if(git('cat-file','-t',`refs/tags/${tag}`)!=='tag')throw Error('ANNOTATED_TAG_REQUIRED');
const commit=git('rev-parse',`refs/tags/${tag}^{commit}`);
if(git('rev-parse','HEAD')!==commit)throw Error('CHECKOUT_NOT_AT_CLI_TAG');
if(git('status','--porcelain','--untracked-files=all'))throw Error('SOURCE_NOT_CLEAN');
await mkdir(output,{mode:0o700});
const packed=spawnSync('npm',['pack','--json','--pack-destination',output],{cwd:packageDir,encoding:'utf8',maxBuffer:4*1024*1024});
if(packed.status!==0)throw Error('CLI_PACK_FAILED:'+packed.stderr.slice(0,1000));
const metadata=JSON.parse(packed.stdout)[0];
if(metadata.name!=='@thotmarket/cli'||metadata.version!==version||!/^sha512-/.test(metadata.integrity))throw Error('CLI_PACK_METADATA_MISMATCH');
const archive=join(output,metadata.filename),bytes=await readFile(archive);
if((await stat(archive)).size!==metadata.size)throw Error('CLI_TARBALL_SIZE_MISMATCH');
const files=metadata.files.map(file=>file.path);
if(files.some(path=>path.includes('deploy/cvm/')||path.includes('node_modules')||path.endsWith('.env')))throw Error('PRIVATE_FILE_IN_CLI_TARBALL');
const record={format:'thot.cli-release-preparation/1',tag,commit,name:metadata.name,version,
  tarball:metadata.filename,sha256:createHash('sha256').update(bytes).digest('hex'),integrity:metadata.integrity,
  files,publication:'not-published'};
await writeFile(join(output,'release-review.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({tag,commit,tarball:archive,sha256:record.sha256,files:files.length,publication:record.publication}));
