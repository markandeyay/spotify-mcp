import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { createTestDb } from "../helpers/test-db.js";
import { DbTokenProvider } from "../../src/spotify/token-provider.js";
import { loadSpotifyTokens, saveSpotifyTokens, upsertUser } from "../../src/db/token-store.js";
import { SpotifyAuthError } from "../../src/util/errors.js";
import { createLogger } from "../../src/logger.js";
import type { Db } from "../../src/db/client.js";

/**
 * Phase 10: the Spotify-leg refresh logic. Proactive refresh inside the 60s
 * buffer, persistence of rotated tokens, and reconnect guidance on failure.
 */

const silentLogger = createLogger("silent", new Writable({ write: (_c, _e, cb) => cb() }));
const key = randomBytes(32);

function refreshResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DbTokenProvider", () => {
  let db: Db;
  let close: () => Promise<void>;
  let userId: string;
  const now = new Date("2026-07-06T12:00:00Z");

  const provider = (fetchImpl: typeof fetch, uid = userId) =>
    new DbTokenProvider({
      db,
      encryptionKey: key,
      userId: uid,
      spotifyClientId: "cid",
      spotifyClientSecret: "csecret",
      tokenUrl: "https://accounts.fake.test/api/token",
      logger: silentLogger,
      fetchImpl,
      now: () => now,
    });

  const seedTokens = (expiresInSeconds: number, refreshToken = "refresh-old") =>
    saveSpotifyTokens(db, key, userId, {
      accessToken: "access-old",
      refreshToken,
      accessExpiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      scope: "user-read-private",
    });

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ id: userId } = await upsertUser(db, "token-user", "Token User"));
  });

  beforeEach(async () => {
    await seedTokens(3600);
  });

  afterAll(async () => {
    await close();
  });

  it("returns the stored token without refreshing when far from expiry", async () => {
    const fetchImpl = vi.fn();
    const token = await provider(fetchImpl as unknown as typeof fetch).getAccessToken();
    expect(token).toBe("access-old");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes proactively inside the 60 second buffer and persists the result", async () => {
    await seedTokens(30); // expires in 30s, inside the buffer
    const fetchImpl = vi.fn().mockResolvedValue(
      refreshResponse({
        access_token: "access-new",
        expires_in: 3600,
        refresh_token: "refresh-new",
      }),
    );

    const token = await provider(fetchImpl as typeof fetch).getAccessToken();

    expect(token).toBe("access-new");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://accounts.fake.test/api/token");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=refresh-old");

    const stored = await loadSpotifyTokens(db, key, userId);
    expect(stored?.accessToken).toBe("access-new");
    expect(stored?.refreshToken).toBe("refresh-new"); // rotated one replaced the old
  });

  it("keeps the previous refresh token when Spotify omits a new one", async () => {
    await seedTokens(30, "refresh-keep");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse({ access_token: "access-new", expires_in: 3600 }));

    await provider(fetchImpl as typeof fetch).getAccessToken();

    const stored = await loadSpotifyTokens(db, key, userId);
    expect(stored?.refreshToken).toBe("refresh-keep");
  });

  it("refreshAccessToken forces a refresh even when the token looks fresh", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse({ access_token: "access-forced", expires_in: 3600 }));

    const token = await provider(fetchImpl as typeof fetch).refreshAccessToken();

    expect(token).toBe("access-forced");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws SpotifyAuthError with reconnect guidance when the refresh is rejected", async () => {
    await seedTokens(30);
    const fetchImpl = vi.fn().mockResolvedValue(refreshResponse({ error: "invalid_grant" }, 400));

    await expect(provider(fetchImpl as typeof fetch).getAccessToken()).rejects.toThrow(
      /reconnect/i,
    );
  });

  it("throws SpotifyAuthError when no tokens are stored for the user", async () => {
    const { id: strangerId } = await upsertUser(db, "no-tokens-user", null);
    const fetchImpl = vi.fn();
    await expect(
      provider(fetchImpl as unknown as typeof fetch, strangerId).getAccessToken(),
    ).rejects.toBeInstanceOf(SpotifyAuthError);
  });
});
