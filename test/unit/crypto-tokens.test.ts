import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken, keyFromBase64 } from "../../src/crypto/tokens.js";

describe("AES-256-GCM token encryption", () => {
  const key = randomBytes(32);

  it("round-trips plaintext", () => {
    const secret = "BQD_example_access_token_value_1234567890";
    const blob = encryptToken(secret, key);
    expect(decryptToken(blob, key)).toBe(secret);
  });

  it("produces a different ciphertext each time (fresh IV)", () => {
    const a = encryptToken("same-input", key);
    const b = encryptToken("same-input", key);
    expect(a.equals(b)).toBe(false);
  });

  it("never contains the plaintext in the blob", () => {
    const blob = encryptToken("super-secret-refresh-token", key);
    expect(blob.toString("utf8")).not.toContain("super-secret-refresh-token");
  });

  it("fails on tampered ciphertext", () => {
    const blob = encryptToken("secret", key);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => decryptToken(blob, key)).toThrow();
  });

  it("fails with the wrong key", () => {
    const blob = encryptToken("secret", key);
    expect(() => decryptToken(blob, randomBytes(32))).toThrow();
  });

  it("rejects blobs too short to contain IV and tag", () => {
    expect(() => decryptToken(Buffer.alloc(10), key)).toThrow();
  });

  it("keyFromBase64 enforces 32 bytes", () => {
    expect(() => keyFromBase64(randomBytes(16).toString("base64"))).toThrow();
    expect(keyFromBase64(randomBytes(32).toString("base64")).length).toBe(32);
  });
});
