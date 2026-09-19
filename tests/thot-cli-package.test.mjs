import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('reviewed export builds a standalone CLI tarball with runtime verification assets',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'thot-cli-package-'));
  try{
    const source=join(temporary,'source');
    const dependencies=JSON.parse(await readFile(join(root,'packages/thot-cli/reviewed-source-files.json'),'utf8')).files;
    let policy;
    try{policy=JSON.parse(await readFile(join(root,'release/public-export-policy.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(policy)for(const dependency of dependencies)assert(policy.files.includes(dependency),dependency);
    // Build from package-owned source plus its explicit runtime dependencies;
    // public source does not need the private export policy or source history.
    const packageFiles=['package.json','build.mjs','reviewed-source-files.json','README.md','LICENSE','bin/thot.js'];
    for(const name of [...new Set([...dependencies,'LICENSE',...packageFiles.map(name=>'packages/thot-cli/'+name)])]){
      const target=join(source,name);await mkdir(dirname(target),{recursive:true});
      await copyFile(join(root,name),target);
    }
    const packed=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temporary],{
      cwd:join(source,'packages/thot-cli'),encoding:'utf8',env:{...process.env,NPM_CONFIG_USERCONFIG:'/dev/null'},
    }))[0];
    const paths=packed.files.map(file=>file.path);
    assert(paths.includes('bin/thot.js'));
    assert(paths.includes('LICENSE'));
    assert(paths.includes('runtime/scripts/capture-terminal-child.js'));
    for(const name of ['verify.mjs','canonical.mjs','hardware.mjs','verify_dcap.py','requirements.txt','README.txt']){
      assert(paths.includes('runtime/packages/provenance/portable/'+name),name);
    }
    assert(paths.includes('runtime/packages/provenance/scripts/verify_recorder.py'));
    assert(paths.includes('runtime/trace-vault/attestation_verify.py'));
    assert(paths.includes('runtime/deploy/tee-recorder-policy.json'));
    assert(!paths.some(path=>path.endsWith('.ts')||path.includes('node_modules')||path.includes('.env')||path.includes('deploy/cvm/')||path.endsWith('build.mjs')));
    execFileSync('tar',['-xzf',join(temporary,packed.filename),'-C',temporary]);
    const installed=join(temporary,'package');
    const metadata=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
    assert.equal(metadata.name,'@thotmarket/cli');
    assert.equal(metadata.license,'MIT');assert.equal(metadata.author,'Thot Market');
    assert.equal(await readFile(join(installed,'LICENSE'),'utf8'),await readFile(join(root,'LICENSE'),'utf8'));
    assert.equal(metadata.bin.thot,'bin/thot.js');assert.equal(metadata.publishConfig.tag,'staging');
    assert(!metadata.scripts?.postinstall && !metadata.scripts?.install && !metadata.dependencies);
    const help=execFileSync(process.execPath,[join(installed,'bin/thot.js'),'--help'],{encoding:'utf8',cwd:temporary});
    assert.match(help,/Usage: thot codex\|claude/);
    assert.doesNotMatch(help,/legacy --thot-url|THOT_URL, THOT_URL/);
    const setup=execFileSync(process.execPath,[join(installed,'bin/thot.js'),'setup','--help'],{encoding:'utf8',cwd:temporary});
    assert.match(setup,/Usage: thot setup/);
    const {recorderPolicyFile}=await import(pathToFileURL(join(installed,'runtime/packages/capture/src/tee/policy-file.js')));
    const selected=await recorderPolicyFile('https://unused.invalid',{});
    assert.deepEqual(JSON.parse(await readFile(selected,'utf8')),{url:'',instances:{}});
    const runtime=await readFile(join(installed,'runtime/scripts/thot.js'),'utf8');
    assert(!runtime.includes("??'http://127.0.0.1:4322'"));
    const noDefault=spawnSync(process.execPath,[join(installed,'bin/thot.js'),'--disconnect','codex'],{encoding:'utf8',cwd:temporary,env:{...process.env,THOT_USER_HOME:temporary,THOT_URL:'',THOT_URL:''}});
    assert.notEqual(noDefault.status,0);
    assert.match(noDefault.stderr,/THOT_PRODUCTION_ORIGIN_UNCONFIGURED/);
    assert.equal(await recorderPolicyFile('https://unused.invalid',{THOT_RECORDER_POLICY_FILE:'/trusted/policy.json'}),'/trusted/policy.json');
    const {clientInvocation}=await import(pathToFileURL(join(installed,'runtime/packages/capture/src/index.js')));
    for(const client of ['claude','codex'])assert.equal(clientInvocation(client,'https://recorder.invalid',[]).command,client);
  }finally{await rm(temporary,{recursive:true,force:true});}
});
