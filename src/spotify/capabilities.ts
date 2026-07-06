import type { SpotifyClient } from "./client.js";
import { getDevices } from "./endpoints.js";
import { SpotifyApiError } from "../util/errors.js";
import type { Device } from "./types.js";

/**
 * Runtime capability detection (Section 7.2), adapted per Decisions Log
 * 2026-07-05: GET /me no longer returns `product`, so Premium cannot be read
 * directly. Premium starts unknown and is inferred from playback-control
 * outcomes. Endpoint liveness is cached once an endpoint is seen dead.
 *
 * v1 keeps this in process memory keyed by user id; it degrades to re-probing
 * after a restart, which is acceptable and recorded in the Decisions Log.
 */

export type PremiumStatus = "unknown" | "premium" | "free";

interface UserCapabilities {
  premium: PremiumStatus;
  deadEndpoints: Set<string>;
}

export class CapabilityRegistry {
  private readonly byUser = new Map<string, UserCapabilities>();

  private forUser(userId: string): UserCapabilities {
    let caps = this.byUser.get(userId);
    if (!caps) {
      caps = { premium: "unknown", deadEndpoints: new Set() };
      this.byUser.set(userId, caps);
    }
    return caps;
  }

  premiumStatus(userId: string): PremiumStatus {
    return this.forUser(userId).premium;
  }

  /** Call after any playback-control attempt so status converges over time. */
  recordPlaybackOutcome(userId: string, outcome: "ok" | "premium_required"): void {
    this.forUser(userId).premium = outcome === "ok" ? "premium" : "free";
  }

  markEndpointUnavailable(userId: string, endpointKey: string): void {
    this.forUser(userId).deadEndpoints.add(endpointKey);
  }

  isEndpointUnavailable(userId: string, endpointKey: string): boolean {
    return this.forUser(userId).deadEndpoints.has(endpointKey);
  }
}

/** Checked live at playback time, never cached (Section 7.2). */
export async function findActiveDevice(client: SpotifyClient): Promise<Device | undefined> {
  const devices = await getDevices(client);
  return devices.find((d) => d.is_active);
}

/**
 * True when a Spotify error indicates the account lacks Premium. Spotify uses
 * 403 with reason PREMIUM_REQUIRED on playback endpoints.
 */
export function isPremiumRequiredError(error: unknown): boolean {
  return (
    error instanceof SpotifyApiError &&
    error.status === 403 &&
    (error.reason ?? "").toUpperCase().includes("PREMIUM")
  );
}

/** True when a playback error means no active device (Spotify returns 404). */
export function isNoActiveDeviceError(error: unknown): boolean {
  return (
    error instanceof SpotifyApiError &&
    error.status === 404 &&
    (error.reason ?? "").toUpperCase().includes("NO_ACTIVE_DEVICE")
  );
}

/**
 * True when a response indicates Spotify removed the endpoint entirely
 * (404/410 on a non-player path, or 403 with a deprecation-shaped reason).
 */
export function looksLikeRemovedEndpoint(error: unknown): boolean {
  if (!(error instanceof SpotifyApiError)) return false;
  if (error.status === 410) return true;
  const reason = (error.reason ?? "").toLowerCase();
  return (
    (error.status === 404 || error.status === 403) &&
    (reason.includes("deprecat") || reason.includes("sunset") || reason.includes("no longer"))
  );
}
