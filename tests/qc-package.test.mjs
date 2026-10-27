import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {contentDigest} from '../packages/qc/index.ts';

test('packed QC installs offline without repository dependencies and checks an exported source',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'thot-qc-package-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=new URL('../',import.meta.url);
 execFileSync('npm',['pack','./packages/thot-qc','--pack-destination',dir],{cwd:root,stdio:'pipe'});
 const archive=(await readdir(dir)).find(name=>name.endsWith('.tgz'));assert(archive);
 const install=join(dir,'installed');
 execFileSync('npm',['install','--prefix',install,'--offline','--ignore-scripts','--no-audit','--no-fund',join(dir,archive)],{stdio:'pipe'});
 const cli=join(install,'node_modules/@thotmarket/qc/bin/thot-qc.js');
 assert.match(execFileSync(process.execPath,[cli,'--help'],{encoding:'utf8'}),/inventory/);
 const content={turns:[{role:'user',content:'Synthetic test task'},{role:'assistant',content:'Synthetic test answer'}]};
 const source=join(dir,'source.json'),report=join(dir,'report.json');
 await writeFile(source,JSON.stringify({schema_version:'trace-qc-export/v1',selected_source:{scope:'release',content_hash:contentDigest(content)},content}));
 const output=execFileSync(process.execPath,[cli,'check','--input',source,'--output',report],{cwd:dir,encoding:'utf8'});
 assert.doesNotMatch(output,/Synthetic test/);
 assert.equal(JSON.parse(await readFile(report,'utf8')).report.content_digest,contentDigest(content));
});
