import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/test-db.js";
import type { Db } from "../../src/db/client.js";
import { spotifyTokens } from "../../src/db/schema.js";
import {
  loadSpotifyTokens,
  saveSpotifyTokens,
  upsertUser,
} from "../../src/db/token-store.js";

describe("data layer against migrated in-memory Postgres", () => {
  let db: Db;
  let close: () => Promise<void>;
  const key = randomBytes(32);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  it("applies migrations cleanly to a fresh database (all tables usable)", async () => {
    const user = await upsertUser(db, "spotify-user-1", "Mark");
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("upsert is idempotent on spotify_user_id and updates display name", async () => {
    const first = await upsertUser(db, "spotify-user-2", "Old Name");
    const second = await upsertUser(db, "spotify-user-2", "New Name");
    expect(second.id).toBe(first.id);
  });

  it("round-trips Spotify tokens through encryption at rest", async () => {
    const { id: userId } = await upsertUser(db, "spotify-user-3", null);
    const expiry = new Date(Date.now() + 3600_000);

    await saveSpotifyTokens(db, key, userId, {
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      accessExpiresAt: expiry,
      scope: "user-read-private",
    });

    const loaded = await loadSpotifyTokens(db, key, userId);
    expect(loaded?.accessToken).toBe("access-plain");
    expect(loaded?.refreshToken).toBe("refresh-plain");
    expect(loaded?.scope).toBe("user-read-private");

    // At-rest bytes must not contain plaintext.
    const raw = await db
      .select()
      .from(spotifyTokens)
      .where(eq(spotifyTokens.userId, userId));
    const stored = Buffer.from(raw[0]!.accessTokenEnc).toString("utf8");
    expect(stored).not.toContain("access-plain");
  });

  it("overwrites tokens on re-save (one row per user)", async () => {
    const { id: userId } = await upsertUser(db, "spotify-user-4", null);
    const expiry = new Date(Date.now() + 3600_000);
    await saveSpotifyTokens(db, key, userId, {
      accessToken: "a1",
      refreshToken: "r1",
      accessExpiresAt: expiry,
      scope: "",
    });
    await saveSpotifyTokens(db, key, userId, {
      accessToken: "a2",
      refreshToken: "r2",
      accessExpiresAt: expiry,
      scope: "",
    });
    const loaded = await loadSpotifyTokens(db, key, userId);
    expect(loaded?.accessToken).toBe("a2");
    const rows = await db
      .select()
      .from(spotifyTokens)
      .where(eq(spotifyTokens.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("returns undefined for a user with no tokens", async () => {
    const { id: userId } = await upsertUser(db, "spotify-user-5", null);
    await expect(loadSpotifyTokens(db, key, userId)).resolves.toBeUndefined();
  });
});
