import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { spotifyTokens, users } from "./schema.js";
import { decryptToken, encryptToken } from "../crypto/tokens.js";

/**
 * The only read/write path for Spotify tokens. Tokens are always encrypted
 * before they touch the database and decrypted only in memory on the way out.
 */

export interface StoredSpotifyTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  scope: string;
}

export async function upsertUser(
  db: Db,
  spotifyUserId: string,
  displayName: string | null,
): Promise<{ id: string }> {
  const rows = await db
    .insert(users)
    .values({ spotifyUserId, displayName })
    .onConflictDoUpdate({
      target: users.spotifyUserId,
      set: { displayName, lastSeenAt: new Date() },
    })
    .returning({ id: users.id });
  const row = rows[0];
  if (!row) throw new Error("user upsert returned no row");
  return row;
}

export async function saveSpotifyTokens(
  db: Db,
  encryptionKey: Buffer,
  userId: string,
  tokens: StoredSpotifyTokens,
): Promise<void> {
  const values = {
    userId,
    accessTokenEnc: encryptToken(tokens.accessToken, encryptionKey),
    refreshTokenEnc: encryptToken(tokens.refreshToken, encryptionKey),
    accessExpiresAt: tokens.accessExpiresAt,
    scope: tokens.scope,
    updatedAt: new Date(),
  };
  await db
    .insert(spotifyTokens)
    .values(values)
    .onConflictDoUpdate({ target: spotifyTokens.userId, set: values });
}

export async function loadSpotifyTokens(
  db: Db,
  encryptionKey: Buffer,
  userId: string,
): Promise<StoredSpotifyTokens | undefined> {
  const rows = await db
    .select()
    .from(spotifyTokens)
    .where(eq(spotifyTokens.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    accessToken: decryptToken(Buffer.from(row.accessTokenEnc), encryptionKey),
    refreshToken: decryptToken(Buffer.from(row.refreshTokenEnc), encryptionKey),
    accessExpiresAt: row.accessExpiresAt,
    scope: row.scope,
  };
}

export async function touchUser(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
}
