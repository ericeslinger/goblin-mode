// Sealing a gardener's provider key (#144, Eric's BYOK design): Cloud
// KMS encrypts it with the project's one symmetric key, which never
// leaves KMS, and `uid:provider` goes along as additional authenticated
// data, so a ciphertext copied to another gardener's record, or another
// provider's field, fails to open. CRC32C checks catch corruption in
// transit, as the KMS docs recommend. The emulator has no KMS: there, a
// local AES-256-GCM sealer with the same AAD stands in.
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface Sealer {
  /** The key as base64 ciphertext, bound to this gardener and provider. */
  seal(uid: string, provider: string, plaintext: string): Promise<string>;
  /** The key back, or a throw if it is not this gardener's and provider's. */
  open(uid: string, provider: string, ciphertext: string): Promise<string>;
}

/** The KMS key ring and key, by name; the project is the deployment's. */
export const KMS_LOCATION = 'us-central1';
export const KMS_KEY_RING = 'mossgoblin';
export const KMS_KEY = 'gardener-keys';

const aad = (uid: string, provider: string) => Buffer.from(`${uid}:${provider}`, 'utf8');

// CRC32C (Castagnoli), table-based, as KMS computes it; pure JS so the
// functions deploy grows no native module.
const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32c(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A KMS checksum, an Int64Value, as a number. */
const longValue = (v: { value?: unknown } | null | undefined): number | undefined =>
  v?.value === undefined || v.value === null ? undefined : Number(v.value);

/** Cloud KMS, in production: the function's own identity must hold the role it needs. */
export function kmsSealer(projectId: string): Sealer {
  const client = new KeyManagementServiceClient();
  const name = client.cryptoKeyPath(projectId, KMS_LOCATION, KMS_KEY_RING, KMS_KEY);
  return {
    async seal(uid, provider, plaintext) {
      const data = Buffer.from(plaintext, 'utf8');
      const extra = aad(uid, provider);
      const [res] = await client.encrypt({
        name,
        plaintext: data,
        plaintextCrc32c: { value: crc32c(data) },
        additionalAuthenticatedData: extra,
        additionalAuthenticatedDataCrc32c: { value: crc32c(extra) },
      });
      if (!res.verifiedPlaintextCrc32c || !res.verifiedAdditionalAuthenticatedDataCrc32c) {
        throw new Error('KMS did not verify the request');
      }
      const out = Buffer.from(res.ciphertext as Uint8Array);
      if (crc32c(out) !== longValue(res.ciphertextCrc32c)) {
        throw new Error('KMS ciphertext corrupted in transit');
      }
      return out.toString('base64');
    },
    async open(uid, provider, ciphertext) {
      const data = Buffer.from(ciphertext, 'base64');
      const extra = aad(uid, provider);
      const [res] = await client.decrypt({
        name,
        ciphertext: data,
        ciphertextCrc32c: { value: crc32c(data) },
        additionalAuthenticatedData: extra,
        additionalAuthenticatedDataCrc32c: { value: crc32c(extra) },
      });
      const out = Buffer.from(res.plaintext as Uint8Array);
      if (crc32c(out) !== longValue(res.plaintextCrc32c)) {
        throw new Error('KMS plaintext corrupted in transit');
      }
      return out.toString('utf8');
    },
  };
}

/**
 * AES-256-GCM with the same AAD, keyed from `secret`: the emulator's
 * stand-in for KMS (there is none), and what specs use. The ciphertext
 * is iv, tag and data, base64.
 */
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

/**
 * The sealer for this deployment: KMS, in the deployment's project,
 * except under the functions emulator, which has no KMS (like the
 * Cloud Tasks wake, which the emulator skips).
 */
export function sealerFromEnv(env: NodeJS.ProcessEnv): Sealer {
  if (env['FUNCTIONS_EMULATOR'] === 'true') return localSealer('mossgoblin-emulator');
  const config = env['FIREBASE_CONFIG'];
  const projectId =
    (config ? (JSON.parse(config) as { projectId?: string }).projectId : undefined) ??
    env['GCLOUD_PROJECT'];
  if (!projectId) throw new Error('no project id for KMS');
  return kmsSealer(projectId);
}
