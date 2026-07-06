/**
 * Typed errors for every external boundary. Tool handlers map these to clean
 * MCP responses in Phase 4+; nothing here ever carries a raw Spotify body
 * forward to the model, only distilled facts.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Any non-OK Spotify response that is not one of the friendlier cases below. */
export class SpotifyApiError extends AppError {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message, "spotify_api_error");
  }
}

/** Spotify auth failed and a refresh did not fix it. User must reconnect. */
export class SpotifyAuthError extends AppError {
  constructor(message = "Spotify authorization failed after refresh") {
    super(message, "spotify_auth_error");
  }
}

/** 429 persisted past bounded backoff. */
export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds?: number) {
    super("Spotify is rate limiting requests; try again shortly", "rate_limited");
  }
}

/** Endpoint removed or restricted by Spotify; dependent tools degrade. */
export class EndpointUnavailableError extends AppError {
  constructor(readonly endpoint: string) {
    super(
      `Spotify no longer offers this capability (${endpoint})`,
      "endpoint_unavailable",
    );
  }
}

/** Playback attempted with no active device. */
export class NoActiveDeviceError extends AppError {
  constructor() {
    super(
      "No active Spotify device. Open Spotify on any device and start it, then retry.",
      "no_active_device",
    );
  }
}

/** Playback control attempted on a non-Premium account. */
export class PremiumRequiredError extends AppError {
  constructor() {
    super(
      "Playback control requires Spotify Premium. Read-only tools still work.",
      "premium_required",
    );
  }
}

/** A Spotify response failed schema validation in an unrecoverable way. */
export class SpotifyResponseShapeError extends AppError {
  constructor(readonly endpoint: string, detail: string) {
    super(`Unexpected Spotify response shape from ${endpoint}: ${detail}`, "bad_response_shape");
  }
}
