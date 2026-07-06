import type { Track } from "../spotify/types.js";

/**
 * Server-computed playlist aggregates (Section 9). Everything here is
 * measured from metadata: counts, runtime, shares, release years. No mood or
 * energy claims; interpretation belongs to the calling model and outputs say
 * so via `measured_note`.
 */

export interface PlaylistSummary {
  measured_note: string;
  track_count: number;
  total_runtime_minutes: number | null;
  top_artists: { name: string; track_count: number; runtime_share_pct: number | null }[];
  artist_concentration: {
    distinct_artists: number;
    top3_runtime_share_pct: number | null;
    herfindahl_index: number | null;
  };
  release_years: {
    known_for_tracks: number;
    min: number | null;
    max: number | null;
    median: number | null;
    by_decade: Record<string, number>;
  };
  explicit_share_pct: number | null;
  added_between: { first: string | null; last: string | null };
}

function releaseYear(track: Track): number | undefined {
  const date = track.album?.release_date;
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : undefined;
}

export function summarizePlaylistTracks(
  tracks: Track[],
  addedAt: (string | null)[] = [],
): PlaylistSummary {
  const trackCount = tracks.length;
  const durations = tracks
    .map((t) => t.duration_ms)
    .filter((d): d is number => d !== undefined);
  const totalRuntimeMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null;

  // Artist shares weighted by runtime where known, else by track count.
  const byArtist = new Map<string, { tracks: number; runtimeMs: number }>();
  for (const track of tracks) {
    const primary = track.artists?.[0]?.name ?? "unknown";
    const entry = byArtist.get(primary) ?? { tracks: 0, runtimeMs: 0 };
    entry.tracks += 1;
    entry.runtimeMs += track.duration_ms ?? 0;
    byArtist.set(primary, entry);
  }
  const totalKnownRuntime = [...byArtist.values()].reduce((a, e) => a + e.runtimeMs, 0);
  const sorted = [...byArtist.entries()].sort((a, b) => b[1].runtimeMs - a[1].runtimeMs || b[1].tracks - a[1].tracks);
  const share = (runtimeMs: number): number | null =>
    totalKnownRuntime > 0 ? Math.round((runtimeMs / totalKnownRuntime) * 1000) / 10 : null;

  const topArtists = sorted.slice(0, 5).map(([name, entry]) => ({
    name,
    track_count: entry.tracks,
    runtime_share_pct: share(entry.runtimeMs),
  }));
  const top3Share =
    totalKnownRuntime > 0
      ? Math.round(
          (sorted.slice(0, 3).reduce((a, [, e]) => a + e.runtimeMs, 0) / totalKnownRuntime) * 1000,
        ) / 10
      : null;
  // Herfindahl index over runtime shares: 1/N (even spread) to 1 (one artist).
  const hhi =
    totalKnownRuntime > 0
      ? Math.round(
          sorted.reduce((a, [, e]) => a + (e.runtimeMs / totalKnownRuntime) ** 2, 0) * 1000,
        ) / 1000
      : null;

  const years = tracks.map(releaseYear).filter((y): y is number => y !== undefined).sort((a, b) => a - b);
  const byDecade: Record<string, number> = {};
  for (const year of years) {
    const decade = `${Math.floor(year / 10) * 10}s`;
    byDecade[decade] = (byDecade[decade] ?? 0) + 1;
  }
  const median =
    years.length > 0
      ? years.length % 2 === 1
        ? years[(years.length - 1) / 2]!
        : Math.round((years[years.length / 2 - 1]! + years[years.length / 2]!) / 2)
      : null;

  const explicitKnown = tracks.filter((t) => t.explicit !== undefined);
  const explicitShare =
    explicitKnown.length > 0
      ? Math.round(
          (explicitKnown.filter((t) => t.explicit).length / explicitKnown.length) * 1000,
        ) / 10
      : null;

  const addedDates = addedAt.filter((d): d is string => d !== null).sort();

  return {
    measured_note:
      "All numbers are computed by the server from Spotify metadata. Genre, mood, or energy characterizations are not included; infer those from the artists and eras if needed and label them as inference.",
    track_count: trackCount,
    total_runtime_minutes: totalRuntimeMs !== null ? Math.round(totalRuntimeMs / 60000) : null,
    top_artists: topArtists,
    artist_concentration: {
      distinct_artists: byArtist.size,
      top3_runtime_share_pct: top3Share,
      herfindahl_index: hhi,
    },
    release_years: {
      known_for_tracks: years.length,
      min: years[0] ?? null,
      max: years[years.length - 1] ?? null,
      median,
      by_decade: byDecade,
    },
    explicit_share_pct: explicitShare,
    added_between: {
      first: addedDates[0] ?? null,
      last: addedDates[addedDates.length - 1] ?? null,
    },
  };
}
