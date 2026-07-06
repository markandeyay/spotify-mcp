import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { listeningSnapshots } from "../db/schema.js";
import type { Artist, PlayHistory, Track } from "../spotify/types.js";

/**
 * Listening snapshots (Section 9.1): trimmed captures of recently-played and
 * top-items, persisted so trends can be computed across time windows that
 * Spotify's API cannot answer in one call. Payloads keep only what trends
 * need. Capture is opportunistic on tool calls (v1 fallback per the doc) and
 * throttled so chatty sessions do not flood the table.
 */

export const SNAPSHOT_THROTTLE_MINUTES = 30;

export interface RecentlyPlayedEntry {
  track_id: string;
  track_name: string;
  artists: { id: string; name: string }[];
  played_at: string;
}

export interface TopItemEntry {
  id: string;
  name: string;
  rank: number;
}

export type SnapshotKind = "recently_played" | "top_tracks" | "top_artists";

async function latestSnapshotTime(
  db: Db,
  userId: string,
  kind: SnapshotKind,
): Promise<Date | undefined> {
  const rows = await db
    .select({ capturedAt: listeningSnapshots.capturedAt })
    .from(listeningSnapshots)
    .where(and(eq(listeningSnapshots.userId, userId), eq(listeningSnapshots.kind, kind)))
    .orderBy(desc(listeningSnapshots.capturedAt))
    .limit(1);
  return rows[0]?.capturedAt;
}

async function shouldCapture(db: Db, userId: string, kind: SnapshotKind, now: Date): Promise<boolean> {
  const latest = await latestSnapshotTime(db, userId, kind);
  if (!latest) return true;
  return now.getTime() - latest.getTime() >= SNAPSHOT_THROTTLE_MINUTES * 60 * 1000;
}

export async function captureRecentlyPlayed(
  db: Db,
  userId: string,
  plays: PlayHistory[],
  now: Date = new Date(),
): Promise<boolean> {
  if (plays.length === 0) return false;
  if (!(await shouldCapture(db, userId, "recently_played", now))) return false;
  const entries: RecentlyPlayedEntry[] = plays.map((p) => ({
    track_id: p.track.id,
    track_name: p.track.name,
    artists: (p.track.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
    played_at: p.played_at,
  }));
  await db.insert(listeningSnapshots).values({
    userId,
    kind: "recently_played",
    capturedAt: now,
    payload: { entries },
  });
  return true;
}

export async function captureTopItems(
  db: Db,
  userId: string,
  kind: "top_tracks" | "top_artists",
  items: (Track | Artist)[],
  now: Date = new Date(),
): Promise<boolean> {
  if (items.length === 0) return false;
  if (!(await shouldCapture(db, userId, kind, now))) return false;
  const entries: TopItemEntry[] = items.map((item, index) => ({
    id: item.id,
    name: item.name,
    rank: index + 1,
  }));
  await db.insert(listeningSnapshots).values({
    userId,
    kind,
    capturedAt: now,
    payload: { entries },
  });
  return true;
}

export interface SnapshotRow<T> {
  capturedAt: Date;
  entries: T[];
}

export async function readSnapshots<T>(
  db: Db,
  userId: string,
  kind: SnapshotKind,
  since?: Date,
): Promise<SnapshotRow<T>[]> {
  const conditions = [eq(listeningSnapshots.userId, userId), eq(listeningSnapshots.kind, kind)];
  if (since) {
    conditions.push(gte(listeningSnapshots.capturedAt, since));
  }
  const rows = await db
    .select()
    .from(listeningSnapshots)
    .where(and(...conditions))
    .orderBy(listeningSnapshots.capturedAt);
  return rows.map((row) => ({
    capturedAt: row.capturedAt,
    entries: ((row.payload as { entries?: T[] }).entries ?? []) as T[],
  }));
}
