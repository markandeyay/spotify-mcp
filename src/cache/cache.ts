import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cacheEntries } from "../db/schema.js";

/**
 * TTL cache backed by the cache_entries table (Section 10). Keys are scoped
 * by the caller (e.g. `track:{id}` global, `user:{id}:saved-tracks` per user).
 */

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number, userId?: string): Promise<void>;
  /** Invalidate one key, e.g. after a mutation makes the cached read stale. */
  delete(key: string): Promise<void>;
  /** Opportunistic cleanup of expired rows; call occasionally, not per read. */
  sweep(): Promise<void>;
}

/** Builders for keys that both readers and invalidating mutators need. */
export const cacheKeys = {
  playlistItems: (userId: string, playlistId: string) =>
    `user:${userId}:playlist:${playlistId}:items`,
  libraryScan: (userId: string) => `user:${userId}:library-scan`,
} as const;

export function createDbCache(db: Db, now: () => Date = () => new Date()): Cache {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const rows = await db
        .select()
        .from(cacheEntries)
        .where(eq(cacheEntries.cacheKey, key))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      if (row.expiresAt.getTime() <= now().getTime()) {
        await db.delete(cacheEntries).where(eq(cacheEntries.cacheKey, key));
        return undefined;
      }
      return row.payload as T;
    },

    async set(key: string, value: unknown, ttlSeconds: number, userId?: string): Promise<void> {
      const values = {
        cacheKey: key,
        userId: userId ?? null,
        payload: value,
        expiresAt: new Date(now().getTime() + ttlSeconds * 1000),
      };
      await db
        .insert(cacheEntries)
        .values(values)
        .onConflictDoUpdate({ target: cacheEntries.cacheKey, set: values });
    },

    async delete(key: string): Promise<void> {
      await db.delete(cacheEntries).where(eq(cacheEntries.cacheKey, key));
    },

    async sweep(): Promise<void> {
      await db
        .delete(cacheEntries)
        .where(and(lt(cacheEntries.expiresAt, now())));
    },
  };
}

/** Standard TTLs (Section 10): catalog is stable, user lists churn. */
export const TTL = {
  catalogDetails: 24 * 60 * 60,
  playlistItems: 120,
  savedTracks: 300,
  playlists: 300,
} as const;
