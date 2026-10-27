#!/usr/bin/env node
import {main} from '../runtime/qc.mjs';
main(process.argv.slice(2)).catch(error=>{
 const code=/^QC_WORKSPACE_[A-Z_0-9]+$/.test(error?.message??'')?error.message:error?.code==='EEXIST'?'Output already exists. Choose a new output; to replace a connection, log out first.':'QC_WORKSPACE_IO_ERROR';
 process.stderr.write(code+'\n');process.exitCode=2;
});
