import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { SpotifyClient } from "../../src/spotify/client.js";
import {
  addPlaylistItems,
  createPlaylist,
  getPlaylistItems,
  removeFromLibrary,
  saveToLibrary,
  search,
} from "../../src/spotify/endpoints.js";
import { createLogger } from "../../src/logger.js";

const silentLogger = createLogger(
  "silent",
  new Writable({ write: (_c, _e, cb) => cb() }),
);

function makeClient(fetchImpl: typeof fetch) {
  return new SpotifyClient({
    tokenProvider: {
      getAccessToken: async () => "t",
      refreshAccessToken: async () => "t",
    },
    logger: silentLogger,
    apiBaseUrl: "https://fake.spotify.test/v1",
    fetchImpl,
    sleep: async () => {},
  });
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("search", () => {
  it("paginates past the 10-per-request cap up to the requested limit", async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      calls.push(parsed);
      const offset = Number(parsed.searchParams.get("offset"));
      const limit = Number(parsed.searchParams.get("limit"));
      const items = Array.from({ length: limit }, (_, i) => ({
        id: `t${offset + i}`,
        name: `Track ${offset + i}`,
      }));
      return ok({ tracks: { items, next: "more" } });
    });

    const result = await search(makeClient(fetchImpl as never), "query", ["track"], 25);

    expect(result.tracks?.items).toHaveLength(25);
    expect(result.tracks?.items[0]?.id).toBe("t0");
    expect(result.tracks?.items[24]?.id).toBe("t24");
    // 10 + 10 + 5, never exceeding the cap in any single request
    expect(calls.map((u) => u.searchParams.get("limit"))).toEqual(["10", "10", "5"]);
    expect(calls.map((u) => u.searchParams.get("offset"))).toEqual(["0", "10", "20"]);
  });
});

describe("getPlaylistItems", () => {
  it("uses the renamed /items path and normalizes item vs legacy track", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/playlists/p1/items");
      return ok({
        items: [
          { added_at: "2026-01-01T00:00:00Z", item: { id: "a", name: "A" } },
          { added_at: "2026-01-02T00:00:00Z", track: { id: "b", name: "B" } },
          { added_at: null, item: null },
        ],
        next: null,
      });
    });

    const result = await getPlaylistItems(makeClient(fetchImpl as never), "p1");

    expect(result.tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.addedAt).toEqual(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]);
  });
});

describe("createPlaylist", () => {
  it("POSTs to /me/playlists per the Feb 2026 change", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://fake.spotify.test/v1/me/playlists");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        name: "My Mix",
        description: "test",
        public: false,
      });
      return ok({ id: "new1", name: "My Mix" });
    });

    const playlist = await createPlaylist(makeClient(fetchImpl as never), {
      name: "My Mix",
      description: "test",
    });

    expect(playlist.id).toBe("new1");
  });
});

describe("generic library endpoints", () => {
  it("saves via PUT /me/library with a uris body", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://fake.spotify.test/v1/me/library");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({
        uris: ["spotify:track:x"],
      });
      return new Response(null, { status: 204 });
    });

    await saveToLibrary(makeClient(fetchImpl as never), ["spotify:track:x"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("removes via DELETE /me/library", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://fake.spotify.test/v1/me/library");
      expect(init.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });

    await removeFromLibrary(makeClient(fetchImpl as never), ["spotify:album:y"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("addPlaylistItems", () => {
  it("POSTs uris to the /items path", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://fake.spotify.test/v1/playlists/p9/items");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ uris: ["spotify:track:z"] });
      return ok({ snapshot_id: "snap" });
    });

    await addPlaylistItems(makeClient(fetchImpl as never), "p9", ["spotify:track:z"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
