import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startFakeSpotify, type FakeSpotify } from "../helpers/fake-spotify.js";
import { startTestApp, type TestApp } from "../helpers/test-app.js";
import { obtainBearer, withMcpClient } from "../helpers/mcp.js";
import { listeningSnapshots, users } from "../../src/db/schema.js";

/** Phase 7 acceptance: save/remove work; snapshots accumulate rows. */

describe("library and history tools", () => {
  let spotify: FakeSpotify;
  let app: TestApp;
  let bearer: string;

  beforeAll(async () => {
    spotify = await startFakeSpotify();
    app = await startTestApp({ spotify: spotify.endpoints });
    bearer = await obtainBearer(app, spotify, { id: "librarian", display_name: "Librarian" });
  });

  afterAll(async () => {
    await app.close();
    await spotify.close();
  });

  it("get_saved_tracks returns compact tracks with saved dates", async () => {
    spotify.stub("GET", "/v1/me/tracks", {
      items: [
        {
          added_at: "2026-06-01T10:00:00Z",
          track: {
            id: "s1",
            name: "Saved One",
            uri: "spotify:track:s1",
            duration_ms: 190000,
            artists: [{ id: "sa1", name: "Saver" }],
            album: { id: "sal1", name: "Saves", release_date: "2018-09-01" },
          },
        },
      ],
      total: 1,
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "get_saved_tracks", arguments: {} }),
    );
    const body = result.structuredContent as { tracks: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(1);
    expect(body.tracks[0]).toMatchObject({
      id: "s1",
      artist: "Saver",
      saved_at: "2026-06-01T10:00:00Z",
    });
  });

  it("get_recently_played returns plays and accumulates a snapshot row (throttled)", async () => {
    spotify.stub("GET", "/v1/me/player/recently-played", {
      items: [
        {
          played_at: "2026-07-05T09:00:00Z",
          track: {
            id: "r1",
            name: "Recent One",
            artists: [{ id: "ra1", name: "Recenter" }],
            album: { id: "ral1", name: "Recents", release_date: "2024-02-01" },
          },
        },
        {
          played_at: "2026-07-05T08:55:00Z",
          track: {
            id: "r2",
            name: "Recent Two",
            artists: [{ id: "ra2", name: "Other" }],
            album: { id: "ral2", name: "Olds", release_date: "2010-01-01" },
          },
        },
      ],
    });

    const call = () =>
      withMcpClient(app, bearer, (client) =>
        client.callTool({ name: "get_recently_played", arguments: { limit: 10 } }),
      );
    const result = await call();
    const body = result.structuredContent as { plays: Record<string, unknown>[] };
    expect(body.plays).toHaveLength(2);
    expect(body.plays[0]).toMatchObject({ id: "r1", played_at: "2026-07-05T09:00:00Z" });

    // Second call within the throttle window must not add another row.
    await call();

    const userRows = await app.db
      .select()
      .from(users)
      .where(eq(users.spotifyUserId, "librarian"));
    const snapshots = await app.db
      .select()
      .from(listeningSnapshots)
      .where(eq(listeningSnapshots.userId, userRows[0]!.id));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.kind).toBe("recently_played");
    const payload = snapshots[0]!.payload as { entries: { track_id: string }[] };
    expect(payload.entries.map((e) => e.track_id)).toEqual(["r1", "r2"]);
  });

  it("save_items PUTs uris to the generic library endpoint", async () => {
    let savedBody: unknown;
    spotify.stubFn("PUT", "/v1/me/library", (req, res) => {
      savedBody = req.body;
      res.status(204).end();
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({
        name: "save_items",
        arguments: { uris: ["spotify:track:s9", "spotify:album:a9"] },
      }),
    );
    expect(result.isError ?? false).toBe(false);
    expect(savedBody).toEqual({ uris: ["spotify:track:s9", "spotify:album:a9"] });
  });

  it("remove_items DELETEs uris from the generic library endpoint", async () => {
    let removedBody: unknown;
    spotify.stubFn("DELETE", "/v1/me/library", (req, res) => {
      removedBody = req.body;
      res.status(204).end();
    });
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "remove_items", arguments: { uris: ["spotify:track:s9"] } }),
    );
    expect(result.isError ?? false).toBe(false);
    expect(removedBody).toEqual({ uris: ["spotify:track:s9"] });
  });

  it("rejects malformed URIs before hitting Spotify", async () => {
    const result = await withMcpClient(app, bearer, (client) =>
      client.callTool({ name: "save_items", arguments: { uris: ["not-a-uri"] } }),
    );
    expect(result.isError).toBe(true);
  });
});
