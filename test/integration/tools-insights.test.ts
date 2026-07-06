import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { obtainBearer, withMcpClient } from "../helpers/mcp.js";
import { listeningSnapshots, users } from "../../src/db/schema.js";

/**
 * Phase 8 acceptance: summaries return accurate server-computed stats; trends
 * degrade gracefully when history is thin.
 */

describe("insight tools", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;
  let userId: string;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "insight", display_name: "Insight" });
    const rows = await app.db.select().from(users).where(eq(users.spotifyUserId, "insight"));
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("summarize_playlist returns measured aggregates, not raw tracks", async () => {
    spotify.stub("GET", "/v1/playlists/pl1", { id: "pl1", name: "Mix" });
    spotify.stub("GET", "/v1/playlists/pl1/items", {
      items: [
        {
          added_at: "2024-05-01T00:00:00Z",
          item: {
            id: "t1",
            name: "One",
            duration_ms: 180_000,
            artists: [{ id: "a1", name: "Anna" }],
            album: { id: "al1", name: "Alpha", release_date: "2015-03-01" },
          },
        },
        {
          added_at: "2024-06-01T00:00:00Z",
          item: {
            id: "t2",
            name: "Two",
            duration_ms: 240_000,
            artists: [{ id: "a2", name: "Bram" }],
            album: { id: "al2", name: "Beta", release_date: "2021-10-01" },
          },
        },
      ],
      next: null,
    });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "summarize_playlist", arguments: { id: "pl1" } }),
    );
    const body = result.structuredContent as {
      name: string;
      summary: Record<string, any>;
    };
    expect(body.name).toBe("Mix");
    expect(body.summary.track_count).toBe(2);
    expect(body.summary.total_runtime_minutes).toBe(7);
    expect(body.summary.release_years.by_decade).toEqual({ "2010s": 1, "2020s": 1 });
    expect(body.summary.measured_note).toMatch(/inference/i);
    // Raw track objects must not leak into the output.
    expect(JSON.stringify(body)).not.toContain("duration_ms");
  });

  it("summarize_library aggregates saved tracks", async () => {
    spotify.stub("GET", "/v1/me/tracks", {
      items: [
        {
          added_at: "2023-01-10T00:00:00Z",
          track: {
            id: "s1",
            name: "Saved One",
            duration_ms: 200_000,
            artists: [{ id: "a1", name: "Anna" }],
            album: { id: "al1", name: "Alpha", release_date: "2019-01-01" },
          },
        },
        {
          added_at: "2024-04-10T00:00:00Z",
          track: {
            id: "s2",
            name: "Saved Two",
            duration_ms: 100_000,
            artists: [{ id: "a1", name: "Anna" }],
            album: { id: "al2", name: "Beta", release_date: "2022-01-01" },
          },
        },
      ],
      total: 2,
    });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "summarize_library", arguments: {} }),
    );
    const body = result.structuredContent as Record<string, any>;
    expect(body.track_count).toBe(2);
    expect(body.saves_by_year).toEqual({ "2023": 1, "2024": 1 });
    expect(body.diversity.distinct_artists).toBe(1);
    expect(body.scan_note).toBeUndefined(); // full library scanned, no cap note
  });

  it("summarize_listening_trends is honest about thin history and still compares top items", async () => {
    spotify.stubFn("GET", "/v1/me/top/artists", (req, res) => {
      const items =
        req.query.time_range === "short_term"
          ? [
              { id: "x", name: "NewFav" },
              { id: "y", name: "Both" },
            ]
          : [
              { id: "y", name: "Both" },
              { id: "z", name: "OldFav" },
            ];
      res.json({ items });
    });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "summarize_listening_trends", arguments: { window: "1m" } }),
    );
    const body = result.structuredContent as Record<string, any>;
    expect(body.history.thin_history).toBe(true);
    expect(body.history.note).toMatch(/snapshots accumulate/i);
    expect(body.top_items_comparison).toMatchObject({
      rising: ["NewFav"],
      fading: ["OldFav"],
      steady: ["Both"],
    });

    // The call itself should have fed the snapshot store for future trends.
    const rows = await app.db
      .select()
      .from(listeningSnapshots)
      .where(eq(listeningSnapshots.userId, userId));
    expect(rows.some((r) => r.kind === "top_artists")).toBe(true);
  });

  it("summarize_listening_trends computes real trends once history exists", async () => {
    const play = (trackId: string, artist: string, playedAt: string) => ({
      track_id: trackId,
      track_name: trackId,
      artists: [{ id: `a-${artist}`, name: artist }],
      played_at: playedAt,
    });
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString();
    await app.db.insert(listeningSnapshots).values([
      {
        userId,
        kind: "recently_played",
        capturedAt: days(20),
        payload: {
          entries: [
            ...Array.from({ length: 5 }, (_, i) => play(`f${i}`, "Fader", iso(days(21)))),
            ...Array.from({ length: 2 }, (_, i) => play(`s${i}`, "Steady", iso(days(21)))),
          ],
        },
      },
      {
        userId,
        kind: "recently_played",
        capturedAt: days(2),
        payload: {
          entries: [
            ...Array.from({ length: 4 }, (_, i) => play(`r${i}`, "Riser", iso(days(3)))),
            ...Array.from({ length: 2 }, (_, i) => play(`s2${i}`, "Steady", iso(days(3)))),
          ],
        },
      },
    ]);

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "summarize_listening_trends", arguments: { window: "1m" } }),
    );
    const body = result.structuredContent as Record<string, any>;
    expect(body.history.thin_history).toBeUndefined();
    expect(body.history.total_plays_observed).toBe(13);
    expect(body.history.new_artists.map((a: { name: string }) => a.name)).toContain("Riser");
    expect(body.history.fading_artists.map((a: { name: string }) => a.name)).toContain("Fader");
  });

  it("find_library_gaps cross-references candidates against the library", async () => {
    let containsQuery: string | undefined;
    spotify.stubFn("GET", "/v1/me/library/contains", (req, res) => {
      containsQuery = String(req.query.uris);
      res.json([true]);
    });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "find_library_gaps",
        arguments: {
          seed: "Anna",
          candidates: [
            { name: "Anna", type: "artist" }, // in saved tracks from the library test
            { name: "Fresh Face", type: "artist" },
            { name: "Owned Album", type: "album", uri: "spotify:album:owned" },
          ],
        },
      }),
    );
    const body = result.structuredContent as Record<string, any>;
    expect(containsQuery).toBe("spotify:album:owned");
    expect(body.missing.map((c: { name: string }) => c.name)).toEqual(["Fresh Face"]);
    expect(body.already_have).toHaveLength(2);
    expect(body.measured_note).toMatch(/measured/i);
  });
});
