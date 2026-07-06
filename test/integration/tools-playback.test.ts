import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { obtainBearer, withMcpClient } from "../helpers/mcp.js";

/**
 * Phase 6 acceptance: playback works when Spotify accepts the command; on a
 * free account or with no device the tools respond with guidance, and premium
 * status converges from those outcomes.
 */

describe("playback tools", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "player", display_name: "Player" });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("get_playback_state reports nothing_playing on Spotify's 204", async () => {
    spotify.stubFn("GET", "/v1/me/player", (_req, res) => {
      res.status(204).end();
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_playback_state", arguments: {} }),
    );
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.nothing_playing).toBe(true);
  });

  it("get_playback_state returns the current track and device", async () => {
    spotify.stub("GET", "/v1/me/player", {
      is_playing: true,
      progress_ms: 61000,
      item: {
        id: "now1",
        name: "Now Playing",
        duration_ms: 180000,
        artists: [{ id: "a", name: "Live Artist" }],
        album: { id: "al", name: "Live Album", release_date: "2020-01-01" },
      },
      device: { id: "d1", is_active: true, name: "Phone", type: "Smartphone", volume_percent: 70 },
      shuffle_state: false,
      repeat_state: "off",
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_playback_state", arguments: {} }),
    );
    const body = result.structuredContent as {
      is_playing: boolean;
      track: { name: string };
      device: { name: string };
    };
    expect(body.is_playing).toBe(true);
    expect(body.track.name).toBe("Now Playing");
    expect(body.device.name).toBe("Phone");
  });

  it("control_playback pause succeeds and marks the account premium", async () => {
    spotify.stubFn("PUT", "/v1/me/player/pause", (_req, res) => {
      res.status(204).end();
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "control_playback", arguments: { action: "pause" } }),
    );
    expect(result.isError ?? false).toBe(false);
    expect((result.structuredContent as Record<string, unknown>).premium_status).toBe("premium");

    // get_initial_context now reports premium, not not_yet_determined.
    spotify.stub("GET", "/v1/me/player/devices", { devices: [] });
    const contextResult = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_initial_context", arguments: {} }),
    );
    expect((contextResult.structuredContent as Record<string, unknown>).premium_status).toBe(
      "premium",
    );
  });

  it("no active device turns into friendly guidance, not a raw 404", async () => {
    spotify.stubFn("POST", "/v1/me/player/next", (_req, res) => {
      res.status(404).json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } });
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "control_playback", arguments: { action: "next" } }),
    );
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("open Spotify");
    expect(text).not.toContain("404");
  });

  it("a free account gets a premium explanation and the result is cached", async () => {
    const freshApp = await startTestApp({ spotify: spotify.endpoints });
    const freeBearer = await obtainBearer(freshApp, spotify, { id: "free-user" });
    try {
      let apiHits = 0;
      spotify.stubFn("PUT", "/v1/me/player/play", (_req, res) => {
        apiHits += 1;
        res.status(403).json({ error: { status: 403, reason: "PREMIUM_REQUIRED" } });
      });
      const first = await withMcpClient(freshApp, freeBearer, (client) =>
        client.callTool({ name: "control_playback", arguments: { action: "play" } }),
      );
      expect(first.isError).toBe(true);
      expect((first.content as { text: string }[])[0]!.text).toContain("Premium");
      expect(apiHits).toBe(1);

      // Second attempt short-circuits on the cached free status.
      const second = await withMcpClient(freshApp, freeBearer, (client) =>
        client.callTool({ name: "control_playback", arguments: { action: "play" } }),
      );
      expect(second.isError).toBe(true);
      expect(apiHits).toBe(1);

      // And get_initial_context reports free, with read-only tools intact.
      spotify.stub("GET", "/v1/me/player/devices", { devices: [] });
      const contextResult = await withMcpClient(freshApp, freeBearer, (client) =>
        client.callTool({ name: "get_initial_context", arguments: {} }),
      );
      expect((contextResult.structuredContent as Record<string, unknown>).premium_status).toBe(
        "free",
      );
    } finally {
      await freshApp.close();
    }
  });

  it("queue_tracks queues each uri in order", async () => {
    const queued: string[] = [];
    spotify.stubFn("POST", "/v1/me/player/queue", (req, res) => {
      queued.push(String(req.query.uri));
      res.status(204).end();
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "queue_tracks",
        arguments: { track_uris: ["spotify:track:q1", "spotify:track:q2"] },
      }),
    );
    expect(result.isError ?? false).toBe(false);
    expect(queued).toEqual(["spotify:track:q1", "spotify:track:q2"]);
  });

  it("transfer_playback sends the device id", async () => {
    let transferBody: unknown;
    spotify.stubFn("PUT", "/v1/me/player", (req, res) => {
      transferBody = req.body;
      res.status(204).end();
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "transfer_playback",
        arguments: { device_id: "dev42", play: true },
      }),
    );
    expect(result.isError ?? false).toBe(false);
    expect(transferBody).toEqual({ device_ids: ["dev42"], play: true });
  });
});
