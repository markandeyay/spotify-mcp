import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Db } from "../db/client.js";
import type { AuthenticatedUser } from "../auth/resolver.js";
import type { SpotifyOAuthEndpoints } from "../auth/deps.js";
import { SpotifyClient } from "../spotify/client.js";
import { DbTokenProvider } from "../spotify/token-provider.js";
import type { CapabilityRegistry } from "../spotify/capabilities.js";
import type { Cache } from "../cache/cache.js";

/**
 * Everything a tool handler needs for one authenticated request. The Spotify
 * client is built per request (per user); the capability registry and cache
 * are shared across requests.
 */

export interface ToolContext {
  user: AuthenticatedUser;
  db: Db;
  config: Config;
  logger: Logger;
  client: SpotifyClient;
  capabilities: CapabilityRegistry;
  cache: Cache;
}

export interface ToolContextDeps {
  db: Db;
  config: Config;
  logger: Logger;
  encryptionKey: Buffer;
  spotify: SpotifyOAuthEndpoints;
  capabilities: CapabilityRegistry;
  cache: Cache;
  fetchImpl?: typeof fetch;
}

export function buildToolContext(deps: ToolContextDeps, user: AuthenticatedUser): ToolContext {
  const tokenProvider = new DbTokenProvider({
    db: deps.db,
    encryptionKey: deps.encryptionKey,
    userId: user.id,
    spotifyClientId: deps.config.SPOTIFY_CLIENT_ID,
    spotifyClientSecret: deps.config.SPOTIFY_CLIENT_SECRET,
    tokenUrl: deps.spotify.tokenUrl,
    logger: deps.logger,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new SpotifyClient({
    tokenProvider,
    logger: deps.logger,
    apiBaseUrl: deps.spotify.apiBaseUrl,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return {
    user,
    db: deps.db,
    config: deps.config,
    logger: deps.logger,
    client,
    capabilities: deps.capabilities,
    cache: deps.cache,
  };
}
