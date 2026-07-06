import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { obtainBearer, withMcpClient } from "../helpers/mcp.js";

/**
 * Phase 10: playlist mutation tools (built in Phase 5 but previously only
 * covered indirectly) and the removed-endpoint degrade path end to end.
 */

describe("playlist mutation tools", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "mutator", display_name: "Mutator" });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("create_playlist POSTs to /me/playlists and adds initial tracks", async () => {
    let createBody: unknown;
    let addBody: unknown;
    spotify.stubFn("POST", "/v1/me/playlists", (req, res) => {
      createBody = req.body;
      res.status(201).json({
        id: "new1",
        name: "Road Trip",
        external_urls: { spotify: "https://open.spotify.com/playlist/new1" },
      });
    });
    spotify.stubFn("POST", "/v1/playlists/new1/items", (req, res) => {
      addBody = req.body;
      res.json({ snapshot_id: "snap" });
    });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "create_playlist",
        arguments: {
          name: "Road Trip",
          description: "Songs for the drive",
          initial_track_uris: ["spotify:track:t1", "spotify:track:t2"],
        },
      }),
    );

    expect(result.structuredContent).toMatchObject({
      created: true,
      id: "new1",
      url: "https://open.spotify.com/playlist/new1",
      initial_tracks_added: 2,
    });
    expect(createBody).toEqual({
      name: "Road Trip",
      description: "Songs for the drive",
      public: false, // private by default
    });
    expect(addBody).toEqual({ uris: ["spotify:track:t1", "spotify:track:t2"] });
  });

  it("remove_tracks_from_playlist DELETEs with the items body shape", async () => {
    let removeBody: unknown;
    spotify.stubFn("DELETE", "/v1/playlists/pm/items", (req, res) => {
      removeBody = req.body;
      res.json({ snapshot_id: "snap" });
    });
    spotify.stub("GET", "/v1/playlists/pm", { id: "pm", name: "Prune", items: { total: 7 } });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "remove_tracks_from_playlist",
        arguments: { playlist_id: "pm", track_uris: ["spotify:track:bye"] },
      }),
    );

    expect(result.structuredContent).toMatchObject({ removed: 1, new_track_count: 7 });
    expect(removeBody).toEqual({ items: [{ uri: "spotify:track:bye" }] });
  });

  it("reorder_playlist PUTs the range fields", async () => {
    let reorderBody: unknown;
    spotify.stubFn("PUT", "/v1/playlists/pm/items", (req, res) => {
      reorderBody = req.body;
      res.json({ snapshot_id: "snap" });
    });

    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "reorder_playlist",
        arguments: { playlist_id: "pm", range_start: 5, insert_before: 0, range_length: 2 },
      }),
    );

    expect(result.structuredContent).toMatchObject({ reordered: true });
    expect(reorderBody).toEqual({ range_start: 5, insert_before: 0, range_length: 2 });
  });

  it("reorder_playlist refuses a no-op move with a clear message", async () => {
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "reorder_playlist",
        arguments: { playlist_id: "pm", range_start: 3, insert_before: 3 },
      }),
    );
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("nothing to move");
  });

  it("degrades a removed endpoint once and short-circuits after", async () => {
    spotify.stub(
      "GET",
      "/v1/artists/gone",
      { error: { status: 410, message: "This endpoint has been deprecated" } },
      410,
    );
    const call = () =>
      withMcpClient(app, bearer, (client) =>
        client.callTool({ name: "get_artist_details", arguments: { id: "gone" } }),
      );

    const first = await call();
    expect(first.isError).toBe(true);
    expect((first.content as { text: string }[])[0]!.text).toContain("no longer offers");

    const second = await call();
    expect(second.isError).toBe(true);
    expect((second.content as { text: string }[])[0]!.text).toContain("no longer offers");
    // The dead endpoint was probed exactly once; the second call short-circuited.
    const probes = spotify.apiRequests.filter((r) => r.startsWith("GET /v1/artists/gone"));
    expect(probes).toHaveLength(1);
  });
});
