// AES-256-GCM with the same additional authenticated data as the KMS
// sealer, keyed from a secret: what specs seal with, and what the
// emulator build's stand-in (stand-in.emulator.ts) is made of. Nothing
// here chooses to use it.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { type Sealer, aad } from './sealer';

/** A sealer keyed from `secret`; the ciphertext is iv, tag and data, base64. */
export function localSealer(secret: string): Sealer {
  const key = createHash('sha256').update(secret).digest();
  return {
    async seal(uid, provider, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(uid, provider));
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    async open(uid, provider, ciphertext) {
      const buf = Buffer.from(ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      decipher.setAAD(aad(uid, provider));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
