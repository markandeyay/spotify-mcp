import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { obtainBearer, withMcpClient } from "../helpers/mcp.js";

/** Phase 5 acceptance: each read tool returns compact, correct data. */

describe("core read tools", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "reader", display_name: "Reader" });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("get_initial_context reports premium as not_yet_determined and device state", async () => {
    spotify.stub("GET", "/v1/me/player/devices", {
      devices: [
        { id: "d1", is_active: true, name: "Desk Speaker", type: "Speaker", volume_percent: 40 },
      ],
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_initial_context", arguments: {} }),
    );
    expect(result.isError ?? false).toBe(false);
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.display_name).toBe("Reader");
    expect(body.premium_status).toBe("not_yet_determined");
    expect(body.premium_note).toContain("playback-control attempt");
    expect(body.active_device).toEqual({ name: "Desk Speaker", type: "Speaker" });
  });

  it("search_music paginates past the 10 cap and returns compact tracks", async () => {
    spotify.stubFn("GET", "/v1/search", (req, res) => {
      const offset = Number(req.query.offset ?? 0);
      const limit = Number(req.query.limit ?? 5);
      const items = Array.from({ length: limit }, (_, i) => ({
        id: `t${offset + i}`,
        name: `Song ${offset + i}`,
        uri: `spotify:track:t${offset + i}`,
        duration_ms: 200000,
        artists: [{ id: "a1", name: "Artist One" }],
        album: { id: "al1", name: "Album", release_date: "2019-05-01" },
      }));
      res.json({ tracks: { items, next: "more" } });
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "search_music",
        arguments: { query: "song", types: ["track"], limit: 15 },
      }),
    );
    const body = result.structuredContent as { tracks: { id: string; artist: string }[] };
    expect(body.tracks).toHaveLength(15);
    expect(body.tracks[0]).toMatchObject({ id: "t0", artist: "Artist One" });
  });

  it("get_track_details returns compact data and caches it", async () => {
    let hits = 0;
    spotify.stubFn("GET", "/v1/tracks/track9", (_req, res) => {
      hits += 1;
      res.json({
        id: "track9",
        name: "Nine",
        uri: "spotify:track:track9",
        duration_ms: 180000,
        explicit: false,
        artists: [{ id: "a2", name: "Niner" }],
        album: { id: "al9", name: "Nines", release_date: "2021-01-15" },
      });
    });
    const call = () =>
      withMcpClient(app, bearer, (client) =>
        client.callTool({ name: "get_track_details", arguments: { id: "track9" } }),
      );
    const first = await call();
    const second = await call();
    expect((first.structuredContent as { name: string }).name).toBe("Nine");
    expect((second.structuredContent as { released: string }).released).toBe("2021-01-15");
    expect(hits).toBe(1); // second read served from cache
  });

  it("get_artist_details flags absent genres instead of implying none", async () => {
    spotify.stub("GET", "/v1/artists/art1", { id: "art1", name: "Genreless" });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_artist_details", arguments: { id: "art1" } }),
    );
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.genres).toEqual([]);
    expect(body.genre_note).toContain("sparsely populated");
  });

  it("list_playlists reads the renamed items.total field", async () => {
    spotify.stub("GET", "/v1/me/playlists", {
      items: [
        {
          id: "p1",
          name: "Focus",
          items: { total: 42 },
          owner: { id: "reader", display_name: "Reader" },
          public: false,
        },
      ],
      total: 1,
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "list_playlists", arguments: {} }),
    );
    const body = result.structuredContent as { playlists: Record<string, unknown>[] };
    expect(body.playlists[0]).toMatchObject({ id: "p1", name: "Focus", track_count: 42 });
  });

  it("get_playlist raw mode returns compact tracks with a truncation note when capped", async () => {
    spotify.stub("GET", "/v1/playlists/p2", {
      id: "p2",
      name: "Big List",
      owner: { display_name: "Reader" },
      items: { total: 500 },
    });
    spotify.stubFn("GET", "/v1/playlists/p2/items", (req, res) => {
      const offset = Number(req.query.offset ?? 0);
      const limit = Number(req.query.limit ?? 50);
      const items = Array.from({ length: limit }, (_, i) => ({
        added_at: "2026-01-01T00:00:00Z",
        item: {
          id: `pt${offset + i}`,
          name: `PTrack ${offset + i}`,
          duration_ms: 210000,
          artists: [{ id: "a3", name: "Lister" }],
          album: { id: "al3", name: "Listing", release_date: "2015-03-01" },
        },
      }));
      res.json({ items, next: "more" });
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_playlist", arguments: { id: "p2", mode: "raw" } }),
    );
    const body = result.structuredContent as {
      tracks: unknown[];
      track_count: number;
      truncation_note?: string;
    };
    expect(body.track_count).toBe(500);
    expect(body.tracks).toHaveLength(200);
    expect(body.truncation_note).toContain("first 200 of 500");
  });

  it("get_playlist summary mode returns measured aggregates, not tracks", async () => {
    spotify.stub("GET", "/v1/playlists/p3", {
      id: "p3",
      name: "Mixed Eras",
      owner: { display_name: "Reader" },
      items: { total: 4 },
    });
    spotify.stub("GET", "/v1/playlists/p3/items", {
      items: [
        { added_at: "2026-02-01T00:00:00Z", item: { id: "m1", name: "A", duration_ms: 180000, artists: [{ id: "x", name: "X" }], album: { id: "b1", name: "B1", release_date: "1995-06-01" } } },
        { added_at: "2026-02-02T00:00:00Z", item: { id: "m2", name: "B", duration_ms: 240000, artists: [{ id: "x", name: "X" }], album: { id: "b2", name: "B2", release_date: "2005-06-01" } } },
        { added_at: "2026-02-03T00:00:00Z", item: { id: "m3", name: "C", duration_ms: 180000, artists: [{ id: "y", name: "Y" }], album: { id: "b3", name: "B3", release_date: "2015-06-01" } } },
        { added_at: "2026-02-04T00:00:00Z", item: { id: "m4", name: "D", duration_ms: 200000, artists: [{ id: "z", name: "Z" }], album: { id: "b4", name: "B4", release_date: "2021-06-01" } } },
      ],
      next: null,
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_playlist", arguments: { id: "p3", mode: "summary" } }),
    );
    const body = result.structuredContent as {
      summary: {
        track_count: number;
        total_runtime_minutes: number;
        top_artists: { name: string }[];
        release_years: { min: number; max: number; by_decade: Record<string, number> };
        measured_note: string;
      };
      tracks?: unknown;
    };
    expect(body.tracks).toBeUndefined();
    expect(body.summary.track_count).toBe(4);
    expect(body.summary.total_runtime_minutes).toBe(13);
    expect(body.summary.top_artists[0]!.name).toBe("X");
    expect(body.summary.release_years.min).toBe(1995);
    expect(body.summary.release_years.max).toBe(2021);
    expect(body.summary.release_years.by_decade["1990s"]).toBe(1);
    expect(body.summary.measured_note).toContain("computed by the server");
  });

  it("maps a rate-limited Spotify response to friendly text", async () => {
    spotify.stubFn("GET", "/v1/tracks/limited", (_req, res) => {
      res.status(429).set("Retry-After", "1").json({ error: { status: 429 } });
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_track_details", arguments: { id: "limited" } }),
    );
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("rate limiting");
    expect(text).not.toContain("429");
  });
});
