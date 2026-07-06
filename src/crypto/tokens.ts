import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for tokens at rest (Section 6.6).
 * Blob layout: 12-byte IV | 16-byte auth tag | ciphertext.
 * The key is the 32-byte MASTER_ENCRYPTION_KEY, decoded from base64 once at
 * boot. Any tampering fails the auth tag check and throws.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function keyFromBase64(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptToken(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptToken(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted blob is too short to be valid");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
