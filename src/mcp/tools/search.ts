import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../tool-context.js";
import { compactTrack, ok, runTool } from "./helpers.js";
import { search } from "../../spotify/endpoints.js";

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_music",
    {
      description:
        "Search the Spotify catalog for tracks, artists, albums, or playlists. Returns compact results (name, primary artist, id, uri). Spotify caps each request at 10 results; this tool paginates internally up to your limit (max 50 per type).",
      inputSchema: {
        query: z.string().min(1).describe("Search text; supports Spotify field filters like artist: or year:"),
        types: z
          .array(z.enum(["track", "artist", "album", "playlist"]))
          .min(1)
          .default(["track"])
          .describe("Which result types to return"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results per type"),
      },
    },
    async ({ query, types, limit }) =>
      runTool(ctx, "search_music", async () => {
        const results = await search(ctx.client, query, types, limit);
        const structured: Record<string, unknown> = { query };
        if (results.tracks) {
          structured.tracks = results.tracks.items.map((t) => compactTrack(t));
        }
        if (results.artists) {
          structured.artists = results.artists.items.map((a) => ({
            id: a.id,
            name: a.name,
            ...(a.uri ? { uri: a.uri } : {}),
            ...(a.genres && a.genres.length > 0 ? { genres: a.genres } : {}),
          }));
        }
        if (results.albums) {
          structured.albums = results.albums.items.map((al) => ({
            id: al.id,
            name: al.name,
            ...(al.uri ? { uri: al.uri } : {}),
            artist: al.artists?.map((a) => a.name).join(", ") ?? "unknown",
            ...(al.release_date ? { released: al.release_date } : {}),
          }));
        }
        if (results.playlists) {
          structured.playlists = results.playlists.items
            .filter((p): p is NonNullable<typeof p> => p !== null)
            .map((p) => ({
              id: p.id,
              name: p.name,
              ...(p.uri ? { uri: p.uri } : {}),
              owner: p.owner?.display_name ?? p.owner?.id ?? "unknown",
            }));
        }
        return ok(structured);
      }),
  );
}
