#!/usr/bin/env node
// Standalone format/integrity example. This is NOT a DCAP verifier or an importer.
import {createPublicKey, verify} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalHash, canonicalJson} from './canonical.mjs';

const check = (condition, code) => { if (!condition) throw Error(code); };
const exact = (value, required, optional = []) => {
  check(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  check(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'INVALID_FIELDS');
};
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const base64 = value => {
  check(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0, 'INVALID_BASE64');
  const bytes = Buffer.from(value, 'base64');
  check(bytes.toString('base64') === value, 'INVALID_BASE64');
  return bytes;
};

/** resolvePart is a placement adapter, outside the signed manifest. */
export async function verifyExample(example, resolvePart) {
  check(example?.example_format === 'thot.receipt-format-example/1', 'UNSUPPORTED_EXAMPLE');
  const {bundle, evidence} = example;
  exact(bundle, ['format','capture_id','client','started_at','finished_at','parts','root']);
  check(bundle.format === 'thot.proxy-capture/2' && ['claude','codex'].includes(bundle.client), 'UNSUPPORTED_MANIFEST');
  check(typeof bundle.capture_id === 'string' && bundle.capture_id.length > 0, 'INVALID_CAPTURE_ID');
  check([bundle.started_at, bundle.finished_at].every(t => typeof t === 'string' && Number.isFinite(Date.parse(t))) && bundle.started_at <= bundle.finished_at, 'INVALID_CAPTURE_TIME');
  check(Array.isArray(bundle.parts) && bundle.parts.length > 0 && bundle.parts.length <= 4096, 'INVALID_PART_COUNT');
  const {root, ...manifest} = bundle;
  check(hex(root) && canonicalHash(manifest) === root, 'MANIFEST_ROOT_MISMATCH');
  for (const [index, descriptor] of bundle.parts.entries()) {
    exact(descriptor, ['sequence','commitment']);
    check(descriptor.sequence === index + 1 && hex(descriptor.commitment), 'INVALID_PART_SEQUENCE');
    const part = await resolvePart(descriptor);
    check(part !== undefined && part !== null, 'PART_MISSING');
    exact(part, ['sequence','upstream','path','request_body_b64','response_body_b64','status','content_type','started_at','finished_at','complete','commitment'], ['request_encoding','request_method']);
    const {commitment, ...record} = part;
    check(part.sequence === descriptor.sequence && commitment === descriptor.commitment && canonicalHash(record) === commitment, 'PART_COMMITMENT_MISMATCH');
    base64(part.request_body_b64); base64(part.response_body_b64);
  }
  const seal = evidence?.statement;
  exact(seal, ['purpose','capture_id','client','consent_hash','bundle_hash','session_root']);
  check(seal.purpose === 'thot.tee-capture-seal/1' && seal.capture_id === bundle.capture_id && seal.client === bundle.client && seal.session_root === root && seal.bundle_hash === canonicalHash(bundle), 'SEAL_BINDING_MISMATCH');
  check(hex(seal.consent_hash) && canonicalHash(example.consent) === seal.consent_hash, 'CONSENT_BINDING_MISMATCH');
  const identity = evidence.attestation?.statement;
  exact(identity, ['purpose','signing_key','channel_key']);
  check(identity.purpose === 'thot.tee-recorder-key/1', 'INVALID_RECORDER_KEY_STATEMENT');
  const key = createPublicKey({key: base64(identity.signing_key), format: 'der', type: 'spki'});
  check(key.asymmetricKeyType === 'ed25519', 'INVALID_SIGNING_KEY_TYPE');
  const signature = base64(evidence.signature);
  check(signature.length === 64 && verify(null, Buffer.from(canonicalJson(seal)), key, signature), 'SEAL_SIGNATURE_INVALID');
  return {
    integrity: 'valid', verified_parts: bundle.parts.length, session_root: root,
    seal_signature: 'valid_under_supplied_public_key',
    hardware_evidence: evidence.attestation.quote ? 'present_but_UNVERIFIED' : 'ABSENT_UNVERIFIED',
    recorder_identity: 'UNAUTHENTICATED', provider_authorship: 'NOT_ESTABLISHED',
    unsigned_vault_receipt_and_summary: 'NOT_AUTHENTICATED',
    warning: 'Synthetic example only. A signature under the supplied key is not hardware assurance, provider authorship, proof of storage, or permission to sell.'
  };
}

/** Bounded local adapter only. No network access and no storage URL in identity. */
export async function verifyDirectory(directory) {
  const root = await realpath(directory);
  async function json(relative) {
    check(typeof relative === 'string' && relative.length > 0, 'INVALID_LOCAL_LOCATOR');
    const path = await realpath(resolve(root, relative)).catch(error => { if (error.code === 'ENOENT') throw Error('PART_MISSING'); throw error; });
    check(path.startsWith(root + sep), 'LOCAL_LOCATOR_OUTSIDE_EXPORT');
    const info = await stat(path);
    check(info.isFile() && info.size <= 1_000_000, 'EXAMPLE_FILE_LIMIT');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  const example = await json('example.json'), locations = await json('locations.json');
  return verifyExample(example, descriptor => {
    check(Object.hasOwn(locations, descriptor.commitment), 'PART_MISSING');
    return json(locations[descriptor.commitment]);
  });
}

// Detached exports may run from /tmp, which macOS resolves to /private/tmp.
if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(resolve(process.argv[1]))) {
  try {
    check(process.argv.length <= 3, 'USAGE: node verify.mjs [export-directory]');
    console.log(JSON.stringify(await verifyDirectory(process.argv[2] ?? dirname(fileURLToPath(import.meta.url))), null, 2));
  } catch (error) {
    console.error(JSON.stringify({integrity: 'FAILED', hardware_evidence: 'UNVERIFIED', error: error.message}));
    process.exitCode = 1;
  }
}
