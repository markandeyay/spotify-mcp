import { z } from "zod";
import type { SpotifyClient } from "./client.js";
import {
  albumSchema,
  artistSchema,
  currentUserSchema,
  devicesResponseSchema,
  libraryContainsSchema,
  pagingSchema,
  playbackStateSchema,
  playlistItemSchema,
  playlistSchema,
  recentlyPlayedSchema,
  savedTrackSchema,
  searchResponseSchema,
  trackSchema,
  type Album,
  type Artist,
  type CurrentUser,
  type Device,
  type PlaybackState,
  type Playlist,
  type PlaylistItem,
  type RecentlyPlayed,
  type SavedTrack,
  type SearchResponse,
  type Track,
} from "./types.js";

/**
 * Typed functions for verified-alive endpoints only (Decisions Log
 * 2026-07-05). Nothing here references audio-features, audio-analysis,
 * recommendations, batch fetches, browse, or artist top-tracks.
 */

/** Search returns at most 10 items per request post Feb 2026. */
export const SEARCH_PER_REQUEST_CAP = 10;

export type SearchType = "track" | "artist" | "album" | "playlist";
export type TopItemType = "artists" | "tracks";
export type TimeRange = "short_term" | "medium_term" | "long_term";

export async function getMe(client: SpotifyClient): Promise<CurrentUser> {
  return client.request("/me", { schema: currentUserSchema });
}

export async function getTopItems(
  client: SpotifyClient,
  type: TopItemType,
  options: { timeRange?: TimeRange; limit?: number; offset?: number } = {},
): Promise<{ items: (Artist | Track)[] }> {
  const schema = pagingSchema(type === "artists" ? artistSchema : trackSchema);
  return client.request(`/me/top/${type}`, {
    query: {
      time_range: options.timeRange ?? "medium_term",
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    },
    schema,
  });
}

/**
 * Paginates past the 10-per-request cap up to `limit` results per type.
 * Results are merged across pages, keyed by type.
 */
export async function search(
  client: SpotifyClient,
  query: string,
  types: SearchType[],
  limit: number,
): Promise<SearchResponse> {
  const merged: SearchResponse = {};
  // Spotify paginates each type independently; fan out per type so offsets stay coherent.
  for (const type of types) {
    const items = await client.paginate(
      async (pageLimit, offset) => {
        const page = await client.request("/search", {
          query: { q: query, type, limit: pageLimit, offset },
          schema: searchResponseSchema,
        });
        const bucket = page[`${type}s` as keyof SearchResponse];
        return {
          items: (bucket?.items ?? []) as never[],
          next: bucket?.next != null,
        };
      },
      { total: limit, perRequest: SEARCH_PER_REQUEST_CAP },
    );
    merged[`${type}s` as keyof SearchResponse] = { items } as never;
  }
  return merged;
}

export async function getTrack(client: SpotifyClient, id: string): Promise<Track> {
  return client.request(`/tracks/${encodeURIComponent(id)}`, { schema: trackSchema });
}

export async function getArtist(client: SpotifyClient, id: string): Promise<Artist> {
  return client.request(`/artists/${encodeURIComponent(id)}`, { schema: artistSchema });
}

export async function getAlbum(client: SpotifyClient, id: string): Promise<Album> {
  return client.request(`/albums/${encodeURIComponent(id)}`, { schema: albumSchema });
}

export async function getMyPlaylists(
  client: SpotifyClient,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: Playlist[]; total?: number | undefined }> {
  const page = await client.request("/me/playlists", {
    query: { limit: options.limit ?? 20, offset: options.offset ?? 0 },
    schema: pagingSchema(playlistSchema),
  });
  return { items: page.items, total: page.total };
}

export async function getPlaylist(client: SpotifyClient, id: string): Promise<Playlist> {
  return client.request(`/playlists/${encodeURIComponent(id)}`, { schema: playlistSchema });
}

/** Uses the renamed /items path and normalizes item vs legacy track field. */
export async function getPlaylistItems(
  client: SpotifyClient,
  id: string,
  options: { maxItems?: number } = {},
): Promise<{ tracks: Track[]; addedAt: (string | null)[] }> {
  const maxItems = options.maxItems ?? 200;
  const raw = await client.paginate<PlaylistItem>(
    async (limit, offset) => {
      const page = await client.request(
        `/playlists/${encodeURIComponent(id)}/items`,
        {
          query: { limit, offset },
          schema: pagingSchema(playlistItemSchema),
        },
      );
      return { items: page.items, next: page.next != null };
    },
    { total: maxItems, perRequest: 50 },
  );
  const tracks: Track[] = [];
  const addedAt: (string | null)[] = [];
  for (const entry of raw) {
    const track = entry.item ?? entry.track;
    if (track) {
      tracks.push(track);
      addedAt.push(entry.added_at ?? null);
    }
  }
  return { tracks, addedAt };
}

const createdPlaylistSchema = playlistSchema.extend({
  external_urls: z.object({ spotify: z.string().optional() }).optional(),
});

