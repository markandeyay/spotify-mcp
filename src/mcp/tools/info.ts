import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../tool-context.js";
import { compactTrack, ok, runTool } from "./helpers.js";
import { getAlbum, getArtist, getTrack } from "../../spotify/endpoints.js";
import { TTL } from "../../cache/cache.js";

/**
 * Catalog detail tools. Batch endpoints are gone (Feb 2026), so each fetch is
 * individual; catalog data is stable, so reads go through the shared cache.
 */

export function registerInfoTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_track_details",
    {
      description:
        "Get metadata for one track by Spotify id: name, artists, album, release date, duration. Note: Spotify removed popularity and audio features for third-party apps; those cannot be returned.",
      inputSchema: { id: z.string().min(1).describe("Spotify track id") },
    },
    async ({ id }) =>
      runTool(ctx, "get_track_details", async () => {
        const cacheKey = `track:${id}`;
        const cached = await ctx.cache.get<Record<string, unknown>>(cacheKey);
        if (cached) return ok(cached);
        const track = await getTrack(ctx.client, id);
        const structured = {
          ...compactTrack(track),
          ...(track.explicit !== undefined ? { explicit: track.explicit } : {}),
          ...(track.track_number !== undefined ? { track_number: track.track_number } : {}),
        };
        await ctx.cache.set(cacheKey, structured, TTL.catalogDetails);
        return ok(structured);
      }),
  );

  server.registerTool(
    "get_artist_details",
    {
      description:
        "Get metadata for one artist by Spotify id: name and genres when Spotify still populates them (genre data is sparse post-2026; absence does not mean the artist has no genre).",
      inputSchema: { id: z.string().min(1).describe("Spotify artist id") },
    },
    async ({ id }) =>
      runTool(ctx, "get_artist_details", async () => {
        const cacheKey = `artist:${id}`;
        const cached = await ctx.cache.get<Record<string, unknown>>(cacheKey);
        if (cached) return ok(cached);
        const artist = await getArtist(ctx.client, id);
        const structured = {
          id: artist.id,
          name: artist.name,
          ...(artist.uri ? { uri: artist.uri } : {}),
          genres: artist.genres ?? [],
          ...(artist.genres === undefined || artist.genres.length === 0
            ? { genre_note: "Spotify returned no genres for this artist; that field is sparsely populated." }
            : {}),
        };
        await ctx.cache.set(cacheKey, structured, TTL.catalogDetails);
        return ok(structured);
      }),
  );

  server.registerTool(
    "get_album_details",
    {
      description:
        "Get metadata and tracklist for one album by Spotify id: name, artist, release date, and its tracks in order.",
      inputSchema: { id: z.string().min(1).describe("Spotify album id") },
    },
    async ({ id }) =>
      runTool(ctx, "get_album_details", async () => {
        const cacheKey = `album:${id}`;
        const cached = await ctx.cache.get<Record<string, unknown>>(cacheKey);
        if (cached) return ok(cached);
        const album = await getAlbum(ctx.client, id);
        const structured = {
          id: album.id,
          name: album.name,
          ...(album.uri ? { uri: album.uri } : {}),
          artist: album.artists?.map((a) => a.name).join(", ") ?? "unknown",
          ...(album.release_date ? { released: album.release_date } : {}),
          ...(album.total_tracks !== undefined ? { total_tracks: album.total_tracks } : {}),
          tracks:
            album.tracks?.items?.map((t) => ({
              track_number: t.track_number,
              name: t.name,
              id: t.id,
              ...(t.duration_ms !== undefined ? { duration_ms: t.duration_ms } : {}),
            })) ?? [],
        };
        await ctx.cache.set(cacheKey, structured, TTL.catalogDetails);
        return ok(structured);
      }),
  );
}
