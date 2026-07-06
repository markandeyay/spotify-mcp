import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../tool-context.js";
import { compactTrack, ok, runTool, toolError } from "./helpers.js";
import {
  addPlaylistItems,
  createPlaylist,
  getMyPlaylists,
  getPlaylist,
  getPlaylistItems,
  removePlaylistItems,
  reorderPlaylistItems,
} from "../../spotify/endpoints.js";
import { summarizePlaylistTracks } from "../../intelligence/summarize-playlist.js";
import { TTL } from "../../cache/cache.js";

/** Fan-out cap: playlist reads walk 50-item pages; cap keeps costs bounded. */
const PLAYLIST_ITEMS_CAP = 200;

export function registerPlaylistTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_playlists",
    {
      description:
        "List the user's playlists: name, id, track count, owner. Paginate with limit and offset.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ limit, offset }) =>
      runTool(ctx, "list_playlists", async () => {
        const page = await getMyPlaylists(ctx.client, { limit, offset });
        return ok({
          total: page.total ?? null,
          offset,
          playlists: page.items.map((p) => ({
            id: p.id,
            name: p.name,
            track_count: p.items?.total ?? p.tracks?.total ?? null,
            owner: p.owner?.display_name ?? p.owner?.id ?? "unknown",
            ...(p.public !== null && p.public !== undefined ? { public: p.public } : {}),
          })),
        });
      }),
  );

  server.registerTool(
    "get_playlist",
    {
      description:
        `Read one playlist. mode "raw" returns a compact track list (capped at ${PLAYLIST_ITEMS_CAP} tracks); mode "summary" returns server-computed aggregates (artist distribution, release-era spread, runtime) instead of tracks. Note: Spotify only returns contents for playlists the user owns or collaborates on.`,
      inputSchema: {
        id: z.string().min(1).describe("Spotify playlist id"),
        mode: z.enum(["raw", "summary"]).default("raw"),
      },
    },
    async ({ id, mode }) =>
      runTool(ctx, "get_playlist", async () => {
        const meta = await getPlaylist(ctx.client, id);
        const cacheKey = `user:${ctx.user.id}:playlist:${id}:items`;
        let items = await ctx.cache.get<Awaited<ReturnType<typeof getPlaylistItems>>>(cacheKey);
        if (!items) {
          items = await getPlaylistItems(ctx.client, id, { maxItems: PLAYLIST_ITEMS_CAP });
          await ctx.cache.set(cacheKey, items, TTL.playlistItems, ctx.user.id);
        }
        const declaredTotal = meta.items?.total ?? meta.tracks?.total ?? items.tracks.length;
        const truncated = declaredTotal > items.tracks.length;

        const base = {
          id: meta.id,
          name: meta.name,
          owner: meta.owner?.display_name ?? meta.owner?.id ?? "unknown",
          ...(meta.description ? { description: meta.description } : {}),
          track_count: declaredTotal,
          ...(truncated
            ? {
                truncation_note: `Only the first ${items.tracks.length} of ${declaredTotal} tracks were read to bound API fan-out.`,
              }
            : {}),
        };

        if (mode === "summary") {
          return ok({
            ...base,
            summary: summarizePlaylistTracks(items.tracks, items.addedAt),
          });
        }
        return ok({ ...base, tracks: items.tracks.map((t) => compactTrack(t)) });
      }),
  );

  server.registerTool(
    "create_playlist",
    {
      description:
        "Create a new playlist for the user (private by default) and optionally add initial tracks. Returns the new playlist id and url.",
      inputSchema: {
        name: z.string().min(1).max(100),
        description: z.string().max(300).optional(),
        public: z.boolean().default(false),
        initial_track_uris: z.array(z.string()).max(100).default([]),
      },
    },
    async ({ name, description, public: isPublic, initial_track_uris }) =>
      runTool(ctx, "create_playlist", async () => {
        const playlist = await createPlaylist(ctx.client, {
          name,
          ...(description !== undefined ? { description } : {}),
          isPublic,
        });
        if (initial_track_uris.length > 0) {
          await addPlaylistItems(ctx.client, playlist.id, initial_track_uris);
        }
        return ok({
          created: true,
          id: playlist.id,
          name: playlist.name,
          ...(playlist.external_urls?.spotify ? { url: playlist.external_urls.spotify } : {}),
          initial_tracks_added: initial_track_uris.length,
        });
      }),
  );

  server.registerTool(
    "add_tracks_to_playlist",
    {
      description: "Append tracks (by spotify:track: URIs) to a playlist the user can modify.",
      inputSchema: {
        playlist_id: z.string().min(1),
        track_uris: z.array(z.string().startsWith("spotify:")).min(1).max(100),
      },
    },
    async ({ playlist_id, track_uris }) =>
      runTool(ctx, "add_tracks_to_playlist", async () => {
        await addPlaylistItems(ctx.client, playlist_id, track_uris);
        const meta = await getPlaylist(ctx.client, playlist_id);
        return ok({
          added: track_uris.length,
          playlist_id,
          new_track_count: meta.items?.total ?? meta.tracks?.total ?? null,
        });
      }),
  );

  server.registerTool(
    "remove_tracks_from_playlist",
    {
      description: "Remove tracks (by spotify:track: URIs) from a playlist the user can modify.",
      inputSchema: {
        playlist_id: z.string().min(1),
        track_uris: z.array(z.string().startsWith("spotify:")).min(1).max(100),
      },
    },
    async ({ playlist_id, track_uris }) =>
      runTool(ctx, "remove_tracks_from_playlist", async () => {
        await removePlaylistItems(ctx.client, playlist_id, track_uris);
        const meta = await getPlaylist(ctx.client, playlist_id);
        return ok({
          removed: track_uris.length,
          playlist_id,
          new_track_count: meta.items?.total ?? meta.tracks?.total ?? null,
        });
      }),
  );

  server.registerTool(
    "reorder_playlist",
    {
      description:
        "Move a range of tracks within a playlist: range_start is the current position of the first track to move, insert_before is the position to move it to, range_length is how many consecutive tracks move (default 1). Positions are zero-based.",
      inputSchema: {
        playlist_id: z.string().min(1),
        range_start: z.number().int().min(0),
        insert_before: z.number().int().min(0),
        range_length: z.number().int().min(1).default(1),
      },
    },
    async ({ playlist_id, range_start, insert_before, range_length }) =>
      runTool(ctx, "reorder_playlist", async () => {
        if (range_start === insert_before) {
          return toolError("range_start and insert_before are the same position; nothing to move.");
        }
        await reorderPlaylistItems(ctx.client, playlist_id, {
          rangeStart: range_start,
          insertBefore: insert_before,
          rangeLength: range_length,
        });
        return ok({ reordered: true, playlist_id, range_start, insert_before, range_length });
      }),
  );
}
