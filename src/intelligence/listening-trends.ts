import type { RecentlyPlayedEntry, SnapshotRow, TopItemEntry } from "./snapshots.js";

/**
 * Listening trend computation (Section 8.6). Two measured signal sources:
 *
 * 1. Accumulated recently-played snapshots, diffed across the halves of the
 *    requested window (best signal, needs history).
 * 2. Spotify's own top-artists over short_term vs long_term (always
 *    available, coarser).
 *
 * When history is thin the output says so plainly instead of inventing
 * trends.
 */

export interface ArtistTrend {
  name: string;
  earlier_plays: number;
  recent_plays: number;
}

export interface HistoryTrends {
  window_days: number;
  distinct_capture_days: number;
  total_plays_observed: number;
  rising_artists: ArtistTrend[];
  fading_artists: ArtistTrend[];
  new_artists: { name: string; recent_plays: number }[];
  concentration_change: {
    earlier_herfindahl: number | null;
    recent_herfindahl: number | null;
    interpretation_hint: string;
  };
}

export interface TopItemsComparison {
  rising: string[];
  fading: string[];
  steady: string[];
  note: string;
}

export interface ListeningTrends {
  measured_note: string;
  history: HistoryTrends | { thin_history: true; note: string };
  top_items_comparison: TopItemsComparison | null;
}

function herfindahl(counts: Map<string, number>): number | null {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let hhi = 0;
  for (const count of counts.values()) {
    hhi += (count / total) ** 2;
  }
  return Math.round(hhi * 1000) / 1000;
}

const MIN_PLAYS = 10;
const MIN_CAPTURE_DAYS = 2;

export function computeHistoryTrends(
  snapshots: SnapshotRow<RecentlyPlayedEntry>[],
  windowDays: number,
  now: Date = new Date(),
): HistoryTrends | { thin_history: true; note: string } {
  // Dedupe plays across overlapping snapshots by (track, played_at).
  const plays = new Map<string, { artist: string; playedAt: Date }>();
  const captureDays = new Set<string>();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  for (const snapshot of snapshots) {
    captureDays.add(snapshot.capturedAt.toISOString().slice(0, 10));
    for (const entry of snapshot.entries) {
      const playedAt = new Date(entry.played_at);
      if (Number.isNaN(playedAt.getTime()) || playedAt < windowStart) continue;
      plays.set(`${entry.track_id}|${entry.played_at}`, {
        artist: entry.artists[0]?.name ?? "unknown",
        playedAt,
      });
    }
  }

  if (plays.size < MIN_PLAYS || captureDays.size < MIN_CAPTURE_DAYS) {
    return {
      thin_history: true,
      note: `Only ${plays.size} plays across ${captureDays.size} capture day(s) are stored so far. Snapshots accumulate as the connector is used; trends from history will improve. The top-items comparison below is available immediately.`,
    };
  }

  const midpoint = new Date(now.getTime() - (windowDays / 2) * 24 * 60 * 60 * 1000);
  const earlier = new Map<string, number>();
  const recent = new Map<string, number>();
  for (const play of plays.values()) {
    const bucket = play.playedAt < midpoint ? earlier : recent;
    bucket.set(play.artist, (bucket.get(play.artist) ?? 0) + 1);
  }

  const artists = new Set([...earlier.keys(), ...recent.keys()]);
  const rising: ArtistTrend[] = [];
  const fading: ArtistTrend[] = [];
  const fresh: { name: string; recent_plays: number }[] = [];
  for (const name of artists) {
    const before = earlier.get(name) ?? 0;
    const after = recent.get(name) ?? 0;
    if (before === 0 && after >= 2) {
      fresh.push({ name, recent_plays: after });
    } else if (after >= before * 2 && after >= 3) {
      rising.push({ name, earlier_plays: before, recent_plays: after });
    } else if (before >= after * 2 && before >= 3) {
      fading.push({ name, earlier_plays: before, recent_plays: after });
    }
  }
  rising.sort((a, b) => b.recent_plays - a.recent_plays);
  fading.sort((a, b) => b.earlier_plays - a.earlier_plays);
  fresh.sort((a, b) => b.recent_plays - a.recent_plays);

  return {
    window_days: windowDays,
    distinct_capture_days: captureDays.size,
    total_plays_observed: plays.size,
    rising_artists: rising.slice(0, 10),
    fading_artists: fading.slice(0, 10),
    new_artists: fresh.slice(0, 10),
    concentration_change: {
      earlier_herfindahl: herfindahl(earlier),
      recent_herfindahl: herfindahl(recent),
      interpretation_hint:
        "Herfindahl over artist plays: higher means listening concentrated on fewer artists. Compare the two values for direction.",
    },
  };
}

export function compareTopItems(
  shortTerm: TopItemEntry[],
  longTerm: TopItemEntry[],
): TopItemsComparison {
  const shortNames = new Set(shortTerm.map((e) => e.name));
  const longNames = new Set(longTerm.map((e) => e.name));
  return {
    rising: shortTerm.filter((e) => !longNames.has(e.name)).map((e) => e.name),
    fading: longTerm.filter((e) => !shortNames.has(e.name)).map((e) => e.name),
    steady: shortTerm.filter((e) => longNames.has(e.name)).map((e) => e.name),
    note: "Measured from Spotify's own top-artists rankings: rising appears in the ~4-week ranking but not the ~1-year ranking, fading the reverse, steady in both.",
  };
}
