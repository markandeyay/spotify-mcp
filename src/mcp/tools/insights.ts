import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../tool-context.js";
import { ok, runTool } from "./helpers.js";
import {
  getPlaylist,
  getPlaylistItems,
  getSavedTracks,
  getTopItems,
  libraryContains,
} from "../../spotify/endpoints.js";
import { summarizePlaylistTracks } from "../../intelligence/summarize-playlist.js";
import { summarizeLibrary } from "../../intelligence/summarize-library.js";
import {
  compareTopItems,
  computeHistoryTrends,
} from "../../intelligence/listening-trends.js";
import { crossReferenceCandidates } from "../../intelligence/find-gaps.js";
import {
  captureTopItems,
  readSnapshots,
  type RecentlyPlayedEntry,
} from "../../intelligence/snapshots.js";
import type { SavedTrack, Artist } from "../../spotify/types.js";
import { TTL } from "../../cache/cache.js";

/**
 * Insight tools (Section 8.6): the differentiators. Aggregation is measured
 * on the server; interpretation is deferred to the model and every output
 * labels which is which. Nothing here touches audio-features (dead endpoint).
 */

/** Fan-out cap: 500 saved tracks = 10 requests at the 50/page limit. */
const LIBRARY_SCAN_CAP = 500;

async function scanSavedTracks(ctx: ToolContext): Promise<{ saved: SavedTrack[]; scannedAll: boolean; total: number | null }> {
  const cacheKey = `user:${ctx.user.id}:library-scan`;
  const cached = await ctx.cache.get<{ saved: SavedTrack[]; scannedAll: boolean; total: number | null }>(cacheKey);
  if (cached) return cached;

  const saved: SavedTrack[] = [];
  let total: number | null = null;
  let offset = 0;
  while (saved.length < LIBRARY_SCAN_CAP) {
    const page = await getSavedTracks(ctx.client, { limit: 50, offset });
    saved.push(...page.items);
    total = page.total ?? total;
    if (page.items.length < 50) break;
    offset += page.items.length;
  }
  const result = {
    saved,
    scannedAll: total === null ? true : saved.length >= total,
    total,
  };
  await ctx.cache.set(cacheKey, result, TTL.savedTracks, ctx.user.id);
  return result;
}