/** POST /me/playlists per Feb 2026 (old /users/{id}/playlists is removed). */
export async function createPlaylist(
  client: SpotifyClient,
  options: { name: string; description?: string; isPublic?: boolean },
): Promise<z.infer<typeof createdPlaylistSchema>> {
  return client.request("/me/playlists", {
    method: "POST",
    body: {
      name: options.name,
      ...(options.description !== undefined ? { description: options.description } : {}),
      public: options.isPublic ?? false,
    },
    schema: createdPlaylistSchema,
  });
}

const snapshotSchema = z.object({ snapshot_id: z.string().optional() });

export async function addPlaylistItems(
  client: SpotifyClient,
  playlistId: string,
  uris: string[],
): Promise<void> {
  await client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
    method: "POST",
    body: { uris },
    schema: snapshotSchema,
  });
}

export async function removePlaylistItems(
  client: SpotifyClient,
  playlistId: string,
  uris: string[],
): Promise<void> {
  await client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
    method: "DELETE",
    body: { items: uris.map((uri) => ({ uri })) },
    schema: snapshotSchema,
  });
}

export async function reorderPlaylistItems(
  client: SpotifyClient,
  playlistId: string,
  options: { rangeStart: number; insertBefore: number; rangeLength?: number },
): Promise<void> {
  await client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
    method: "PUT",
    body: {
      range_start: options.rangeStart,
      insert_before: options.insertBefore,
      range_length: options.rangeLength ?? 1,
    },
    schema: snapshotSchema,
  });
}

export async function getSavedTracks(
  client: SpotifyClient,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: SavedTrack[]; total?: number | undefined }> {
  const page = await client.request("/me/tracks", {
    query: { limit: options.limit ?? 20, offset: options.offset ?? 0 },
    schema: pagingSchema(savedTrackSchema),
  });
  return { items: page.items, total: page.total };
}

/** Generic library save per Feb 2026 consolidation. */
export async function saveToLibrary(client: SpotifyClient, uris: string[]): Promise<void> {
  await client.request("/me/library", { method: "PUT", body: { uris } });
}

export async function removeFromLibrary(client: SpotifyClient, uris: string[]): Promise<void> {
  await client.request("/me/library", { method: "DELETE", body: { uris } });
}

export async function libraryContains(
  client: SpotifyClient,
  uris: string[],
): Promise<boolean[]> {
  return client.request("/me/library/contains", {
    query: { uris: uris.join(",") },
    schema: libraryContainsSchema,
  });
}

export async function getRecentlyPlayed(
  client: SpotifyClient,
  options: { limit?: number; after?: number } = {},
): Promise<RecentlyPlayed> {
  return client.request("/me/player/recently-played", {
    query: { limit: options.limit ?? 20, after: options.after },
    schema: recentlyPlayedSchema,
  });
}

export async function getPlaybackState(
  client: SpotifyClient,
): Promise<PlaybackState | undefined> {
  // Spotify returns 204 with no body when nothing is playing.
  return client.request("/me/player", { schema: playbackStateSchema.optional() });
}

export async function getDevices(client: SpotifyClient): Promise<Device[]> {
  const response = await client.request("/me/player/devices", {
    schema: devicesResponseSchema,
  });
  return response.devices;
}

export type PlaybackAction =
  | { action: "play"; uris?: string[]; contextUri?: string }
  | { action: "pause" }
  | { action: "next" }
  | { action: "previous" }
  | { action: "seek"; positionMs: number }
  | { action: "volume"; volumePercent: number };

export async function controlPlayback(
  client: SpotifyClient,
  command: PlaybackAction,
): Promise<void> {
  switch (command.action) {
    case "play":
      await client.request("/me/player/play", {
        method: "PUT",
        ...(command.uris || command.contextUri
          ? {
              body: {
                ...(command.uris ? { uris: command.uris } : {}),
                ...(command.contextUri ? { context_uri: command.contextUri } : {}),
              },
            }
          : {}),
      });
      return;
    case "pause":
      await client.request("/me/player/pause", { method: "PUT" });
      return;
    case "next":
      await client.request("/me/player/next", { method: "POST" });
      return;
    case "previous":
      await client.request("/me/player/previous", { method: "POST" });
      return;
    case "seek":
      await client.request("/me/player/seek", {
        method: "PUT",
        query: { position_ms: command.positionMs },
      });
      return;
    case "volume":
      await client.request("/me/player/volume", {
        method: "PUT",
        query: { volume_percent: command.volumePercent },
      });
      return;
  }
}

export async function queueTrack(client: SpotifyClient, uri: string): Promise<void> {
  await client.request("/me/player/queue", { method: "POST", query: { uri } });
}

export async function transferPlayback(
  client: SpotifyClient,
  deviceId: string,
  play: boolean,
): Promise<void> {
  await client.request("/me/player", {
    method: "PUT",
    body: { device_ids: [deviceId], play },
  });
}
