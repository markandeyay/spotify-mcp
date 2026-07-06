import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../tool-context.js";
import { compactTrack, ok, runTool } from "./helpers.js";
import {
  getRecentlyPlayed,
  getSavedTracks,
  removeFromLibrary,
  saveToLibrary,
} from "../../spotify/endpoints.js";
import { captureRecentlyPlayed } from "../../intelligence/snapshots.js";
import { cacheKeys } from "../../cache/cache.js";

/**
 * Library and history tools (Section 8.5). Recently-played reads feed the
 * snapshot store opportunistically (Section 9.1) so trends improve with use.
 */

const SPOTIFY_URI = z
  .string()
  .regex(/^spotify:(track|album|artist|episode|show):[A-Za-z0-9]+$/, {
    message: "must be a spotify:type:id URI",
  });

export function registerLibraryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_saved_tracks",
    {
      description:
        "The user's saved (liked) tracks, newest first: compact list with saved date. Paginate with limit and offset.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ limit, offset }) =>
      runTool(ctx, "get_saved_tracks", async () => {
        const page = await getSavedTracks(ctx.client, { limit, offset });
        return ok({
          total: page.total ?? null,
          offset,
          tracks: page.items
            .map((entry) => {
              const track = entry.track ?? entry.item;
              if (!track) return null;
              return {
                ...compactTrack(track),
                ...(entry.added_at ? { saved_at: entry.added_at } : {}),
              };
            })
            .filter((t): t is NonNullable<typeof t> => t !== null),
        });
      }),
  );

  server.registerTool(
    "get_recently_played",
    {
      description:
        "The user's recently played tracks with timestamps (up to 50). Each call also feeds the server's listening-history snapshots, which improve trend analysis over time.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ limit }) =>
      runTool(ctx, "get_recently_played", async () => {
        const recent = await getRecentlyPlayed(ctx.client, { limit });
        // Best effort; a snapshot failure must never break the read.
        try {
          await captureRecentlyPlayed(ctx.db, ctx.user.id, recent.items);
        } catch (error) {
          ctx.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "snapshot capture failed",
          );
        }
        return ok({
          plays: recent.items.map((p) => ({
            ...compactTrack(p.track),
            played_at: p.played_at,
          })),
        });
      }),
  );

  server.registerTool(
    "save_items",
    {
      description:
        "Save items to the user's library by Spotify URI (tracks, albums, artists to follow). Uses Spotify's generic library endpoint.",
      inputSchema: { uris: z.array(SPOTIFY_URI).min(1).max(50) },
    },
    async ({ uris }) =>
      runTool(ctx, "save_items", async () => {
        await saveToLibrary(ctx.client, uris);
        await ctx.cache.delete(cacheKeys.libraryScan(ctx.user.id));
        return ok({ saved: uris.length, uris });
      }),
  );

  server.registerTool(
    "remove_items",
    {
      description: "Remove items from the user's library by Spotify URI.",
      inputSchema: { uris: z.array(SPOTIFY_URI).min(1).max(50) },
    },
    async ({ uris }) =>
      runTool(ctx, "remove_items", async () => {
        await removeFromLibrary(ctx.client, uris);
        await ctx.cache.delete(cacheKeys.libraryScan(ctx.user.id));
        return ok({ removed: uris.length, uris });
      }),
  );
}