export function registerInsightTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "summarize_playlist",
    {
      description:
        "Server-computed summary of a playlist: artist distribution and concentration, release-era spread, total runtime, add dates. All numbers are measured from metadata; genre or mood characterization is intentionally left to you and should be labeled as inference.",
      inputSchema: { id: z.string().min(1).describe("Spotify playlist id") },
    },
    async ({ id }) =>
      runTool(ctx, "summarize_playlist", async () => {
        const meta = await getPlaylist(ctx.client, id);
        const items = await getPlaylistItems(ctx.client, id, { maxItems: 200 });
        return ok({
          id: meta.id,
          name: meta.name,
          summary: summarizePlaylistTracks(items.tracks, items.addedAt),
        });
      }),
  );

  server.registerTool(
    "summarize_library",
    {
      description:
        `Aggregate statistics over the user's saved tracks (up to ${LIBRARY_SCAN_CAP} newest): top artists, era distribution, artist diversity, save cadence by year, notable concentrations. All measured server-side from metadata.`,
      inputSchema: {},
    },
    async () =>
      runTool(ctx, "summarize_library", async () => {
        const scan = await scanSavedTracks(ctx);
        const summary = summarizeLibrary(scan.saved);
        return ok({
          ...(scan.scannedAll
            ? {}
            : {
                scan_note: `Computed over the ${scan.saved.length} most recently saved tracks of ${scan.total} total to bound API fan-out.`,
              }),
          ...summary,
        });
      }),
  );

  server.registerTool(
    "summarize_listening_trends",
    {
      description:
        "How the user's listening has shifted: rising, fading, and newly appearing artists plus concentration change. Uses listening-history snapshots accumulated by this server (best signal, needs history) and Spotify's short-term vs long-term top-artist rankings (always available). Output distinguishes both sources; if stored history is thin it says so honestly.",
      inputSchema: {
        window: z
          .enum(["1m", "3m", "6m"])
          .default("3m")
          .describe("How far back to analyze from stored history"),
      },
    },
    async ({ window }) =>
      runTool(ctx, "summarize_listening_trends", async () => {
        const windowDays = window === "1m" ? 30 : window === "3m" ? 90 : 180;
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const snapshots = await readSnapshots<RecentlyPlayedEntry>(
          ctx.db,
          ctx.user.id,
          "recently_played",
          since,
        );
        const history = computeHistoryTrends(snapshots, windowDays);

        let topComparison = null;
        try {
          const [shortTerm, longTerm] = await Promise.all([
            getTopItems(ctx.client, "artists", { timeRange: "short_term", limit: 20 }),
            getTopItems(ctx.client, "artists", { timeRange: "long_term", limit: 20 }),
          ]);
          const toEntries = (items: (Artist | { id: string; name: string })[]) =>
            items.map((item, index) => ({ id: item.id, name: item.name, rank: index + 1 }));
          topComparison = compareTopItems(toEntries(shortTerm.items), toEntries(longTerm.items));
          // Feed the snapshot store so future trend calls have more history.
          await captureTopItems(ctx.db, ctx.user.id, "top_artists", shortTerm.items as Artist[]);
        } catch (error) {
          ctx.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "top-items comparison unavailable",
          );
        }

        return ok({
          measured_note:
            "Both sections are measured: history from this server's stored snapshots, top_items_comparison from Spotify's own rankings. Explanations of WHY taste shifted are yours to infer and label.",
          window,
          history,
          top_items_comparison: topComparison,
        });
      }),
  );

  server.registerTool(
    "find_library_gaps",
    {
      description:
        "Cross-reference candidate artists/albums/tracks against what the user already has. YOU generate the candidates from your music knowledge (adjacent artists to the seed, essential albums, etc.), then this tool measures which are genuinely absent from the library so you never recommend something already owned. Provide spotify: URIs when known for exact matching; names match against saved-track artists.",
      inputSchema: {
        seed: z.string().min(1).describe("The artist or genre the candidates relate to"),
        candidates: z
          .array(
            z.object({
              name: z.string().min(1),
              type: z.enum(["artist", "album", "track"]),
              uri: z.string().startsWith("spotify:").optional(),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    async ({ seed, candidates }) =>
      runTool(ctx, "find_library_gaps", async () => {
        const scan = await scanSavedTracks(ctx);
        const ownedArtists = new Set<string>();
        for (const entry of scan.saved) {
          const track = entry.track ?? entry.item;
          for (const artist of track?.artists ?? []) {
            ownedArtists.add(artist.name);
          }
        }

        const uris = candidates.map((c) => c.uri).filter((u): u is string => u !== undefined);
        const containsByUri = new Map<string, boolean>();
        for (let i = 0; i < uris.length; i += 50) {
          const batch = uris.slice(i, i + 50);
          try {
            const results = await libraryContains(ctx.client, batch);
            batch.forEach((uri, index) => containsByUri.set(uri, results[index] ?? false));
          } catch (error) {
            ctx.logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "library contains check failed; falling back to name matching",
            );
          }
        }

        const result = crossReferenceCandidates(candidates, ownedArtists, containsByUri);
        return ok({
          seed,
          measured_note: `Cross-referenced against ${ownedArtists.size} artists from the user's ${scan.saved.length} most recent saved tracks${scan.scannedAll ? "" : ` (of ${scan.total} total; older saves not scanned)`}. Candidate quality is your inference; presence/absence here is measured.`,
          missing: result.missing,
          already_have: result.already_have,
        });
      }),
  );
}
