import { z } from "zod";
import type { TokenProvider } from "./client.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { loadSpotifyTokens, saveSpotifyTokens } from "../db/token-store.js";
import { SpotifyAuthError } from "../util/errors.js";

/**
 * TokenProvider backed by the encrypted token store. Refreshes proactively
 * inside a 60 second expiry buffer (Section 7.1) and persists rotated tokens.
 * Spotify occasionally returns a new refresh_token on refresh; when it does,
 * the new one replaces the old at rest.
 */

const refreshResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export interface DbTokenProviderOptions {
  db: Db;
  encryptionKey: Buffer;
  userId: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  tokenUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  expiryBufferSeconds?: number;
  now?: () => Date;
}

export class DbTokenProvider implements TokenProvider {
  private readonly opts: DbTokenProviderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly bufferMs: number;

  constructor(opts: DbTokenProviderOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.bufferMs = (opts.expiryBufferSeconds ?? 60) * 1000;
  }

  async getAccessToken(): Promise<string> {
    const tokens = await loadSpotifyTokens(this.opts.db, this.opts.encryptionKey, this.opts.userId);
    if (!tokens) {
      throw new SpotifyAuthError("No Spotify tokens stored; please reconnect the connector.");
    }
    if (tokens.accessExpiresAt.getTime() - this.now().getTime() > this.bufferMs) {
      return tokens.accessToken;
    }
    return this.refreshWith(tokens.refreshToken, tokens.scope);
  }

  async refreshAccessToken(): Promise<string> {
    const tokens = await loadSpotifyTokens(this.opts.db, this.opts.encryptionKey, this.opts.userId);
    if (!tokens) {
      throw new SpotifyAuthError("No Spotify tokens stored; please reconnect the connector.");
    }
    return this.refreshWith(tokens.refreshToken, tokens.scope);
  }

  private async refreshWith(refreshToken: string, previousScope: string): Promise<string> {
    const basic = Buffer.from(
      `${this.opts.spotifyClientId}:${this.opts.spotifyClientSecret}`,
    ).toString("base64");
    const response = await this.fetchImpl(this.opts.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response.ok) {
      this.opts.logger.warn(
        { status: response.status, userId: this.opts.userId },
        "spotify token refresh failed",
      );
      throw new SpotifyAuthError("Spotify refresh failed; please reconnect the connector.");
    }
    const parsed = refreshResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new SpotifyAuthError("Unexpected refresh response from Spotify.");
    }
    await saveSpotifyTokens(this.opts.db, this.opts.encryptionKey, this.opts.userId, {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? refreshToken,
      accessExpiresAt: new Date(this.now().getTime() + parsed.data.expires_in * 1000),
      scope: parsed.data.scope ?? previousScope,
    });
    return parsed.data.access_token;
  }
}
