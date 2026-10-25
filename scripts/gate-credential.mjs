#!/usr/bin/env node
// Generate one tester credential for the private form gate (#93). The password
// is read from stdin so it never appears in argv, logs or shell history; the
// printed entry belongs in the environment's sealed THOT_FORM_GATE_USERS set.
import {formGateCredentialFromStdin} from '../apps/api/form-gate.ts';

const username = process.argv[2];
if (!username || process.argv.length > 3) {
  console.error('Usage: printf %s \'tester password\' | node scripts/gate-credential.mjs <username>');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(await formGateCredentialFromStdin(username)));
}
