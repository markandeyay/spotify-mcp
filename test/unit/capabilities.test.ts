import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  isNoActiveDeviceError,
  isPremiumRequiredError,
  looksLikeRemovedEndpoint,
} from "../../src/spotify/capabilities.js";
import { SpotifyApiError } from "../../src/util/errors.js";

describe("CapabilityRegistry", () => {
  it("starts premium status as unknown and converges on playback outcomes", () => {
    const registry = new CapabilityRegistry();
    expect(registry.premiumStatus("u1")).toBe("unknown");

    registry.recordPlaybackOutcome("u1", "premium_required");
    expect(registry.premiumStatus("u1")).toBe("free");

    registry.recordPlaybackOutcome("u1", "ok");
    expect(registry.premiumStatus("u1")).toBe("premium");
  });

  it("caches dead endpoints per user", () => {
    const registry = new CapabilityRegistry();
    registry.markEndpointUnavailable("u1", "GET /browse/new-releases");
    expect(registry.isEndpointUnavailable("u1", "GET /browse/new-releases")).toBe(true);
    expect(registry.isEndpointUnavailable("u2", "GET /browse/new-releases")).toBe(false);
  });
});

describe("error classifiers", () => {
  it("detects premium-required 403s", () => {
    const err = new SpotifyApiError("forbidden", 403, "PREMIUM_REQUIRED");
    expect(isPremiumRequiredError(err)).toBe(true);
    expect(isPremiumRequiredError(new SpotifyApiError("forbidden", 403, "OTHER"))).toBe(false);
  });

  it("detects no-active-device 404s", () => {
    const err = new SpotifyApiError("not found", 404, "NO_ACTIVE_DEVICE");
    expect(isNoActiveDeviceError(err)).toBe(true);
    expect(isNoActiveDeviceError(new SpotifyApiError("not found", 404))).toBe(false);
  });

  it("detects removed endpoints by 410 or deprecation-shaped reasons", () => {
    expect(looksLikeRemovedEndpoint(new SpotifyApiError("gone", 410))).toBe(true);
    expect(
      looksLikeRemovedEndpoint(new SpotifyApiError("gone", 404, "endpoint deprecated")),
    ).toBe(true);
    expect(looksLikeRemovedEndpoint(new SpotifyApiError("nf", 404, "NO_ACTIVE_DEVICE"))).toBe(
      false,
    );
    expect(looksLikeRemovedEndpoint(new Error("random"))).toBe(false);
  });
});
