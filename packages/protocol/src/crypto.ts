import { sign, verify, createPrivateKey, createPublicKey, KeyObject, type KeyLike } from 'node:crypto';
import { canonicalJson } from './canonical.ts';

export interface SignedEnvelope<T> {
  payload: T;
  key_id: string;
  algorithm: 'Ed25519';
  signature: string;
}

function signingKey(input: KeyLike): KeyObject {
  const key = input instanceof KeyObject ? input : createPrivateKey(input);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('Receipt signing requires an Ed25519 private key');
  return key;
}

function verificationKey(input: KeyLike): KeyObject {
  const key = input instanceof KeyObject && input.type === 'public' ? input : createPublicKey(input);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Receipt verification requires an Ed25519 public key');
  return key;
}

/** Domain-separated signature: key identity and algorithm are included in signed bytes. */
export function signReceipt<T>(payload: T, keyId: string, privateKey: KeyLike): SignedEnvelope<T> {
  if (!keyId || typeof keyId !== 'string') throw new TypeError('Signing key ID is required');
  const unsigned = { payload, key_id: keyId, algorithm: 'Ed25519' as const };
  const signature = sign(null, Buffer.from('THOT-RECEIPT-v1\n' + canonicalJson(unsigned)), signingKey(privateKey)).toString('base64url');
  return { ...unsigned, signature };
}

export function verifyReceipt<T>(envelope: SignedEnvelope<T>, publicKey: KeyLike): boolean {
  try {
    if (!envelope || envelope.algorithm !== 'Ed25519' || typeof envelope.key_id !== 'string' || !envelope.key_id || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) return false;
    const { payload, key_id, algorithm, signature } = envelope;
    const decoded = Buffer.from(signature, 'base64url');
    if (decoded.toString('base64url') !== signature) return false;
    return verify(null, Buffer.from('THOT-RECEIPT-v1\n' + canonicalJson({ payload, key_id, algorithm })), verificationKey(publicKey), decoded);
  } catch {
    return false;
  }
}

export function signCanonical(value: unknown, privateKey: KeyLike): string {
  return sign(null, Buffer.from(canonicalJson(value)), signingKey(privateKey)).toString('base64url');
}

export function verifyCanonical(value: unknown, signature: string, publicKey: KeyLike): boolean {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    const decoded = Buffer.from(signature, 'base64url');
    return decoded.toString('base64url') === signature && verify(null, Buffer.from(canonicalJson(value)), verificationKey(publicKey), decoded);
  } catch { return false; }
}
