import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { obtainBearer, withMcpClient } from "../helpers/mcp.js";

/**
 * Phase 9 acceptance: repeated reads hit cache instead of Spotify, and
 * mutations invalidate what they made stale.
 */

describe("tool-level caching", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;

  const requestCount = (method: string, pathPrefix: string) =>
    spotify.apiRequests.filter((r) => r.startsWith(`${method} ${pathPrefix}`)).length;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "cacher", display_name: "Cacher" });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("repeated catalog reads hit the cache, not Spotify", async () => {
    spotify.stub("GET", "/v1/tracks/c1", {
      id: "c1",
      name: "Cached Track",
      artists: [{ id: "a1", name: "Anna" }],
    });
    const call = () =>
      withMcpClient(app, bearer, (client) =>
        client.callTool({ name: "get_track_details", arguments: { id: "c1" } }),
      );
    const first = await call();
    const second = await call();
    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(requestCount("GET", "/v1/tracks/c1")).toBe(1);
  });

  it("playlist items are cached until a mutation invalidates them", async () => {
    const item = (id: string, name: string) => ({
      added_at: "2026-01-01T00:00:00Z",
      item: { id, name, artists: [{ id: "a1", name: "Anna" }] },
    });
    spotify.stub("GET", "/v1/playlists/pc", { id: "pc", name: "Mut", items: { total: 1 } });
    spotify.stub("GET", "/v1/playlists/pc/items", { items: [item("t1", "One")], next: null });
    spotify.stub("POST", "/v1/playlists/pc/items", { snapshot_id: "snap-1" });

    const read = async () => {
      const result = await withMcpClient(app, bearer, (client) =>
        client.callTool({ name: "get_playlist", arguments: { id: "pc" } }),
      );
      return result.structuredContent as { tracks: { id: string }[] };
    };

    await read();
    await read();
    expect(requestCount("GET", "/v1/playlists/pc/items")).toBe(1); // second read cached

    const mutation = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "add_tracks_to_playlist",
        arguments: { playlist_id: "pc", track_uris: ["spotify:track:t2"] },
      }),
    );
    expect(mutation.isError ?? false).toBe(false);

    spotify.stub("GET", "/v1/playlists/pc/items", {
      items: [item("t1", "One"), item("t2", "Two")],
      next: null,
    });
    const after = await read();
    expect(requestCount("GET", "/v1/playlists/pc/items")).toBe(2); // cache was invalidated
    expect(after.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("library scans are cached until save_items invalidates them", async () => {
    spotify.stub("GET", "/v1/me/tracks", {
      items: [
        {
          added_at: "2024-01-01T00:00:00Z",
          track: { id: "s1", name: "One", artists: [{ id: "a1", name: "Anna" }] },
        },
      ],
      total: 1,
    });
    spotify.stubFn("PUT", "/v1/me/library", (_req, res) => res.status(204).end());

    const summarize = () =>
      withMcpClient(app, bearer, (client) =>
        client.callTool({ name: "summarize_library", arguments: {} }),
      );

    await summarize();
    await summarize();
    expect(requestCount("GET", "/v1/me/tracks")).toBe(1);

    await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "save_items", arguments: { uris: ["spotify:track:s2"] } }),
    );
    await summarize();
    expect(requestCount("GET", "/v1/me/tracks")).toBe(2);
  });
});
