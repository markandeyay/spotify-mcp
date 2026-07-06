import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** PKCE (RFC 7636) helpers plus shared random-token utilities. */

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Constant-time S256 verification of a verifier against a stored challenge. */
export function verifyS256(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(codeChallengeS256(verifier), "ascii");
  const stored = Buffer.from(challenge, "ascii");
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/** URL-safe random token for states, auth codes, and refresh tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
