import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Db } from "../db/client.js";

/**
 * Everything the OAuth broker needs, injected so tests can point the Spotify
 * leg at a local fake without touching real Spotify.
 */

export interface SpotifyOAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export const REAL_SPOTIFY_OAUTH: SpotifyOAuthEndpoints = {
  authorizeUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  apiBaseUrl: "https://api.spotify.com/v1",
};

/** Minimum scopes for the tool surface (Section 6.5). No user-read-email. */
export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
] as const;

/** auth_session and our_auth_code lifetime (Section 6.6). */
export const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export interface AuthDeps {
  db: Db;
  config: Config;
  logger: Logger;
  encryptionKey: Buffer;
  spotify: SpotifyOAuthEndpoints;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}
