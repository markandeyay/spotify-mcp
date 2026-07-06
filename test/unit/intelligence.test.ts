import { describe, expect, it } from "vitest";
import { summarizePlaylistTracks } from "../../src/intelligence/summarize-playlist.js";
import { summarizeLibrary } from "../../src/intelligence/summarize-library.js";
import {
  compareTopItems,
  computeHistoryTrends,
  type HistoryTrends,
} from "../../src/intelligence/listening-trends.js";
import { crossReferenceCandidates } from "../../src/intelligence/find-gaps.js";
import type { SavedTrack, Track } from "../../src/spotify/types.js";
import type { RecentlyPlayedEntry, SnapshotRow } from "../../src/intelligence/snapshots.js";

/** Phase 8 acceptance: summaries return accurate server-computed stats. */

const track = (id: string, artist: string, extra: Partial<Track> = {}): Track => ({
  id,
  name: `Track ${id}`,
  artists: [{ id: `artist-${artist}`, name: artist }],
  ...extra,
});

describe("summarizePlaylistTracks", () => {
  const tracks: Track[] = [
    track("t1", "Anna", {
      duration_ms: 200_000,
      explicit: false,
      album: { id: "al1", name: "One", release_date: "2010-05-01" },
    }),
    track("t2", "Anna", {
      duration_ms: 200_000,
      explicit: false,
      album: { id: "al2", name: "Two", release_date: "2012" },
    }),
    track("t3", "Bram", {
      duration_ms: 400_000,
      explicit: true,
      album: { id: "al3", name: "Three", release_date: "2020-01-15" },
    }),
    // No duration, no album, no explicit flag: every field must degrade.
    track("t4", "Cleo"),
  ];
  const addedAt = ["2024-01-01T00:00:00Z", null, "2023-06-15T00:00:00Z", null];
  const summary = summarizePlaylistTracks(tracks, addedAt);

  it("computes runtime, counts, and artist shares from known durations", () => {
    expect(summary.track_count).toBe(4);
    expect(summary.total_runtime_minutes).toBe(13); // 800000 ms
    expect(summary.top_artists[0]).toEqual({
      name: "Anna",
      track_count: 2,
      runtime_share_pct: 50,
    });
    expect(summary.artist_concentration.distinct_artists).toBe(3);
    expect(summary.artist_concentration.top3_runtime_share_pct).toBe(100);
    // Shares 0.5 (Anna), 0.5 (Bram), 0 (Cleo): 0.25 + 0.25 + 0.
    expect(summary.artist_concentration.herfindahl_index).toBe(0.5);
  });

  it("computes release-year stats only over tracks with a known year", () => {
    expect(summary.release_years).toEqual({
      known_for_tracks: 3,
      min: 2010,
      max: 2020,
      median: 2012,
      by_decade: { "2010s": 2, "2020s": 1 },
    });
  });

  it("computes explicit share over tracks with a known flag", () => {
    expect(summary.explicit_share_pct).toBeCloseTo(33.3, 1);
  });

  it("reports the add-date range ignoring unknown dates", () => {
    expect(summary.added_between).toEqual({
      first: "2023-06-15T00:00:00Z",
      last: "2024-01-01T00:00:00Z",
    });
  });

  it("labels the output as measured, deferring interpretation", () => {
    expect(summary.measured_note).toMatch(/computed by the server/i);
    expect(summary.measured_note).toMatch(/inference/i);
  });

  it("returns nulls, not NaN, for an empty playlist", () => {
    const empty = summarizePlaylistTracks([]);
    expect(empty.track_count).toBe(0);
    expect(empty.total_runtime_minutes).toBeNull();
    expect(empty.artist_concentration.herfindahl_index).toBeNull();
    expect(empty.release_years.median).toBeNull();
    expect(empty.explicit_share_pct).toBeNull();
  });
});

describe("summarizeLibrary", () => {
  const saved: SavedTrack[] = [
    {
      added_at: "2023-03-01T00:00:00Z",
      track: track("t1", "Anna", { duration_ms: 300_000 }),
    },
    {
      added_at: "2023-08-01T00:00:00Z",
      // The renamed `item` field must be handled like `track`.
      item: track("t2", "Anna", { duration_ms: 300_000 }),
    },
    {
      added_at: "2024-02-01T00:00:00Z",
      track: track("t3", "Bram", { duration_ms: 60_000 }),
    },
    // Track object missing entirely: entry is skipped, not crashed on.
    { added_at: "2024-03-01T00:00:00Z" },
  ];
  const summary = summarizeLibrary(saved);

  it("counts saves by year from added_at", () => {
    expect(summary.saves_by_year).toEqual({ "2023": 2, "2024": 1 });
  });

  it("computes diversity over distinct artists", () => {
    expect(summary.diversity.distinct_artists).toBe(2);
    expect(summary.diversity.tracks_per_artist).toBe(1.5);
  });

  it("flags artists holding at least 10 percent of runtime", () => {
    const names = summary.notable_concentrations.map((c) => c.name);
    expect(names).toContain("Anna"); // 600k of 660k runtime
    expect(summary.notable_concentrations[0]!.runtime_share_pct).toBeGreaterThanOrEqual(10);
  });
});

