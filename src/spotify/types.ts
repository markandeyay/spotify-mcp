import { z } from "zod";

/**
 * Zod schemas for Spotify responses, post Feb 2026 shape. Every field Spotify
 * has removed or might remove is optional or nullable; code must handle
 * absence gracefully (spotifymcp.md Sections 7.1 and 12).
 */

export const simplifiedArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string().optional(),
});

export const imageSchema = z.object({
  url: z.string(),
  height: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
});

export const artistSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string().optional(),
  // Not listed as removed in Feb 2026, but may be sparse. Always optional.
  genres: z.array(z.string()).optional(),
  images: z.array(imageSchema).optional(),
});

export const simplifiedAlbumSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string().optional(),
  album_type: z.string().optional(),
  release_date: z.string().optional(),
  release_date_precision: z.string().optional(),
  total_tracks: z.number().optional(),
  artists: z.array(simplifiedArtistSchema).optional(),
  images: z.array(imageSchema).optional(),
});

export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string().optional(),
  duration_ms: z.number().optional(),
  explicit: z.boolean().optional(),
  track_number: z.number().optional(),
  disc_number: z.number().optional(),
  artists: z.array(simplifiedArtistSchema).optional(),
  album: simplifiedAlbumSchema.optional(),
  is_local: z.boolean().optional(),
});

export const albumSchema = simplifiedAlbumSchema.extend({
  tracks: z
    .object({
      items: z.array(trackSchema).optional(),
      total: z.number().optional(),
      next: z.string().nullable().optional(),
    })
    .optional(),
});

/** GET /me post Feb 2026: product, country, email, followers are gone. */
export const currentUserSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable().optional(),
  uri: z.string().optional(),
});

export function pagingSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    next: z.string().nullable().optional(),
  });
}

export const playlistOwnerSchema = z.object({
  id: z.string().optional(),
  display_name: z.string().nullable().optional(),
});

/** Playlist as it appears in list responses. `tracks` renamed to `items`. */
export const playlistSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string().optional(),
  description: z.string().nullable().optional(),
  public: z.boolean().nullable().optional(),
  collaborative: z.boolean().optional(),
  owner: playlistOwnerSchema.optional(),
  items: z.object({ total: z.number().optional() }).optional(),
  // Tolerate the pre-rename field so a partial rollout cannot break us.
  tracks: z.object({ total: z.number().optional() }).optional(),
});

/** One entry of GET /playlists/{id}/items. `track` renamed to `item`. */
export const playlistItemSchema = z.object({
  added_at: z.string().nullable().optional(),
  is_local: z.boolean().optional(),
  item: trackSchema.nullable().optional(),
  track: trackSchema.nullable().optional(),
});

export const savedTrackSchema = z.object({
  added_at: z.string().optional(),
  track: trackSchema.nullable().optional(),
  item: trackSchema.nullable().optional(),
});

export const deviceSchema = z.object({
  id: z.string().nullable(),
  is_active: z.boolean(),
  name: z.string(),
  type: z.string(),
  volume_percent: z.number().nullable().optional(),
});

export const devicesResponseSchema = z.object({
  devices: z.array(deviceSchema),
});

export const playbackStateSchema = z.object({
  device: deviceSchema.optional(),
  is_playing: z.boolean(),
  progress_ms: z.number().nullable().optional(),
  item: trackSchema.nullable().optional(),
  shuffle_state: z.boolean().optional(),
  repeat_state: z.string().optional(),
  currently_playing_type: z.string().optional(),
});

export const playHistorySchema = z.object({
  track: trackSchema,
  played_at: z.string(),
  context: z
    .object({ type: z.string().optional(), uri: z.string().optional() })
    .nullable()
    .optional(),
});

export const recentlyPlayedSchema = z.object({
  items: z.array(playHistorySchema),
  next: z.string().nullable().optional(),
  cursors: z
    .object({ after: z.string().optional(), before: z.string().optional() })
    .nullable()
    .optional(),
});

export const searchResponseSchema = z.object({
  tracks: pagingSchema(trackSchema).optional(),
  artists: pagingSchema(artistSchema).optional(),
  albums: pagingSchema(simplifiedAlbumSchema).optional(),
  playlists: pagingSchema(playlistSchema.nullable()).optional(),
});

export const libraryContainsSchema = z.array(z.boolean());

export type SimplifiedArtist = z.infer<typeof simplifiedArtistSchema>;
export type Artist = z.infer<typeof artistSchema>;
export type SimplifiedAlbum = z.infer<typeof simplifiedAlbumSchema>;
export type Album = z.infer<typeof albumSchema>;
export type Track = z.infer<typeof trackSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type Playlist = z.infer<typeof playlistSchema>;
export type PlaylistItem = z.infer<typeof playlistItemSchema>;
export type SavedTrack = z.infer<typeof savedTrackSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type PlaybackState = z.infer<typeof playbackStateSchema>;
export type PlayHistory = z.infer<typeof playHistorySchema>;
export type RecentlyPlayed = z.infer<typeof recentlyPlayedSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
