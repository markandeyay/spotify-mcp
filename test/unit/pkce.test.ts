import { describe, expect, it } from "vitest";
import {
  codeChallengeS256,
  generateCodeVerifier,
  randomToken,
  sha256Hex,
  verifyS256,
} from "../../src/auth/pkce.js";

describe("PKCE helpers", () => {
  it("verifier round-trips through S256 verification", () => {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    expect(verifyS256(verifier, challenge)).toBe(true);
  });

  it("rejects a different verifier", () => {
    const challenge = codeChallengeS256(generateCodeVerifier());
    expect(verifyS256(generateCodeVerifier(), challenge)).toBe(false);
  });

  it("rejects a malformed challenge without throwing", () => {
    expect(verifyS256(generateCodeVerifier(), "short")).toBe(false);
  });

  it("matches the RFC 7636 appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("randomToken is url-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("sha256Hex is deterministic", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toHaveLength(64);
  });
});