describe("computeHistoryTrends", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const entry = (trackId: string, artist: string, playedAt: string): RecentlyPlayedEntry => ({
    track_id: trackId,
    track_name: `Track ${trackId}`,
    artists: [{ id: `artist-${artist}`, name: artist }],
    played_at: playedAt,
  });
  const snapshot = (
    capturedAt: string,
    entries: RecentlyPlayedEntry[],
  ): SnapshotRow<RecentlyPlayedEntry> => ({ capturedAt: new Date(capturedAt), entries });

  it("reports thin history honestly instead of inventing trends", () => {
    const result = computeHistoryTrends(
      [snapshot("2026-06-20T00:00:00Z", [entry("t1", "Anna", "2026-06-20T10:00:00Z")])],
      30,
      now,
    );
    expect(result).toMatchObject({ thin_history: true });
    expect((result as { note: string }).note).toMatch(/1 plays across 1 capture day/);
  });

  it("classifies rising, fading, and new artists across window halves", () => {
    // Window 2026-06-01 to 2026-07-01, midpoint 2026-06-16.
    const earlier = (n: number, artist: string) =>
      Array.from({ length: n }, (_, i) =>
        entry(`${artist}-e${i}`, artist, `2026-06-05T0${i}:00:00Z`),
      );
    const recent = (n: number, artist: string) =>
      Array.from({ length: n }, (_, i) =>
        entry(`${artist}-r${i}`, artist, `2026-06-20T0${i}:00:00Z`),
      );
    const snapshots = [
      snapshot("2026-06-06T00:00:00Z", [
        ...earlier(4, "Fader"),
        ...earlier(1, "Riser"),
        ...earlier(2, "Steady"),
      ]),
      snapshot("2026-06-21T00:00:00Z", [
        ...recent(1, "Fader"),
        ...recent(3, "Riser"),
        ...recent(2, "Fresh"),
        ...recent(2, "Steady"),
        // Duplicate of an earlier play (same track, same timestamp): the
        // overlap that recently-played snapshots naturally produce.
        entry("Fader-e0", "Fader", "2026-06-05T00:00:00Z"),
      ]),
    ];

    const result = computeHistoryTrends(snapshots, 30, now) as HistoryTrends;
    expect(result.total_plays_observed).toBe(15); // duplicate counted once
    expect(result.distinct_capture_days).toBe(2);
    expect(result.rising_artists.map((a) => a.name)).toEqual(["Riser"]);
    expect(result.fading_artists.map((a) => a.name)).toEqual(["Fader"]);
    expect(result.new_artists).toEqual([{ name: "Fresh", recent_plays: 2 }]);
    // Earlier: 4/1/2 of 7 plays. Recent: 1/3/2/2 of 8 plays.
    expect(result.concentration_change.earlier_herfindahl).toBeCloseTo(21 / 49, 2);
    expect(result.concentration_change.recent_herfindahl).toBeCloseTo(18 / 64, 2);
  });

  it("ignores plays outside the requested window", () => {
    const stale = Array.from({ length: 12 }, (_, i) =>
      entry(`old-${i}`, "Ancient", `2026-01-01T0${i % 10}:00:00Z`),
    );
    const result = computeHistoryTrends(
      [snapshot("2026-01-02T00:00:00Z", stale), snapshot("2026-06-20T00:00:00Z", [])],
      30,
      now,
    );
    expect(result).toMatchObject({ thin_history: true });
  });
});

describe("compareTopItems", () => {
  it("splits short-term vs long-term rankings into rising, fading, steady", () => {
    const result = compareTopItems(
      [
        { id: "x", name: "NewFav", rank: 1 },
        { id: "y", name: "Both", rank: 2 },
      ],
      [
        { id: "y", name: "Both", rank: 1 },
        { id: "z", name: "OldFav", rank: 2 },
      ],
    );
    expect(result.rising).toEqual(["NewFav"]);
    expect(result.fading).toEqual(["OldFav"]);
    expect(result.steady).toEqual(["Both"]);
  });
});

describe("crossReferenceCandidates", () => {
  it("separates missing candidates from ones the user already has", () => {
    const result = crossReferenceCandidates(
      [
        { name: "anna", type: "artist" }, // owned, case-insensitive
        { name: "Fresh Face", type: "artist" }, // not owned
        { name: "Some Album", type: "album", uri: "spotify:album:owned" }, // URI hit
        { name: "Anna", type: "album" }, // album named like an owned artist: still missing
      ],
      new Set(["Anna", "Bram"]),
      new Map([["spotify:album:owned", true]]),
    );
    expect(result.missing.map((c) => c.name)).toEqual(["Fresh Face", "Anna"]);
    expect(result.already_have).toHaveLength(2);
    expect(result.already_have.map((h) => h.candidate.name).sort()).toEqual([
      "Some Album",
      "anna",
    ]);
  });
});
