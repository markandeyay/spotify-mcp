import type { SavedTrack, Track } from "../spotify/types.js";
import { summarizePlaylistTracks, type PlaylistSummary } from "./summarize-playlist.js";

/**
 * Server-computed library aggregates (Section 8.6). Builds on the playlist
 * summarizer and adds save-cadence and diversity measures. All measured, no
 * mood claims.
 */

export interface LibrarySummary extends PlaylistSummary {
  saves_by_year: Record<string, number>;
  diversity: {
    distinct_artists: number;
    tracks_per_artist: number | null;
    note: string;
  };
  notable_concentrations: { name: string; runtime_share_pct: number }[];
}

export function summarizeLibrary(saved: SavedTrack[]): LibrarySummary {
  const tracks: Track[] = [];
  const addedAt: (string | null)[] = [];
  for (const entry of saved) {
    const track = entry.track ?? entry.item;
    if (track) {
      tracks.push(track);
      addedAt.push(entry.added_at ?? null);
    }
  }
  const base = summarizePlaylistTracks(tracks, addedAt);

  const savesByYear: Record<string, number> = {};
  for (const date of addedAt) {
    if (!date) continue;
    const year = date.slice(0, 4);
    savesByYear[year] = (savesByYear[year] ?? 0) + 1;
  }

  const distinct = base.artist_concentration.distinct_artists;
  const tracksPerArtist =
    distinct > 0 ? Math.round((tracks.length / distinct) * 10) / 10 : null;

  const notable = base.top_artists
    .filter((a) => a.runtime_share_pct !== null && a.runtime_share_pct >= 10)
    .map((a) => ({ name: a.name, runtime_share_pct: a.runtime_share_pct! }));

  return {
    ...base,
    saves_by_year: savesByYear,
    diversity: {
      distinct_artists: distinct,
      tracks_per_artist: tracksPerArtist,
      note: "Higher tracks_per_artist means deeper investment in fewer artists; lower means broader sampling. Measured from saved tracks only.",
    },
    notable_concentrations: notable,
  };
}
